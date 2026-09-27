import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { PhysicalReceipt } from "../../src/contracts/types.js";
import type { PiDuplexExecutionPort } from "../../src/contracts/pi.js";
import {
  createPiCertificationExecutionPort,
  type PiCertificationExecutionPortOptions,
} from "../../src/testing/pi/execution.js";

interface RpcRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

class Capture {
  readonly records: RpcRecord[] = [];
  readonly errors: Error[] = [];
  readonly exit = deferred<PhysicalReceipt>();
  stderrBytes = 0;
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    predicate: (record: RpcRecord) => boolean;
    result: ReturnType<typeof deferred<RpcRecord>>;
    timer: NodeJS.Timeout;
  }> = [];

  readonly observer = {
    onStdout: (chunk: Uint8Array): void => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      if (this.buffer.byteLength > 64 * 1024 && !this.buffer.includes(0x0a)) {
        this.rejectWaiters(
          new Error("Certification record exceeded its bounded line buffer"),
        );
        return;
      }
      for (;;) {
        const delimiterIndex = this.buffer.indexOf(0x0a);
        if (delimiterIndex < 0) break;
        const line = this.buffer.subarray(0, delimiterIndex);
        this.buffer = this.buffer.subarray(delimiterIndex + 1);
        if (line.byteLength === 0) continue;
        if (line.byteLength > 64 * 1024) {
          this.rejectWaiters(
            new Error("Certification record exceeded its bounded line buffer"),
          );
          return;
        }
        try {
          const record: unknown = JSON.parse(line.toString("utf8"));
          if (!isRecord(record)) continue;
          if (this.records.length < 32) this.records.push(record);
          this.resolveMatching(record);
        } catch {
          this.rejectWaiters(
            new Error("Pi emitted an invalid certification record"),
          );
          return;
        }
      }
    },
    onStderr: (chunk: Uint8Array): void => {
      // Count bounded diagnostic bytes without retaining or printing their contents.
      this.stderrBytes += chunk.byteLength;
    },
    onExit: (receipt: PhysicalReceipt): void => {
      this.exit.resolve(receipt);
    },
    onError: (error: Error): void => {
      this.errors.push(error);
      this.rejectWaiters(error);
    },
  };

  waitFor(
    predicate: (record: RpcRecord) => boolean,
    timeoutMs = 10_000,
  ): Promise<RpcRecord> {
    const existing = this.records.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    const result = deferred<RpcRecord>();
    const timer = setTimeout(() => {
      this.waiters.splice(
        this.waiters.findIndex((waiter) => waiter.result === result),
        1,
      );
      result.reject(
        new Error("Timed out waiting for a Pi certification record"),
      );
    }, timeoutMs);
    this.waiters.push({ predicate, result, timer });
    return result.promise;
  }

  async waitForExit(timeoutMs = 10_000): Promise<PhysicalReceipt> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exit.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Timed out waiting for Pi certification process exit",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private resolveMatching(record: RpcRecord): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter === undefined || !waiter.predicate(record)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.result.resolve(record);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.result.reject(error);
    }
  }
}

async function makeExecutable(
  body: string,
): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "tsukai-pi-cert-test-"));
  const path = join(root, "pi-test.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return { root, path };
}

async function findExecutable(executable: string): Promise<string | undefined> {
  const candidates = executable.includes("/")
    ? [resolve(executable)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Check the remaining PATH entries.
    }
  }
  return undefined;
}

async function sendGetState(
  execution: Awaited<ReturnType<PiDuplexExecutionPort["open"]>>,
  capture: Capture,
  id: string,
): Promise<RpcRecord> {
  const response = capture.waitFor(
    (record) => record.type === "response" && record.id === id,
  );
  await execution.write(
    Buffer.from(`${JSON.stringify({ type: "get_state", id })}\n`),
  );
  return response;
}

function rpcReplyScript(): string {
  return `
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const boot = {
  type: "test_boot",
  args,
  home: process.env.HOME,
  cwd: process.cwd(),
  hasOpenAiKey: Object.prototype.hasOwnProperty.call(process.env, "OPENAI_API_KEY"),
  hasUnlistedSecret: Object.prototype.hasOwnProperty.call(process.env, "TSUKAI_TEST_SECRET"),
};
process.stdout.write(JSON.stringify(boot) + "\\n");
process.stderr.write("d".repeat(256));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const command = JSON.parse(line);
  if (command.id === "crash") process.exit(17);
  process.stdout.write(JSON.stringify({
    type: "response",
    command: command.type,
    id: command.id,
    success: true,
    data: { sessionId: "fake-session" },
  }) + "\\n");
}
`;
}

describe("Pi certification execution port", () => {
  it("starts with fixed arguments and isolated, bounded transport", async () => {
    const executable = await makeExecutable(rpcReplyScript());
    const capture = new Capture();
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const savedTestSecret = process.env.TSUKAI_TEST_SECRET;
    const testCredential = `credential-sentinel-${randomUUID()}`;
    process.env.OPENAI_API_KEY = testCredential;
    process.env.TSUKAI_TEST_SECRET = testCredential;
    const port = createPiCertificationExecutionPort({
      executable: executable.path,
      maxStderrBytes: 24,
      maxWriteQueueBytes: 64,
    });
    try {
      const execution = await port.open("fixed-argv", capture.observer);
      const boot = await capture.waitFor(
        (record) => record.type === "test_boot",
      );
      expect(boot.args).toEqual([
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--no-tools",
      ]);
      expect(boot.home).not.toBe(process.env.HOME);
      expect(boot.hasOpenAiKey).toBe(false);
      expect(boot.hasUnlistedSecret).toBe(false);
      await expect(execution.write(new Uint8Array(65))).rejects.toThrow(
        "write queue limit",
      );

      const response = await sendGetState(execution, capture, "fake-state");
      expect(response.success).toBe(true);
      expect(isRecord(response.data) && response.data.sessionId).toBe(
        "fake-session",
      );
      await execution.closeInput();
      const receipt = await capture.waitForExit();
      expect(capture.stderrBytes).toBe(24);
      expect(receipt).toMatchObject({
        executionRunId: execution.executionRunId,
        status: "exited",
        exitCode: 0,
        signal: null,
        forced: false,
      });
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      if (savedTestSecret === undefined) delete process.env.TSUKAI_TEST_SECRET;
      else process.env.TSUKAI_TEST_SECRET = savedTestSecret;
      await port.dispose();
      await rm(executable.root, { recursive: true, force: true });
    }
  });

  it("isolates a crashing execution from a sibling and proves each exit", async () => {
    const executable = await makeExecutable(rpcReplyScript());
    const port = createPiCertificationExecutionPort({
      executable: executable.path,
    });
    const crashCapture = new Capture();
    const steadyCapture = new Capture();
    try {
      const crashing = await port.open("crash", crashCapture.observer);
      const steady = await port.open("steady", steadyCapture.observer);
      expect(crashing.executionRunId).not.toBe(steady.executionRunId);
      await crashing.write(
        Buffer.from(`${JSON.stringify({ type: "get_state", id: "crash" })}\n`),
      );
      const crashReceipt = await crashCapture.waitForExit();
      expect(crashReceipt).toMatchObject({
        status: "exited",
        exitCode: 17,
        forced: false,
      });
      expect(crashCapture.records.some((record) => record.id === "crash")).toBe(
        false,
      );

      const steadyResponse = await sendGetState(
        steady,
        steadyCapture,
        "steady-state",
      );
      expect(steadyResponse.id).toBe("steady-state");
      expect(
        steadyCapture.records.some((record) => record.id === "crash"),
      ).toBe(false);
      await steady.closeInput();
      expect(await steadyCapture.waitForExit()).toMatchObject({
        executionRunId: steady.executionRunId,
        status: "exited",
        exitCode: 0,
        forced: false,
      });
    } finally {
      await port.dispose();
      await rm(executable.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses provider credentials and model flags only after explicit opt-in", async () => {
    const executable = await makeExecutable(rpcReplyScript());
    const capture = new Capture();
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = `credential-sentinel-${randomUUID()}`;
    const port = createPiCertificationExecutionPort({
      executable: executable.path,
      inheritProviderAuth: true,
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    });
    try {
      const execution = await port.open("provider-opt-in", capture.observer);
      const boot = await capture.waitFor(
        (record) => record.type === "test_boot",
      );
      expect(boot.args).toEqual([
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--no-tools",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-luna",
      ]);
      expect(boot.hasOpenAiKey).toBe(true);
      await execution.closeInput();
      expect(await capture.waitForExit()).toMatchObject({
        status: "exited",
        exitCode: 0,
        forced: false,
      });
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      await port.dispose();
      await rm(executable.root, { recursive: true, force: true });
    }
  });

  it("escalates cancellation to SIGKILL after bounded grace periods", async () => {
    const executable = await makeExecutable(`
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
setInterval(() => {}, 1000);
`);
    const capture = new Capture();
    const port = createPiCertificationExecutionPort({
      executable: executable.path,
      terminateGraceMs: 25,
      killGraceMs: 1_000,
    });
    try {
      const execution = await port.open("cancel", capture.observer);
      await capture.waitFor((record) => record.type === "ready");
      await execution.retire("cancel");
      expect(await capture.waitForExit()).toMatchObject({
        executionRunId: execution.executionRunId,
        status: "exited",
        exitCode: null,
        signal: "SIGKILL",
        forced: true,
      });
    } finally {
      await port.dispose();
      await rm(executable.root, { recursive: true, force: true });
    }
  });
});

const configuredPi = process.env.PI_EXECUTABLE ?? "pi";
const installedPi = await findExecutable(configuredPi);

describe.skipIf(installedPi === undefined)(
  "installed Pi RPC transport certification",
  () => {
    it("correlates get_state, captures sessionId, and exits cleanly without a model call", async () => {
      const capture = new Capture();
      const port = createPiCertificationExecutionPort({
        executable: installedPi ?? "pi",
      });
      try {
        const execution = await port.open(
          `credential-free-${randomUUID()}`,
          capture.observer,
        );
        expect(execution.pid).toBeTypeOf("number");
        const response = await sendGetState(
          execution,
          capture,
          `state-${randomUUID()}`,
        );
        expect(response.command).toBe("get_state");
        expect(response.success).toBe(true);
        expect(isRecord(response.data)).toBe(true);
        if (!isRecord(response.data))
          throw new Error("Pi get_state response omitted its data");
        expect(response.data.sessionId).toBeTypeOf("string");
        expect((response.data.sessionId as string).length).toBeGreaterThan(0);
        await execution.closeInput();
        expect(await capture.waitForExit()).toMatchObject({
          executionRunId: execution.executionRunId,
          status: "exited",
          exitCode: 0,
          signal: null,
          forced: false,
        });
        expect(capture.errors).toEqual([]);
      } finally {
        await port.dispose();
      }
    }, 20_000);
  },
);

it("validates opt-in provider selection without accepting free-form arguments", () => {
  expect(() =>
    createPiCertificationExecutionPort({
      inheritProviderAuth: true,
      provider: "openai-codex; touch /tmp/not-allowed",
    }),
  ).toThrow("provider contains unsupported characters");
  expect(() =>
    createPiCertificationExecutionPort({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    } satisfies PiCertificationExecutionPortOptions),
  ).toThrow("requires inheritProviderAuth");
});
