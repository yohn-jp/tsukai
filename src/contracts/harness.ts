import type { RuntimeLimits } from "./limits.js";
import type {
  PiAttachResult,
  PiDuplexExecution,
  PiDuplexExecutionPort,
  PiTransportObserver,
} from "./pi.js";
import type { ExecutionPort, HarnessPort } from "./ports.js";
import type { HarnessName, RunCreateInput } from "./types.js";
import type { ExecutionProfileCapabilities } from "./profile.js";

/**
 * Harness-neutral names for the byte-duplex execution seam first introduced
 * for Pi. Jinushi owns the process; adapters are the sole protocol writer.
 */
export type DuplexExecution = PiDuplexExecution;
export type DuplexExecutionPort = PiDuplexExecutionPort;
export type DuplexTransportObserver = PiTransportObserver;
export type DuplexAttachResult = PiAttachResult;

/**
 * How a Tsukai adapter handles one harness feature.
 *
 * - `native`: the adapter drives the harness's own mechanism.
 * - `unsupported`: the adapter never attempts it; a request fails explicitly
 *   with {@link HarnessCapabilityError}, and nothing is emulated.
 */
export type HarnessCapabilitySupport = "native" | "unsupported";

/**
 * Whether the harness itself offers a feature, as verified from its current
 * protocol authority. `unverified` means no authority was established; it is
 * never treated as available.
 */
export type HarnessNativeAvailability = "available" | "absent" | "unverified";

export interface HarnessControlCapability {
  /** What Tsukai does for this feature on runs of this harness. */
  tsukai: HarnessCapabilitySupport;
  native: HarnessNativeAvailability;
}

/** Availability of a harness-native metric in the observation journal. */
export type HarnessMetricAvailability =
  /** Provider/harness-reported values are recorded when the harness sends them. */
  | "reported"
  /** The harness reports an estimate, recorded and projected as such. */
  | "estimated"
  /** No authoritative source; projections report `unavailable`, never zero. */
  | "unavailable";

/**
 * Machine-readable capabilities of one harness adapter. Every entry describes
 * current Tsukai behavior backed by verified harness authority.
 */
export interface HarnessCapabilities {
  schemaVersion: 1;
  harness: { name: HarnessName; version: string };
  /** Wire protocol the adapter speaks, e.g. `pi-rpc-jsonl`. */
  protocol: string;
  /** Payload key under which harness-native observation detail is recorded. */
  evidenceNamespace: string;
  session: {
    /**
     * When the native session identity becomes known. `before-prompt`: from a
     * handshake before any prompt is written; `after-prompt`: from the
     * harness's first output for the prompt; `none`: never.
     */
    identity: "before-prompt" | "after-prompt" | "none";
  };
  prompt: {
    /** One submitted prompt per AgentRun; Tsukai never resends it. */
    delivery: "single";
    /**
     * `acknowledged`: the harness answers the prompt with an explicit
     * acceptance/disposition; `implicit`: only later harness output proves the
     * prompt was received.
     */
    acceptance: "acknowledged" | "implicit";
  };
  /** Native evidence that ends the harness's automatic continuation. */
  settlement: { evidence: string };
  cancellation: {
    /** Semantic abort request sent before physical retirement. */
    abort: HarnessCapabilitySupport;
    /** Physical retirement always goes through the execution owner. */
    retirement: "execution-owner";
  };
  steer: HarnessControlCapability;
  followUp: HarnessControlCapability;
  /** Required interactive input (permission/UI prompts) is never auto-approved. */
  interaction: HarnessControlCapability;
  observations: {
    tools: HarnessMetricAvailability;
    toolDurations: HarnessMetricAvailability;
    usage: HarnessMetricAvailability;
    cost: HarnessMetricAvailability;
    retry: HarnessMetricAvailability;
    compaction: HarnessMetricAvailability;
  };
  recovery: {
    /** Owner restart re-attaches by execution identity and cursor. */
    reattach: "output-replay" | "unsupported";
  };
  /** Which execution-profile dimensions Tsukai validates and projects. */
  executionProfile: ExecutionProfileCapabilities;
}

export type HarnessControlOperation = "steer" | "followUp";

/** Stable typed failure for a feature the run's harness adapter does not support. */
export class HarnessCapabilityError extends Error {
  readonly code = "HARNESS_CAPABILITY_UNSUPPORTED";
  constructor(
    readonly harness: HarnessName,
    readonly capability: string,
    readonly native: HarnessNativeAvailability,
  ) {
    super(
      `Harness ${harness} does not support ${capability} through Tsukai (native: ${native})`,
    );
    this.name = "HarnessCapabilityError";
  }
}

/**
 * One harness binding for the canonical RunService. The service chooses the
 * adapter from the run's harness identity; it never switches a persisted run
 * to another adapter.
 */
export interface HarnessAdapter<
  Request = unknown,
  Harness extends HarnessName = HarnessName,
> {
  identity: { name: Harness; version: string };
  capabilities: HarnessCapabilities;
  execution: ExecutionPort<Request>;
  harness: HarnessPort;
  validateInput(
    input: RunCreateInput<Request, Harness>,
    limits: RuntimeLimits,
  ): RunCreateInput<Request, Harness>;
}
