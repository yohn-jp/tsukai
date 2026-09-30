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
import type { HarnessAdapter, HarnessCapabilities } from "./harness.js";

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
  /**
   * Machine-readable capabilities of the run's harness adapter. Throws
   * `HarnessCapabilityError` when the run's harness advertises none.
   */
  capabilities(agentRunId: string): HarnessCapabilities;
  /**
   * Capability-checked before anything reaches the harness. Unsupported
   * operations reject with `HarnessCapabilityError`; nothing is emulated.
   */
  steer(agentRunId: string, message: string): Promise<never>;
  followUp(agentRunId: string, message: string): Promise<never>;
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
  /** Single-harness binding; omit when `adapters` is given. */
  execution?: ExecutionPort<Request>;
  harness?: HarnessPort;
  /**
   * Multi-harness binding. Each run is bound to the adapter named by its
   * harness identity for its whole life, including after owner restart.
   */
  adapters?: readonly HarnessAdapter<unknown, HarnessName>[];
  /** Single-harness capabilities; adapters carry their own. */
  capabilities?: HarnessCapabilities;
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
