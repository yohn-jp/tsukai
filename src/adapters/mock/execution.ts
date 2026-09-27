import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS } from "../../contracts/limits.js";
import type {
  ExecutionObserver,
  ExecutionPort,
} from "../../contracts/ports.js";
import type {
  ExecutionBinding,
  PhysicalReceipt,
  RunCreateInput,
} from "../../contracts/types.js";

const MAX_FIXTURES = DEFAULT_LIMITS.maxRuns;
const MAX_START_RECORD_BYTES = DEFAULT_LIMITS.maxRecordBytes;
const MAX_REPORTED_TEXT_BYTES = 32 * 1024;
const MAX_QUEUED_INPUT_BYTES = DEFAULT_LIMITS.maxQueuedInputBytes;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const FORCE_KILL_WAIT_MS = 1_000;

export interface MockExecutionOptions {
  terminationGraceMs?: number;
  cleanupTimeoutMs?: number;
  maxFixtures?: number;
}

export interface MockExecutionPort extends ExecutionPort {
  /** Release the explicit gate on a fixture created with the `hold` scenario. */
  release(agentRunId: string): Promise<void>;
}

interface FixtureRecord {
  executionRunId: string;
  scenario: RunCreateInput["request"]["scenario"];
  child: ChildProcessByStdio<Writable, Readable, null>;
  observer: ExecutionObserver;
  exitPromise: Promise<PhysicalReceipt>;
  resolveExit(receipt: PhysicalReceipt): void;
  closed: boolean;
  spawned: boolean;
  forced: boolean;
  releaseSent: boolean;
  terminationTimer?: NodeJS.Timeout;
}

/**
 * Create the only direct process adapter in M0. It always launches the fixed,
 * package-owned fixture with the current Node executable and no shell.
 */
export function createMockExecutionPort(
  options: MockExecutionOptions = {},
): MockExecutionPort {
  const terminationGraceMs = boundedInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    0,
    30_000,
    "terminationGraceMs",
  );
  const cleanupTimeoutMs = boundedInteger(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    1,
    30_000,
    "cleanupTimeoutMs",
  );
  const maxFixtures = boundedInteger(
    options.maxFixtures ?? MAX_FIXTURES,
    1,
    MAX_FIXTURES,
    "maxFixtures",
  );
  const records = new Map<string, FixtureRecord>();
  const byAgentRunId = new Map<string, FixtureRecord>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  function recordFor(executionRunId: string): FixtureRecord {
    const record = records.get(executionRunId);
    if (!record) throw new Error(`Unknown mock execution: ${executionRunId}`);
    return record;
  }

  function reportError(record: FixtureRecord, error: Error): void {
    try {
      record.observer.onError(error);
    } catch {
      // An observer callback cannot be allowed to escape a Node stream event.
    }
  }

  function signalTermination(record: FixtureRecord): void {
    if (record.closed) return;
    if (record.terminationTimer) return;
    try {
      record.child.kill("SIGTERM");
    } catch (error) {
      reportError(
        record,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    record.terminationTimer = setTimeout(() => {
      if (record.closed) return;
      record.forced = true;
      try {
        record.child.kill("SIGKILL");
      } catch (error) {
        reportError(
          record,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }, terminationGraceMs);
    record.terminationTimer.unref();
  }

  function sendInput(
    record: FixtureRecord,
    command: { kind: "release" },
  ): Promise<void> {
    if (
      !command ||
      typeof command !== "object" ||
      command.kind !== "release" ||
      Object.keys(command).length !== 1
    ) {
      return Promise.reject(new Error("Unsupported mock input command"));
    }
    if (record.scenario !== "hold") {
      return Promise.reject(new Error("The mock fixture has no release gate"));
    }
    if (record.closed)
      return Promise.reject(new Error("Mock fixture has already exited"));
    if (record.releaseSent) return Promise.resolve();

    const bytes = Buffer.from('{"type":"release"}\n', "utf8");
    if (
      record.child.stdin.writableLength + bytes.byteLength >
      MAX_QUEUED_INPUT_BYTES
    ) {
      return Promise.reject(
        new Error("Mock fixture input buffer limit exceeded"),
      );
    }
    record.releaseSent = true;
    return new Promise<void>((resolve, reject) => {
      record.child.stdin.write(bytes, (error?: Error | null) => {
        if (error) {
          record.releaseSent = false;
          reject(error);
        } else resolve();
      });
    });
  }

  async function waitForExit(
    pending: Promise<unknown>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function disposeAll(): Promise<void> {
    const active = [...records.values()].filter((record) => !record.closed);
    for (const record of active) signalTermination(record);
    const graceful = await waitForExit(
      Promise.all(active.map((record) => record.exitPromise)),
      cleanupTimeoutMs,
    );
    if (graceful) return;

    const remaining = active.filter((record) => !record.closed);
    for (const record of remaining) {
      record.forced = true;
      try {
        record.child.kill("SIGKILL");
      } catch (error) {
        reportError(
          record,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    const forced = await waitForExit(
      Promise.all(remaining.map((record) => record.exitPromise)),
      FORCE_KILL_WAIT_MS,
    );
    if (!forced) {
      throw new Error("Could not prove that every mock fixture process exited");
    }
  }

  return {
    async start(
      agentRunId: string,
      request: RunCreateInput["request"],
      observer: ExecutionObserver,
    ): Promise<ExecutionBinding> {
      if (disposed) throw new Error("Mock execution port is disposed");
      if (!agentRunId || typeof agentRunId !== "string") {
        throw new TypeError("agentRunId must be a non-empty string");
      }
      if (Buffer.byteLength(agentRunId, "utf8") > 256) {
        throw new RangeError("agentRunId exceeds its byte limit");
      }
      if (byAgentRunId.has(agentRunId)) {
        throw new Error(
          `Mock fixture already started for AgentRun: ${agentRunId}`,
        );
      }
      if (records.size >= maxFixtures) {
        throw new Error("Mock fixture limit exceeded");
      }
      const validatedRequest = validateRequest(request);
      const executionRunId = randomUUID();
      const binding: ExecutionBinding = {
        executionRunId,
        backend: "mock-fixture",
        pid: 0,
      };
      const sourceExtension = fileURLToPath(import.meta.url).endsWith(".ts")
        ? "ts"
        : "js";
      const workerPath = fileURLToPath(
        new URL(
          `../../testing/fixture-worker.${sourceExtension}`,
          import.meta.url,
        ),
      );
      const initialRecord = Buffer.from(
        `${JSON.stringify({ type: "start", agentRunId, request: validatedRequest })}\n`,
        "utf8",
      );
      if (initialRecord.byteLength > MAX_START_RECORD_BYTES) {
        throw new RangeError(
          "Mock fixture start record exceeds its byte limit",
        );
      }

      const child = spawn(process.execPath, [workerPath], {
        cwd: dirname(workerPath),
        env: {},
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let resolveExit!: (receipt: PhysicalReceipt) => void;
      const record: FixtureRecord = {
        executionRunId,
        scenario: validatedRequest.scenario,
        child,
        observer,
        exitPromise: new Promise((resolve) => {
          resolveExit = resolve;
        }),
        resolveExit: (receipt) => resolveExit(receipt),
        closed: false,
        spawned: false,
        forced: false,
        releaseSent: false,
      };
      records.set(executionRunId, record);
      byAgentRunId.set(agentRunId, record);

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          observer.onOutput(Buffer.from(chunk));
        } catch (error) {
          reportError(
            record,
            error instanceof Error ? error : new Error(String(error)),
          );
          signalTermination(record);
        }
      });
      child.stdout.on("error", (error) => reportError(record, error));
      child.stdin.on("error", (error) => reportError(record, error));
      child.on("error", (error) => {
        if (!record.spawned) {
          records.delete(executionRunId);
          byAgentRunId.delete(agentRunId);
          return;
        }
        reportError(record, error);
      });
      child.once("close", (exitCode, signal) => {
        record.closed = true;
        if (record.terminationTimer) clearTimeout(record.terminationTimer);
        if (!record.spawned) return;
        const receipt: PhysicalReceipt = {
          executionRunId,
          status: "exited",
          exitCode,
          signal,
          forced: record.forced || signal === "SIGKILL",
        };
        record.resolveExit(receipt);
        try {
          observer.onExit(receipt);
        } catch {
          // Preserve the process receipt even if a consumer callback fails.
        }
      });

      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
          record.spawned = true;
          binding.pid = child.pid ?? 0;
          if (!binding.pid) {
            signalTermination(record);
            reject(new Error("Mock fixture did not provide a process ID"));
            return;
          }
          if (initialRecord.byteLength > MAX_QUEUED_INPUT_BYTES) {
            signalTermination(record);
            reject(new RangeError("Mock fixture input buffer limit exceeded"));
            return;
          }
          child.stdin.write(initialRecord, (error?: Error | null) => {
            if (error) {
              signalTermination(record);
              reject(error);
            } else {
              resolve();
            }
          });
        });
        child.once("error", (error) => reject(error));
      });
      return binding;
    },

    async input(executionRunId, command) {
      const record = recordFor(executionRunId);
      await sendInput(record, command);
    },

    async retire(executionRunId, _reason) {
      const record = recordFor(executionRunId);
      signalTermination(record);
    },

    async dispose() {
      if (!disposePromise) {
        disposed = true;
        disposePromise = disposeAll();
      }
      await disposePromise;
    },

    async release(agentRunId) {
      const record = byAgentRunId.get(agentRunId);
      if (!record)
        throw new Error(`No mock fixture for AgentRun: ${agentRunId}`);
      await sendInput(record, { kind: "release" });
    },
  };
}

function validateRequest(
  request: RunCreateInput["request"],
): RunCreateInput["request"] {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Mock fixture request must be an object");
  }
  const allowedKeys = new Set(["scenario", "reportedText", "delayMs"]);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key))
      throw new TypeError(`Unsupported mock fixture request field: ${key}`);
  }
  const scenarios = new Set([
    "normal",
    "error",
    "crash",
    "retry",
    "quiet",
    "hold",
  ]);
  if (!scenarios.has(request.scenario)) {
    throw new TypeError(
      `Unsupported mock fixture scenario: ${String(request.scenario)}`,
    );
  }
  if (request.reportedText !== undefined) {
    if (typeof request.reportedText !== "string") {
      throw new TypeError("Mock fixture reportedText must be a string");
    }
    if (
      Buffer.byteLength(request.reportedText, "utf8") > MAX_REPORTED_TEXT_BYTES
    ) {
      throw new RangeError("Mock fixture reportedText exceeds its byte limit");
    }
  }
  if (request.delayMs !== undefined) {
    boundedInteger(request.delayMs, 0, 2_000, "delayMs");
  }
  return {
    scenario: request.scenario,
    ...(request.reportedText === undefined
      ? {}
      : { reportedText: request.reportedText }),
    ...(request.delayMs === undefined ? {} : { delayMs: request.delayMs }),
  };
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
