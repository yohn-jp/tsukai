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

/** Payload key for Claude Code native evidence. */
export const CLAUDE_CODE_NAMESPACE = "claudeCode";

const MAX_STRING_BYTES = 256;
const MAX_BLOCKS = 256;
const NATIVE_TYPE = /^[A-Za-z][A-Za-z0-9_/]{0,127}$/;

const SYSTEM_KINDS: Readonly<Record<string, string>> = Object.freeze({
  init: "harness.session",
  api_retry: "harness.retry",
  compact_boundary: "harness.compaction",
  session_state_changed: "harness.state",
});

type Json = Record<string, JsonValue>;

function protocolError(message: string, code: string): HarnessProtocolError {
  return new HarnessProtocolError(message, code);
}

function boundedString(
  record: Record<string, unknown>,
  key: string,
  maximum = MAX_STRING_BYTES,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > maximum
  ) {
    throw protocolError(
      `Claude Code ${key} must be a bounded non-empty string`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function nonNegative(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocolError(
      `Claude Code ${key} must be a non-negative number`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function bool(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw protocolError(
      `Claude Code ${key} must be a boolean`,
      "INVALID_EVENT_METADATA",
    );
  }
  return value;
}

function put(target: Json, key: string, value: JsonValue | undefined): void {
  if (value !== undefined) target[key] = value;
}

function draft(
  kind: string,
  native: Json,
  limits: RuntimeLimits,
): HarnessSignal {
  let payload: JsonObject;
  try {
    payload = jsonObject(
      { [CLAUDE_CODE_NAMESPACE]: native },
      limits.maxRecordBytes,
    );
  } catch (error) {
    throw protocolError(
      `Invalid Claude Code metadata: ${error instanceof Error ? error.message : "unknown value"}`,
      "INVALID_EVENT_METADATA",
    );
  }
  return { type: "observation", draft: { source: "harness", kind, payload } };
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string" || content === undefined) return [];
  if (!Array.isArray(content) || content.length > MAX_BLOCKS) {
    throw protocolError(
      "Claude Code message content must be a bounded array",
      "EVENT_LIMIT",
    );
  }
  return content.filter(isRecord);
}

/**
 * Main-loop usage from a `result` record. The Agent SDK documents it as the
 * turn's final usage; zeroed values on an error result are not evidence.
 */
function resultUsage(usage: unknown): Json | undefined {
  if (!isRecord(usage)) return undefined;
  const values: Json = {};
  put(values, "input", nonNegative(usage, "input_tokens"));
  put(values, "output", nonNegative(usage, "output_tokens"));
  put(values, "cacheRead", nonNegative(usage, "cache_read_input_tokens"));
  put(values, "cacheWrite", nonNegative(usage, "cache_creation_input_tokens"));
  return Object.keys(values).length === 0
    ? undefined
    : { scope: "result_turn_final", values };
}

interface Settlement {
  status: "success" | "error" | "abort";
  reason: string;
  reportedText?: string;
}

function settlementOf(
  record: Record<string, unknown>,
  maxTextBytes: number,
): Settlement {
  const subtype = boundedString(record, "subtype", 64);
  const isError = bool(record, "is_error");
  const terminalReason = boundedString(record, "terminal_reason", 64);
  const queued = nonNegative(record, "queued_turn_count");
  if (terminalReason?.startsWith("aborted")) {
    return { status: "abort", reason: `claude_code_${terminalReason}` };
  }
  if (queued !== undefined && queued > 0) {
    // Another turn follows automatically: this result does not settle.
    return {
      status: "error",
      reason: "claude_code_result_queued_continuation",
    };
  }
  if (
    subtype === "success" &&
    isError === false &&
    (terminalReason === undefined || terminalReason === "completed")
  ) {
    const text = record.result;
    const settlement: Settlement = {
      status: "success",
      reason: "claude_code_result_success",
    };
    if (typeof text === "string" && text.length > 0) {
      if (utf8Bytes(text) > maxTextBytes) {
        throw protocolError(
          "Claude Code result text exceeds the record limit",
          "TEXT_LIMIT",
        );
      }
      settlement.reportedText = text;
    }
    return settlement;
  }
  if (isError === undefined || subtype === undefined) {
    return { status: "error", reason: "claude_code_result_missing_status" };
  }
  return {
    status: "error",
    reason: `claude_code_result_${terminalReason ?? subtype}`,
  };
}

function mapResult(record: Record<string, unknown>): Json {
  const native: Json = { nativeType: "result" };
  put(native, "subtype", boundedString(record, "subtype", 64));
  const isError = bool(record, "is_error");
  put(native, "isError", isError);
  put(native, "terminalReason", boundedString(record, "terminal_reason", 64));
  put(native, "stopReason", boundedString(record, "stop_reason", 64));
  put(native, "numTurns", nonNegative(record, "num_turns"));
  put(native, "durationMs", nonNegative(record, "duration_ms"));
  put(native, "durationApiMs", nonNegative(record, "duration_api_ms"));
  put(native, "queuedTurnCount", nonNegative(record, "queued_turn_count"));
  put(native, "index", nonNegative(record, "result_index"));
  if (isError === false) {
    put(native, "usage", resultUsage(record.usage));
    const cost = nonNegative(record, "total_cost_usd");
    if (cost !== undefined) {
      // Documented as a cumulative estimate, not a billing statement.
      native.cost = { scope: "session_cumulative_estimate", total: cost };
    }
  } else {
    native.usageAvailable = false;
  }
  return native;
}

function mapAssistant(
  record: Record<string, unknown>,
  limits: RuntimeLimits,
): HarnessSignal[] {
  const message = isRecord(record.message) ? record.message : {};
  const blocks = contentBlocks(record.message);
  const native: Json = {
    nativeType: "assistant",
    blockTypes: blocks.map((block) =>
      typeof block.type === "string" && utf8Bytes(block.type) <= 64
        ? block.type
        : "unknown",
    ),
    subagent:
      record.parent_tool_use_id !== null &&
      record.parent_tool_use_id !== undefined,
  };
  put(native, "model", boundedString(message, "model"));
  put(native, "stopReason", boundedString(message, "stop_reason", 64));
  put(native, "errorKind", boundedString(record, "error", 64));
  const signals: HarnessSignal[] = [draft("harness.message", native, limits)];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const tool: Json = { nativeType: "tool_use" };
    put(tool, "toolUseId", boundedString(block, "id"));
    put(tool, "toolName", boundedString(block, "name"));
    signals.push(draft("harness.tool", tool, limits));
  }
  return signals;
}

function mapUser(
  record: Record<string, unknown>,
  limits: RuntimeLimits,
): HarnessSignal[] {
  const results = contentBlocks(record.message).filter(
    (block) => block.type === "tool_result",
  );
  if (results.length === 0) {
    return [draft("harness.native", { nativeType: "user" }, limits)];
  }
  return results.map((block) => {
    const tool: Json = { nativeType: "tool_result" };
    put(tool, "toolUseId", boundedString(block, "tool_use_id"));
    put(tool, "isError", bool(block, "is_error") ?? false);
    return draft("harness.tool", tool, limits);
  });
}

function mapSystem(
  record: Record<string, unknown>,
  limits: RuntimeLimits,
): HarnessSignal {
  const subtype = boundedString(record, "subtype", 64) ?? "unknown";
  const native: Json = { nativeType: `system/${subtype}` };
  switch (subtype) {
    case "init": {
      put(native, "sessionId", boundedString(record, "session_id"));
      put(native, "model", boundedString(record, "model"));
      put(
        native,
        "permissionMode",
        boundedString(record, "permissionMode", 64),
      );
      put(
        native,
        "claudeCodeVersion",
        boundedString(record, "claude_code_version", 64),
      );
      if (Array.isArray(record.tools)) native.toolCount = record.tools.length;
      break;
    }
    case "api_retry": {
      put(native, "attempt", nonNegative(record, "attempt"));
      put(native, "maxRetries", nonNegative(record, "max_retries"));
      put(native, "retryDelayMs", nonNegative(record, "retry_delay_ms"));
      put(native, "errorStatus", nonNegative(record, "error_status"));
      put(native, "errorKind", boundedString(record, "error", 64));
      break;
    }
    case "compact_boundary": {
      const metadata = isRecord(record.compact_metadata)
        ? record.compact_metadata
        : {};
      put(native, "trigger", boundedString(metadata, "trigger", 16));
      put(native, "preTokens", nonNegative(metadata, "pre_tokens"));
      put(native, "postTokens", nonNegative(metadata, "post_tokens"));
      put(native, "durationMs", nonNegative(metadata, "duration_ms"));
      break;
    }
    case "status": {
      const compact = boundedString(record, "compact_result", 16);
      if (compact !== undefined) {
        native.compactOutcome = compact;
        return draft("harness.compaction", native, limits);
      }
      put(native, "status", boundedString(record, "status", 64));
      break;
    }
    case "session_state_changed":
      put(native, "state", boundedString(record, "state", 32));
      break;
  }
  return draft(SYSTEM_KINDS[subtype] ?? "harness.native", native, limits);
}

class ClaudeCodeSemanticDecoder implements HarnessDecoder {
  private pending: number[] = [];
  private failed: HarnessProtocolError | undefined;
  private finished = false;
  private settled = false;

  constructor(private readonly limits: RuntimeLimits) {}

  push(chunk: Uint8Array): HarnessSignal[] {
    this.assertUsable();
    if (!(chunk instanceof Uint8Array)) {
      return this.fail("Claude Code input must be Uint8Array", "INVALID_CHUNK");
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
          "Claude Code record exceeds record byte limit",
          "RECORD_LIMIT",
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
        "Truncated final Claude Code record without LF delimiter",
        "TRUNCATED_FRAME",
      );
    }
    return [];
  }

  private decodeFrame(frame: number[]): HarnessSignal[] {
    let record: unknown;
    try {
      record = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(frame),
        ),
      ) as unknown;
    } catch {
      return this.fail("Claude Code record is not valid JSON", "INVALID_JSON");
    }
    if (
      !isRecord(record) ||
      typeof record.type !== "string" ||
      !NATIVE_TYPE.test(record.type)
    ) {
      return this.fail(
        "Claude Code record must be a typed object",
        "INVALID_RECORD",
      );
    }
    if (
      record.type === "control_response" ||
      record.type === "control_request"
    ) {
      return this.fail(
        "Control records must be filtered before semantic decoding",
        "UNEXPECTED_CONTROL",
      );
    }
    try {
      switch (record.type) {
        case "system":
          return [mapSystem(record, this.limits)];
        case "assistant":
          return mapAssistant(record, this.limits);
        case "user":
          return mapUser(record, this.limits);
        case "result": {
          const observation = draft(
            "harness.result",
            mapResult(record),
            this.limits,
          );
          if (this.settled) return [observation];
          this.settled = true;
          const settlement = settlementOf(record, this.limits.maxRecordBytes);
          return [observation, { type: "settlement", ...settlement }];
        }
        default:
          return [
            draft("harness.native", { nativeType: record.type }, this.limits),
          ];
      }
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Invalid Claude Code event",
        error instanceof HarnessProtocolError ? error.code : "INVALID_EVENT",
      );
    }
  }

  private assertUsable(): void {
    if (this.failed) throw this.failed;
    if (this.finished) {
      throw protocolError(
        "Claude Code decoder is already finished",
        "DECODER_FINISHED",
      );
    }
  }

  private fail(message: string, code: string): never {
    const error = protocolError(message, code);
    this.failed = error;
    this.pending = [];
    throw error;
  }
}

export function createClaudeCodeHarness(
  limits: Partial<RuntimeLimits> = {},
): HarnessPort {
  const resolved = resolveLimits(limits);
  return { decoder: () => new ClaudeCodeSemanticDecoder(resolved) };
}
