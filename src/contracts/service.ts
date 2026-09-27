import type {
  ObservationEnvelope,
  Page,
  RunCreateInput,
  HarnessName,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "./types.js";
import type { ExecutionPort, HarnessPort, JournalPort } from "./ports.js";
import type { RuntimeLimits } from "./limits.js";

export interface RunOperations<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
> {
  create(input: RunCreateInput<Request, Harness>): Promise<RunSnapshot>;
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

export interface RunService<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
> {
  runs: RunOperations<Request, Harness>;
  dispose(): Promise<void>;
}

export interface RunServiceOptions<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
> {
  execution: ExecutionPort<Request>;
  harness: HarnessPort;
  journal: JournalPort;
  limits?: Partial<RuntimeLimits>;
  harnessIdentity?: { name: Harness; version: string };
  validateInput?: (
    input: RunCreateInput<Request, Harness>,
    limits: RuntimeLimits,
  ) => RunCreateInput<Request, Harness>;
}

export interface MockRuntime extends RunService {
  /** Explicit fixture gate control, available only from tsukai/testing. */
  release(agentRunId: string): Promise<void>;
  journal: JournalPort;
}
