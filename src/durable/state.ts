import type { DurableRunState } from "../contracts/durable.js";
import type {
  Activity,
  ExecutionBinding,
  HarnessName,
  Lifecycle,
  Outcome,
  PhysicalReceipt,
  RecoveryGap,
  RecoveryState,
  RunRecovery,
  RunSnapshot,
  SemanticState,
} from "../contracts/types.js";
import { isRecord } from "../observation/json.js";
import { parseEffectiveExecutionProfile } from "../domain/execution-profile.js";

export class DurableStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStateError";
  }
}

const LIFECYCLES = new Set<Lifecycle>([
  "accepted",
  "starting",
  "running",
  "stopping",
  "reconciling",
  "uncertain",
  "terminal",
]);
const SEMANTICS = new Set<SemanticState>([
  "pending",
  "active",
  "settled",
  "failed",
  "aborted",
  "unknown",
]);
const ACTIVITIES = new Set<Activity>([
  "output",
  "tool",
  "retry",
  "compaction",
  "input_wait",
  "idle",
  "unknown",
]);
const OUTCOMES = new Set<Outcome>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const RECOVERY_STATES = new Set<RecoveryState>([
  "none",
  "pending",
  "reconciling",
  "attached",
  "terminal",
  "uncertain",
]);
const GAP_KINDS = new Set(["event", "output", "journal", "observation"]);
export const MAX_RECOVERY_GAPS = 16;

function bad(message: string): never {
  throw new DurableStateError(`Invalid durable run state: ${message}`);
}

function str(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    bad(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function optStr(
  record: Record<string, unknown>,
  name: string,
  max = 4096,
): string | undefined {
  return record[name] === undefined ? undefined : str(record[name], name, max);
}

function int(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    bad(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") bad(`${name} must be a boolean`);
  return value;
}

function isHarnessName(value: unknown): value is HarnessName {
  return value === "mock" || value === "pi" || value === "claude-code";
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) bad(`${name} must be an object`);
  return value;
}

function parseBinding(value: unknown): ExecutionBinding {
  const record = obj(value, "execution");
  const binding: ExecutionBinding = {
    executionRunId: str(record.executionRunId, "execution.executionRunId", 256),
    backend: str(record.backend, "execution.backend", 256),
  };
  if (record.pid !== undefined) binding.pid = int(record.pid, "execution.pid");
  const sessionId = optStr(record, "sessionId", 256);
  if (sessionId !== undefined) binding.sessionId = sessionId;
  const piVersion = optStr(record, "piVersion", 128);
  if (piVersion !== undefined) binding.piVersion = piVersion;
  const piRevision = optStr(record, "piRevision", 128);
  if (piRevision !== undefined) binding.piRevision = piRevision;
  const harnessVersion = optStr(record, "harnessVersion", 128);
  if (harnessVersion !== undefined) binding.harnessVersion = harnessVersion;
  return binding;
}

function parseReceipt(value: unknown): PhysicalReceipt {
  const record = obj(value, "receipt");
  if (record.status !== "exited" && record.status !== "uncertain") {
    bad("receipt.status is invalid");
  }
  if (record.exitCode !== null) int(record.exitCode, "receipt.exitCode");
  if (record.signal !== null) str(record.signal, "receipt.signal", 128);
  return {
    executionRunId: str(record.executionRunId, "receipt.executionRunId", 256),
    status: record.status,
    exitCode: record.exitCode as number | null,
    signal: record.signal as string | null,
    forced: bool(record.forced, "receipt.forced"),
  };
}

function parseRecovery(value: unknown): RunRecovery {
  const record = obj(value, "recovery");
  if (
    typeof record.state !== "string" ||
    !RECOVERY_STATES.has(record.state as RecoveryState)
  ) {
    bad("recovery.state is invalid");
  }
  if (!Array.isArray(record.gaps) || record.gaps.length > MAX_RECOVERY_GAPS) {
    bad("recovery.gaps must be a bounded array");
  }
  const gaps: RecoveryGap[] = record.gaps.map((gap: unknown) => {
    const entry = obj(gap, "recovery gap");
    if (typeof entry.kind !== "string" || !GAP_KINDS.has(entry.kind)) {
      bad("recovery gap kind is invalid");
    }
    return {
      kind: entry.kind as RecoveryGap["kind"],
      code: str(entry.code, "recovery gap code", 128),
      detectedAt: str(entry.detectedAt, "recovery gap detectedAt", 64),
    };
  });
  const recovery: RunRecovery = {
    state: record.state as RecoveryState,
    epoch: int(record.epoch, "recovery.epoch"),
    attempts: int(record.attempts, "recovery.attempts"),
    gaps,
  };
  const reason = optStr(record, "reason", 256);
  if (reason !== undefined) recovery.reason = reason;
  const reconciledAt = optStr(record, "reconciledAt", 64);
  if (reconciledAt !== undefined) recovery.reconciledAt = reconciledAt;
  return recovery;
}

function parseSnapshot(value: unknown): RunSnapshot {
  const record = obj(value, "snapshot");
  const harness = obj(record.harness, "snapshot.harness");
  if (!isHarnessName(harness.name)) {
    bad("snapshot.harness.name is invalid");
  }
  const metadataRecord = obj(record.metadata, "snapshot.metadata");
  const metadata: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, entry] of Object.entries(metadataRecord)) {
    metadata[key] = typeof entry === "string" ? entry : bad("metadata value");
  }
  if (
    typeof record.lifecycle !== "string" ||
    !LIFECYCLES.has(record.lifecycle as Lifecycle) ||
    typeof record.semantic !== "string" ||
    !SEMANTICS.has(record.semantic as SemanticState) ||
    typeof record.activity !== "string" ||
    !ACTIVITIES.has(record.activity as Activity) ||
    (record.completeness !== "complete" && record.completeness !== "incomplete")
  ) {
    bad("snapshot state enums are invalid");
  }
  const snapshot: RunSnapshot = {
    agentRunId: str(record.agentRunId, "snapshot.agentRunId", 256),
    harness: {
      name: harness.name,
      version: str(harness.version, "snapshot.harness.version", 128),
    },
    metadata,
    lifecycle: record.lifecycle as Lifecycle,
    semantic: record.semantic as SemanticState,
    activity: record.activity as Activity,
    revision: int(record.revision, "snapshot.revision"),
    createdAt: str(record.createdAt, "snapshot.createdAt", 64),
    updatedAt: str(record.updatedAt, "snapshot.updatedAt", 64),
    completeness: record.completeness,
  };
  const parentRunId = optStr(record, "parentRunId", 256);
  if (parentRunId !== undefined) snapshot.parentRunId = parentRunId;
  const spawnedBy = optStr(record, "spawnedBy", 256);
  if (spawnedBy !== undefined) {
    if (spawnedBy !== parentRunId)
      bad("snapshot.spawnedBy must equal parentRunId");
    snapshot.spawnedBy = spawnedBy;
  }
  if (record.workspace !== undefined) {
    const workspace = obj(record.workspace, "snapshot.workspace");
    const workspaceSessionId = optStr(workspace, "workspaceSessionId", 256);
    snapshot.workspace = {
      cwd: str(workspace.cwd, "snapshot.workspace.cwd"),
      ...(workspaceSessionId === undefined ? {} : { workspaceSessionId }),
    };
  }
  if (record.executionProfile !== undefined) {
    // The fingerprint is compared at reconciliation, where a mismatch becomes
    // explicit `execution-profile-drift` uncertainty instead of a lost run.
    try {
      snapshot.executionProfile = parseEffectiveExecutionProfile(
        record.executionProfile,
        false,
      );
    } catch (error) {
      bad(error instanceof Error ? error.message : "executionProfile");
    }
  }
  if (record.execution !== undefined)
    snapshot.execution = parseBinding(record.execution);
  if (record.receipt !== undefined)
    snapshot.receipt = parseReceipt(record.receipt);
  if (record.outcome !== undefined) {
    if (
      typeof record.outcome !== "string" ||
      !OUTCOMES.has(record.outcome as Outcome)
    ) {
      bad("snapshot.outcome is invalid");
    }
    snapshot.outcome = record.outcome as Outcome;
  }
  const reason = optStr(record, "reason", 256);
  if (reason !== undefined) snapshot.reason = reason;
  if (record.recovery !== undefined)
    snapshot.recovery = parseRecovery(record.recovery);
  return snapshot;
}

/** Strict, whitelisting parse: unknown fields (for example content) are dropped. */
export function parseDurableRunState(value: unknown): DurableRunState {
  const record = obj(value, "state");
  const snapshot = parseSnapshot(record.snapshot);
  const cursor = obj(record.cursor, "cursor");
  const intent = obj(record.intent, "intent");
  if (!Array.isArray(record.retirementRequests)) {
    bad("retirementRequests must be an array");
  }
  const retirementRequests = record.retirementRequests.map((entry: unknown) =>
    entry === "settled" || entry === "cancel"
      ? entry
      : bad("retirement request is invalid"),
  );
  const state: DurableRunState = {
    snapshot,
    cancelIntentSeen: bool(record.cancelIntentSeen, "cancelIntentSeen"),
    cursor: {
      eventSeq: int(cursor.eventSeq, "cursor.eventSeq"),
      stdoutOffset: int(cursor.stdoutOffset, "cursor.stdoutOffset"),
      stderrOffset: int(cursor.stderrOffset, "cursor.stderrOffset"),
    },
    intent: { startRequested: bool(intent.startRequested, "intent") },
    retirementRequests: [...new Set(retirementRequests)],
    journalSeq: int(record.journalSeq, "journalSeq"),
  };
  if (record.candidate !== undefined) {
    const candidate = obj(record.candidate, "candidate");
    if (
      typeof candidate.outcome !== "string" ||
      !OUTCOMES.has(candidate.outcome as Outcome) ||
      typeof candidate.semantic !== "string" ||
      !SEMANTICS.has(candidate.semantic as SemanticState)
    ) {
      bad("candidate is invalid");
    }
    state.candidate = {
      outcome: candidate.outcome as Outcome,
      semantic: candidate.semantic as SemanticState,
      reason: str(candidate.reason, "candidate.reason", 256),
    };
  }
  if (record.dispatch !== undefined) {
    if (record.dispatch !== "requested" && record.dispatch !== "accepted") {
      bad("dispatch is invalid");
    }
    state.dispatch = record.dispatch;
  }
  return state;
}
