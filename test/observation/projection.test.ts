import { describe, expect, it } from "vitest";
import type {
  JsonObject,
  ObservationDraft,
  RunSnapshot,
} from "../../src/contracts/types.js";
import {
  collectLiveProjection,
  createMemoryJournal,
  escapeDisplayText,
  projectObservation,
  projectReplay,
  renderOperatorProjection,
} from "../../src/observation/index.js";

type SnapshotOverrides = Omit<Partial<RunSnapshot>, "outcome" | "reason"> & {
  outcome?: RunSnapshot["outcome"] | undefined;
  reason?: RunSnapshot["reason"] | undefined;
};

const snapshot = (
  agentRunId: string,
  overrides: SnapshotOverrides = {},
): RunSnapshot => {
  const merged: Record<string, unknown> = {
    agentRunId,
    harness: { name: "mock", version: "fixture" },
    metadata: { label: agentRunId },
    lifecycle: "terminal",
    semantic: "settled",
    activity: "idle",
    revision: 2,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:02.000Z",
    outcome: "completed",
    reason: "done",
    completeness: "complete",
    ...overrides,
  };
  for (const key of Object.keys(merged))
    if (merged[key] === undefined) delete merged[key];
  return merged as unknown as RunSnapshot;
};

function append(
  journal: ReturnType<typeof createMemoryJournal>,
  runId: string,
  kind: string,
  payload: JsonObject,
): void {
  const draft: ObservationDraft = {
    runId,
    source: kind.startsWith("execution")
      ? "execution"
      : kind.startsWith("run")
        ? "runtime"
        : "harness",
    kind,
    payload,
  };
  journal.append(draft);
}

describe("operator observation projections", () => {
  it("produces the same projection from live journal evidence and replay", () => {
    const journal = createMemoryJournal();
    const run = snapshot("run-a");
    append(journal, run.agentRunId, "run.snapshot", {
      snapshot: run as unknown as JsonObject,
    });
    append(journal, run.agentRunId, "harness.tool", {
      pi: {
        nativeType: "tool_execution_end",
        toolName: "<unsafe>",
        durationMs: 12,
        isError: true,
      },
    });
    append(journal, run.agentRunId, "harness.message", {
      pi: {
        nativeType: "message_end",
        assistant: {
          usage: {
            scope: "assistant_message_final",
            values: {
              input: 10,
              output: 4,
              totalTokens: 14,
              cost: { total: 0.25 },
            },
          },
        },
      },
    });
    append(journal, run.agentRunId, "execution.exit", {
      status: "exited",
      exitCode: 0,
      signal: null,
      forced: false,
    });

    const events = journal.read(run.agentRunId).items;
    const live = projectObservation({ snapshots: [run], events });
    const replay = projectReplay(journal.export());

    expect(replay).toEqual(live);
    expect(live.fleet[0]?.lineage).toBe("root");
    expect(live.metrics[run.agentRunId]?.tool.errors).toMatchObject({
      availability: "derived",
      value: 1,
    });
    expect(live.metrics[run.agentRunId]?.tool.latencyMs).toMatchObject({
      availability: "derived",
      value: 12,
    });
    expect(live.metrics[run.agentRunId]?.usage.totalTokens).toMatchObject({
      availability: "observed",
      value: 14,
    });
    expect(live.metrics[run.agentRunId]?.usage.cost).toMatchObject({
      availability: "observed",
      value: 0.25,
    });
  });

  it("collects a live projection through finite owner read APIs", async () => {
    const journal = createMemoryJournal();
    const run = snapshot("live-run");
    append(journal, run.agentRunId, "run.snapshot", {
      snapshot: run as unknown as JsonObject,
    });
    const events = journal.read(run.agentRunId).items;
    const live = await collectLiveProjection({
      list: async () => ({ items: [run] }),
      eventsPage: async (_runId, afterSeq) =>
        journal.read(run.agentRunId, afterSeq),
    });

    expect(live.fleet.map((entry) => entry.agentRunId)).toEqual(["live-run"]);
    expect(live.timeline).toHaveLength(events.length);
  });

  it("builds deterministic trees and keeps missing parents as orphans", () => {
    const parent = snapshot("parent", {
      lifecycle: "running",
      semantic: "active",
      outcome: undefined,
      reason: undefined,
    });
    const child = snapshot("child", { parentRunId: "parent" });
    const orphan = snapshot("orphan", { parentRunId: "missing" });
    const projection = projectObservation({
      snapshots: [orphan, child, parent],
      events: [],
    });

    expect(projection.tree.map((node) => node.agentRunId)).toEqual([
      "orphan",
      "parent",
    ]);
    expect(projection.tree[0]?.lineage).toBe("orphan");
    expect(projection.tree[1]?.children.map((node) => node.agentRunId)).toEqual(
      ["child"],
    );
  });

  it("replays canonical Pi bindings and recovery projections", () => {
    const journal = createMemoryJournal();
    const run = snapshot("pi-run", {
      harness: { name: "pi", version: "0.99.1" },
      lifecycle: "uncertain",
      semantic: "unknown",
      completeness: "incomplete",
      execution: {
        executionRunId: "jinushi-run",
        backend: "jinushi",
        sessionId: "pi-session",
        piVersion: "0.99.1",
        piRevision: "revision",
      },
      recovery: {
        state: "uncertain",
        epoch: 2,
        attempts: 3,
        reason: "execution-observation-lost",
        gaps: [
          {
            kind: "output",
            code: "stdout-gap",
            detectedAt: "2026-09-30T00:00:03.000Z",
          },
        ],
      },
    });
    append(journal, run.agentRunId, "run.snapshot", {
      snapshot: run as unknown as JsonObject,
    });

    const projection = projectReplay(journal.export());
    expect(projection.fleet[0]).toMatchObject({
      harness: { name: "pi" },
      execution: { backend: "jinushi", sessionId: "pi-session" },
      recovery: { state: "uncertain", gaps: [{ kind: "output" }] },
      completeness: "incomplete",
    });
  });

  it("makes event and recovery gaps explicit and prevents complete status", () => {
    const run = snapshot("run-gap", {
      completeness: "complete",
      recovery: {
        state: "attached",
        epoch: 1,
        attempts: 1,
        gaps: [
          {
            kind: "output",
            code: "stdout-loss",
            detectedAt: "2026-09-30T00:00:03.000Z",
          },
        ],
      },
    });
    const projection = projectObservation({
      snapshots: [run],
      events: [],
      gaps: [
        {
          runId: run.agentRunId,
          kind: "event",
          code: "missing-events",
          fromSeq: 2,
          toSeq: 3,
          provenance: {
            availability: "observed",
            source: "journal",
            eventSeqs: [],
            explanation: "replay gap",
          },
        },
      ],
    });

    expect(projection.completeness.status).toBe("incomplete");
    expect(projection.completeness.runs[run.agentRunId]?.status).toBe(
      "incomplete",
    );
    expect(
      projection.completeness.runs[run.agentRunId]?.gaps.map((gap) => gap.kind),
    ).toEqual(["event", "output"]);
    expect(
      projection.timeline.filter((entry) => entry.type === "gap"),
    ).toHaveLength(2);
  });

  it("leaves unsupported metrics unavailable instead of using zero", () => {
    const run = snapshot("run-no-usage");
    const projection = projectObservation({ snapshots: [run], events: [] });
    const metrics = projection.metrics[run.agentRunId]!;
    expect(metrics.usage.inputTokens.availability).toBe("unavailable");
    expect(metrics.usage.cost.availability).toBe("unavailable");
    expect(metrics.tool.latencyMs.availability).toBe("unavailable");
    expect(metrics.retry.attempts.availability).toBe("observed");
    expect(metrics.retry.attempts).toMatchObject({ value: 0 });
  });

  it("does not mutate snapshots and escapes untrusted display strings", () => {
    const run = snapshot("run-<unsafe>", {
      metadata: { label: "<script>alert(1)</script>" },
    });
    const before = structuredClone(run);
    const projection = projectObservation({ snapshots: [run], events: [] });
    expect(run).toEqual(before);
    expect(escapeDisplayText("<script>")).toBe("&lt;script&gt;");
    expect(renderOperatorProjection(projection)).toContain("&lt;script&gt;");
    expect(renderOperatorProjection(projection)).not.toContain("<script>");
  });

  it("orders a multi-run timeline deterministically regardless of input order", () => {
    const runA = snapshot("run-a", {
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    const runB = snapshot("run-b", {
      createdAt: "2026-09-30T00:00:01.000Z",
    });
    const journal = createMemoryJournal();
    append(journal, runA.agentRunId, "run.snapshot", {
      snapshot: runA as unknown as JsonObject,
    });
    append(journal, runA.agentRunId, "harness.message", {
      pi: { nativeType: "message_start" },
    });
    append(journal, runB.agentRunId, "run.snapshot", {
      snapshot: runB as unknown as JsonObject,
    });
    append(journal, runB.agentRunId, "harness.message", {
      pi: { nativeType: "message_start" },
    });
    const events = journal
      .read(runA.agentRunId)
      .items.concat(journal.read(runB.agentRunId).items);

    const forward = projectObservation({
      snapshots: [runA, runB],
      events,
    });
    const reversed = projectObservation({
      snapshots: [runB, runA],
      events: [...events].reverse(),
    });
    const shuffled = projectObservation({
      snapshots: [runB, runA],
      events: [events[1]!, events[3]!, events[0]!, events[2]!],
    });

    expect(forward.timeline.map((entry) => entry.id)).toEqual(
      reversed.timeline.map((entry) => entry.id),
    );
    expect(forward.timeline.map((entry) => entry.id)).toEqual(
      shuffled.timeline.map((entry) => entry.id),
    );
    expect(forward.fleet.map((entry) => entry.agentRunId)).toEqual(
      reversed.fleet.map((entry) => entry.agentRunId),
    );
  });

  it("preserves provenance source and event seqs for observed metrics and timeline entries", () => {
    const run = snapshot("run-provenance");
    const journal = createMemoryJournal();
    append(journal, run.agentRunId, "run.snapshot", {
      snapshot: run as unknown as JsonObject,
    });
    append(journal, run.agentRunId, "harness.tool", {
      pi: {
        nativeType: "tool_execution_end",
        durationMs: 5,
      },
    });
    const events = journal.read(run.agentRunId).items;
    const projection = projectObservation({ snapshots: [run], events });

    const toolEvent = projection.timeline.find(
      (entry) => entry.type === "event" && entry.kind === "harness.tool",
    );
    expect(toolEvent?.provenance).toMatchObject({
      availability: "observed",
      source: "harness",
    });
    expect(toolEvent?.type === "event" ? [toolEvent.seq] : []).toEqual(
      projection.metrics[run.agentRunId]?.tool.calls.provenance.eventSeqs,
    );
    expect(
      projection.metrics[run.agentRunId]?.tool.latencyMs.provenance,
    ).toMatchObject({ availability: "derived", source: "harness" });
  });

  it("cannot mutate lifecycle state: collectLiveProjection is typed to read-only owner operations", async () => {
    const run = snapshot("read-only-run");
    const journal = createMemoryJournal();
    append(journal, run.agentRunId, "run.snapshot", {
      snapshot: run as unknown as JsonObject,
    });
    // collectLiveProjection's parameter type only exposes `list` and
    // `eventsPage`; it has no access to create/cancel/wait/result at the
    // type level, so this object literal below is the complete read
    // surface a caller can supply.
    const projection = await collectLiveProjection({
      list: async () => ({ items: [run] }),
      eventsPage: async (_runId, afterSeq) =>
        journal.read(run.agentRunId, afterSeq),
    });
    expect(projection.fleet.map((entry) => entry.agentRunId)).toEqual([
      "read-only-run",
    ]);
  });
});
