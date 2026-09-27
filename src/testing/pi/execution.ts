import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  PiDuplexExecution,
  PiDuplexExecutionPort,
  PiTransportObserver,
} from "../../contracts/pi.js";
import type { PhysicalReceipt } from "../../contracts/types.js";

const FIXED_ARGS = [
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
] as const;

const PROVIDER_AUTH_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "OPENROUTER_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "META_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
] as const;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_GRACE_MS = 3_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_WRITE_QUEUE_BYTES = 1_048_576;
const DEFAULT_MAX_STDERR_BYTES = 16_384;

export interface PiCertificationExecutionPortOptions {
  /** A Pi executable name or path. Arguments are fixed by this certification runner. */
  executable?: string;
  /** Enables access to the caller's Pi auth directory and documented provider env credentials. */
  inheritProviderAuth?: boolean;
  /** Optional, validated Pi provider selection for an opt-in live prompt certification. */
  provider?: string;
  /** Optional, validated Pi model selection for an opt-in live prompt certification. */
  model?: string;
  startupTimeoutMs?: number;
  settleGraceMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  maxWriteQueueBytes?: number;
  maxStderrBytes?: number;
}

export interface PiCertificationWorkspace {
  cwd: string;
  workspaceSessionId?: string;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validPiSelection(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
    throw new TypeError(`${name} contains unsupported characters`);
  }
  return value;
}

function childEnvironment(
  home: string,
  inheritProviderAuth: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const safeNames = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
  ];
  for (const name of safeNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  env.HOME = inheritProviderAuth ? (process.env.HOME ?? homedir()) : home;
  env.USERPROFILE = inheritProviderAuth
    ? (process.env.USERPROFILE ?? env.HOME)
    : home;
  env.TMPDIR = home;
  env.TMP = home;
  env.TEMP = home;
  env.PI_CODING_AGENT_DIR = inheritProviderAuth
    ? (process.env.PI_CODING_AGENT_DIR ?? join(env.HOME, ".pi", "agent"))
    : join(home, "agent");
  env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  env.PI_TELEMETRY = "0";
  if (!inheritProviderAuth) env.PI_OFFLINE = "1";

  if (inheritProviderAuth) {
    for (const name of PROVIDER_AUTH_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
}

function fixedArgs(
  provider: string | undefined,
  model: string | undefined,
): string[] {
  const args: string[] = [...FIXED_ARGS];
  if (provider !== undefined) args.push("--provider", provider);
  if (model !== undefined) args.push("--model", model);
  return args;
}

function safeObserverError(
  observer: PiTransportObserver,
  message: string,
): void {
  try {
    observer.onError(new Error(message));
  } catch {
    // Transport observers must not interrupt physical cleanup.
  }
}

function safeObserverBytes(
  observer: PiTransportObserver,
  target: "stdout" | "stderr",
  bytes: Uint8Array,
): void {
  try {
    if (target === "stdout") observer.onStdout(bytes);
    else observer.onStderr(bytes);
  } catch {
    safeObserverError(observer, `Pi certification ${target} observer failed`);
  }
}

class PiCertificationExecution implements PiDuplexExecution {
  readonly executionRunId = randomUUID();
  readonly backend = "pi-certification";
  pid?: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly observer: PiTransportObserver;
  private readonly workspaceRoot: string;
  private readonly onClose: (executionRunId: string) => void;
  private readonly startupTimeoutMs: number;
  private readonly settleGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxWriteQueueBytes: number;
  private readonly maxStderrBytes: number;
  private stderrBytes = 0;
  private queuedWriteBytes = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private readySettled = false;
  private started = false;
  private processHasExited = false;
  private acceptingWrites = true;
  private forced = false;
  private closePromise: Promise<void> | undefined;
  private retirementPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private exitReceipt: PhysicalReceipt | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveExit!: (receipt: PhysicalReceipt | undefined) => void;
  private readonly ready: Promise<void>;
  private readonly exit: Promise<PhysicalReceipt | undefined>;

  constructor(
    child: ChildProcessWithoutNullStreams,
    observer: PiTransportObserver,
    workspaceRoot: string,
    onClose: (executionRunId: string) => void,
    options: {
      startupTimeoutMs: number;
      settleGraceMs: number;
      terminateGraceMs: number;
      killGraceMs: number;
      maxWriteQueueBytes: number;
      maxStderrBytes: number;
    },
  ) {
    this.child = child;
    this.observer = observer;
    this.workspaceRoot = workspaceRoot;
    this.onClose = onClose;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.settleGraceMs = options.settleGraceMs;
    this.terminateGraceMs = options.terminateGraceMs;
    this.killGraceMs = options.killGraceMs;
    this.maxWriteQueueBytes = options.maxWriteQueueBytes;
    this.maxStderrBytes = options.maxStderrBytes;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    void this.ready.catch(() => undefined);
    this.exit = new Promise<PhysicalReceipt | undefined>((resolveExit) => {
      this.resolveExit = resolveExit;
    });

    child.once("spawn", () => {
      this.started = true;
      if (child.pid !== undefined) this.pid = child.pid;
      this.readySettled = true;
      this.resolveReady();
    });
    child.on("error", () => {
      if (!this.started && !this.readySettled) {
        this.readySettled = true;
        this.rejectReady(
          new Error("Pi certification executable could not be started"),
        );
      } else {
        safeObserverError(
          this.observer,
          "Pi certification process reported an error",
        );
      }
    });
    child.once("exit", () => {
      this.processHasExited = true;
    });
    child.once("close", (exitCode, signal) => {
      this.processHasExited = true;
      if (!this.started) {
        this.resolveExit(undefined);
        this.onClose(this.executionRunId);
        void this.cleanupWorkspace();
        return;
      }
      this.exitReceipt = {
        executionRunId: this.executionRunId,
        status: "exited",
        exitCode,
        signal,
        forced: this.forced,
      };
      try {
        this.observer.onExit(this.exitReceipt);
      } catch {
        safeObserverError(
          this.observer,
          "Pi certification exit observer failed",
        );
      }
      this.resolveExit(this.exitReceipt);
      this.onClose(this.executionRunId);
      void this.cleanupWorkspace();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      safeObserverBytes(this.observer, "stdout", chunk);
    });
    child.stdout.on("error", () => {
      safeObserverError(this.observer, "Pi certification stdout stream failed");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = this.maxStderrBytes - this.stderrBytes;
      if (remaining <= 0) return;
      const bounded =
        chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      this.stderrBytes += bounded.byteLength;
      safeObserverBytes(this.observer, "stderr", bounded);
    });
    child.stderr.on("error", () => {
      safeObserverError(this.observer, "Pi certification stderr stream failed");
    });
    child.stdin.on("error", () => {
      safeObserverError(this.observer, "Pi certification stdin stream failed");
    });
  }

  async waitUntilStarted(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Pi certification process startup timed out")),
            this.startupTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    if (!this.acceptingWrites)
      return Promise.reject(new Error("Pi stdin is closed"));
    if (!(bytes instanceof Uint8Array)) {
      return Promise.reject(
        new TypeError("Pi stdin writes must be Uint8Array values"),
      );
    }
    if (bytes.byteLength === 0) return Promise.resolve();
    if (this.queuedWriteBytes + bytes.byteLength > this.maxWriteQueueBytes) {
      return Promise.reject(
        new Error("Pi certification stdin write queue limit exceeded"),
      );
    }

    const owned = Buffer.from(bytes);
    this.queuedWriteBytes += owned.byteLength;
    const write = this.writeTail.then(() => this.writeChunk(owned));
    this.writeTail = write.catch(() => undefined);
    return write.finally(() => {
      this.queuedWriteBytes -= owned.byteLength;
    });
  }

  closeInput(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.acceptingWrites = false;
    this.closePromise = this.writeTail.then(async () => {
      if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
      await new Promise<void>((resolveEnd, rejectEnd) => {
        this.child.stdin.end((error?: Error | null) => {
          if (error != null)
            rejectEnd(new Error("Pi stdin could not be closed cleanly"));
          else resolveEnd();
        });
      });
    });
    return this.closePromise;
  }

  retire(reason: "settled" | "cancel"): Promise<void> {
    if (this.retirementPromise !== undefined) return this.retirementPromise;
    this.acceptingWrites = false;
    this.retirementPromise = this.performRetirement(reason);
    return this.retirementPromise;
  }

  async failStartup(): Promise<void> {
    if (!this.processHasExited) {
      if (this.child.pid !== undefined) {
        this.sendSignal("SIGKILL");
      } else if (!this.readySettled) {
        this.child.once("spawn", () => this.sendSignal("SIGKILL"));
      }
    }
    const exited = await this.waitForExit(this.killGraceMs);
    if (!exited && this.child.pid !== undefined) {
      safeObserverError(
        this.observer,
        "Pi certification startup cleanup could not confirm process exit",
      );
    }
    if (this.processHasExited) await this.cleanupWorkspace();
  }

  private writeChunk(chunk: Buffer): Promise<void> {
    if (this.exitReceipt !== undefined || this.processHasExited) {
      return Promise.reject(new Error("Pi process has exited"));
    }
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      return Promise.reject(new Error("Pi stdin is closed"));
    }
    return new Promise<void>((resolveWrite, rejectWrite) => {
      let settled = false;
      let drainComplete = false;
      let callbackComplete = false;
      const cleanup = (): void => {
        this.child.stdin.removeListener("drain", onDrain);
        this.child.stdin.removeListener("error", onError);
        this.child.stdin.removeListener("close", onClose);
      };
      const finish = (): void => {
        if (settled || !drainComplete || !callbackComplete) return;
        settled = true;
        cleanup();
        resolveWrite();
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWrite(new Error("Pi stdin write failed"));
      };
      const onDrain = (): void => {
        drainComplete = true;
        finish();
      };
      const onError = (): void => fail();
      const onClose = (): void => fail();

      this.child.stdin.once("error", onError);
      this.child.stdin.once("close", onClose);
      let accepted: boolean;
      try {
        accepted = this.child.stdin.write(chunk, (error?: Error | null) => {
          if (error != null) {
            fail();
            return;
          }
          callbackComplete = true;
          finish();
        });
      } catch {
        fail();
        return;
      }
      drainComplete = accepted;
      if (!accepted) this.child.stdin.once("drain", onDrain);
      finish();
    });
  }

  private async performRetirement(reason: "settled" | "cancel"): Promise<void> {
    try {
      await this.waitUntilStarted();
    } catch {
      await this.failStartup();
      return;
    }

    const closePromise = this.closeInput().catch(() => undefined);
    if (reason === "settled" && (await this.waitForExit(this.settleGraceMs))) {
      await closePromise;
      await this.cleanupWorkspace();
      return;
    }
    if (reason === "cancel" && (await this.waitForExit(0))) {
      await closePromise;
      await this.cleanupWorkspace();
      return;
    }

    this.sendSignal("SIGTERM");
    if (!(await this.waitForExit(this.terminateGraceMs))) {
      this.sendSignal("SIGKILL");
      if (!(await this.waitForExit(this.killGraceMs))) {
        safeObserverError(
          this.observer,
          "Pi certification retirement could not confirm process exit after SIGKILL",
        );
      }
    }
    if (this.processHasExited) {
      await closePromise;
      await this.cleanupWorkspace();
    }
  }

  private sendSignal(signal: NodeJS.Signals): void {
    if (this.processHasExited || this.exitReceipt !== undefined) return;
    try {
      if (this.child.kill(signal)) this.forced = true;
    } catch {
      safeObserverError(
        this.observer,
        "Pi certification process could not be signalled",
      );
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.processHasExited) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolveWait) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolveWait(this.processHasExited);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolveWait(true);
        }
      };
      this.exit.then(onExit);
    });
  }

  private cleanupWorkspace(): Promise<void> {
    if (this.cleanupPromise === undefined) {
      this.cleanupPromise = rm(this.workspaceRoot, {
        recursive: true,
        force: true,
      }).then(
        () => undefined,
        () => undefined,
      );
    }
    return this.cleanupPromise;
  }
}

/**
 * Explicit testing/certification-only Pi process owner. Production Pi adapters must receive
 * their execution port from the production execution owner instead of constructing this port.
 */
export function createPiCertificationExecutionPort(
  options: PiCertificationExecutionPortOptions = {},
): PiDuplexExecutionPort {
  const executable = options.executable ?? "pi";
  if (executable.length === 0 || executable.includes("\0")) {
    throw new TypeError(
      "executable must be a non-empty Pi executable name or path",
    );
  }
  const inheritProviderAuth = options.inheritProviderAuth ?? false;
  const provider = validPiSelection(options.provider, "provider");
  const model = validPiSelection(options.model, "model");
  if ((provider !== undefined || model !== undefined) && !inheritProviderAuth) {
    throw new TypeError(
      "provider/model selection requires inheritProviderAuth: true",
    );
  }
  const limits = {
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
    settleGraceMs: positiveInteger(
      options.settleGraceMs,
      DEFAULT_SETTLE_GRACE_MS,
      "settleGraceMs",
    ),
    terminateGraceMs: positiveInteger(
      options.terminateGraceMs,
      DEFAULT_TERMINATE_GRACE_MS,
      "terminateGraceMs",
    ),
    killGraceMs: positiveInteger(
      options.killGraceMs,
      DEFAULT_KILL_GRACE_MS,
      "killGraceMs",
    ),
    maxWriteQueueBytes: positiveInteger(
      options.maxWriteQueueBytes,
      DEFAULT_MAX_WRITE_QUEUE_BYTES,
      "maxWriteQueueBytes",
    ),
    maxStderrBytes: positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    ),
  };
  const args = fixedArgs(provider, model);
  const executions = new Map<string, PiCertificationExecution>();
  let disposed = false;

  return {
    async open(
      agentRunId: string,
      observer: PiTransportObserver,
      workspace?: PiCertificationWorkspace,
    ): Promise<PiDuplexExecution> {
      if (disposed)
        throw new Error("Pi certification execution port is disposed");
      if (typeof agentRunId !== "string" || agentRunId.length === 0) {
        throw new TypeError("agentRunId must be a non-empty string");
      }
      if (
        workspace !== undefined &&
        (typeof workspace.cwd !== "string" || workspace.cwd.length === 0)
      ) {
        throw new TypeError("workspace.cwd must be a non-empty path");
      }

      const workspaceRoot = await mkdtemp(join(tmpdir(), "tsukai-pi-cert-"));
      if (disposed) {
        await rm(workspaceRoot, { recursive: true, force: true });
        throw new Error("Pi certification execution port is disposed");
      }
      const cwd =
        workspace === undefined ? workspaceRoot : resolve(workspace.cwd);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, args, {
          cwd,
          env: childEnvironment(workspaceRoot, inheritProviderAuth),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        await rm(workspaceRoot, { recursive: true, force: true });
        throw new Error("Pi certification executable could not be started");
      }

      const execution = new PiCertificationExecution(
        child,
        observer,
        workspaceRoot,
        (executionRunId) => executions.delete(executionRunId),
        limits,
      );
      executions.set(execution.executionRunId, execution);
      try {
        await execution.waitUntilStarted();
        if (disposed) {
          await execution.retire("cancel");
          throw new Error("Pi certification execution port is disposed");
        }
        return execution;
      } catch (error) {
        await execution.failStartup();
        executions.delete(execution.executionRunId);
        if (
          error instanceof Error &&
          error.message === "Pi certification process startup timed out"
        ) {
          throw error;
        }
        throw new Error("Pi certification executable could not be started");
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await Promise.all(
        [...executions.values()].map((execution) => execution.retire("cancel")),
      );
      executions.clear();
    },
  };
}
