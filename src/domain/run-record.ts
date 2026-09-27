import type { HarnessDecoder } from "../contracts/ports.js";
import type {
  Activity,
  ExecutionBinding,
  Lifecycle,
  Outcome,
  PhysicalReceipt,
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
  reconciling: new Set(["stopping", "uncertain", "terminal"]),
  uncertain: new Set(["stopping", "reconciling", "terminal"]),
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
    harness: { name: "mock", version: "mock-fixture-v1" },
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
            pid: run.execution.pid,
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
  };
}
