import type { RuntimeLimits } from "../../contracts/limits.js";
import type {
  HarnessDecoder,
  HarnessPort,
  HarnessSignal,
} from "../../contracts/ports.js";
import type { JsonObject, JsonValue } from "../../contracts/types.js";
import { HarnessProtocolError } from "../../observation/errors.js";
import { resolveLimits } from "../../observation/limits.js";
import { isRecord, jsonObject, utf8Bytes } from "../../observation/json.js";

const EVENT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  agent_start: "harness.agent_start",
  agent_end: "harness.agent_end",
  agent_settled: "harness.agent_settled",
  turn_start: "harness.turn",
  turn_end: "harness.turn",
  message_start: "harness.message",
  message_update: "harness.message",
  message_end: "harness.message",
  tool_execution_start: "harness.tool",
  tool_execution_update: "harness.tool",
  tool_execution_end: "harness.tool",
  queue_update: "harness.queue",
  compaction_start: "harness.compaction",
  compaction_end: "harness.compaction",
  agent_retry: "harness.retry",
  auto_retry_start: "harness.retry",
  auto_retry_end: "harness.retry",
  summarization_retry_scheduled: "harness.retry",
  summarization_retry_attempt_start: "harness.retry",
  summarization_retry_finished: "harness.retry",
  session_info_changed: "harness.session",
  thinking_level_changed: "harness.config",
});

const ASSISTANT_STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_METADATA_STRING_BYTES = 256;
const MAX_USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "totalTokens",
] as const;
const MAX_COST_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "total",
] as const;

type AssistantStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred"
  | "unsupported";

interface AssistantEvidence {
  stopReason: AssistantStopReason;
  text?: string;
}

type FailureEvidence = "retry_failed" | "compaction_failed";

function protocolError(message: string, code: string): HarnessProtocolError {
  return new HarnessProtocolError(message, code);
}

function optionalBoundedString(
  record: Record<string, unknown>,
  key: string,
  maximum = MAX_METADATA_STRING_BYTES,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > maximum
  ) {
    throw protocolError(
      `Pi ${key} must be a bounded non-empty string`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw protocolError(
      `Pi ${key} must be a boolean`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function optionalNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocolError(
      `Pi ${key} must be a finite non-negative number`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = optionalNonNegativeNumber(record, key);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw protocolError(
      `Pi ${key} must be a positive safe integer`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function appendOptional(
  target: Record<string, JsonValue>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function validateUsage(
  value: unknown,
  field: string,
): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw protocolError(`Pi ${field} must be a usage object`, "INVALID_USAGE");
  }
  const usage: Record<string, JsonValue> = {};
  for (const key of MAX_USAGE_FIELDS) {
    const number = usageNumber(value, key, field);
    appendOptional(usage, key, number);
  }
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) {
      throw protocolError(
        `Pi ${field}.cost must be an object`,
        "INVALID_USAGE",
      );
    }
    const cost: Record<string, JsonValue> = {};
    for (const key of MAX_COST_FIELDS) {
      const number = usageNumber(value.cost, key, `${field}.cost`);
      appendOptional(cost, key, number);
    }
    usage.cost = cost;
  }
  return usage;
}

function usageNumber(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocolError(
      `Pi ${field}.${key} must be a finite non-negative number`,
      "INVALID_USAGE",
    );
  }
  return value;
}

function addUsage(
  target: Record<string, JsonValue>,
  value: unknown,
  field: string,
  scope: string,
): void {
  if (value === undefined) return;
  target.usage = { scope, values: validateUsage(value, field) };
}

function assistantStopReason(
  message: Record<string, unknown>,
): AssistantStopReason {
  const value = message.stopReason;
  return typeof value === "string" && ASSISTANT_STOP_REASONS.has(value)
    ? (value as AssistantStopReason)
    : "unsupported";
}

function textFromAssistantMessage(
  message: Record<string, unknown>,
  maxBytes: number,
): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  let result = "";
  for (const block of message.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      result += block.text;
      if (utf8Bytes(result) > maxBytes) {
        throw protocolError(
          "Final Pi assistant text exceeds the record limit",
          "TEXT_LIMIT",
        );
      }
    }
  }
  return result || undefined;
}

function addMessageMetadata(
  pi: Record<string, JsonValue>,
  message: unknown,
  eventType: string,
): void {
  if (!isRecord(message)) return;
  const role = optionalBoundedString(message, "role", 32);
  if (role === undefined) return;

  if (role === "assistant") {
    const assistant: Record<string, JsonValue> = {};
    assistant.stopReason = assistantStopReason(message);
    for (const field of [
      "api",
      "provider",
      "model",
      "responseModel",
    ] as const) {
      appendOptional(assistant, field, optionalBoundedString(message, field));
    }
    appendOptional(assistant, "endTurn", optionalBoolean(message, "endTurn"));
    if (eventType !== "turn_end") {
      addUsage(
        assistant,
        message.usage,
        "message.usage",
        eventType === "message_end"
          ? "assistant_message_final"
          : "assistant_message_cumulative",
      );
    }
    pi.assistant = assistant;
    return;
  }

  if (role === "toolResult") {
    const toolResult: Record<string, JsonValue> = {};
    appendOptional(
      toolResult,
      "toolName",
      optionalBoundedString(message, "toolName"),
    );
    appendOptional(toolResult, "isError", optionalBoolean(message, "isError"));
    addUsage(toolResult, message.usage, "message.usage", "nested_tool_usage");
    pi.toolResult = toolResult;
    return;
  }

  pi.role = role;
}

function addEventMetadata(
  event: Record<string, unknown>,
  limits: RuntimeLimits,
): JsonObject {
  if (
    typeof event.type !== "string" ||
    utf8Bytes(event.type) > MAX_EVENT_TYPE_BYTES ||
    !EVENT_TYPE.test(event.type)
  ) {
    throw protocolError("Pi event requires a bounded type", "INVALID_EVENT");
  }

  const pi: Record<string, JsonValue> = { nativeType: event.type };
  for (const key of ["attempt", "maxAttempts"] as const) {
    appendOptional(pi, key, optionalPositiveInteger(event, key));
  }
  for (const key of ["delayMs", "durationMs"] as const) {
    appendOptional(pi, key, optionalNonNegativeNumber(event, key));
  }
  for (const key of ["willRetry", "success", "aborted", "isError"] as const) {
    appendOptional(pi, key, optionalBoolean(event, key));
  }
  for (const key of ["toolCallId", "toolName", "level"] as const) {
    appendOptional(pi, key, optionalBoundedString(event, key));
  }

  if (
    event.reason !== undefined &&
    (event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "summarization_retry_attempt_start")
  ) {
    const reason = optionalBoundedString(event, "reason", 32);
    if (!reason || !COMPACTION_REASONS.has(reason)) {
      throw protocolError(
        "Pi reason is not a supported compaction reason",
        "INVALID_EVENT_METADATA",
      );
    }
    pi.reason = reason;
  }
  if (
    event.source !== undefined &&
    event.type === "summarization_retry_attempt_start"
  ) {
    const source = optionalBoundedString(event, "source", 32);
    if (source !== "compaction" && source !== "branchSummary") {
      throw protocolError(
        "Pi retry source is unsupported",
        "INVALID_EVENT_METADATA",
      );
    }
    pi.source = source;
  }

  if (event.message !== undefined) {
    addMessageMetadata(pi, event.message, event.type);
  }
  if (event.type === "message_update") {
    if (event.assistantMessageEvent !== undefined) {
      if (!isRecord(event.assistantMessageEvent)) {
        throw protocolError(
          "Pi assistantMessageEvent must be an object",
          "INVALID_EVENT_METADATA",
        );
      }
      appendOptional(
        pi,
        "updateType",
        optionalBoundedString(event.assistantMessageEvent, "type", 32),
      );
      appendOptional(
        pi,
        "contentIndex",
        optionalNonNegativeNumber(event.assistantMessageEvent, "contentIndex"),
      );
    }
    addUsage(pi, event.usage, "usage", "assistant_message_cumulative");
  }

  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    if (event.messages.length > limits.maxHistoryPerRun) {
      throw protocolError(
        "Pi agent_end message count exceeds history limit",
        "EVENT_LIMIT",
      );
    }
    pi.messageCount = event.messages.length;
  }

  if (event.type === "queue_update") {
    const counts: Record<string, JsonValue> = {};
    for (const key of ["steering", "followUp"] as const) {
      const queue = event[key];
      if (queue === undefined) continue;
      if (!Array.isArray(queue) || queue.length > limits.maxHistoryPerRun) {
        throw protocolError(
          `Pi ${key} queue must be a bounded array`,
          "EVENT_LIMIT",
        );
      }
      counts[key === "steering" ? "steeringCount" : "followUpCount"] =
        queue.length;
    }
    pi.queue = counts;
  }

  if (event.type === "compaction_end" && isRecord(event.result)) {
    const compaction: Record<string, JsonValue> = {};
    appendOptional(
      compaction,
      "tokensBefore",
      optionalNonNegativeNumber(event.result, "tokensBefore"),
    );
    appendOptional(
      compaction,
      "estimatedTokensAfter",
      optionalNonNegativeNumber(event.result, "estimatedTokensAfter"),
    );
    addUsage(
      compaction,
      event.result.usage,
      "result.usage",
      "compaction_summary",
    );
    pi.compaction = compaction;
  }

  try {
    return jsonObject({ pi }, limits.maxRecordBytes);
  } catch (error) {
    throw protocolError(
      `Invalid Pi metadata: ${error instanceof Error ? error.message : "unknown value"}`,
      "INVALID_EVENT_METADATA",
    );
  }
}

function mapPiEvent(
  event: Record<string, unknown>,
  limits: RuntimeLimits,
): HarnessSignal {
  const kind = EVENT_KINDS[event.type as string] ?? "harness.native";
  return {
    type: "observation",
    draft: {
      source: "harness",
      kind,
      payload: addEventMetadata(event, limits),
    },
  };
}

function queueIsNonEmpty(event: Record<string, unknown>): boolean {
  return ["steering", "followUp"].some(
    (key) => Array.isArray(event[key]) && (event[key] as unknown[]).length > 0,
  );
}

class PiSemanticDecoder implements HarnessDecoder {
  private pending: number[] = [];
  private failed: HarnessProtocolError | undefined;
  private finished = false;
  private settled = false;
  private assistantEvidence: AssistantEvidence | undefined;
  private awaitingFinalAssistant = false;
  private failureEvidence: FailureEvidence | undefined;
  private readonly limits: RuntimeLimits;

  constructor(limits: RuntimeLimits) {
    this.limits = limits;
  }

  push(chunk: Uint8Array): HarnessSignal[] {
    this.assertUsable();
    if (!(chunk instanceof Uint8Array)) {
      return this.fail("Pi input must be Uint8Array", "INVALID_CHUNK");
    }
    if (chunk.byteLength > this.limits.maxQueuedInputBytes) {
      return this.fail(
        "Pi input chunk exceeds queued input limit",
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
        continue;
      }
      this.pending.push(byte);
      if (this.pending.length > this.limits.maxRecordBytes) {
        return this.fail(
          "Pi JSONL record exceeds record byte limit",
          "RECORD_LIMIT",
        );
      }
      if (this.pending.length > this.limits.maxQueuedInputBytes) {
        return this.fail(
          "Pi JSONL buffer exceeds queued input limit",
          "INPUT_LIMIT",
        );
      }
    }
    return signals;
  }

  finish(): HarnessSignal[] {
    this.assertUsable();
    this.finished = true;
    if (this.pending.length > 0) {
      return this.fail(
        "Truncated final Pi JSONL frame without LF delimiter",
        "TRUNCATED_FRAME",
      );
    }
    return [];
  }

  private decodeFrame(frame: number[]): HarnessSignal[] {
    if (frame.length === 0)
      return this.fail("Empty Pi JSONL record", "EMPTY_RECORD");

    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(frame),
      );
    } catch {
      return this.fail("Pi JSONL record is not valid UTF-8", "INVALID_UTF8");
    }

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      return this.fail("Pi JSONL record is not valid JSON", "INVALID_JSON");
    }
    if (!isRecord(record) || typeof record.type !== "string") {
      return this.fail(
        "Pi JSONL record must be an event object",
        "INVALID_RECORD",
      );
    }
    if (record.type === "response") {
      return this.fail(
        "RPC responses must be filtered before semantic decoding",
        "UNEXPECTED_RESPONSE",
      );
    }

    try {
      const observation = mapPiEvent(record, this.limits);
      this.reduce(record);
      if (record.type !== "agent_settled") return [observation];
      if (this.settled) return [observation];
      this.settled = true;
      return [observation, this.settlement(record)];
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Invalid Pi event",
        error instanceof HarnessProtocolError ? error.code : "INVALID_EVENT",
      );
    }
  }

  private reduce(event: Record<string, unknown>): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.invalidateAssistantEvidence();
        return;
      case "message_start":
        this.invalidateAssistantEvidence();
        return;
      case "message_update":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.invalidateAssistantEvidence();
        return;
      case "message_end":
        if (isRecord(event.message) && event.message.role === "assistant") {
          const text = textFromAssistantMessage(
            event.message,
            this.limits.maxRecordBytes,
          );
          this.assistantEvidence = {
            stopReason: assistantStopReason(event.message),
            ...(text === undefined ? {} : { text }),
          };
          this.awaitingFinalAssistant = false;
          this.failureEvidence = undefined;
        } else {
          this.invalidateAssistantEvidence();
        }
        return;
      case "agent_end":
        if (optionalBoolean(event, "willRetry") === true)
          this.invalidateAssistantEvidence();
        return;
      case "agent_retry":
      case "auto_retry_start":
      case "compaction_start":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
        this.invalidateAssistantEvidence();
        return;
      case "queue_update":
        if (queueIsNonEmpty(event)) this.invalidateAssistantEvidence();
        return;
      case "compaction_end": {
        if (optionalBoolean(event, "willRetry") === true) {
          this.invalidateAssistantEvidence();
          return;
        }
        const aborted = optionalBoolean(event, "aborted");
        const hasResult = isRecord(event.result);
        if (aborted === true || (!hasResult && aborted === false)) {
          this.failureEvidence = "compaction_failed";
        }
        return;
      }
      case "auto_retry_end":
        if (optionalBoolean(event, "success") === false) {
          this.failureEvidence = "retry_failed";
        }
        return;
    }
  }

  private invalidateAssistantEvidence(): void {
    this.assistantEvidence = undefined;
    this.awaitingFinalAssistant = true;
    this.failureEvidence = undefined;
  }

  private settlement(event: Record<string, unknown>): HarnessSignal {
    const unexpectedStatus = Object.prototype.hasOwnProperty.call(
      event,
      "finalStatus",
    );
    let status: "success" | "error" | "abort" = "error";
    let reason = "agent_settled_missing_final_assistant_message";
    const evidence = this.assistantEvidence;

    if (unexpectedStatus) {
      reason = "agent_settled_unexpected_final_status";
    } else if (this.failureEvidence !== undefined) {
      if (this.failureEvidence === "retry_failed") {
        reason = evidence
          ? "agent_settled_retry_conflicts_with_final_message"
          : "agent_settled_retry_failed";
      } else {
        reason = evidence
          ? "agent_settled_compaction_conflicts_with_final_message"
          : "agent_settled_compaction_failed";
      }
    } else if (this.awaitingFinalAssistant) {
      reason = "agent_settled_continuation_missing_final_message";
    } else if (evidence === undefined) {
      reason = "agent_settled_missing_final_assistant_message";
    } else {
      switch (evidence.stopReason) {
        case "stop":
          status = "success";
          reason = "pi_assistant_stop";
          break;
        case "length":
          reason = "pi_assistant_length";
          break;
        case "error":
          reason = "pi_assistant_error";
          break;
        case "aborted":
          status = "abort";
          reason = "pi_assistant_aborted";
          break;
        case "toolUse":
        case "deferred":
        case "pending":
        case "unsupported":
          reason = `agent_settled_unconfirmed_${evidence.stopReason}`;
          break;
      }
    }

    const signal: Extract<HarnessSignal, { type: "settlement" }> = {
      type: "settlement",
      status,
      reason,
    };
    if (!unexpectedStatus && evidence?.text !== undefined) {
      signal.reportedText = evidence.text;
    }
    return signal;
  }

  private assertUsable(): void {
    if (this.failed) throw this.failed;
    if (this.finished) {
      throw protocolError("Pi decoder is already finished", "DECODER_FINISHED");
    }
  }

  private fail(message: string, code: string): never {
    const error = protocolError(message, code);
    this.failed = error;
    this.pending = [];
    throw error;
  }
}

export function createPiHarness(
  limits: Partial<RuntimeLimits> = {},
): HarnessPort {
  const resolved = resolveLimits(limits);
  return { decoder: () => new PiSemanticDecoder(resolved) };
}
