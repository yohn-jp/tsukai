import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../src/testing/index.js";
import { replayJournal } from "../../src/observation/index.js";

describe("integrated mock runtime", () => {
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
