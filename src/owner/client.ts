import { lstatSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { ReconcileReport } from "../contracts/service.js";
import type {
  HarnessName,
  ObservationEnvelope,
  Page,
  RunCreateInput,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "../contracts/types.js";
import { RunNotFoundError, WaitTimeoutError } from "../contracts/types.js";
import {
  createFrameReader,
  OWNER_SOCKET_NAME,
  OWNER_TOKEN_NAME,
  OwnerError,
  type OwnerResponse,
} from "./protocol.js";
import {
  assertOwnedPrivate,
  assertPosix,
  assertPrivateDirectory,
} from "./security.js";

export interface OwnerStatus {
  protocol: number;
  pid: number;
  startedAt: string;
  connections: number;
  storeIssues: { entry: string; reason: string }[];
}

/** The same semantic operations as RunOperations, made asynchronous by IPC. */
export interface OwnerRunOperations {
  create(input: RunCreateInput<unknown, HarnessName>): Promise<RunSnapshot>;
  get(agentRunId: string): Promise<RunSnapshot>;
  list(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<RunSnapshot>>;
  children(
    parentRunId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<Page<RunSnapshot>>;
  wait(agentRunId: string, options?: WaitOptions): Promise<RunSnapshot>;
  cancel(agentRunId: string): Promise<RunSnapshot>;
  events(
    agentRunId: string,
    afterSeq?: number,
  ): AsyncIterable<ObservationEnvelope>;
  result(agentRunId: string): Promise<RunResult>;
}

/** Clients are projections: every operation runs in the resident owner. */
export interface OwnerClient {
  runs: OwnerRunOperations;
  reconcile(): Promise<ReconcileReport>;
  status(): Promise<OwnerStatus>;
  /** Drops this connection only. Runs and the owner are unaffected. */
  close(): Promise<void>;
}

export interface OwnerClientOptions {
  stateDir: string;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onEvent?: (event: unknown) => void;
}

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  closed = false;

  constructor(private readonly socket: Socket) {
    socket.on("close", () => this.shutdown());
    socket.on("error", () => this.shutdown());
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new OwnerError(
      "OWNER_UNAVAILABLE",
      "Owner connection was lost; the outcome of in-flight requests is unknown",
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  attach(maxFrameBytes: number): void {
    this.socket.on(
      "data",
      createFrameReader(
        maxFrameBytes,
        (frame) => {
          let message: OwnerResponse;
          try {
            message = JSON.parse(frame) as OwnerResponse;
          } catch {
            this.socket.destroy();
            return;
          }
          const pending = this.pending.get(message.id);
          if (pending === undefined) return;
          if (!message.ok) {
            this.pending.delete(message.id);
            pending.reject(toError(message.error));
          } else if ("event" in message) {
            pending.onEvent?.(message.event);
          } else if ("done" in message) {
            this.pending.delete(message.id);
            pending.resolve(undefined);
          } else {
            this.pending.delete(message.id);
            pending.resolve(message.result);
          }
        },
        () => this.socket.destroy(),
      ),
    );
  }

  request(
    op: string,
    args: Record<string, unknown> = {},
    onEvent?: (event: unknown) => void,
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(
          new OwnerError("OWNER_UNAVAILABLE", "Owner connection is closed"),
        );
        return;
      }
      this.pending.set(id, {
        resolve,
        reject,
        ...(onEvent === undefined ? {} : { onEvent }),
      });
      this.socket.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
    return { id, promise };
  }

  close(): void {
    this.socket.destroy();
  }
}

function toError(error: { code: string; message: string }): Error {
  if (error.code === "RUN_NOT_FOUND") {
    const match = /: (.+)$/.exec(error.message);
    return new RunNotFoundError(match?.[1] ?? "unknown");
  }
  if (error.code === "WAIT_TIMEOUT") return new WaitTimeoutError();
  return new OwnerError(error.code as OwnerError["code"], error.message);
}

function readToken(stateDir: string): string {
  const path = join(stateDir, OWNER_TOKEN_NAME);
  assertOwnedPrivate(lstatSync(path), "Owner token");
  return readFileSync(path, "utf8").trim();
}

async function open(options: OwnerClientOptions): Promise<Connection> {
  assertPosix();
  const { stateDir } = options;
  // Refuse to hand the token to anything another user could have planted.
  assertPrivateDirectory(stateDir);
  const socketPath = join(stateDir, OWNER_SOCKET_NAME);
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket()) {
    throw new OwnerError("OWNER_UNAVAILABLE", "Owner endpoint is not a socket");
  }
  assertOwnedPrivate(socketStat, "Owner socket");
  const token = readToken(stateDir);
  const socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = connect(socketPath);
    const timer = setTimeout(() => {
      candidate.destroy();
      reject(new OwnerError("OWNER_UNAVAILABLE", "Owner connection timed out"));
    }, options.connectTimeoutMs ?? 5_000);
    candidate.once("connect", () => {
      clearTimeout(timer);
      resolve(candidate);
    });
    candidate.once("error", () => {
      clearTimeout(timer);
      reject(new OwnerError("OWNER_UNAVAILABLE", "Owner is not reachable"));
    });
  });
  const connection = new Connection(socket);
  connection.attach(options.maxFrameBytes ?? 4 * 1024 * 1024);
  try {
    await connection.request("hello", { token }).promise;
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/**
 * Connects to the resident owner for this state directory. The client
 * reconnects lazily after a lost connection, but never retries `create`: a
 * lost create response must be resolved by listing runs, not by resubmitting.
 */
export async function connectOwner(
  options: OwnerClientOptions,
): Promise<OwnerClient> {
  let connection = await open(options);
  let closed = false;
  const ensure = async (): Promise<Connection> => {
    if (closed) throw new OwnerError("OWNER_UNAVAILABLE", "Client is closed");
    if (connection.closed) connection = await open(options);
    return connection;
  };
  const call = async <T>(
    op: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    // Every operation except create is idempotent by identity, so one
    // transparent reconnect after a dropped connection is safe.
    const retryable = op !== "create";
    for (let attempt = 0; ; attempt++) {
      try {
        return (await (await ensure()).request(op, args).promise) as T;
      } catch (error) {
        const lost =
          error instanceof OwnerError && error.code === "OWNER_UNAVAILABLE";
        if (!lost || !retryable || attempt >= 1 || closed) throw error;
        connection.close();
      }
    }
  };
  const paging = (page?: { cursor?: string; limit?: number }) => ({
    ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
    ...(page?.limit === undefined ? {} : { limit: page.limit }),
  });

  const runs: OwnerRunOperations = {
    create: (input) => call("create", { input }),
    get: (agentRunId) => call("get", { agentRunId }),
    list: (page) => call("list", paging(page)),
    children: (parentRunId, page) =>
      call("children", { parentRunId, ...paging(page) }),
    cancel: (agentRunId) => call("cancel", { agentRunId }),
    result: (agentRunId) => call("result", { agentRunId }),
    async wait(agentRunId, waitOptions = {}) {
      const { signal, timeoutMs } = waitOptions;
      if (signal?.aborted) throw abortError();
      const active = await ensure();
      const { id, promise } = active.request("wait", {
        agentRunId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (signal === undefined) return (await promise) as RunSnapshot;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = (): void => {
          // Only the waiter ends; the run is untouched.
          void active
            .request("cancel-request", { target: id })
            .promise.catch(() => undefined);
          reject(abortError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([promise as Promise<RunSnapshot>, aborted]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        void promise.catch(() => undefined);
      }
    },
    events(agentRunId, afterSeq) {
      return {
        [Symbol.asyncIterator]: () => {
          const queue: ObservationEnvelope[] = [];
          let wake: (() => void) | undefined;
          let finished = false;
          let failure: Error | undefined;
          let requestId: number | undefined;
          let active: Connection | undefined;
          const start = async (): Promise<void> => {
            active = await ensure();
            const started = active.request(
              "events",
              { agentRunId, ...(afterSeq === undefined ? {} : { afterSeq }) },
              (event) => {
                queue.push(event as ObservationEnvelope);
                wake?.();
              },
            );
            requestId = started.id;
            started.promise.then(
              () => {
                finished = true;
                wake?.();
              },
              (error: unknown) => {
                failure =
                  error instanceof Error ? error : new Error("events failed");
                finished = true;
                wake?.();
              },
            );
          };
          const started = start();
          return {
            async next(): Promise<IteratorResult<ObservationEnvelope>> {
              await started;
              for (;;) {
                const value = queue.shift();
                if (value !== undefined) return { value, done: false };
                if (failure !== undefined) throw failure;
                if (finished) return { value: undefined, done: true };
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            },
            async return(): Promise<IteratorResult<ObservationEnvelope>> {
              if (
                !finished &&
                active !== undefined &&
                requestId !== undefined
              ) {
                void active
                  .request("cancel-request", { target: requestId })
                  .promise.catch(() => undefined);
              }
              finished = true;
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };

  return {
    runs,
    reconcile: () => call("reconcile"),
    status: () => call("status"),
    close: async () => {
      closed = true;
      connection.close();
    },
  };
}

function abortError(): Error {
  const error = new Error("Wait was aborted");
  error.name = "AbortError";
  return error;
}
