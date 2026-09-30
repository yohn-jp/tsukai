import type { HarnessDecoder } from "../contracts/ports.js";
import type {
  Activity,
  ExecutionBinding,
  HarnessName,
  Lifecycle,
  Outcome,
  PhysicalReceipt,
  RunRecovery,
  RunSnapshot,
  SemanticState,
} from "../contracts/types.js";

export interface OutcomeCandidate {
  outcome: Outcome;
  semantic: SemanticState;
  reason: string;
  reportedText?: string;
}

export interface RunRecord {
  agentRunId: string;
  harness: { name: HarnessName; version: string };
  parentRunId?: string;
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
  pendingReceipt?: PhysicalReceipt;
  pendingBindingUpdate?: ExecutionBinding;
  outcome?: Outcome;
  reason?: string;
  completeness: "complete" | "incomplete";
  decoder: HarnessDecoder;
  waiters: Set<() => void>;
  outcomeCandidate?: OutcomeCandidate;
  reportedText?: string;
  retirementRequests: Set<"settled" | "cancel">;
  cancelIntentSeen: boolean;
  decoderFinished: boolean;
  /** Durable-owner state; unused by the ephemeral mock owner. */
  recovery?: RunRecovery;
  cursor: { eventSeq: number; stdoutOffset: number; stderrOffset: number };
  startRequested: boolean;
  dispatch?: "requested" | "accepted";
  /** True while this process holds a live observation of the execution. */
  attached: boolean;
  /** Set when a state commit failed; durable state is then behind memory. */
  persistFailed: boolean;
}

export type RunChanges = Partial<
  Pick<
    RunRecord,
    | "activity"
    | "completeness"
    | "execution"
    | "lifecycle"
    | "outcome"
    | "receipt"
    | "reason"
    | "semantic"
    | "recovery"
  >
>;

const allowedLifecycleChanges: Record<Lifecycle, ReadonlySet<Lifecycle>> = {
  accepted: new Set(["starting", "terminal", "reconciling", "uncertain"]),
  starting: new Set([
    "running",
    "stopping",
    "reconciling",
    "uncertain",
    "terminal",
  ]),
  running: new Set(["stopping", "reconciling", "uncertain", "terminal"]),
  stopping: new Set(["reconciling", "uncertain", "terminal"]),
  reconciling: new Set(["running", "stopping", "uncertain", "terminal"]),
  uncertain: new Set(["running", "stopping", "reconciling", "terminal"]),
  terminal: new Set(),
};

export function changeRun(run: RunRecord, changes: RunChanges): boolean {
  if (run.lifecycle === "terminal") return false;
  const nextLifecycle = changes.lifecycle;
  if (
    nextLifecycle !== undefined &&
    nextLifecycle !== run.lifecycle &&
    !allowedLifecycleChanges[run.lifecycle].has(nextLifecycle)
  ) {
    throw new Error(
      `Invalid AgentRun lifecycle transition: ${run.lifecycle} -> ${nextLifecycle}`,
    );
  }

  let changed = false;
  for (const key of Object.keys(changes) as (keyof RunChanges)[]) {
    const value = changes[key];
    if (value !== undefined && run[key] !== value) {
      (run as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;
  run.revision += 1;
  run.updatedAt = new Date().toISOString();
  return true;
}

export function toSnapshot(run: RunRecord): RunSnapshot {
  return {
    agentRunId: run.agentRunId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    harness: { ...run.harness },
    metadata: { ...run.metadata },
    ...(run.workspace === undefined
      ? {}
      : {
          workspace: {
            cwd: run.workspace.cwd,
            ...(run.workspace.workspaceSessionId === undefined
              ? {}
              : { workspaceSessionId: run.workspace.workspaceSessionId }),
          },
        }),
    lifecycle: run.lifecycle,
    semantic: run.semantic,
    activity: run.activity,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.execution === undefined
      ? {}
      : {
          execution: {
            executionRunId: run.execution.executionRunId,
            backend: run.execution.backend,
            ...(run.execution.pid === undefined
              ? {}
              : { pid: run.execution.pid }),
            ...(run.execution.sessionId === undefined
              ? {}
              : { sessionId: run.execution.sessionId }),
            ...(run.execution.piVersion === undefined
              ? {}
              : { piVersion: run.execution.piVersion }),
            ...(run.execution.piRevision === undefined
              ? {}
              : { piRevision: run.execution.piRevision }),
          },
        }),
    ...(run.receipt === undefined
      ? {}
      : {
          receipt: {
            executionRunId: run.receipt.executionRunId,
            status: run.receipt.status,
            exitCode: run.receipt.exitCode,
            signal: run.receipt.signal,
            forced: run.receipt.forced,
          },
        }),
    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
    ...(run.reason === undefined ? {} : { reason: run.reason }),
    completeness: run.completeness,
    ...(run.recovery === undefined
      ? {}
      : {
          recovery: {
            state: run.recovery.state,
            epoch: run.recovery.epoch,
            attempts: run.recovery.attempts,
            ...(run.recovery.reason === undefined
              ? {}
              : { reason: run.recovery.reason }),
            gaps: run.recovery.gaps.map((gap) => ({ ...gap })),
            ...(run.recovery.reconciledAt === undefined
              ? {}
              : { reconciledAt: run.recovery.reconciledAt }),
          },
        }),
  };
}
