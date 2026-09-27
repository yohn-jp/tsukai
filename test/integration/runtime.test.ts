import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../src/testing/index.js";
import { replayJournal } from "../../src/observation/index.js";

describe("integrated mock runtime", () => {
  it("uses settlement and proven exit for real fixture crash, error, retry, and quiet traces", async () => {
    const runtime = createMockRuntime();
    try {
      const [crash, error, retry, quiet] = await Promise.all([
        runtime.runs.create({
          harness: "mock",
          request: { scenario: "crash" },
        }),
        runtime.runs.create({
          harness: "mock",
          request: { scenario: "error" },
        }),
        runtime.runs.create({
          harness: "mock",
          request: { scenario: "retry" },
        }),
        runtime.runs.create({
          harness: "mock",
          request: { scenario: "quiet" },
        }),
      ] as const);
      const [crashed, failed, retried] = await Promise.all([
        runtime.runs.wait(crash.agentRunId, { timeoutMs: 5000 }),
        runtime.runs.wait(error.agentRunId, { timeoutMs: 5000 }),
        runtime.runs.wait(retry.agentRunId, { timeoutMs: 5000 }),
      ] as const);
      expect(crashed).toMatchObject({
        outcome: "interrupted",
        receipt: { status: "exited" },
      });
      expect(failed).toMatchObject({
        outcome: "failed",
        receipt: { status: "exited" },
      });
      expect(retried).toMatchObject({
        outcome: "completed",
        receipt: { status: "exited" },
      });
      const firstResult = runtime.runs.result(retry.agentRunId);
      expect(runtime.runs.result(retry.agentRunId)).toEqual(firstResult);
      expect(runtime.runs.get(retry.agentRunId).revision).toBe(
        retried.revision,
      );
      const kinds = runtime.journal
        .read(retry.agentRunId, 0, 100)
        .items.map((event) => event.kind);
      expect(kinds.indexOf("harness.agent_end")).toBeLessThan(
        kinds.indexOf("harness.retry"),
      );
      expect(kinds.indexOf("harness.retry")).toBeLessThan(
        kinds.indexOf("harness.agent_settled"),
      );
      await expect(
        runtime.runs.wait(quiet.agentRunId, { timeoutMs: 30 }),
      ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
      expect(runtime.runs.get(quiet.agentRunId).lifecycle).not.toBe("terminal");
      await runtime.runs.cancel(quiet.agentRunId);
      const stopped = await runtime.runs.wait(quiet.agentRunId, {
        timeoutMs: 5000,
      });
      expect(stopped.outcome).toBe("cancelled");
      expect(stopped.receipt?.status).toBe("exited");
    } finally {
      await runtime.dispose();
    }
  }, 15000);

  it("keeps result text out of replay and rejects private caller metadata", async () => {
    const runtime = createMockRuntime();
    try {
      await expect(
        runtime.runs.create({
          harness: "mock",
          request: { scenario: "normal" },
          metadata: { secret: "private-value" },
        }),
      ).rejects.toThrow();
      const run = await runtime.runs.create({
        harness: "mock",
        request: { scenario: "normal", reportedText: "private-result" },
        metadata: { label: "safe" },
      });
      await runtime.runs.wait(run.agentRunId, { timeoutMs: 5000 });
      expect(runtime.runs.result(run.agentRunId)).toMatchObject({
        ready: true,
        reportedText: "private-result",
      });
      const jsonl = runtime.journal.export();
      expect(jsonl).not.toContain("private-result");
      expect(jsonl).not.toContain("private-value");
      expect(replayJournal(jsonl).runs).toEqual([
        runtime.runs.get(run.agentRunId),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps three actual workers and parent/child lifetimes independent", async () => {
    const runtime = createMockRuntime();
    try {
      const parent = await runtime.runs.create({
        harness: "mock",
        request: { scenario: "hold" },
      });
      const child = await runtime.runs.create({
        harness: "mock",
        request: { scenario: "normal" },
        parentRunId: parent.agentRunId,
      });
      const independent = await runtime.runs.create({
        harness: "mock",
        request: { scenario: "hold" },
      });
      const bindings = [parent, child, independent].map((run) => run.execution);
      expect(new Set(bindings.map((binding) => binding?.pid)).size).toBe(3);
      expect(
        new Set(bindings.map((binding) => binding?.executionRunId)).size,
      ).toBe(3);
      expect(
        runtime.runs
          .children(parent.agentRunId)
          .items.map((run) => run.agentRunId),
      ).toEqual([child.agentRunId]);
      expect(runtime.runs.result(parent.agentRunId).ready).toBe(false);

      await expect(
        runtime.runs.wait(parent.agentRunId, { timeoutMs: 20 }),
      ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
      const childTerminal = await runtime.runs.wait(child.agentRunId, {
        timeoutMs: 5000,
      });
      expect(childTerminal.outcome).toBe("completed");
      expect(childTerminal.receipt?.status).toBe("exited");
      expect(runtime.runs.get(parent.agentRunId).lifecycle).not.toBe(
        "terminal",
      );

      await Promise.all([
        runtime.runs.cancel(independent.agentRunId),
        runtime.runs.cancel(independent.agentRunId),
      ]);
      const cancelled = await runtime.runs.wait(independent.agentRunId, {
        timeoutMs: 5000,
      });
      expect(cancelled.outcome).toBe("cancelled");
      expect(cancelled.receipt?.status).toBe("exited");
      expect(runtime.runs.get(parent.agentRunId).lifecycle).not.toBe(
        "terminal",
      );

      await runtime.release(parent.agentRunId);
      const terminal = await runtime.runs.wait(parent.agentRunId, {
        timeoutMs: 5000,
      });
      expect(terminal.outcome).toBe("completed");
      expect(terminal.receipt?.status).toBe("exited");

      const replayed = replayJournal(runtime.journal.export());
      expect(replayed.incomplete).toBe(false);
      const live = runtime.runs
        .list()
        .items.sort((a, b) => a.agentRunId.localeCompare(b.agentRunId));
      expect(
        replayed.runs.sort((a, b) => a.agentRunId.localeCompare(b.agentRunId)),
      ).toEqual(live);
    } finally {
      await runtime.dispose();
    }
  }, 15000);
});
