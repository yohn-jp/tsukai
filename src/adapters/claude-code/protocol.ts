import type { DuplexExecution } from "../../contracts/harness.js";

const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_PENDING_CONTROLS = 16;
const MAX_TYPE_BYTES = 128;
const MAX_ID_BYTES = 128;

export class ClaudeCodeProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "CLAUDE_CODE_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "ClaudeCodeProtocolError";
  }
}

export class ClaudeCodeTransportClosedError extends Error {
  constructor(message = "Claude Code stream-json transport closed") {
    super(message);
    this.name = "ClaudeCodeTransportClosedError";
  }
}

export interface ClaudeCodeRecordMeta {
  /** Stdout offset of the first byte of this record. */
  start: number;
  /** Stdout offset just after this record's LF. */
  end: number;
  /** Produced before `replayUntil` (an earlier owner already applied it). */
  historical: boolean;
}

export type ClaudeCodeEventHandler = (
  record: Record<string, unknown>,
  frame: Uint8Array,
  meta: ClaudeCodeRecordMeta,
) => void;

export interface ClaudeCodeClientOptions {
  maxRecordBytes?: number;
  maxBufferedBytes?: number;
  onFailure?: (error: Error) => void;
  /** Resume only: records ending at or before this offset are historical. */
  replayUntil?: number;
  /** Called after each complete record is fully applied. */
  onRecordEnd?: (end: number) => void;
}

export interface ClaudeCodeControlResult {
  subtype: "success" | "error";
}

/**
 * The single writer and control correlator for one Claude Code stream-json
 * execution. Only two outgoing records exist: the run's one user message and
 * the `interrupt` control request. Incoming `control_response` records resolve
 * pending controls; every other record is delivered to `onEvent`.
 */
export interface ClaudeCodeClient {
  sendUserMessage(prompt: string): Promise<void>;
  interrupt(timeoutMs: number): Promise<ClaudeCodeControlResult>;
  push(chunk: Uint8Array): void;
  finish(): void;
  fail(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createClaudeCodeClient(
  execution: DuplexExecution,
  onEvent: ClaudeCodeEventHandler,
  options: ClaudeCodeClientOptions = {},
): ClaudeCodeClient {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxBufferedBytes =
    options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const replayUntil = options.replayUntil ?? 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const pending = new Map<
    string,
    {
      resolve: (value: ClaudeCodeControlResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let buffered: number[] = [];
  let position = 0;
  let recordStart = 0;
  let nextId = 0;
  let terminalError: Error | undefined;
  let userMessageSent = false;
  let writeChain: Promise<void> = Promise.resolve();

  const clear = (error: Error, report: boolean): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    buffered = [];
    if (report) options.onFailure?.(error);
  };

  const write = (record: object): Promise<void> => {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    const encoded = encoder.encode(`${JSON.stringify(record)}\n`);
    if (encoded.byteLength - 1 > maxRecordBytes) {
      return Promise.reject(
        new ClaudeCodeProtocolError(
          "Encoded Claude Code record exceeds record byte limit",
          "OUTGOING_RECORD_LIMIT",
        ),
      );
    }
    const next = writeChain.then(() => {
      if (terminalError !== undefined) throw terminalError;
      return execution.write(encoded);
    });
    writeChain = next.catch((error: unknown) => {
      clear(asError(error), true);
    });
    return next;
  };

  const decodeFrame = (raw: Uint8Array, start: number, end: number): void => {
    const length = raw.at(-1) === 0x0d ? raw.byteLength - 1 : raw.byteLength;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(raw.subarray(0, length))) as unknown;
    } catch {
      throw new ClaudeCodeProtocolError(
        "Claude Code record is not valid UTF-8 JSON",
        "MALFORMED_RECORD",
      );
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.type !== "string" ||
      parsed.type.length === 0 ||
      utf8Length(parsed.type) > MAX_TYPE_BYTES
    ) {
      throw new ClaudeCodeProtocolError(
        "Claude Code record requires a bounded type",
        "INVALID_RECORD_TYPE",
      );
    }
    const historical = end <= replayUntil;
    if (parsed.type === "control_response") {
      const response = parsed.response;
      if (
        !isRecord(response) ||
        typeof response.request_id !== "string" ||
        utf8Length(response.request_id) > MAX_ID_BYTES ||
        (response.subtype !== "success" && response.subtype !== "error")
      ) {
        throw new ClaudeCodeProtocolError(
          "Claude Code control_response is malformed",
          "INVALID_CONTROL_RESPONSE",
        );
      }
      // A response to an earlier owner's control resolves nothing here.
      const request = historical ? undefined : pending.get(response.request_id);
      if (request === undefined) {
        if (historical) return;
        throw new ClaudeCodeProtocolError(
          "Claude Code control_response has an unknown request_id",
          "UNKNOWN_CONTROL_RESPONSE",
        );
      }
      clearTimeout(request.timer);
      pending.delete(response.request_id);
      request.resolve({ subtype: response.subtype });
      return;
    }
    if (parsed.type === "keep_alive") return;
    const frame = new Uint8Array(raw.byteLength + 1);
    frame.set(raw);
    frame[frame.byteLength - 1] = 0x0a;
    onEvent(parsed, frame, { start, end, historical });
  };

  return {
    sendUserMessage(prompt: string): Promise<void> {
      if (userMessageSent) {
        return Promise.reject(
          new ClaudeCodeProtocolError(
            "An AgentRun submits exactly one Claude Code user message",
            "PROMPT_ALREADY_SENT",
          ),
        );
      }
      userMessageSent = true;
      return write({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: "",
      });
    },
    interrupt(timeoutMs: number): Promise<ClaudeCodeControlResult> {
      if (terminalError !== undefined) return Promise.reject(terminalError);
      if (pending.size >= MAX_PENDING_CONTROLS) {
        return Promise.reject(
          new ClaudeCodeProtocolError(
            "Claude Code pending control limit reached",
            "PENDING_LIMIT",
          ),
        );
      }
      const requestId = `tsukai-${nextId++}`;
      return new Promise<ClaudeCodeControlResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          reject(
            new ClaudeCodeProtocolError(
              `Claude Code control ${requestId} timed out`,
              "CONTROL_TIMEOUT",
            ),
          );
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        write({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "interrupt" },
        }).catch((error: unknown) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer);
          reject(asError(error));
        });
      });
    },
    push(chunk: Uint8Array): void {
      if (terminalError !== undefined) return;
      try {
        if (!(chunk instanceof Uint8Array)) {
          throw new ClaudeCodeProtocolError(
            "Claude Code stdout chunk must be Uint8Array",
            "INVALID_CHUNK",
          );
        }
        for (const byte of chunk) {
          position += 1;
          if (byte === 0x0a) {
            const raw = Uint8Array.from(buffered);
            const start = recordStart;
            buffered = [];
            recordStart = position;
            decodeFrame(raw, start, position);
            if (terminalError !== undefined) return;
            options.onRecordEnd?.(position);
            continue;
          }
          buffered.push(byte);
          if (buffered.length > maxRecordBytes) {
            throw new ClaudeCodeProtocolError(
              "Claude Code record exceeds record byte limit",
              "RECORD_LIMIT",
            );
          }
          if (buffered.length > maxBufferedBytes) {
            throw new ClaudeCodeProtocolError(
              "Claude Code buffered input exceeds byte limit",
              "BUFFER_LIMIT",
            );
          }
        }
      } catch (error) {
        clear(asError(error), true);
      }
    },
    finish(): void {
      if (terminalError !== undefined) return;
      if (buffered.length > 0) {
        clear(
          new ClaudeCodeProtocolError(
            "Claude Code transport ended with an unterminated record",
            "UNTERMINATED_RECORD",
          ),
          true,
        );
        return;
      }
      clear(new ClaudeCodeTransportClosedError(), false);
    },
    fail(error: Error): void {
      clear(error, false);
    },
  };
}
