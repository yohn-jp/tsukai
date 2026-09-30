import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CrashError,
  PROMPT,
  startOwner,
  tempDir,
  until,
  WORKSPACE,
} from "./harness.js";
import { FakeSupervisor } from "./fake-supervisor.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(): { dir: string; sup: FakeSupervisor } {
  const temp = tempDir();
  cleanups.push(temp.cleanup);
  return { dir: temp.dir, sup: new FakeSupervisor() };
}

function allFiles(dir: string): string {
  let text = "";
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else text += `${readFileSync(full, "utf8")}\n`;
    }
  };
  walk(dir);
  return text;
}

const create = (owner: ReturnType<typeof startOwner>, extra = {}) =>
  owner.runtime.runs.create({
    harness: "pi",
    request: { prompt: PROMPT },
    workspace: WORKSPACE,
    ...extra,
  });

describe("durable AgentRun registry", () => {
  it("persists identity, lineage, binding, result metadata, and cursors across a clean restart", async () => {
    const { dir, sup } = setup();
    const first = startOwner(dir, sup);
    const parent = await create(first, { metadata: { label: "parent" } });
    const child = await create(first, { parentRunId: parent.agentRunId });
    const done = await first.runtime.runs.wait(child.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done.outcome).toBe("completed");
    await first.runtime.runs.wait(parent.agentRunId, { timeoutMs: 2_000 });
    await first.runtime.detach();

    const second = startOwner(dir, sup);
    const restored = second.runtime.runs.get(child.agentRunId);
    expect(restored).toMatchObject({
      agentRunId: child.agentRunId,
      parentRunId: parent.agentRunId,
      lifecycle: "terminal",
      outcome: "completed",
      reason: "pi_assistant_stop",
      execution: { sessionId: expect.stringMatching(/^pi-session-/) },
      receipt: { status: "exited" },
    });
    expect(second.runtime.runs.children(parent.agentRunId).items).toHaveLength(
      1,
    );
    expect(
      second.runtime.runs.list().items.map((run) => run.agentRunId),
    ).toEqual([parent.agentRunId, child.agentRunId]);
    const state = second.store
      .loadRuns()
      .find((entry) => entry.snapshot.agentRunId === child.agentRunId)!;
    expect(state.cursor.stdoutOffset).toBeGreaterThan(0);
    expect(state.cursor.eventSeq).toBeGreaterThan(0);
    expect(state.intent.startRequested).toBe(true);
    expect(state.dispatch).toBe("accepted");
    expect(second.runtime.runs.result(child.agentRunId)).toMatchObject({
      ready: true,
      outcome: "completed",
    });
    // The journal keeps counting from the persisted head.
    const page = second.runtime.journal.read(child.agentRunId);
    expect(page.gap).toBe(false);
    expect(page.items.at(-1)!.seq).toBe(
      second.store.journalHead(child.agentRunId).lastSeq,
    );
    expect(sup.runStarts).toBe(2);
    expect(sup.prompts).toBe(2);
    await second.runtime.detach();
  });

  it("stays metadata-only: prompt and assistant text never reach disk", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    const run = await create(owner);
    await owner.runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    expect(owner.runtime.runs.result(run.agentRunId)).toMatchObject({
      reportedText: "private answer",
    });
    await owner.runtime.detach();
    const disk = allFiles(dir);
    expect(disk).not.toContain(PROMPT);
    expect(disk).not.toContain("private answer");
    expect(disk).toContain(run.agentRunId);
    const restarted = startOwner(dir, sup);
    const result = restarted.runtime.runs.result(run.agentRunId);
    expect(result).toMatchObject({ ready: true, outcome: "completed" });
    expect(result).not.toHaveProperty("reportedText");
    await restarted.runtime.detach();
  });
});

describe("crash-consistent ordering", () => {
  it("intent persisted, external start unknown: uncertain, never restarted", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    owner.store.armAfter((state) => state.intent.startRequested);
    await expect(create(owner)).rejects.toBeInstanceOf(CrashError);
    expect(sup.runStarts).toBe(0);

    const restarted = startOwner(dir, sup);
    const [run] = restarted.runtime.runs.list().items;
    expect(run).toMatchObject({
      lifecycle: "uncertain",
      semantic: "unknown",
      completeness: "incomplete",
      recovery: {
        state: "uncertain",
        reason: "execution-start-unconfirmed-after-restart",
      },
    });
    expect(run!.execution).toBeUndefined();
    await restarted.runtime.runs.wait(run!.agentRunId, { timeoutMs: 500 });
    const report = await restarted.runtime.reconcile();
    expect(report.runs).toEqual([]);
    expect(sup.runCalls).toBe(0);
    expect(sup.prompts).toBe(0);
    await restarted.runtime.detach();
  });

  it("a run whose start was never requested ends failed without an execution", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    // Crash after the identity commit but before the intent commit.
    owner.store.armAfter((state) => !state.intent.startRequested);
    await expect(create(owner)).rejects.toBeInstanceOf(CrashError);
    const restarted = startOwner(dir, sup);
    const [run] = restarted.runtime.runs.list().items;
    expect(run).toMatchObject({
      lifecycle: "terminal",
      outcome: "failed",
      reason: "owner-restarted-before-start",
      recovery: { state: "terminal" },
    });
    expect(sup.runCalls).toBe(0);
    await restarted.runtime.detach();
  });

  it("external start happened, binding not persisted: uncertain, prompt never delivered", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    owner.store.armBefore((state) => state.snapshot.execution !== undefined);
    await create(owner).catch(() => undefined);
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(0);

    const restarted = startOwner(dir, sup);
    const [run] = restarted.runtime.runs.list().items;
    expect(run).toMatchObject({
      lifecycle: "uncertain",
      recovery: { reason: "execution-start-unconfirmed-after-restart" },
    });
    expect(run!.execution).toBeUndefined();
    await restarted.runtime.reconcile();
    // No lookup invents a binding and no second execution appears.
    expect(sup.runStarts).toBe(1);
    expect(sup.runCalls).toBe(1);
    expect(sup.prompts).toBe(0);
    expect(sup.promptsSeen(sup.only())).toBe(0);
    await restarted.runtime.detach();
  });

  it("binding persisted, acknowledgement and prompt interrupted: attached but prompt never dispatched", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    owner.store.armAfter((state) => state.snapshot.execution !== undefined);
    await create(owner).catch(() => undefined);
    expect(sup.prompts).toBe(0);

    const restarted = startOwner(dir, sup);
    const [before] = restarted.runtime.runs.list().items;
    expect(before).toMatchObject({
      lifecycle: "reconciling",
      execution: { executionRunId: sup.only().runId },
    });
    await restarted.runtime.reconcile();
    const after = restarted.runtime.runs.get(before!.agentRunId);
    expect(after).toMatchObject({
      lifecycle: "uncertain",
      recovery: { state: "uncertain", reason: "prompt-not-dispatched" },
    });
    expect(sup.prompts).toBe(0);
    expect(sup.runStarts).toBe(1);
    await restarted.runtime.detach();
  });

  it("prompt dispatch requested but never reached Pi: prompt is not resent", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    owner.store.armAfter((state) => state.dispatch === "requested");
    await create(owner).catch(() => undefined);
    await until(() => owner.store.isDead);
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const [run] = restarted.runtime.runs.list().items;
    expect(run).toMatchObject({
      lifecycle: "uncertain",
      recovery: { reason: "prompt-delivery-unconfirmed" },
    });
    expect(sup.prompts).toBe(0);
    await restarted.runtime.detach();
  });

  it("prompt reached Pi but its acceptance was not persisted: recovered from the stream", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    owner.store.armBefore((state) => state.dispatch === "accepted");
    await create(owner).catch(() => undefined);
    await until(() => owner.store.isDead);
    expect(sup.prompts).toBe(1);

    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const [run] = restarted.runtime.runs.list().items;
    const done = await restarted.runtime.runs.wait(run!.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
      receipt: { status: "exited" },
      execution: { sessionId: expect.stringMatching(/^pi-session-/) },
    });
    expect(sup.prompts).toBe(1);
    expect(sup.runStarts).toBe(1);
    await restarted.runtime.detach();
  });
});

describe("restart reconciliation", () => {
  it("re-attaches to a running execution, never relaunching or resending", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    const cursorBefore = owner.store
      .loadRuns()
      .find(
        (entry) => entry.snapshot.agentRunId === created.agentRunId,
      )!.cursor;
    owner.crash();

    const restarted = startOwner(dir, sup);
    expect(restarted.runtime.runs.get(created.agentRunId)).toMatchObject({
      lifecycle: "reconciling",
      recovery: { state: "pending", epoch: 1 },
    });
    const report = await restarted.runtime.reconcile();
    expect(report.runs).toEqual([
      {
        agentRunId: created.agentRunId,
        before: "reconciling",
        after: "running",
        recovery: "attached",
      },
    ]);
    expect(restarted.runtime.runs.get(created.agentRunId)).toMatchObject({
      agentRunId: created.agentRunId,
      execution: { executionRunId: sup.only().runId },
      recovery: { state: "attached", epoch: 1 },
    });

    sup.releaseTranscript(sup.only());
    const done = await restarted.runtime.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
      receipt: { status: "exited", executionRunId: sup.only().runId },
      recovery: { state: "terminal" },
    });
    expect(sup.runStarts).toBe(1);
    expect(sup.runCalls).toBe(1);
    expect(sup.prompts).toBe(1);
    const cursorAfter = restarted.store
      .loadRuns()
      .find(
        (entry) => entry.snapshot.agentRunId === created.agentRunId,
      )!.cursor;
    expect(cursorAfter.stdoutOffset).toBeGreaterThanOrEqual(
      cursorBefore.stdoutOffset,
    );
    expect(cursorAfter.eventSeq).toBeGreaterThanOrEqual(cursorBefore.eventSeq);
    await restarted.runtime.detach();
  });

  it("recovers physical terminal evidence that arrived while no owner was alive", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    owner.crash();
    sup.releaseTranscript(sup.only());
    sup.terminate(sup.only(), 0);

    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const done = restarted.runtime.runs.get(created.agentRunId);
    expect(done).toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
      reason: "pi_assistant_stop",
      receipt: { status: "exited", exitCode: 0, forced: false },
      recovery: { state: "terminal" },
    });
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
    await restarted.runtime.detach();
  });

  it("finishes a persisted settlement decision without reinterpreting missing text", async () => {
    const { dir, sup } = setup();
    sup.exitOnCloseInput = false;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(
      () =>
        owner.runtime.runs.get(created.agentRunId).lifecycle === "stopping" &&
        sup.only().inputClosed,
    );
    owner.crash();
    const durable = startOwner(dir, sup);
    expect(durable.store.loadRuns()[0]!.candidate).toMatchObject({
      outcome: "completed",
    });
    durable.crash();
    sup.exitOnCloseInput = true;
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const done = await restarted.runtime.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    expect(
      restarted.runtime.runs.result(created.agentRunId),
    ).not.toHaveProperty("reportedText");
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
    await restarted.runtime.detach();
  });

  it("cancels through the canonical owner after a restart", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    owner.crash();
    const restarted = startOwner(dir, sup);
    const cancelled = await restarted.runtime.runs.cancel(created.agentRunId);
    expect(cancelled.agentRunId).toBe(created.agentRunId);
    const done = await restarted.runtime.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "cancelled" });
    expect(sup.prompts).toBe(1);
    await restarted.runtime.detach();
  });
});

describe("explicit uncertainty and gaps", () => {
  it("surfaces a backend that no longer knows the execution as uncertain, never terminal", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    owner.crash();
    sup.runs.clear();
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const run = restarted.runtime.runs.get(created.agentRunId);
    expect(run).toMatchObject({
      lifecycle: "uncertain",
      completeness: "incomplete",
      recovery: {
        state: "uncertain",
        reason: "execution-missing-from-backend",
      },
    });
    expect(run.outcome).toBeUndefined();
    expect(restarted.runtime.runs.result(created.agentRunId).ready).toBe(false);
    expect(sup.runCalls).toBe(1);
    await restarted.runtime.detach();
  });

  it("keeps an unreachable backend uncertain, then resolves on later evidence", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    owner.crash();
    sup.outage = true;
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    expect(restarted.runtime.runs.get(created.agentRunId)).toMatchObject({
      lifecycle: "uncertain",
      recovery: { state: "uncertain", reason: "jinushi-inspect-failed" },
    });
    sup.outage = false;
    sup.releaseTranscript(sup.only());
    await restarted.runtime.reconcile();
    const done = await restarted.runtime.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ lifecycle: "terminal", outcome: "completed" });
    expect(done.recovery!.attempts).toBe(2);
    expect(sup.runStarts).toBe(1);
    expect(sup.prompts).toBe(1);
    await restarted.runtime.detach();
  });

  it("preserves an output gap even after the physical exit is known", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(() => sup.only().heldTranscript);
    owner.crash();
    const run = sup.only();
    sup.compactStdout(run, 10);
    sup.releaseTranscript(run);
    sup.terminate(run, 0);
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    const snapshot = restarted.runtime.runs.get(created.agentRunId);
    expect(snapshot).toMatchObject({
      lifecycle: "uncertain",
      semantic: "unknown",
      completeness: "incomplete",
      reason: "physical-exit-with-observation-gap",
      receipt: { status: "exited", exitCode: 0 },
    });
    expect(snapshot.outcome).toBeUndefined();
    expect(snapshot.recovery!.gaps).toEqual([
      expect.objectContaining({ kind: "output", code: "JINUSHI_OUTPUT_GAP" }),
    ]);
    expect(
      restarted.runtime.journal
        .read(created.agentRunId)
        .items.some((event) => event.kind === "run.gap"),
    ).toBe(true);
    expect(sup.prompts).toBe(1);
    await restarted.runtime.detach();
  });

  it("records an event-history gap and keeps a persisted decision terminal-capable", async () => {
    const { dir, sup } = setup();
    sup.exitOnCloseInput = false;
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await until(
      () =>
        owner.runtime.runs.get(created.agentRunId).lifecycle === "stopping" &&
        sup.only().inputClosed,
    );
    owner.crash();
    const run = sup.only();
    // History moves on while no owner is alive, then its head is compacted.
    for (let index = 0; index < 4; index++) sup.event(run, "run.note");
    sup.compactEvents(run, run.events.at(-1)!.seq);
    sup.exitOnCloseInput = true;
    const restarted = startOwner(dir, sup);
    await restarted.runtime.reconcile();
    // Event history is evaluated when the follow's first page arrives.
    await until(
      () =>
        restarted.runtime.runs.get(created.agentRunId).recovery?.gaps.length,
    );
    expect(restarted.runtime.runs.get(created.agentRunId)).toMatchObject({
      lifecycle: "uncertain",
      recovery: { gaps: [expect.objectContaining({ kind: "event" })] },
    });
    sup.terminate(run, 0);
    await restarted.runtime.runs.wait(created.agentRunId, { timeoutMs: 100 });
    const done = await until(() => {
      const snapshot = restarted.runtime.runs.get(created.agentRunId);
      return snapshot.lifecycle === "terminal" && snapshot;
    });
    // The semantic decision was durable, so the physical exit can finalize it,
    // but the lost history stays visible.
    expect(done).toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
      completeness: "incomplete",
    });
    expect(done.recovery!.gaps).toEqual([
      expect.objectContaining({ kind: "event", code: "JINUSHI_EVENT_GAP" }),
    ]);
    await restarted.runtime.detach();
  });

  it("marks a discarded journal tail as a journal gap instead of fabricating continuity", async () => {
    const { dir, sup } = setup();
    const owner = startOwner(dir, sup);
    const created = await create(owner);
    await owner.runtime.runs.wait(created.agentRunId, { timeoutMs: 2_000 });
    await owner.runtime.detach();
    const journal = join(
      dir,
      "store",
      "journal",
      `${created.agentRunId}.jsonl`,
    );
    const text = readFileSync(journal, "utf8");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(journal, `${text}{"schemaVersion":1,"runId":"torn`);
    const restarted = startOwner(dir, sup);
    const run = restarted.runtime.runs.get(created.agentRunId);
    expect(run).toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
      completeness: "incomplete",
    });
    expect(run.recovery!.gaps).toEqual([
      expect.objectContaining({
        kind: "journal",
        code: "journal-tail-discarded",
      }),
    ]);
    const page = restarted.runtime.journal.read(created.agentRunId);
    expect(
      page.items.every((event) => event.runId === created.agentRunId),
    ).toBe(true);
    await restarted.runtime.detach();
  });
});

describe("repeated recovery", () => {
  it("converges: reconcile and restart can repeat without new effects", async () => {
    const { dir, sup } = setup();
    sup.holdTranscript = true;
    const first = startOwner(dir, sup);
    const created = await create(first);
    await until(() => sup.only().heldTranscript);
    first.crash();

    const second = startOwner(dir, sup);
    await second.runtime.reconcile();
    const once = second.runtime.runs.get(created.agentRunId);
    const journalOnce = second.runtime.journal.export(created.agentRunId);
    const again = await second.runtime.reconcile();
    expect(again.runs).toEqual([]);
    expect(second.runtime.runs.get(created.agentRunId)).toEqual(once);
    expect(second.runtime.journal.export(created.agentRunId)).toBe(journalOnce);
    second.crash();

    // A third owner, without any progress in between, reaches the same place.
    const third = startOwner(dir, sup);
    await third.runtime.reconcile();
    await third.runtime.reconcile();
    expect(third.runtime.runs.get(created.agentRunId)).toMatchObject({
      lifecycle: "running",
      recovery: { state: "attached", epoch: 2 },
    });
    sup.releaseTranscript(sup.only());
    const done = await third.runtime.runs.wait(created.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done.outcome).toBe("completed");
    const events = third.runtime.journal.read(created.agentRunId, 0, 100).items;
    // Replayed stdout frames never duplicate an observation.
    const identities = events
      .filter((event) => event.sourceIdentity !== undefined)
      .map((event) => event.sourceIdentity);
    expect(new Set(identities).size).toBe(identities.length);
    expect(sup.runStarts).toBe(1);
    expect(sup.runCalls).toBe(1);
    expect(sup.prompts).toBe(1);
    await third.runtime.detach();
  });
});
