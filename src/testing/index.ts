import { createRunService } from "../application/index.js";
import { createMockExecutionPort } from "../adapters/mock/execution.js";
import {
  createMemoryJournal,
  createMockHarness,
} from "../observation/index.js";
import type { MockRuntime } from "../contracts/service.js";

/** Create an ephemeral AgentRun service backed only by fixed mock fixtures. */
export function createMockRuntime(): MockRuntime {
  const execution = createMockExecutionPort();
  const journal = createMemoryJournal();
  const service = createRunService({
    execution,
    harness: createMockHarness(),
    journal,
  });

  return {
    runs: service.runs,
    dispose: () => service.dispose(),
    release: (agentRunId) => execution.release(agentRunId),
    journal,
  };
}
