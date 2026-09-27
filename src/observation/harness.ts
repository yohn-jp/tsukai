import type {
  HarnessDecoder,
  HarnessPort,
  HarnessSignal,
} from "../contracts/ports.js";
import type { RuntimeLimits } from "../contracts/limits.js";
import type { JsonObject } from "../contracts/types.js";
import { HarnessProtocolError } from "./errors.js";
import { resolveLimits } from "./limits.js";
import { isRecord, jsonObject, utf8Bytes } from "./json.js";

const NATIVE_EVENT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  prompt_accepted: "harness.prompt_accepted",
  agent_start: "harness.agent_start",
  turn_start: "harness.turn",
  turn_end: "harness.turn",
  message_start: "harness.message",
  message_update: "harness.message",
  message_end: "harness.message",
  tool_execution_start: "harness.tool",
  tool_execution_end: "harness.tool",
  agent_end: "harness.agent_end",
  agent_settled: "harness.agent_settled",
  agent_retry: "harness.retry",
  auto_retry_start: "harness.retry",
  auto_retry_end: "harness.retry",
  compaction_start: "harness.compaction",
  compaction_end: "harness.compaction",
});
const NATIVE_METADATA_FIELDS = [
  "attempt",
  "compactionId",
  "durationMs",
  "eventId",
  "finalStatus",
  "id",
  "messageId",
  "model",
  "provider",
  "retryCount",
  "status",
  "stopReason",
  "toolCallId",
  "toolName",
  "turnId",
  "usage",
  "usageDelta",
] as const;
const MAX_REASON_BYTES = 256;
const REASON = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function protocolError(message: string, code?: string): HarnessProtocolError {
  return new HarnessProtocolError(message, code);
}

function getReportedText(
  event: Record<string, unknown>,
  maxBytes: number,
): string | undefined {
  if (event.type !== "message_end" || !isRecord(event.message))
    return undefined;
  if (
    event.message.role !== "assistant" ||
    !Array.isArray(event.message.content)
  ) {
    return undefined;
  }
  let text = "";
  for (const block of event.message.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text += block.text;
      if (utf8Bytes(text) > maxBytes) {
        throw protocolError(
          "Reported assistant text exceeds the record limit",
          "TEXT_LIMIT",
        );
      }
    }
  }
  return text || undefined;
}

function mapEvent(
  event: Record<string, unknown>,
  maxRecordBytes: number,
  reportedText?: string,
): HarnessSignal[] {
  if (
    typeof event.type !== "string" ||
    event.type.length === 0 ||
    event.type.length > 128
  ) {
    throw protocolError(
      "Pi-shaped event requires a bounded type",
      "INVALID_EVENT",
    );
  }

  const kind = NATIVE_EVENT_KINDS[event.type] ?? "harness.native";
  const native: Record<string, unknown> = { nativeType: event.type };
  for (const key of NATIVE_METADATA_FIELDS) {
    if (key in event) native[key] = event[key];
  }
  let payload: JsonObject;
  try {
    payload = jsonObject({ nativeType: event.type, ...native }, maxRecordBytes);
  } catch (error) {
    throw protocolError(
      `Invalid metadata in ${event.type}: ${error instanceof Error ? error.message : "unknown value"}`,
      "INVALID_EVENT_METADATA",
    );
  }
  const sourceIdentity = event.eventId;
  if (
    sourceIdentity !== undefined &&
    (typeof sourceIdentity !== "string" ||
      sourceIdentity.length === 0 ||
      utf8Bytes(sourceIdentity) > 256)
  ) {
    throw protocolError(
      "Pi eventId must be a bounded non-empty string",
      "INVALID_EVENT_ID",
    );
  }
  const signals: HarnessSignal[] = [
    {
      type: "observation",
      draft: {
        source: "harness",
        kind,
        payload,
        ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      },
    },
  ];

  if (event.type !== "agent_settled" || !("finalStatus" in event))
    return signals;
  const finalStatus = event.finalStatus;
  if (
    finalStatus !== "success" &&
    finalStatus !== "error" &&
    finalStatus !== "abort"
  ) {
    throw protocolError(
      "agent_settled finalStatus must be success, error, or abort",
      "INVALID_STATUS",
    );
  }
  let reason = `agent_settled_${finalStatus}`;
  if (event.reason !== undefined) {
    if (
      typeof event.reason !== "string" ||
      utf8Bytes(event.reason) > MAX_REASON_BYTES ||
      !REASON.test(event.reason)
    ) {
      throw protocolError(
        "agent_settled reason must be a bounded machine-readable code",
        "INVALID_REASON",
      );
    }
    reason = event.reason;
  }
  const settlement: Extract<HarnessSignal, { type: "settlement" }> = {
    type: "settlement",
    status: finalStatus,
    reason,
  };
  if (reportedText !== undefined) settlement.reportedText = reportedText;
  signals.push(settlement);
  return signals;
}

class JsonlMockDecoder implements HarnessDecoder {
  private pending: number[] = [];
  private failed: HarnessProtocolError | undefined;
  private reportedText: string | undefined;
  private readonly limits: RuntimeLimits;
  private finished = false;

  constructor(limits: RuntimeLimits) {
    this.limits = limits;
  }

  push(chunk: Uint8Array): HarnessSignal[] {
    this.assertUsable();
    if (!(chunk instanceof Uint8Array)) {
      return this.fail("Harness input must be Uint8Array", "INVALID_CHUNK");
    }
    if (chunk.byteLength > this.limits.maxQueuedInputBytes) {
      return this.fail(
        "Harness input chunk exceeds queued input limit",
        "INPUT_LIMIT",
      );
    }
    const signals: HarnessSignal[] = [];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const frame = this.pending;
        this.pending = [];
        if (frame.at(-1) === 0x0d) frame.pop();
        signals.push(...this.decodeFrame(frame));
      } else {
        this.pending.push(byte);
        if (this.pending.length > this.limits.maxRecordBytes) {
          return this.fail(
            "Harness JSONL record exceeds record byte limit",
            "RECORD_LIMIT",
          );
        }
        if (this.pending.length > this.limits.maxQueuedInputBytes) {
          return this.fail(
            "Harness JSONL buffer exceeds queued input limit",
            "INPUT_LIMIT",
          );
        }
      }
    }
    return signals;
  }

  finish(): HarnessSignal[] {
    this.assertUsable();
    this.finished = true;
    if (this.pending.length > 0) {
      return this.fail(
        "Truncated final JSONL frame without LF delimiter",
        "TRUNCATED_FRAME",
      );
    }
    return [];
  }

  private decodeFrame(frame: number[]): HarnessSignal[] {
    if (frame.length === 0)
      return this.fail("Empty JSONL record", "EMPTY_RECORD");
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(frame),
      );
    } catch {
      return this.fail(
        "Harness JSONL record is not valid UTF-8",
        "INVALID_UTF8",
      );
    }
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      return this.fail(
        "Harness JSONL record is not valid JSON",
        "INVALID_JSON",
      );
    }
    if (
      !isRecord(record) ||
      record.type !== "pi-event" ||
      !isRecord(record.event)
    ) {
      return this.fail(
        "Expected a pi-event record with an event object",
        "INVALID_RECORD",
      );
    }
    const event = record.event;
    try {
      const text = getReportedText(event, this.limits.maxRecordBytes);
      if (text !== undefined) this.reportedText = text;
      if (
        event.type === "agent_retry" ||
        event.type === "auto_retry_start" ||
        event.type === "compaction_start" ||
        event.type === "turn_start"
      ) {
        this.reportedText = undefined;
      }
      const signals = mapEvent(
        event,
        this.limits.maxRecordBytes,
        event.type === "agent_settled" ? this.reportedText : undefined,
      );
      if (event.type === "agent_settled") {
        this.reportedText = undefined;
        return signals;
      }
      return signals;
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Invalid Pi-shaped event",
        error instanceof HarnessProtocolError ? error.code : "INVALID_EVENT",
      );
    }
  }

  private assertUsable(): void {
    if (this.failed) throw this.failed;
    if (this.finished)
      throw protocolError(
        "Harness decoder is already finished",
        "DECODER_FINISHED",
      );
  }

  private fail(message: string, code?: string): never {
    const error = protocolError(message, code);
    this.failed = error;
    this.pending = [];
    throw error;
  }
}

export function createMockHarness(
  limits: Partial<RuntimeLimits> = {},
): HarnessPort {
  const resolved = resolveLimits(limits);
  return { decoder: () => new JsonlMockDecoder(resolved) };
}
