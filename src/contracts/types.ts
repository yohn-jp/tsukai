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
export type HarnessName = "mock" | "pi";
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
}

export interface RunSnapshot {
  agentRunId: string;
  parentRunId?: string;
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
