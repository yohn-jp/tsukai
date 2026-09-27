import { describe, expect, it } from "vitest";
import type { HarnessSignal } from "../../src/contracts/ports.js";
import { createPiHarness } from "../../src/adapters/pi/semantic.js";
import { HarnessProtocolError } from "../../src/observation/errors.js";

const encoder = new TextEncoder();

function record(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function transcript(...events: Record<string, unknown>[]): HarnessSignal[] {
  const decoder = createPiHarness().decoder();
  const signals: HarnessSignal[] = [];
  for (const event of events) signals.push(...decoder.push(record(event)));
  signals.push(...decoder.finish());
  return signals;
}

function settlement(signals: HarnessSignal[]) {
  return signals.find((signal) => signal.type === "settlement");
}

function observations(signals: HarnessSignal[]) {
  return signals.flatMap((signal) =>
    signal.type === "observation" ? [signal] : [],
  );
}

function piMetadata(signal: Extract<HarnessSignal, { type: "observation" }>) {
  const pi = signal.draft.payload.pi;
  return pi !== null && typeof pi === "object" && !Array.isArray(pi)
    ? pi
    : undefined;
}

function assistantMessage(
  stopReason: string,
  text = "the private result",
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 11,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.3,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

describe("Pi semantic adapter", () => {
  it("settles success only after agent_settled and keeps final text out of observations", () => {
    const signals = transcript(
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_start",
        message: { role: "assistant", stopReason: "pending", content: [] },
      },
      {
        type: "message_update",
        usage: { input: 11, output: 1, totalTokens: 12, cost: { total: 0.1 } },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "private delta",
        },
      },
      { type: "message_end", message: assistantMessage("stop") },
      { type: "turn_end", message: assistantMessage("stop") },
      {
        type: "agent_end",
        willRetry: false,
        messages: [assistantMessage("stop")],
      },
      { type: "agent_settled" },
    );

    expect(settlement(signals)).toEqual({
      type: "settlement",
      status: "success",
      reason: "pi_assistant_stop",
      reportedText: "the private result",
    });
    expect(
      signals.filter((signal) => signal.type === "settlement"),
    ).toHaveLength(1);
    const payloads = observations(signals).map(
      (signal) => signal.draft.payload,
    );
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("the private result");
    expect(serialized).not.toContain("private delta");
    expect(payloads[3]?.pi).toMatchObject({
      usage: {
        scope: "assistant_message_cumulative",
        values: { input: 11, output: 1, totalTokens: 12 },
      },
    });
    expect(payloads[4]?.pi).toMatchObject({
      assistant: {
        stopReason: "stop",
        usage: {
          scope: "assistant_message_final",
          values: { input: 11, output: 3, totalTokens: 17 },
        },
      },
    });
    expect(payloads[5]).not.toHaveProperty("pi.assistant.usage");
  });

  it("treats agent_end as nonterminal", () => {
    const decoder = createPiHarness().decoder();
    const signals = decoder.push(
      record({ type: "agent_end", willRetry: false }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).toBe("observation");
  });

  it.each([
    ["error", "error", "pi_assistant_error"],
    ["aborted", "abort", "pi_assistant_aborted"],
    ["length", "error", "pi_assistant_length"],
  ] as const)(
    "maps final assistant stopReason %s",
    (stopReason, status, reason) => {
      const result = settlement(
        transcript(
          { type: "agent_start" },
          { type: "message_end", message: assistantMessage(stopReason) },
          { type: "agent_end", willRetry: false },
          { type: "agent_settled" },
        ),
      );
      expect(result).toMatchObject({ type: "settlement", status, reason });
    },
  );

  it.each(["pending", "toolUse", "deferred", "future-stop-reason"] as const)(
    "does not turn an unconfirmed %s message into success",
    (stopReason) => {
      expect(
        settlement(
          transcript(
            { type: "agent_start" },
            { type: "message_end", message: assistantMessage(stopReason) },
            { type: "agent_settled" },
          ),
        ),
      ).toMatchObject({ type: "settlement", status: "error" });
    },
  );

  it("settles missing and contradictory terminal evidence as explicit errors", () => {
    expect(settlement(transcript({ type: "agent_settled" }))).toMatchObject({
      type: "settlement",
      status: "error",
      reason: "agent_settled_missing_final_assistant_message",
    });

    expect(
      settlement(
        transcript(
          { type: "agent_start" },
          { type: "message_end", message: assistantMessage("error") },
          { type: "agent_settled", finalStatus: "success" },
        ),
      ),
    ).toMatchObject({
      type: "settlement",
      status: "error",
      reason: "agent_settled_unexpected_final_status",
    });
  });

  it("keeps retry, compaction, and queued continuation observations before final settlement", () => {
    const signals = transcript(
      { type: "agent_start" },
      {
        type: "message_end",
        message: assistantMessage("error", "discard this attempt"),
      },
      { type: "agent_end", willRetry: true },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 20,
        errorMessage: "private retry detail",
      },
      { type: "auto_retry_end", success: true, attempt: 2 },
      { type: "compaction_start", reason: "overflow" },
      {
        type: "compaction_end",
        reason: "overflow",
        willRetry: true,
        result: {
          summary: "private summary",
          tokensBefore: 100,
          estimatedTokensAfter: 20,
        },
      },
      {
        type: "queue_update",
        steering: [{ text: "private steering" }],
        followUp: [{ text: "private follow-up" }],
      },
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_end",
        message: assistantMessage("stop", "recovered result"),
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled" },
    );
    const nativeTypes = observations(signals).map(
      (signal) => piMetadata(signal)?.nativeType,
    );
    expect(nativeTypes).toContain("auto_retry_start");
    expect(nativeTypes).toContain("auto_retry_end");
    expect(nativeTypes).toContain("compaction_start");
    expect(nativeTypes).toContain("compaction_end");
    expect(nativeTypes).toContain("queue_update");
    expect(settlement(signals)).toMatchObject({
      type: "settlement",
      status: "success",
      reason: "pi_assistant_stop",
      reportedText: "recovered result",
    });
    const queued = observations(signals).find(
      (signal) => piMetadata(signal)?.nativeType === "queue_update",
    );
    expect(queued?.draft.payload).toMatchObject({
      pi: { queue: { steeringCount: 1, followUpCount: 1 } },
    });
    const serialized = JSON.stringify(observations(signals));
    expect(serialized).not.toContain("private steering");
    expect(serialized).not.toContain("private follow-up");
    expect(serialized).not.toContain("private summary");
    expect(serialized).not.toContain("private retry detail");
    expect(serialized).not.toContain("discard this attempt");
  });

  it("reports an exhausted retry or failed compaction without reusing stale success", () => {
    const retry = transcript(
      { type: "agent_start" },
      {
        type: "message_end",
        message: assistantMessage("stop", "stale answer"),
      },
      { type: "agent_end", willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0 },
      {
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "private error",
      },
      { type: "agent_settled" },
    );
    expect(settlement(retry)).toMatchObject({
      type: "settlement",
      status: "error",
      reason: "agent_settled_retry_failed",
    });
    expect(JSON.stringify(observations(retry))).not.toContain("private error");

    const compaction = transcript(
      { type: "agent_start" },
      { type: "compaction_start", reason: "overflow" },
      {
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        errorMessage: "private compaction failure",
      },
      { type: "agent_settled" },
    );
    expect(settlement(compaction)).toMatchObject({
      type: "settlement",
      status: "error",
      reason: "agent_settled_compaction_failed",
    });
    expect(JSON.stringify(observations(compaction))).not.toContain(
      "private compaction failure",
    );
  });

  it("records only metadata for assistant, thinking, image, and tool content", () => {
    const signals = transcript(
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          ...assistantMessage("toolUse", "intermediate private text"),
          content: [
            { type: "text", text: "intermediate private text" },
            {
              type: "thinking",
              thinking: "private reasoning",
              thinkingSignature: "private signature",
            },
            { type: "image", data: "private-base64", mimeType: "image/png" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "private command" },
            },
          ],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "private command" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        result: { text: "private result" },
      },
      {
        type: "message_end",
        message: assistantMessage("stop", "caller result"),
      },
      { type: "agent_settled" },
    );
    const serialized = JSON.stringify(observations(signals));
    for (const secret of [
      "caller result",
      "intermediate private text",
      "private reasoning",
      "private signature",
      "private-base64",
      "private command",
      "private result",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(settlement(signals)).toMatchObject({
      reportedText: "caller result",
    });
  });

  it("rejects transport responses, malformed records, invalid usage, and oversized frames", () => {
    const responseDecoder = createPiHarness().decoder();
    expect(() =>
      responseDecoder.push(record({ type: "response", id: "req-1" })),
    ).toThrow(expect.objectContaining({ code: "UNEXPECTED_RESPONSE" }));

    const jsonDecoder = createPiHarness().decoder();
    expect(() => jsonDecoder.push(encoder.encode("{bad}\n"))).toThrow(
      HarnessProtocolError,
    );

    const usageDecoder = createPiHarness().decoder();
    expect(() =>
      usageDecoder.push(
        record({
          type: "message_update",
          usage: { input: "eleven" },
          assistantMessageEvent: { type: "text_delta" },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_USAGE" }));

    const boundedDecoder = createPiHarness({ maxRecordBytes: 32 }).decoder();
    expect(() =>
      boundedDecoder.push(encoder.encode(`${"x".repeat(33)}\n`)),
    ).toThrow(expect.objectContaining({ code: "RECORD_LIMIT" }));
  });
});
