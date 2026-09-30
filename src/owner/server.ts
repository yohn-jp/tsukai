import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { DurableStore } from "../contracts/durable.js";
import type { RunService } from "../contracts/service.js";
import type { RunCreateInput } from "../contracts/types.js";
import { RunNotFoundError, WaitTimeoutError } from "../contracts/types.js";
import { createFileDurableStore } from "../durable/file-store.js";
import {
  AGENT_OPERATIONS,
  createAgentSurface,
  openAgentGrantStore,
  type AgentPrincipal,
} from "./agent.js";
import {
  createFrameReader,
  DEFAULT_MAX_FRAME_BYTES,
  OWNER_PROTOCOL_VERSION,
  OWNER_SOCKET_NAME,
  OWNER_TOKEN_NAME,
  OwnerError,
  type OwnerErrorCode,
  type OwnerRequest,
  type OwnerResponse,
} from "./protocol.js";
import { assertPosix, assertPrivateDirectory } from "./security.js";

/** Any harness-specific RunService: its own validator guards `create`. */
export type OwnerService = RunService<never, never>;

export interface ResidentOwnerOptions {
  /** Private directory holding the durable store, socket, and access token. */
  stateDir: string;
  /** Builds the one canonical service over the durable store. */
  createService(store: DurableStore): OwnerService | Promise<OwnerService>;
  maxConnections?: number;
  maxFrameBytes?: number;
  maxRequestsPerConnection?: number;
  helloTimeoutMs?: number;
  /**
   * Retry interval for runs whose backend evidence was unavailable
   * (reconciling/uncertain). 0 disables the timer; explicit `reconcile` still works.
   */
  reconcileIntervalMs?: number;
  fsync?: boolean;
}

export interface ResidentOwner {
  readonly socketPath: string;
  readonly pid: number;
  /** `detach` (default) leaves physical executions running across owner exit. */
  close(mode?: "detach" | "dispose"): Promise<void>;
}

const MAX_WAIT_TIMEOUT_MS = 2_147_483_647;

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new OwnerError("INVALID_REQUEST", `${name} must be a bounded string`);
  }
  return value;
}

function optInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OwnerError(
      "INVALID_REQUEST",
      `${name} must be a non-negative integer`,
    );
  }
  return value as number;
}

function optString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

function classify(error: unknown): { code: OwnerErrorCode; message: string } {
  if (error instanceof OwnerError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RunNotFoundError) {
    return { code: "RUN_NOT_FOUND", message: error.message };
  }
  if (error instanceof WaitTimeoutError) {
    return { code: "WAIT_TIMEOUT", message: error.message };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { code: "INVALID_REQUEST", message: error.message };
  }
  // Internal details (paths, stacks) never cross the IPC boundary.
  return { code: "INTERNAL", message: "Owner request failed" };
}

/**
 * Starts the canonical in-machine AgentRun authority: one durable RunService
 * behind an access-controlled Unix-domain socket. There is no TCP/HTTP listener.
 */
export async function startResidentOwner(
  options: ResidentOwnerOptions,
): Promise<ResidentOwner> {
  assertPosix();
  const stateDir = options.stateDir;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(stateDir);
  const maxConnections = options.maxConnections ?? 64;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxRequests = options.maxRequestsPerConnection ?? 32;
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  const socketPath = join(stateDir, OWNER_SOCKET_NAME);
  const tokenPath = join(stateDir, OWNER_TOKEN_NAME);

  // The store lock is the single-owner guarantee: a second live owner over
  // the same state fails here before it can touch the socket or any run.
  const store = createFileDurableStore({
    dir: join(stateDir, "store"),
    ...(options.fsync === undefined ? {} : { fsync: options.fsync }),
  });
  let service: OwnerService | undefined;
  try {
    service = await options.createService(store);
    await service.reconcile();
  } catch (error) {
    // Leave any Jinushi-owned execution running; only stop observing.
    await service?.detach().catch(() => undefined);
    store.close();
    throw error;
  }
  const canonical: OwnerService = service;
  const grants = openAgentGrantStore(join(stateDir, "authz"), (runId) => {
    try {
      return canonical.runs.get(runId).lifecycle !== "terminal";
    } catch {
      return false;
    }
  });
  const agent = createAgentSurface(canonical, grants);

  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token, "utf8");
  writeFileSync(`${tokenPath}.tmp`, `${token}\n`, { mode: 0o600 });
  renameSync(`${tokenPath}.tmp`, tokenPath);

  try {
    unlinkSync(socketPath); // stale socket of a dead owner
  } catch {
    /* none */
  }
  const sockets = new Set<Socket>();
  const startedAt = new Date().toISOString();

  const server: Server = createServer((socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let authed = false;
    /** Set for a scoped agent connection; absent means full operator authority. */
    let principal: AgentPrincipal | undefined;
    let inFlight = 0;
    const aborts = new Set<AbortController>();
    const streams = new Map<number, AbortController>();
    const hello = setTimeout(() => socket.destroy(), helloTimeoutMs);
    hello.unref();
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(hello);
      sockets.delete(socket);
      for (const abort of aborts) abort.abort();
    });

    let rejected = false;
    /** Protocol violation: flush the error, then stop reading this peer. */
    const reject = (response: OwnerResponse): void => {
      if (rejected) return;
      rejected = true;
      send(response);
      socket.end();
    };
    const send = (response: OwnerResponse): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    };
    const fail = (id: number, error: unknown): void =>
      send({ id, ok: false, error: classify(error) });

    const handleAgent = async (
      request: OwnerRequest,
      who: AgentPrincipal,
    ): Promise<void> => {
      const { id, op } = request;
      if (op === "agent_spawn") {
        const spec = request.input;
        if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
          throw new OwnerError("INVALID_REQUEST", "input must be an object");
        }
        send({
          id,
          ok: true,
          result: await agent.spawn(who, spec as Record<string, unknown>),
        });
        return;
      }
      const agentRunId = text(request.agentRunId, "agentRunId");
      if (op === "agent_status") {
        send({ id, ok: true, result: agent.status(who, agentRunId) });
      } else if (op === "agent_result") {
        send({ id, ok: true, result: agent.result(who, agentRunId) });
      } else if (op === "agent_cancel") {
        send({ id, ok: true, result: await agent.cancel(who, agentRunId) });
      } else {
        const timeoutMs = optInt(request.timeoutMs, "timeoutMs");
        if (timeoutMs !== undefined && timeoutMs > MAX_WAIT_TIMEOUT_MS) {
          throw new OwnerError("INVALID_REQUEST", "timeoutMs is too large");
        }
        // Waiter abort or disconnect ends only this wait, never the AgentRun.
        const abort = new AbortController();
        aborts.add(abort);
        streams.set(id, abort);
        try {
          send({
            id,
            ok: true,
            result: await agent.wait(who, agentRunId, {
              signal: abort.signal,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }),
          });
        } finally {
          aborts.delete(abort);
          streams.delete(id);
        }
      }
    };

    const handle = async (request: OwnerRequest): Promise<void> => {
      const { id, op } = request;
      if (op === "hello") {
        const presentedText = String(request.token ?? "");
        const presented = Buffer.from(presentedText, "utf8");
        const isOperator =
          presented.length === tokenBytes.length &&
          timingSafeEqual(presented, tokenBytes);
        const agentIdentity = isOperator
          ? undefined
          : grants.authenticate(presentedText);
        if (!isOperator && agentIdentity === undefined) {
          send({
            id,
            ok: false,
            error: { code: "UNAUTHENTICATED", message: "Invalid owner token" },
          });
          socket.end();
          return;
        }
        authed = true;
        if (agentIdentity !== undefined) {
          principal = {
            principalRunId: agentIdentity.principalRunId,
            hash: agentIdentity.hash,
          };
        }
        clearTimeout(hello);
        send({
          id,
          ok: true,
          result: {
            protocol: OWNER_PROTOCOL_VERSION,
            pid: process.pid,
            role: principal === undefined ? "operator" : "agent",
          },
        });
        return;
      }
      if (!authed) {
        send({
          id,
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "Authenticate first" },
        });
        socket.end();
        return;
      }
      const runs = canonical.runs;
      if (principal !== undefined) {
        // A scoped agent connection reaches only its own five operations.
        if (op === "cancel-request") {
          streams.get(Number(request.target))?.abort();
          send({ id, ok: true, result: null });
          return;
        }
        if (!(AGENT_OPERATIONS as readonly string[]).includes(op)) {
          throw new OwnerError(
            "FORBIDDEN",
            "Operation requires operator authority",
          );
        }
        await handleAgent(request, principal);
        return;
      }
      if ((AGENT_OPERATIONS as readonly string[]).includes(op)) {
        throw new OwnerError(
          "FORBIDDEN",
          "Operation requires an agent credential",
        );
      }
      switch (op) {
        case "agent-grant": {
          const agentRunId = text(request.agentRunId, "agentRunId");
          if (runs.get(agentRunId).lifecycle === "terminal") {
            throw new OwnerError(
              "INVALID_REQUEST",
              "Cannot grant control to a terminal AgentRun",
            );
          }
          send({
            id,
            ok: true,
            result: { agentRunId, ...grants.issue(agentRunId) },
          });
          return;
        }
        case "agent-revoke":
          send({
            id,
            ok: true,
            result: {
              revoked: grants.revoke(text(request.agentRunId, "agentRunId")),
            },
          });
          return;
        case "create":
          if (
            (request.input as { spawnedBy?: unknown } | null)?.spawnedBy !==
            undefined
          ) {
            throw new OwnerError(
              "INVALID_REQUEST",
              "spawnedBy is owner-internal",
            );
          }
          send({
            id,
            ok: true,
            result: await runs.create(
              request.input as RunCreateInput<never, never>,
            ),
          });
          return;
        case "get":
          send({
            id,
            ok: true,
            result: runs.get(text(request.agentRunId, "agentRunId")),
          });
          return;
        case "list": {
          const cursor = optString(request.cursor, "cursor");
          const limit = optInt(request.limit, "limit");
          send({
            id,
            ok: true,
            result: runs.list({
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit }),
            }),
          });
          return;
        }
        case "children": {
          const cursor = optString(request.cursor, "cursor");
          const limit = optInt(request.limit, "limit");
          send({
            id,
            ok: true,
            result: runs.children(text(request.parentRunId, "parentRunId"), {
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit }),
            }),
          });
          return;
        }
        case "wait": {
          const timeoutMs = optInt(request.timeoutMs, "timeoutMs");
          if (timeoutMs !== undefined && timeoutMs > MAX_WAIT_TIMEOUT_MS) {
            throw new OwnerError("INVALID_REQUEST", "timeoutMs is too large");
          }
          // A disconnecting client cancels only its waiter, never the run.
          const abort = new AbortController();
          aborts.add(abort);
          streams.set(id, abort);
          try {
            send({
              id,
              ok: true,
              result: await runs.wait(text(request.agentRunId, "agentRunId"), {
                signal: abort.signal,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
              }),
            });
          } finally {
            aborts.delete(abort);
            streams.delete(id);
          }
          return;
        }
        case "cancel":
          send({
            id,
            ok: true,
            result: await runs.cancel(text(request.agentRunId, "agentRunId")),
          });
          return;
        case "result":
          send({
            id,
            ok: true,
            result: runs.result(text(request.agentRunId, "agentRunId")),
          });
          return;
        case "events": {
          const afterSeq = optInt(request.afterSeq, "afterSeq");
          const stream = runs.events(
            text(request.agentRunId, "agentRunId"),
            afterSeq,
          );
          const abort = new AbortController();
          aborts.add(abort);
          streams.set(id, abort);
          try {
            const iterator = stream[Symbol.asyncIterator]();
            abort.signal.addEventListener(
              "abort",
              () => void iterator.return?.(),
              {
                once: true,
              },
            );
            for (;;) {
              const next = await iterator.next();
              if (next.done || abort.signal.aborted) break;
              send({ id, ok: true, event: next.value });
              if (socket.writableNeedDrain) {
                await new Promise<void>((resolve) =>
                  socket.once("drain", resolve),
                );
              }
            }
            send({ id, ok: true, done: true });
          } finally {
            aborts.delete(abort);
            streams.delete(id);
          }
          return;
        }
        case "cancel-request":
          streams.get(Number(request.target))?.abort();
          send({ id, ok: true, result: null });
          return;
        case "reconcile":
          send({ id, ok: true, result: await canonical.reconcile() });
          return;
        case "status":
          send({
            id,
            ok: true,
            result: {
              protocol: OWNER_PROTOCOL_VERSION,
              pid: process.pid,
              startedAt,
              connections: sockets.size,
              storeIssues: [
                ...store.issues(),
                ...(grants.corrupt === undefined
                  ? []
                  : [{ entry: "authz/grants.json", reason: grants.corrupt }]),
              ],
            },
          });
          return;
        default:
          throw new OwnerError("INVALID_REQUEST", "Unknown operation");
      }
    };

    const reader = createFrameReader(
      maxFrameBytes,
      (frame) => {
        let request: OwnerRequest;
        try {
          const parsed = JSON.parse(frame) as unknown;
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            !Number.isSafeInteger((parsed as { id?: unknown }).id) ||
            typeof (parsed as { op?: unknown }).op !== "string"
          ) {
            throw new OwnerError("INVALID_REQUEST", "Malformed request");
          }
          request = parsed as OwnerRequest;
        } catch (error) {
          reject({
            id: 0,
            ok: false,
            error:
              error instanceof OwnerError
                ? classify(error)
                : { code: "INVALID_REQUEST", message: "Malformed request" },
          });
          return;
        }
        if (inFlight >= maxRequests) {
          send({
            id: request.id,
            ok: false,
            error: {
              code: "OWNER_BUSY",
              message: "Too many concurrent requests",
            },
          });
          return;
        }
        inFlight += 1;
        void handle(request)
          .catch((error: unknown) => fail(request.id, error))
          .finally(() => {
            inFlight -= 1;
          });
      },
      (error) => {
        reject({ id: 0, ok: false, error: classify(error) });
      },
    );
    socket.on("data", (chunk: Buffer) => {
      if (!rejected) reader(chunk);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    await canonical.detach().catch(() => undefined);
    throw error;
  }

  const interval = options.reconcileIntervalMs ?? 30_000;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  if (interval > 0) {
    reconcileTimer = setInterval(() => {
      // Only unattached runs are touched; a failed pass is retried next tick.
      void canonical.reconcile().catch(() => undefined);
    }, interval);
    reconcileTimer.unref();
  }

  let closing: Promise<void> | undefined;
  return {
    socketPath,
    pid: process.pid,
    close(mode = "detach"): Promise<void> {
      closing ??= (async () => {
        if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        for (const path of [socketPath, tokenPath]) {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        }
        if (mode === "dispose") await canonical.dispose();
        else await canonical.detach();
      })();
      return closing;
    },
  };
}
