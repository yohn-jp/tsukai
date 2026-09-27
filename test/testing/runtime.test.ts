import { afterEach, describe, expect, it } from "vitest";
import { createMockRuntime } from "../../src/testing/index.js";
import type { MockRuntime } from "../../src/contracts/service.js";

const runtimes: MockRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("createMockRuntime", () => {
  it("releases a held fixture and reports the result after physical exit", async () => {
    const runtime = createMockRuntime();
    runtimes.push(runtime);

    const accepted = await runtime.runs.create({
      harness: "mock",
      request: { scenario: "hold", reportedText: "fixture result" },
    });
    expect(accepted.lifecycle).not.toBe("terminal");
    expect(runtime.runs.result(accepted.agentRunId).ready).toBe(false);

    await runtime.release(accepted.agentRunId);
    const completed = await runtime.runs.wait(accepted.agentRunId, {
      timeoutMs: 2_000,
    });
    const result = runtime.runs.result(accepted.agentRunId);
    expect(completed.lifecycle).toBe("terminal");
    expect(completed.outcome).toBe("completed");
    expect(completed.receipt?.status).toBe("exited");
    expect(result).toMatchObject({
      ready: true,
      outcome: "completed",
      reportedText: "fixture result",
    });
  });
});
