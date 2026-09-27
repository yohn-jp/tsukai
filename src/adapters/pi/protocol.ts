import type {
  PiDuplexExecution,
  PiRpcCommand,
  PiRpcResponse,
} from "../../contracts/pi.js";

const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ID_BYTES = 128;
const MAX_TYPE_BYTES = 128;

export interface PiRpcClientOptions {
  maxRecordBytes?: number;
  maxBufferedBytes?: number;
  maxPendingRequests?: number;
  defaultTimeoutMs?: number;
  onFailure?: (error: Error) => void;
}

export interface PiRpcClient {
  request(command: PiRpcCommand, timeoutMs?: number): Promise<PiRpcResponse>;
  push(chunk: Uint8Array): void;
  finish(): void;
  fail(error: Error): void;
  pendingCount(): number;
}

export type PiRpcEventHandler = (
  record: Record<string, unknown>,
  frame: Uint8Array,
) => void;

export class PiRpcProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "PI_RPC_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "PiRpcProtocolError";
  }
}

export class PiRpcTimeoutError extends Error {
  constructor(
    readonly requestId: string,
    timeoutMs: number,
  ) {
    super(`Pi RPC request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "PiRpcTimeoutError";
  }
}

export class PiRpcTransportClosedError extends Error {
  constructor(message = "Pi RPC transport closed") {
    super(message);
    this.name = "PiRpcTransportClosedError";
  }
}

interface PendingRequest {
  command: PiRpcCommand["type"];
  resolve(response: PiRpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResolvedLimits {
  maxRecordBytes: number;
  maxBufferedBytes: number;
  maxPendingRequests: number;
  defaultTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveLimits(
  options: PiRpcClientOptions | undefined,
): ResolvedLimits {
  const maxRecordBytes = positiveInteger(
    options?.maxRecordBytes,
    DEFAULT_MAX_RECORD_BYTES,
    "maxRecordBytes",
  );
  const maxBufferedBytes = positiveInteger(
    options?.maxBufferedBytes,
    DEFAULT_MAX_BUFFERED_BYTES,
    "maxBufferedBytes",
  );
  if (maxRecordBytes > maxBufferedBytes) {
    throw new RangeError("maxRecordBytes cannot exceed maxBufferedBytes");
  }
  return {
    maxRecordBytes,
    maxBufferedBytes,
    maxPendingRequests: positiveInteger(
      options?.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests",
    ),
    defaultTimeoutMs: positiveInteger(
      options?.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    ),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Pi RPC transport failed");
}

function validateCommand(command: PiRpcCommand): PiRpcCommand {
  if (!isRecord(command)) {
    throw new TypeError("Pi RPC command must be an object");
  }
  if (
    command.type !== "get_state" &&
    command.type !== "prompt" &&
    command.type !== "abort"
  ) {
    throw new TypeError("Unsupported Pi RPC command type");
  }
  if (command.type === "prompt") {
    if (typeof command.message !== "string") {
      throw new TypeError("Pi RPC prompt command requires a string message");
    }
    return { type: "prompt", message: command.message };
  }
  return { type: command.type };
}

/**
 * Creates the single writer and response correlator for one injected Pi
 * execution. `frame` delivered to `onEvent` is the original record bytes,
 * including its LF delimiter and any CR before the LF.
 */
export function createPiRpcClient(
  execution: PiDuplexExecution,
  onEvent: PiRpcEventHandler,
  options?: PiRpcClientOptions,
): PiRpcClient {
  const limits = resolveLimits(options);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const pending = new Map<string, PendingRequest>();
  let buffered: number[] = [];
  let nextId = 0n;
  let terminalError: Error | undefined;
  let writeChain: Promise<void> = Promise.resolve();
  let queuedWrites = 0;

  const clearPending = (error: Error, report = false): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    buffered = [];
    if (report) options?.onFailure?.(error);
  };

  const protocolFailure = (message: string, code?: string): void => {
    clearPending(new PiRpcProtocolError(message, code), true);
  };

  const validateResponse = (
    record: Record<string, unknown>,
    id: string,
    expected: PiRpcCommand["type"],
  ): PiRpcResponse => {
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      utf8Length(record.id) > MAX_ID_BYTES
    ) {
      throw new PiRpcProtocolError(
        "Pi RPC response requires a bounded non-empty id",
        "INVALID_RESPONSE_ID",
      );
    }
    if (
      record.command !== "get_state" &&
      record.command !== "prompt" &&
      record.command !== "abort"
    ) {
      throw new PiRpcProtocolError(
        "Pi RPC response has an unsupported command",
        "INVALID_RESPONSE_COMMAND",
      );
    }
    if (record.command !== expected) {
      throw new PiRpcProtocolError(
        "Pi RPC response command does not match its request",
        "RESPONSE_COMMAND_MISMATCH",
      );
    }
    if (typeof record.success !== "boolean") {
      throw new PiRpcProtocolError(
        "Pi RPC response requires a boolean success field",
        "INVALID_RESPONSE_SUCCESS",
      );
    }
    if (record.error !== undefined && typeof record.error !== "string") {
      throw new PiRpcProtocolError(
        "Pi RPC response error must be a string when present",
        "INVALID_RESPONSE_ERROR",
      );
    }
    return {
      id,
      type: "response",
      command: record.command,
      success: record.success,
      ...(Object.hasOwn(record, "data") ? { data: record.data } : {}),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  };

  const decodeFrame = (rawRecord: Uint8Array): void => {
    const contentLength =
      rawRecord.at(-1) === 0x0d
        ? rawRecord.byteLength - 1
        : rawRecord.byteLength;
    const content = rawRecord.subarray(0, contentLength);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(content)) as unknown;
    } catch {
      throw new PiRpcProtocolError(
        "Pi RPC record is not valid UTF-8 JSON",
        "MALFORMED_RECORD",
      );
    }
    if (!isRecord(parsed)) {
      throw new PiRpcProtocolError(
        "Pi RPC record must be a JSON object",
        "INVALID_RECORD",
      );
    }
    if (
      typeof parsed.type !== "string" ||
      parsed.type.length === 0 ||
      utf8Length(parsed.type) > MAX_TYPE_BYTES
    ) {
      throw new PiRpcProtocolError(
        "Pi RPC record requires a bounded type",
        "INVALID_RECORD_TYPE",
      );
    }

    if (parsed.type === "response") {
      if (typeof parsed.id !== "string") {
        throw new PiRpcProtocolError(
          "Pi RPC response requires an id",
          "INVALID_RESPONSE_ID",
        );
      }
      const request = pending.get(parsed.id);
      if (request === undefined) {
        throw new PiRpcProtocolError(
          "Pi RPC response has an unknown or duplicate id",
          "UNKNOWN_RESPONSE_ID",
        );
      }
      const response = validateResponse(parsed, parsed.id, request.command);
      clearTimeout(request.timer);
      pending.delete(parsed.id);
      request.resolve(response);
      return;
    }

    const frame = new Uint8Array(rawRecord.byteLength + 1);
    frame.set(rawRecord);
    frame[frame.byteLength - 1] = 0x0a;
    onEvent(parsed, frame);
  };

  const processRecord = (): void => {
    const rawRecord = Uint8Array.from(buffered);
    buffered = [];
    decodeFrame(rawRecord);
  };

  const request = (
    rawCommand: PiRpcCommand,
    timeoutMs?: number,
  ): Promise<PiRpcResponse> => {
    let command: PiRpcCommand;
    try {
      command = validateCommand(rawCommand);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    if (terminalError !== undefined) return Promise.reject(terminalError);
    if (pending.size >= limits.maxPendingRequests) {
      return Promise.reject(
        new PiRpcProtocolError(
          "Pi RPC pending request limit reached",
          "PENDING_LIMIT",
        ),
      );
    }
    if (queuedWrites >= limits.maxPendingRequests) {
      return Promise.reject(
        new PiRpcProtocolError(
          "Pi RPC write queue limit reached",
          "WRITE_QUEUE_LIMIT",
        ),
      );
    }
    let duration: number;
    try {
      duration = positiveInteger(
        timeoutMs,
        limits.defaultTimeoutMs,
        "timeoutMs",
      );
    } catch (error) {
      return Promise.reject(asError(error));
    }

    const id = `tsukai-${nextId++}`;
    let encoded: Uint8Array;
    try {
      const envelope = {
        id,
        type: command.type,
        ...(command.type === "prompt" ? { message: command.message } : {}),
      };
      const json = JSON.stringify(envelope);
      encoded = encoder.encode(`${json}\n`);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    if (encoded.byteLength - 1 > limits.maxRecordBytes) {
      return Promise.reject(
        new PiRpcProtocolError(
          "Encoded Pi RPC command exceeds record byte limit",
          "OUTGOING_RECORD_LIMIT",
        ),
      );
    }

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = pending.get(id);
        if (current === undefined) return;
        pending.delete(id);
        current.reject(new PiRpcTimeoutError(id, duration));
      }, duration);
      pending.set(id, {
        command: command.type,
        resolve,
        reject,
        timer,
      });

      queuedWrites += 1;
      const write = writeChain.then(async () => {
        try {
          if (terminalError !== undefined) throw terminalError;
          if (!pending.has(id)) return;
          await execution.write(encoded);
        } finally {
          queuedWrites -= 1;
        }
      });
      writeChain = write.catch((error: unknown) => {
        clearPending(asError(error), true);
      });
    });
  };

  const push = (chunk: Uint8Array): void => {
    if (terminalError !== undefined) return;
    if (!(chunk instanceof Uint8Array)) {
      protocolFailure(
        "Pi RPC stdout chunk must be Uint8Array",
        "INVALID_CHUNK",
      );
      return;
    }
    if (chunk.byteLength > limits.maxBufferedBytes) {
      protocolFailure(
        "Pi RPC stdout chunk exceeds buffered byte limit",
        "BUFFER_LIMIT",
      );
      return;
    }

    try {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          processRecord();
          if (terminalError !== undefined) return;
          continue;
        }
        buffered.push(byte);
        if (buffered.length > limits.maxRecordBytes) {
          throw new PiRpcProtocolError(
            "Pi RPC record exceeds record byte limit",
            "RECORD_LIMIT",
          );
        }
        if (buffered.length > limits.maxBufferedBytes) {
          throw new PiRpcProtocolError(
            "Pi RPC buffered input exceeds byte limit",
            "BUFFER_LIMIT",
          );
        }
      }
    } catch (error) {
      clearPending(asError(error), true);
    }
  };

  return {
    request,
    push,
    finish() {
      if (terminalError !== undefined) return;
      if (buffered.length > 0) {
        protocolFailure(
          "Pi RPC transport ended with an unterminated record",
          "UNTERMINATED_RECORD",
        );
        return;
      }
      clearPending(
        new PiRpcTransportClosedError("Pi RPC transport reached EOF"),
      );
    },
    fail(error) {
      clearPending(asError(error));
    },
    pendingCount() {
      return pending.size;
    },
  };
}
