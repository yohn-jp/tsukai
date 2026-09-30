export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Lifecycle =
  | "accepted"
  | "starting"
  | "running"
  | "stopping"
  | "reconciling"
  | "uncertain"
  | "terminal";
export type SemanticState =
  "pending" | "active" | "settled" | "failed" | "aborted" | "unknown";
export type Activity =
  | "output"
  | "tool"
  | "retry"
  | "compaction"
  | "input_wait"
  | "idle"
  | "unknown";
export type Outcome = "completed" | "failed" | "cancelled" | "interrupted";
export type MockScenario =
  "normal" | "error" | "crash" | "retry" | "quiet" | "hold";
export type HarnessName = "mock" | "pi" | "claude-code";
export interface MockRunRequest {
  scenario: MockScenario;
  reportedText?: string;
  delayMs?: number;
}

export interface RunCreateInput<
  Request = MockRunRequest,
  Harness extends HarnessName = "mock",
> {
  harness: Harness;
  request: Request;
  parentRunId?: string;
  /**
   * Owner-internal: the authenticated principal AgentRun that spawned this run
   * through the agent-facing surface. Never accepted from clients; it must
   * equal `parentRunId` and is persisted as authorization metadata.
   */
  spawnedBy?: string;
  metadata?: Record<string, string>;
  workspace?: { cwd: string; workspaceSessionId?: string };
}

export interface PhysicalReceipt {
  executionRunId: string;
  status: "exited" | "uncertain";
  exitCode: number | null;
  signal: string | null;
  forced: boolean;
}

export interface ExecutionBinding {
  executionRunId: string;
  backend: string;
  pid?: number;
  sessionId?: string;
  piVersion?: string;
  piRevision?: string;
  /** Harness version reported by the harness itself (non-Pi adapters). */
  harnessVersion?: string;
}

export type RecoveryState =
  "none" | "pending" | "reconciling" | "attached" | "terminal" | "uncertain";

/** A preserved interval of evidence that the owner could not observe. */
export interface RecoveryGap {
  kind: "event" | "output" | "journal" | "observation";
  code: string;
  detectedAt: string;
}

/**
 * Restart reconciliation projection. Absent on a run that has never crossed an
 * owner restart. `gaps` never shrink: lost history stays a gap even after the
 * current state becomes known.
 */
export interface RunRecovery {
  state: RecoveryState;
  /** Number of owner restarts that loaded this run. */
  epoch: number;
  /** Number of backend reconciliation attempts so far. */
  attempts: number;
  reason?: string;
  gaps: RecoveryGap[];
  reconciledAt?: string;
}

export interface RunSnapshot {
  agentRunId: string;
  parentRunId?: string;
  /** Principal AgentRun that spawned this run via agent_spawn (authorization, not lineage). */
  spawnedBy?: string;
  harness: { name: HarnessName; version: string };
  metadata: Record<string, string>;
  workspace?: { cwd: string; workspaceSessionId?: string };
  lifecycle: Lifecycle;
  semantic: SemanticState;
  activity: Activity;
  revision: number;
  createdAt: string;
  updatedAt: string;
  execution?: ExecutionBinding;
  receipt?: PhysicalReceipt;
  outcome?: Outcome;
  reason?: string;
  completeness: "complete" | "incomplete";
  recovery?: RunRecovery;
}

export type RunResult =
  | { ready: false; agentRunId: string }
  | {
      ready: true;
      agentRunId: string;
      outcome: Outcome;
      reason: string;
      reportedText?: string;
      receipt?: PhysicalReceipt;
    };

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ObservationDraft {
  runId: string;
  source: "runtime" | "harness" | "execution";
  sourceIdentity?: string;
  sourceTime?: string;
  kind: string;
  payload: JsonObject;
}

export interface ObservationEnvelope extends ObservationDraft {
  schemaVersion: 1;
  seq: number;
  receivedAt: string;
}

export interface ObservationPage extends Page<ObservationEnvelope> {
  retainedFrom: number;
  gap: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class RunNotFoundError extends Error {
  readonly code = "RUN_NOT_FOUND";
  constructor(readonly agentRunId: string) {
    super(`AgentRun not found: ${agentRunId}`);
  }
}

export class UnsupportedBackendError extends Error {
  readonly code = "UNSUPPORTED_BACKEND";
  constructor(backend: string) {
    super(`Unsupported M0 backend: ${backend}`);
  }
}

export class WaitTimeoutError extends Error {
  readonly code = "WAIT_TIMEOUT";
  constructor() {
    super("Wait timed out");
  }
}
