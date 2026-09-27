import { describe, expect, it } from "vitest";
import {
  createMemoryJournal,
  createMockHarness,
  importJournal,
  JournalGapError,
  JournalOverflowError,
  replayJournal,
} from "../../src/observation/index.js";
import type {
  JsonObject,
  ObservationDraft,
  RunSnapshot,
} from "../../src/contracts/types.js";

const utf8 = new TextEncoder();

function pi(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "pi-event", event });
}

function draft(
  runId: string,
  overrides: Partial<ObservationDraft> = {},
): ObservationDraft {
  return {
    runId,
    source: "runtime",
    kind: "test.event",
    payload: {},
    ...overrides,
  };
}

const snapshot: RunSnapshot = {
  agentRunId: "run-1",
  harness: { name: "mock", version: "0.1.0" },
  metadata: {},
  lifecycle: "terminal",
  semantic: "settled",
  activity: "idle",
  revision: 4,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:01.000Z",
  outcome: "completed",
  reason: "harness_settled",
  completeness: "complete",
  receipt: {
    executionRunId: "execution-1",
    status: "exited",
    exitCode: 0,
    signal: null,
    forced: false,
  },
};

describe("mock harness JSONL decoder", () => {
  it("frames fragmented UTF-8 and LF records, preserving Unicode separators", () => {
    const decoder = createMockHarness().decoder();
    const record = pi({ type: "message_update", text: "こんにちは\u2028世界" });
    const bytes = utf8.encode(`${record}\r\n${pi({ type: "agent_end" })}\n`);
    const split = bytes.indexOf(0xe3);
    const first = decoder.push(bytes.slice(0, split + 1));
    const second = decoder.push(bytes.slice(split + 1));

    expect(first).toEqual([]);
    expect(second.map((signal) => signal.type)).toEqual([
      "observation",
      "observation",
    ]);
    expect(second[0]).toMatchObject({
      type: "observation",
      draft: {
        kind: "harness.message",
        payload: { nativeType: "message_update" },
      },
    });
    expect(decoder.finish()).toEqual([]);
  });

  it("does not settle on agent_end, and returns assistant text only on final settlement", () => {
    const decoder = createMockHarness().decoder();
    const signals = decoder.push(
      utf8.encode(
        [
          pi({ type: "prompt_accepted", success: true }),
          pi({ type: "agent_end" }),
          pi({ type: "auto_retry_start", attempt: 2 }),
          pi({ type: "compaction_start" }),
          pi({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "private answer" }],
            },
          }),
          pi({ type: "agent_settled", finalStatus: "success" }),
        ].join("\n") + "\n",
      ),
    );

    expect(signals.filter((signal) => signal.type === "settlement")).toEqual([
      {
        type: "settlement",
        status: "success",
        reason: "agent_settled_success",
        reportedText: "private answer",
      },
    ]);
    expect(signals.map((signal) => signal.type)).toEqual([
      "observation",
      "observation",
      "observation",
      "observation",
      "observation",
      "observation",
      "settlement",
    ]);
    expect(
      JSON.stringify(signals.filter((signal) => signal.type === "observation")),
    ).not.toContain("private answer");
  });

  it("maps only validated final status from agent_settled", () => {
    const decoder = createMockHarness().decoder();
    expect(
      decoder.push(utf8.encode(`${pi({ type: "agent_settled" })}\n`)),
    ).toEqual([
      expect.objectContaining({
        type: "observation",
        draft: expect.objectContaining({
          kind: "harness.agent_settled",
          payload: { nativeType: "agent_settled" },
        }),
      }),
    ]);

    expect(() =>
      createMockHarness()
        .decoder()
        .push(
          utf8.encode(
            `${pi({ type: "agent_settled", finalStatus: "maybe" })}\n`,
          ),
        ),
    ).toThrow(/finalStatus/);
  });

  it("reports malformed, oversized, invalid UTF-8, and truncated frames", () => {
    expect(() =>
      createMockHarness().decoder().push(utf8.encode("{nope}\n")),
    ).toThrow(/JSON/);
    expect(() =>
      createMockHarness({ maxRecordBytes: 8 })
        .decoder()
        .push(utf8.encode("123456789")),
    ).toThrow(/record.*limit/i);
    expect(() =>
      createMockHarness({ maxQueuedInputBytes: 8 })
        .decoder()
        .push(utf8.encode("123456789")),
    ).toThrow(/queued input limit/i);
    expect(() =>
      createMockHarness()
        .decoder()
        .push(Uint8Array.of(0xc3, 0x28, 0x0a)),
    ).toThrow(/UTF-8/);
    const truncated = createMockHarness().decoder();
    truncated.push(utf8.encode(pi({ type: "agent_end" })));
    expect(() => truncated.finish()).toThrow(/truncated/i);
  });
});

describe("bounded in-memory journal", () => {
  it("assigns monotonic sequences, de-duplicates known source identities, and reports retention gaps", () => {
    const journal = createMemoryJournal({ maxHistoryPerRun: 2 });
    journal.append(
      draft("run-1", { source: "harness", sourceIdentity: "event-a" }),
    );
    const duplicate = journal.append(
      draft("run-1", {
        source: "harness",
        sourceIdentity: "event-a",
        kind: "duplicate",
      }),
    );
    journal.append(draft("run-1", { kind: "second" }));
    journal.append(draft("run-1", { kind: "third" }));

    expect(duplicate.seq).toBe(1);
    expect(journal.read("run-1")).toMatchObject({
      retainedFrom: 2,
      gap: true,
      items: [
        { seq: 2, kind: "second" },
        { seq: 3, kind: "third" },
      ],
    });
    expect(journal.read("run-1", 2)).toMatchObject({
      retainedFrom: 2,
      gap: false,
    });
    expect(journal.read("run-1", 0)).toMatchObject({ gap: true });
  });

  it("bounds runs, records, and pages", () => {
    const journal = createMemoryJournal({ maxRuns: 1, maxPageSize: 1 });
    journal.append(draft("run-1", { kind: "first" }));
    journal.append(draft("run-1", { kind: "second" }));
    expect(journal.read("run-1")).toMatchObject({ nextCursor: "1" });
    expect(() => journal.append(draft("run-2"))).toThrow(/run limit/i);

    const small = createMemoryJournal({ maxRecordBytes: 96 });
    expect(() =>
      small.append(
        draft("run-small", { payload: { detail: "x".repeat(256) } }),
      ),
    ).toThrow(/record byte limit/i);
  });

  it("rejects a subscriber whose cursor expired and bounds slow subscriber queues", async () => {
    const expired = createMemoryJournal({ maxHistoryPerRun: 1 });
    expired.append(draft("run-gap"));
    expired.append(draft("run-gap"));
    await expect(async () => {
      for await (const _event of expired.subscribe("run-gap", 0)) {
        void _event;
      }
    }).rejects.toBeInstanceOf(JournalGapError);

    const journal = createMemoryJournal({ maxSubscriberQueue: 1 });
    const stream = journal.subscribe("run-live")[Symbol.asyncIterator]();
    const first = stream.next();
    journal.append(draft("run-live", { kind: "one" }));
    journal.append(draft("run-live", { kind: "two" }));
    journal.append(draft("run-live", { kind: "three" }));
    await expect(first).resolves.toMatchObject({ value: { kind: "one" } });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "two" },
    });
    await expect(stream.next()).rejects.toBeInstanceOf(JournalOverflowError);
    await stream.return?.();
  });

  it("exports metadata only and replays a validated deterministic snapshot projection", () => {
    const journal = createMemoryJournal();
    journal.append(
      draft("run-1", {
        source: "harness",
        kind: "harness.message",
        payload: {
          prompt: "never export this",
          reportedText: "private result",
          thinking: "private thoughts",
          toolArguments: { path: "/private/path" },
          accessToken: "private credential",
          rawEnvironment: { API_KEY: "private credential" },
          usage: { inputTokens: 11, outputTokens: 3 },
        },
      }),
    );
    journal.append(
      draft("run-1", {
        kind: "run.snapshot",
        payload: {
          snapshot: JSON.parse(JSON.stringify(snapshot)) as JsonObject,
        },
      }),
    );
    const exported = journal.export();
    expect(exported).not.toContain("never export this");
    expect(exported).not.toContain("private result");
    expect(exported).not.toContain("private thoughts");
    expect(exported).not.toContain("private credential");
    expect(exported).not.toContain("/private/path");
    expect(exported).toContain('"inputTokens":11');
    expect(exported).toContain('"outputTokens":3');
    expect(replayJournal(exported)).toEqual({
      runs: [snapshot],
      incomplete: false,
    });
    expect(importJournal(exported).events).toHaveLength(2);
  });

  it("marks sequence gaps incomplete and rejects invalid imported envelopes", () => {
    const journal = createMemoryJournal();
    journal.append(
      draft("run-1", {
        kind: "run.snapshot",
        payload: {
          snapshot: JSON.parse(JSON.stringify(snapshot)) as JsonObject,
        },
      }),
    );
    const complete = JSON.parse(journal.export()) as Record<string, unknown>;
    const later = { ...complete, seq: 3 };
    const replay = replayJournal(`${JSON.stringify(later)}\n`);
    expect(replay.incomplete).toBe(true);
    expect(replay.runs[0]?.completeness).toBe("incomplete");

    expect(() =>
      importJournal(`${JSON.stringify({ ...complete, seq: 0 })}\n`),
    ).toThrow(/sequence/i);
    expect(() =>
      importJournal(`${JSON.stringify({ ...complete, runId: "other" })}\n`),
    ).toThrow(/run.snapshot.*runId|runId.*snapshot/i);
    const envelope = JSON.parse(journal.export()) as Record<string, unknown>;
    const directPayload = { ...envelope, payload: snapshot };
    expect(() => importJournal(`${JSON.stringify(directPayload)}\n`)).toThrow(
      /\{ snapshot \}/,
    );
  });
});
