import type {
  ObservationEnvelope,
  ObservationPage,
  Page,
  RunCreateInput,
  HarnessName,
  RunResult,
  RunSnapshot,
  WaitOptions,
} from "./types.js";
import type { ExecutionPort, HarnessPort, JournalPort } from "./ports.js";
import type { RuntimeLimits } from "./limits.js";
import type { DurableStore } from "./durable.js";

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
  eventsPage(
    agentRunId: string,
    afterSeq?: number,
    limit?: number,
  ): ObservationPage;
  result(agentRunId: string): RunResult;
}

export interface ReconcileReport {
  runs: {
    agentRunId: string;
    before: RunSnapshot["lifecycle"];
    after: RunSnapshot["lifecycle"];
    recovery: NonNullable<RunSnapshot["recovery"]>["state"];
  }[];
}

export interface RunService<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
> {
  runs: RunOperations<Request, Harness>;
  /**
   * Reconciles every persisted non-terminal run against backend evidence by
   * stable identity and cursor. Idempotent; never starts an execution or
   * resends a prompt. Without a durable store it is a no-op.
   */
  reconcile(): Promise<ReconcileReport>;
  /** Stops observing and closes stores but leaves physical executions running. */
  detach(): Promise<void>;
  /** Retires every owned execution (cancel) and closes stores. */
  dispose(): Promise<void>;
}

export interface RunServiceOptions<
  Request = RunCreateInput["request"],
  Harness extends HarnessName = "mock",
> {
  execution: ExecutionPort<Request>;
  harness: HarnessPort;
  journal: JournalPort;
  durableStore?: DurableStore;
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
