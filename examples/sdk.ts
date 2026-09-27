import { createMockRuntime } from "tsukai/testing";

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
  await runtime.release(parent.agentRunId);
  for (const run of [parent, child]) {
    const terminal = await runtime.runs.wait(run.agentRunId, {
      timeoutMs: 5000,
    });
    console.log(
      terminal.agentRunId,
      terminal.outcome,
      runtime.runs.result(run.agentRunId),
    );
  }
  console.log(runtime.journal.export()); // metadata only; no reported text
} finally {
  await runtime.dispose();
}
