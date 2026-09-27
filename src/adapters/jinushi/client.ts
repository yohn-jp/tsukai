import { Buffer } from "node:buffer";
import { connect, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

import type {
  JinushiClient,
  JinushiEvent,
  JinushiEventPage,
  JinushiOutputPage,
  JinushiReceipt,
  JinushiRun,
  JinushiRunSpec,
} from "./contract.js";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1 << 20;
const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 65_536;
const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const ignoreSocketError = () => {};
const FINAL_STATES = new Set(["terminal", "uncertain"]);
const DEFINITIVE_RUN_REJECTIONS = new Set([
  "backend-failure",
  "cwd-failure",
  "invalid-request",
  "response-too-large",
  "supervisor-closed",
  "unsupported-capability",
]);
const RUN_STATES = new Set([
  "accepted",
  "starting",
  "running",
  "terminating",
  "reconciling",
  "terminal",
  "uncertain",
]);

export type JinushiClientErrorKind =
  "validation" | "transport" | "protocol" | "remote" | "timeout" | "aborted";

export class JinushiClientError extends Error {
  readonly kind: JinushiClientErrorKind;
  readonly operation: string;
  readonly code: string | undefined;
  readonly ambiguousEffect: boolean;

  constructor(
    message: string,
    details: {
      kind: JinushiClientErrorKind;
      operation: string;
      code?: string;
      ambiguousEffect?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "JinushiClientError";
    this.kind = details.kind;
    this.operation = details.operation;
    this.code = details.code;
    this.ambiguousEffect = details.ambiguousEffect ?? false;
  }
}

export interface JinushiClientOptions {
  /**
   * Maximum response wait in milliseconds for ordinary requests and await.
   * Event-follow lasts until its AbortSignal fires or Jinushi reaches final
   * state; it has no response deadline.
   */
  requestTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type Operation =
  | "capabilities"
  | "run"
  | "input"
  | "close-input"
  | "output"
  | "events"
  | "inspect"
  | "await"
  | "cancel";

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Connect to the local Jinushi supervisor at <stateDir>/jinushi.sock. */
export function createJinushiClient(
  stateDir: string,
  options: JinushiClientOptions = {},
): JinushiClient {
  if (typeof stateDir !== "string" || stateDir.trim().length === 0) {
    throw validationError("client", "stateDir must be a non-empty path");
  }
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      options.requestTimeoutMs > MAX_TIMER_MS)
  ) {
    throw validationError(
      "client",
      "requestTimeoutMs must be a positive safe integer within the timer limit",
    );
  }

  const socketPath = resolve(stateDir, "jinushi.sock");
  const configuredTimeout = options.requestTimeoutMs;

  async function request(
    operation: Operation,
    payload: Record<string, unknown> = {},
    requestOptions: RequestOptions = {},
  ): Promise<JsonObject> {
    const frame = encodeRequest(operation, payload);
    const timeoutMs =
      requestOptions.timeoutMs ??
      (operation === "await" || operation === "events"
        ? configuredTimeout
        : (configuredTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS));
    const raw = await exchange(socketPath, frame, operation, {
      mutation: isMutation(operation),
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return validateResponse(raw, operation);
  }

  return {
    async capabilities() {
      const response = await request("capabilities");
      const caps = objectField(response, "capabilities", "capabilities");
      const backend = stringField(caps, "backend", "capabilities");
      if (backend.length === 0) {
        throw protocolError("capabilities", "capabilities.backend is empty");
      }
      return { backend };
    },

    async run(spec: JinushiRunSpec) {
      validateRunSpec(spec);
      const response = await request("run", { spec: toWireRunSpec(spec) });
      return requiredRun(response, "run", true);
    },

    async input(runId: string, bytes: Uint8Array) {
      validateRunId(runId, "input");
      if (!(bytes instanceof Uint8Array)) {
        throw validationError("input", "bytes must be a Uint8Array");
      }
      if (bytes.byteLength > MAX_INPUT_BYTES) {
        throw validationError(
          "input",
          `input is limited to ${MAX_INPUT_BYTES} bytes by Jinushi protocol v1`,
        );
      }
      const data = Buffer.from(bytes).toString("base64");
      await request("input", { runId, data });
    },

    async closeInput(runId: string) {
      validateRunId(runId, "close-input");
      await request("close-input", { runId });
    },

    async output(
      runId: string,
      stream: "stdout" | "stderr",
      offset: number,
      limit: number,
    ): Promise<JinushiOutputPage> {
      validateRunId(runId, "output");
      if (stream !== "stdout" && stream !== "stderr") {
        throw validationError("output", "stream must be stdout or stderr");
      }
      validateSafeInteger(offset, "output", "offset", 0);
      validateSafeInteger(limit, "output", "limit", 1, MAX_OUTPUT_BYTES);
      const response = await request("output", {
        runId,
        stream,
        offset,
        limit,
      });
      const data = decodeBase64(
        stringField(response, "data", "output", true),
        "output",
      );
      if (data.byteLength > limit || data.byteLength > MAX_OUTPUT_BYTES) {
        throw protocolError(
          "output",
          "Jinushi returned more bytes than the requested limit",
        );
      }
      const page: JinushiOutputPage = {
        data,
        retainedFrom: uint64Field(response, "retainedFrom", "output", true),
        gap: booleanField(response, "gap", "output", true),
      };
      if (response.run !== undefined) {
        page.run = parseRun(response.run, "output", true);
      }
      return page;
    },

    async followEvents(
      runId: string,
      after: number,
      signal: AbortSignal,
      onPage: (page: JinushiEventPage) => Promise<void>,
    ) {
      validateRunId(runId, "events");
      validateSafeInteger(after, "events", "after", 0);
      if (!(signal instanceof AbortSignal)) {
        throw validationError("events", "signal must be an AbortSignal");
      }
      if (typeof onPage !== "function") {
        throw validationError("events", "onPage must be a function");
      }
      if (signal.aborted) return;

      const frame = encodeRequest("events", { runId, after, follow: true });
      await follow(socketPath, frame, runId, after, signal, onPage);
    },

    async inspect(runId: string) {
      validateRunId(runId, "inspect");
      return requiredRun(await request("inspect", { runId }), "inspect", true);
    },

    async await(runId: string, signal?: AbortSignal) {
      validateRunId(runId, "await");
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw validationError("await", "signal must be an AbortSignal");
      }
      const result = requiredRun(
        await request(
          "await",
          { runId },
          signal === undefined ? {} : { signal },
        ),
        "await",
        true,
      );
      if (!FINAL_STATES.has(result.state)) {
        throw protocolError(
          "await",
          "await returned a non-final Run state",
          true,
        );
      }
      return result;
    },

    async cancel(runId: string) {
      validateRunId(runId, "cancel");
      await request("cancel", { runId });
    },
  };
}

function encodeRequest(
  operation: Operation,
  payload: Record<string, unknown>,
): Buffer {
  const json = JSON.stringify({
    version: PROTOCOL_VERSION,
    op: operation,
    ...payload,
  });
  const body = Buffer.from(json, "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) {
    throw validationError(
      operation,
      `request frame must be between 1 and ${MAX_FRAME_BYTES} bytes`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function exchange(
  socketPath: string,
  frame: Buffer,
  operation: Operation,
  options: { mutation: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  if (options.signal?.aborted) {
    return Promise.reject(
      abortedError(operation, "request was aborted before connecting"),
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    let sent = false;
    let buffered = Buffer.alloc(0);
    let expectedBytes: number | undefined;
    let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      fail("timeout", `connecting to Jinushi exceeded ${CONNECT_TIMEOUT_MS}ms`);
    }, CONNECT_TIMEOUT_MS);
    let requestTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const fail = (
      kind: JinushiClientErrorKind,
      message: string,
      cause?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectPromise(
        new JinushiClientError(message, {
          kind,
          operation,
          ambiguousEffect: options.mutation && sent,
          ...(cause === undefined ? {} : { cause }),
        }),
      );
    };

    const onAbort = () =>
      fail("aborted", "request was aborted", options.signal?.reason);
    const onConnect = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      connectTimer = undefined;
      if (options.timeoutMs !== undefined) {
        requestTimer = setTimeout(() => {
          fail(
            "timeout",
            `Jinushi ${operation} response exceeded ${options.timeoutMs}ms`,
          );
        }, options.timeoutMs);
      }
      sent = true;
      socket.write(frame, (error?: Error | null) => {
        if (error)
          fail("transport", `sending Jinushi ${operation} failed`, error);
      });
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      if (buffered.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 4) {
        fail("protocol", "Jinushi response frame exceeds the protocol limit");
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (expectedBytes === undefined && buffered.byteLength >= 4) {
        expectedBytes = buffered.readUInt32BE(0);
        if (expectedBytes === 0 || expectedBytes > MAX_FRAME_BYTES) {
          fail(
            "protocol",
            `invalid Jinushi response frame length ${expectedBytes}`,
          );
          return;
        }
      }
      if (
        expectedBytes === undefined ||
        buffered.byteLength < expectedBytes + 4
      ) {
        return;
      }
      if (buffered.byteLength !== expectedBytes + 4) {
        fail(
          "protocol",
          "Jinushi sent trailing bytes after a single response frame",
        );
        return;
      }
      try {
        const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffered.subarray(4),
          ),
        ) as unknown;
        settled = true;
        cleanup();
        socket.destroy();
        resolvePromise(raw);
      } catch (cause) {
        fail("protocol", "Jinushi response was not valid JSON", cause);
      }
    };
    const onEnd = () =>
      fail(
        "transport",
        "Jinushi closed the connection before a response frame",
      );
    const onClose = () => {
      if (!settled) {
        fail(
          "transport",
          "Jinushi closed the connection before a response frame",
        );
      }
    };
    const onError = (error: Error) =>
      fail("transport", `Jinushi ${operation} connection failed`, error);

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function follow(
  socketPath: string,
  frame: Buffer,
  runId: string,
  after: number,
  signal: AbortSignal,
  onPage: (page: JinushiEventPage) => Promise<void>,
): Promise<void> {
  const operation: Operation = "events";
  const socket = await connectAndSend(socketPath, frame, operation, signal);
  if (signal.aborted) {
    socket.destroy();
    return;
  }
  let lastSeq = after;
  let finalSeen = false;
  let buffered = Buffer.alloc(0);
  let callbackFailed = false;
  const onAbort = () => socket.destroy();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const chunk of socket) {
      if (signal.aborted) return;
      const combined =
        buffered.byteLength === 0
          ? chunk
          : Buffer.concat([buffered, chunk as Buffer]);
      let offset = 0;
      while (combined.byteLength - offset >= 4) {
        const size = combined.readUInt32BE(offset);
        if (size === 0 || size > MAX_FRAME_BYTES) {
          throw protocolError(
            "events",
            `invalid Jinushi event frame length ${size}`,
          );
        }
        const frameBytes = size + 4;
        if (combined.byteLength - offset < frameBytes) break;
        const raw = parseJsonFrame(
          combined.subarray(offset + 4, offset + frameBytes),
          "events",
        );
        offset += frameBytes;
        const response = validateResponse(raw, operation);
        const page = parseEventPage(response, runId, lastSeq);
        if (page.events.length > 0) {
          lastSeq = page.events[page.events.length - 1]!.seq;
        } else if (page.gap && page.retainedFrom > 0) {
          lastSeq = Math.max(lastSeq, page.retainedFrom - 1);
        }
        if (page.run !== undefined && FINAL_STATES.has(page.run.state)) {
          finalSeen = true;
        }
        try {
          await onPage(page);
        } catch (error) {
          callbackFailed = true;
          throw error;
        }
      }
      buffered = Buffer.from(combined.subarray(offset));
      if (buffered.byteLength > MAX_FRAME_BYTES + 3) {
        throw protocolError(
          "events",
          "Jinushi event frame exceeds the protocol limit",
        );
      }
    }
    if (signal.aborted) return;
    if (buffered.byteLength !== 0) {
      throw transportError(
        "events",
        "Jinushi ended in the middle of an event frame",
      );
    }
    if (!finalSeen) {
      throw transportError(
        "events",
        "Jinushi event follow ended before a terminal or uncertain Run observation",
      );
    }
  } catch (error) {
    if (signal.aborted) return;
    if (callbackFailed) throw error;
    if (error instanceof JinushiClientError) throw error;
    if (error instanceof Error && error.name === "AbortError") return;
    throw transportError("events", "Jinushi event follow failed", error);
  } finally {
    signal.removeEventListener("abort", onAbort);
    socket.removeListener("error", ignoreSocketError);
    socket.destroy();
  }
}

function connectAndSend(
  socketPath: string,
  frame: Buffer,
  operation: Operation,
  signal: AbortSignal,
): Promise<Socket> {
  if (signal.aborted) {
    return Promise.reject(abortedError(operation, "event follow was aborted"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ path: socketPath });
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => {
      fail("timeout", `connecting to Jinushi exceeded ${CONNECT_TIMEOUT_MS}ms`);
    }, CONNECT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };
    const fail = (
      kind: JinushiClientErrorKind,
      message: string,
      cause?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectPromise(
        new JinushiClientError(message, {
          kind,
          operation,
          ambiguousEffect: sent,
          ...(cause === undefined ? {} : { cause }),
        }),
      );
    };
    const onAbort = () =>
      fail("aborted", "event follow was aborted", signal.reason);
    const onConnect = () => {
      sent = true;
      socket.write(frame, (error?: Error | null) => {
        if (error) {
          fail(
            "transport",
            "sending Jinushi event follow request failed",
            error,
          );
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        socket.on("error", ignoreSocketError);
        resolvePromise(socket);
      });
    };
    const onError = (error: Error) =>
      fail("transport", "Jinushi event follow connection failed", error);

    socket.on("connect", onConnect);
    socket.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateResponse(raw: unknown, operation: Operation): JsonObject {
  if (!isObject(raw)) {
    throw protocolError(
      operation,
      "Jinushi response must be a JSON object",
      isMutation(operation),
    );
  }
  if (raw.version !== PROTOCOL_VERSION) {
    throw protocolError(
      operation,
      `Jinushi returned unsupported protocol version ${String(raw.version)}`,
      isMutation(operation),
    );
  }
  if (raw.error !== undefined) {
    if (!isObject(raw.error)) {
      throw protocolError(
        operation,
        "Jinushi error response is malformed",
        isMutation(operation),
      );
    }
    const code = raw.error.code;
    const message = raw.error.message;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      typeof message !== "string"
    ) {
      throw protocolError(
        operation,
        "Jinushi error response is malformed",
        isMutation(operation),
      );
    }
    const ambiguousEffect =
      (operation === "run" && !DEFINITIVE_RUN_REJECTIONS.has(code)) ||
      (operation === "input" &&
        (code === "backend-failure" || code === "internal")) ||
      ((operation === "close-input" || operation === "cancel") &&
        (code === "internal" || code === "backend-failure"));
    throw new JinushiClientError(`Jinushi ${operation} failed: ${message}`, {
      kind: "remote",
      operation,
      code,
      ambiguousEffect,
    });
  }
  return raw;
}

function requiredRun(
  response: JsonObject,
  operation: Operation,
  ambiguousEffect: boolean,
): JinushiRun {
  if (response.run === undefined) {
    throw protocolError(
      operation,
      "Jinushi response did not contain a Run",
      ambiguousEffect,
    );
  }
  return parseRun(response.run, operation, ambiguousEffect);
}

function parseRun(
  value: unknown,
  operation: Operation,
  ambiguousEffect: boolean,
): JinushiRun {
  if (!isObject(value)) {
    throw protocolError(
      operation,
      "Jinushi Run must be an object",
      ambiguousEffect,
    );
  }
  const runId = stringField(value, "runId", operation);
  const state = stringField(value, "state", operation);
  if (!RUN_STATES.has(state)) {
    throw protocolError(
      operation,
      `Jinushi Run has unknown state ${state}`,
      ambiguousEffect,
    );
  }
  const output = objectField(value, "output", operation);
  const stdout = objectField(output, "stdout", operation);
  const stderr = objectField(output, "stderr", operation);
  const parsed: JinushiRun = {
    runId,
    state: state as JinushiRun["state"],
    output: {
      stdout: {
        observedBytes: int64Field(stdout, "observedBytes", operation),
        retainedFrom: int64Field(stdout, "retainedFrom", operation),
      },
      stderr: {
        observedBytes: int64Field(stderr, "observedBytes", operation),
        retainedFrom: int64Field(stderr, "retainedFrom", operation),
      },
      historyComplete: booleanField(output, "historyComplete", operation),
    },
  };
  if (value.ownership !== undefined) {
    const ownership = objectField(value, "ownership", operation);
    const backend = stringField(ownership, "backend", operation);
    const pid = optionalSafeInteger(ownership, "pid", operation, 1);
    parsed.ownership = pid === undefined ? { backend } : { backend, pid };
  }
  if (value.receipt !== undefined) {
    parsed.receipt = parseReceipt(
      value.receipt,
      runId,
      operation,
      ambiguousEffect,
    );
  }
  return parsed;
}

function parseReceipt(
  value: unknown,
  runId: string,
  operation: Operation,
  ambiguousEffect: boolean,
): JinushiReceipt {
  if (!isObject(value)) {
    throw protocolError(
      operation,
      "Jinushi terminal receipt must be an object",
      ambiguousEffect,
    );
  }
  const receiptRunId = stringField(value, "runId", operation);
  if (receiptRunId !== runId) {
    throw protocolError(
      operation,
      "Jinushi receipt Run ID does not match its Run",
      ambiguousEffect,
    );
  }
  const receiptOutput = objectField(value, "output", operation);
  const exitCode = optionalSafeInteger(value, "exitCode", operation);
  const signal = optionalString(value, "signal", operation);
  return {
    version: safeIntegerField(value, "version", operation, 1),
    runId: receiptRunId,
    outcome: stringField(value, "outcome", operation),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    forced: booleanField(value, "forced", operation),
    cleanup: stringField(value, "cleanup", operation),
    output: {
      historyComplete: booleanField(
        receiptOutput,
        "historyComplete",
        operation,
      ),
    },
    evidenceIncomplete: booleanField(value, "evidenceIncomplete", operation),
  };
}

function parseEventPage(
  response: JsonObject,
  expectedRunId: string,
  after: number,
): JinushiEventPage {
  const retainedFrom = uint64Field(response, "retainedFrom", "events", true);
  const gap = booleanField(response, "gap", "events", true);
  const page: JinushiEventPage = {
    events: [],
    retainedFrom,
    gap,
  };
  if (response.run !== undefined) {
    page.run = parseRun(response.run, "events", false);
    if (page.run.runId !== expectedRunId) {
      throw protocolError(
        "events",
        "Jinushi follow Run ID does not match the request",
      );
    }
  }
  if (response.events !== undefined) {
    if (!Array.isArray(response.events)) {
      throw protocolError("events", "Jinushi events field must be an array");
    }
    let lastSeq = after;
    page.events = response.events.map((event) => {
      const parsed = parseEvent(event, expectedRunId);
      if (parsed.seq <= lastSeq) {
        throw protocolError("events", "Jinushi event sequence did not advance");
      }
      lastSeq = parsed.seq;
      return parsed;
    });
  }
  return page;
}

function parseEvent(value: unknown, expectedRunId: string): JinushiEvent {
  if (!isObject(value))
    throw protocolError("events", "Jinushi event must be an object");
  const runId = stringField(value, "runId", "events");
  if (runId !== expectedRunId) {
    throw protocolError(
      "events",
      "Jinushi event Run ID does not match the request",
    );
  }
  const version = safeIntegerField(value, "version", "events", 1);
  if (version !== 1) {
    throw protocolError(
      "events",
      `unsupported Jinushi event schema version ${version}`,
    );
  }
  const payload: JinushiEvent["payload"] = {};
  if (value.payload !== undefined) {
    const eventPayload = objectField(value, "payload", "events");
    if (eventPayload.output !== undefined) {
      const output = objectField(eventPayload, "output", "events");
      const stream = stringField(output, "stream", "events");
      if (stream !== "stdout" && stream !== "stderr" && stream !== "pty") {
        throw protocolError(
          "events",
          `unknown Jinushi output stream ${stream}`,
        );
      }
      const bytes = optionalSafeInteger(output, "bytes", "events", 0);
      const observedBytes = optionalSafeInteger(
        output,
        "observedBytes",
        "events",
        0,
      );
      payload.output = {
        stream,
        ...(bytes === undefined ? {} : { bytes }),
        ...(observedBytes === undefined ? {} : { observedBytes }),
      };
    }
  }
  const seq = uint64Field(value, "seq", "events");
  if (seq === 0)
    throw protocolError("events", "Jinushi event sequence must be positive");
  return {
    version,
    runId,
    seq,
    kind: stringField(value, "kind", "events"),
    ...(Object.keys(payload).length === 0 ? {} : { payload }),
  };
}

function validateRunSpec(spec: JinushiRunSpec): void {
  const operation = "run";
  if (!isObject(spec))
    throw validationError(operation, "spec must be an object");
  if (
    !Array.isArray(spec.argv) ||
    spec.argv.length === 0 ||
    spec.argv.length > 256 ||
    spec.argv[0] === undefined ||
    spec.argv[0].length === 0 ||
    spec.argv.some(
      (arg) =>
        typeof arg !== "string" ||
        Buffer.byteLength(arg, "utf8") > 32_768 ||
        arg.includes("\0"),
    )
  ) {
    throw validationError(
      operation,
      "spec.argv must contain a valid executable and at most 256 arguments",
    );
  }
  if (
    typeof spec.cwd !== "string" ||
    !isAbsolute(spec.cwd) ||
    Buffer.byteLength(spec.cwd, "utf8") > 4096
  ) {
    throw validationError(
      operation,
      "spec.cwd must be an absolute path no longer than 4096 bytes",
    );
  }
  if (
    !isObject(spec.environment) ||
    (spec.environment.mode !== "replace" &&
      spec.environment.mode !== "inherit-supervisor")
  ) {
    throw validationError(operation, "spec.environment.mode is unsupported");
  }
  if (spec.environment.set !== undefined) {
    if (
      !isStringRecord(spec.environment.set) ||
      Object.keys(spec.environment.set).length > 128
    ) {
      throw validationError(
        operation,
        "spec.environment.set must contain at most 128 string entries",
      );
    }
    for (const [key, value] of Object.entries(spec.environment.set)) {
      if (
        key.length === 0 ||
        Buffer.byteLength(key, "utf8") > 256 ||
        key.includes("=") ||
        key.includes("\0") ||
        Buffer.byteLength(value, "utf8") > 32_768 ||
        value.includes("\0")
      ) {
        throw validationError(
          operation,
          "spec.environment.set contains an invalid entry",
        );
      }
    }
  }
  if (
    spec.environment.unset !== undefined &&
    (!Array.isArray(spec.environment.unset) ||
      spec.environment.unset.length > 128 ||
      spec.environment.unset.some((key) => typeof key !== "string"))
  ) {
    throw validationError(
      operation,
      "spec.environment.unset must contain at most 128 strings",
    );
  }
  for (const key of spec.environment.unset ?? []) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 256 ||
      key.includes("=") ||
      key.includes("\0")
    ) {
      throw validationError(
        operation,
        "spec.environment.unset contains an invalid key",
      );
    }
  }
  if (spec.interactive !== false) {
    throw validationError(
      operation,
      "production Pi Runs must use non-interactive stdio",
    );
  }
  if (!isObject(spec.lifetime) || spec.lifetime.mode !== "detached") {
    throw validationError(operation, "spec.lifetime.mode must be detached");
  }
  if (spec.limits !== undefined) {
    if (!isObject(spec.limits))
      throw validationError(operation, "spec.limits must be an object");
    if (spec.limits.outputBytes !== undefined) {
      validateSafeInteger(
        spec.limits.outputBytes,
        operation,
        "limits.outputBytes",
        0,
      );
    }
    if (spec.limits.wallTimeMs !== undefined) {
      validateSafeInteger(
        spec.limits.wallTimeMs,
        operation,
        "limits.wallTimeMs",
        0,
      );
    }
  }
  if (
    !isStringRecord(spec.correlation) ||
    Object.keys(spec.correlation).length > 16
  ) {
    throw validationError(
      operation,
      "spec.correlation must contain at most 16 string entries",
    );
  }
  for (const [key, value] of Object.entries(spec.correlation)) {
    if (
      key.length === 0 ||
      Buffer.byteLength(key, "utf8") > 64 ||
      Buffer.byteLength(value, "utf8") > 256
    ) {
      throw validationError(
        operation,
        "spec.correlation contains an invalid label",
      );
    }
  }
}

function toWireRunSpec(spec: JinushiRunSpec): Record<string, unknown> {
  const environment: Record<string, unknown> = { mode: spec.environment.mode };
  if (spec.environment.set !== undefined) {
    environment.set = { ...spec.environment.set };
  }
  if (spec.environment.unset !== undefined) {
    environment.unset = [...spec.environment.unset];
  }
  const limits: Record<string, number> = {};
  if (spec.limits?.outputBytes !== undefined) {
    limits.outputBytes = spec.limits.outputBytes;
  }
  if (spec.limits?.wallTimeMs !== undefined) {
    limits.wallTimeMs = spec.limits.wallTimeMs;
  }
  return {
    argv: [...spec.argv],
    cwd: spec.cwd,
    environment,
    interactive: false,
    lifetime: { mode: "detached" },
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    correlation: { ...spec.correlation },
  };
}

function validateRunId(runId: string, operation: Operation): void {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw validationError(operation, "runId must be a non-empty string");
  }
}

function validateSafeInteger(
  value: number,
  operation: Operation,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validationError(
      operation,
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function objectField(
  object: JsonObject,
  field: string,
  operation: Operation | "client",
): JsonObject {
  const value = object[field];
  if (!isObject(value))
    throw protocolError(operation, `${field} must be an object`);
  return value;
}

function stringField(
  object: JsonObject,
  field: string,
  operation: Operation,
  defaultEmpty = false,
): string {
  const value = object[field];
  if (defaultEmpty && value === undefined) return "";
  if (typeof value !== "string" || (!defaultEmpty && value.length === 0)) {
    throw protocolError(operation, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  object: JsonObject,
  field: string,
  operation: Operation,
): string | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw protocolError(operation, `${field} must be a string when present`);
  }
  return value;
}

function booleanField(
  object: JsonObject,
  field: string,
  operation: Operation,
  defaultFalse = false,
): boolean {
  const value = object[field];
  if (defaultFalse && value === undefined) return false;
  if (typeof value !== "boolean") {
    throw protocolError(operation, `${field} must be a boolean`);
  }
  return value;
}

function safeIntegerField(
  object: JsonObject,
  field: string,
  operation: Operation,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = object[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw protocolError(
      operation,
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function optionalSafeInteger(
  object: JsonObject,
  field: string,
  operation: Operation,
  minimum = Number.MIN_SAFE_INTEGER,
): number | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  return safeIntegerField(object, field, operation, minimum);
}

function int64Field(
  object: JsonObject,
  field: string,
  operation: Operation,
): number {
  return safeIntegerField(object, field, operation, 0);
}

function uint64Field(
  object: JsonObject,
  field: string,
  operation: Operation,
  defaultZero = false,
): number {
  if (defaultZero && object[field] === undefined) return 0;
  return safeIntegerField(object, field, operation, 0);
}

function decodeBase64(value: string, operation: Operation): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw protocolError(
      operation,
      "Jinushi output data is not valid standard base64",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw protocolError(
      operation,
      "Jinushi output data is not canonical base64",
    );
  }
  return new Uint8Array(decoded);
}

function parseJsonFrame(frame: Buffer, operation: Operation): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame),
    ) as unknown;
  } catch (cause) {
    throw protocolError(operation, "Jinushi sent invalid JSON", false, cause);
  }
}

function isMutation(operation: Operation): boolean {
  return (
    operation === "run" ||
    operation === "input" ||
    operation === "close-input" ||
    operation === "cancel"
  );
}

function validationError(
  operation: string,
  message: string,
): JinushiClientError {
  return new JinushiClientError(message, { kind: "validation", operation });
}

function protocolError(
  operation: string,
  message: string,
  ambiguousEffect = false,
  cause?: unknown,
): JinushiClientError {
  return new JinushiClientError(message, {
    kind: "protocol",
    operation,
    ambiguousEffect,
    ...(cause === undefined ? {} : { cause }),
  });
}

function transportError(
  operation: string,
  message: string,
  cause?: unknown,
): JinushiClientError {
  return new JinushiClientError(message, {
    kind: "transport",
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function abortedError(operation: string, message: string): JinushiClientError {
  return new JinushiClientError(message, { kind: "aborted", operation });
}
