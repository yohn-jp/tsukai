import type {
  ObservationEnvelope,
  Page,
  RunCreateInput,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "./types.js";
import type { ExecutionPort, HarnessPort, JournalPort } from "./ports.js";
import type { RuntimeLimits } from "./limits.js";

export interface RunOperations {
  create(input: RunCreateInput): Promise<RunSnapshot>;
  get(agentRunId: string): RunSnapshot;
  list(options?: { cursor?: string; limit?: number }): Page<RunSnapshot>;
  children(
    parentRunId: string,
    options?: { cursor?: string; limit?: number },
  ): Page<RunSnapshot>;
  wait(agentRunId: string, options?: WaitOptions): Promise<RunSnapshot>;
  cancel(agentRunId: string): Promise<RunSnapshot>;
  events(
    agentRunId: string,
    afterSeq?: number,
  ): AsyncIterable<ObservationEnvelope>;
  result(agentRunId: string): RunResult;
}

export interface RunService {
  runs: RunOperations;
  dispose(): Promise<void>;
}

export interface RunServiceOptions {
  execution: ExecutionPort;
  harness: HarnessPort;
  journal: JournalPort;
  limits?: Partial<RuntimeLimits>;
}

export interface MockRuntime extends RunService {
  /** Explicit fixture gate control, available only from tsukai/testing. */
  release(agentRunId: string): Promise<void>;
  journal: JournalPort;
}
