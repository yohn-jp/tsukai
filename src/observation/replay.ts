import type { RuntimeLimits } from "../contracts/limits.js";
import type {
  Activity,
  JsonObject,
  Lifecycle,
  ObservationEnvelope,
  Outcome,
  RunSnapshot,
  SemanticState,
} from "../contracts/types.js";
import { JournalValidationError } from "./errors.js";
import { resolveLimits } from "./limits.js";
import { isRecord, jsonObject, utf8Bytes } from "./json.js";

export interface ReplayGap {
  runId: string;
  fromSeq: number;
  toSeq: number;
}

export interface ReplayJournal {
  events: readonly ObservationEnvelope[];
  gaps: readonly ReplayGap[];
  incomplete: boolean;
}

const ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "runId",
  "seq",
  "source",
  "sourceIdentity",
  "sourceTime",
  "receivedAt",
  "kind",
  "payload",
]);
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
const SOURCE_NAMES = new Set(["runtime", "harness", "execution"]);
const SNAPSHOT_KEYS = new Set([
  "agentRunId",
  "parentRunId",
  "spawnedBy",
  "harness",
  "metadata",
  "workspace",
  "lifecycle",
  "semantic",
  "activity",
  "revision",
  "createdAt",
  "updatedAt",
  "execution",
  "receipt",
  "outcome",
  "reason",
  "completeness",
]);

function invalid(message: string): never {
  throw new JournalValidationError(message);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8Bytes(value) <= 128 &&
    Number.isFinite(Date.parse(value))
  );
}

function boundedString(
  value: unknown,
  name: string,
  maximum = 256,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    utf8Bytes(value) > maximum
  ) {
    return invalid(
      `${name} must be a bounded ${allowEmpty ? "string" : "non-empty string"}`,
    );
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  maximum = 256,
): string | undefined {
  if (!(key in source)) return undefined;
  return boundedString(source[key], key, maximum);
}

function validateSnapshot(
  value: unknown,
  eventRunId: string,
  limits: RuntimeLimits,
): RunSnapshot {
  if (!isRecord(value))
    return invalid("run.snapshot payload must contain a snapshot object");
  if (Object.keys(value).some((key) => !SNAPSHOT_KEYS.has(key))) {
    return invalid("run.snapshot has an unknown field");
  }
  const agentRunId = boundedString(value.agentRunId, "snapshot.agentRunId");
  if (agentRunId !== eventRunId)
    return invalid("run.snapshot runId does not match snapshot.agentRunId");
  if (!isRecord(value.harness) || value.harness.name !== "mock") {
    return invalid("run.snapshot harness must identify the mock harness");
  }
  if (
    Object.keys(value.harness).some(
      (key) => key !== "name" && key !== "version",
    )
  ) {
    return invalid("run.snapshot harness has an unknown field");
  }
  const harnessVersion = boundedString(
    value.harness.version,
    "snapshot.harness.version",
    128,
  );
  if (!isRecord(value.metadata))
    return invalid("run.snapshot metadata must be an object");
  const metadata = Object.create(null) as Record<string, string>;
  const metadataKeys = Object.keys(value.metadata);
  if (metadataKeys.length > limits.maxMetadataEntries) {
    return invalid("run.snapshot metadata exceeds the entry limit");
  }
  for (const key of metadataKeys) {
    const metadataKey = boundedString(key, "snapshot metadata key", 128);
    metadata[metadataKey] = boundedString(
      value.metadata[key],
      `snapshot.metadata.${metadataKey}`,
      limits.maxMetadataValueBytes,
      true,
    );
  }

  if (
    typeof value.lifecycle !== "string" ||
    !LIFECYCLES.has(value.lifecycle as Lifecycle)
  ) {
    return invalid("run.snapshot lifecycle is invalid");
  }
  if (
    typeof value.semantic !== "string" ||
    !SEMANTICS.has(value.semantic as SemanticState)
  ) {
    return invalid("run.snapshot semantic state is invalid");
  }
  if (
    typeof value.activity !== "string" ||
    !ACTIVITIES.has(value.activity as Activity)
  ) {
    return invalid("run.snapshot activity is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return invalid("run.snapshot revision must be a non-negative safe integer");
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    return invalid("run.snapshot timestamps are invalid");
  }
  if (
    value.completeness !== "complete" &&
    value.completeness !== "incomplete"
  ) {
    return invalid("run.snapshot completeness is invalid");
  }

  const result: RunSnapshot = {
    agentRunId,
    harness: { name: "mock", version: harnessVersion },
    metadata,
    lifecycle: value.lifecycle as Lifecycle,
    semantic: value.semantic as SemanticState,
    activity: value.activity as Activity,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completeness: value.completeness,
  };
  const parentRunId = optionalString(value, "parentRunId");
  if (parentRunId !== undefined) result.parentRunId = parentRunId;
  const spawnedBy = optionalString(value, "spawnedBy");
  if (spawnedBy !== undefined) result.spawnedBy = spawnedBy;

  if (value.workspace !== undefined) {
    if (!isRecord(value.workspace))
      return invalid("run.snapshot workspace is invalid");
    if (
      Object.keys(value.workspace).some(
        (key) => key !== "cwd" && key !== "workspaceSessionId",
      )
    ) {
      return invalid("run.snapshot workspace has an unknown field");
    }
    const workspace: NonNullable<RunSnapshot["workspace"]> = {
      cwd: boundedString(value.workspace.cwd, "snapshot.workspace.cwd", 4096),
    };
    const workspaceSessionId = optionalString(
      value.workspace,
      "workspaceSessionId",
    );
    if (workspaceSessionId !== undefined)
      workspace.workspaceSessionId = workspaceSessionId;
    result.workspace = workspace;
  }

  if (value.execution !== undefined) {
    if (
      isRecord(value.execution) &&
      Object.keys(value.execution).some(
        (key) => key !== "executionRunId" && key !== "backend" && key !== "pid",
      )
    ) {
      return invalid("run.snapshot execution binding has an unknown field");
    }
    if (
      !isRecord(value.execution) ||
      value.execution.backend !== "mock-fixture" ||
      !Number.isSafeInteger(value.execution.pid) ||
      (value.execution.pid as number) < 1
    ) {
      return invalid("run.snapshot execution binding is invalid");
    }
    result.execution = {
      executionRunId: boundedString(
        value.execution.executionRunId,
        "snapshot.executionRunId",
      ),
      backend: "mock-fixture",
      pid: value.execution.pid as number,
    };
  }

  if (value.receipt !== undefined) {
    if (
      isRecord(value.receipt) &&
      Object.keys(value.receipt).some(
        (key) =>
          ![
            "executionRunId",
            "status",
            "exitCode",
            "signal",
            "forced",
          ].includes(key),
      )
    ) {
      return invalid("run.snapshot receipt has an unknown field");
    }
    if (
      !isRecord(value.receipt) ||
      (value.receipt.status !== "exited" &&
        value.receipt.status !== "uncertain") ||
      (value.receipt.exitCode !== null &&
        !Number.isSafeInteger(value.receipt.exitCode)) ||
      (value.receipt.signal !== null &&
        typeof value.receipt.signal !== "string") ||
      typeof value.receipt.forced !== "boolean"
    ) {
      return invalid("run.snapshot physical receipt is invalid");
    }
    result.receipt = {
      executionRunId: boundedString(
        value.receipt.executionRunId,
        "snapshot.receipt.executionRunId",
      ),
      status: value.receipt.status,
      exitCode: value.receipt.exitCode as number | null,
      signal: value.receipt.signal as string | null,
      forced: value.receipt.forced,
    };
  }

  if (value.outcome !== undefined) {
    if (
      typeof value.outcome !== "string" ||
      !OUTCOMES.has(value.outcome as Outcome)
    ) {
      return invalid("run.snapshot outcome is invalid");
    }
    result.outcome = value.outcome as Outcome;
  }
  const reason = optionalString(value, "reason");
  if (reason !== undefined) result.reason = reason;
  return result;
}

function validateEnvelope(
  value: unknown,
  limits: RuntimeLimits,
): ObservationEnvelope {
  if (!isRecord(value))
    return invalid("Journal line must be an observation object");
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key))
      return invalid(`Unknown observation envelope field: ${key}`);
  }
  if (value.schemaVersion !== 1)
    return invalid("Unsupported observation schemaVersion");
  const runId = boundedString(value.runId, "observation.runId");
  if (utf8Bytes(runId) > 256)
    return invalid("observation.runId exceeds its byte limit");
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
    return invalid("Observation sequence must be a positive safe integer");
  }
  if (typeof value.source !== "string" || !SOURCE_NAMES.has(value.source)) {
    return invalid("Observation source is invalid");
  }
  const sourceIdentity = optionalString(value, "sourceIdentity");
  if (sourceIdentity !== undefined && utf8Bytes(sourceIdentity) > 256) {
    return invalid("observation.sourceIdentity exceeds its byte limit");
  }
  let sourceTime: string | undefined;
  if ("sourceTime" in value) {
    if (!isTimestamp(value.sourceTime))
      return invalid("observation.sourceTime is invalid");
    sourceTime = value.sourceTime;
  }
  if (!isTimestamp(value.receivedAt))
    return invalid("observation.receivedAt is invalid");
  const kind = boundedString(value.kind, "observation.kind", 128);
  let payload: JsonObject;
  try {
    payload = jsonObject(value.payload, limits.maxRecordBytes);
  } catch (error) {
    return invalid(
      `Observation payload is invalid: ${error instanceof Error ? error.message : "unknown value"}`,
    );
  }

  const envelope: ObservationEnvelope = {
    schemaVersion: 1,
    runId,
    seq: value.seq as number,
    source: value.source as ObservationEnvelope["source"],
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    ...(sourceTime === undefined ? {} : { sourceTime }),
    receivedAt: value.receivedAt,
    kind,
    payload,
  };
  if (kind === "run.snapshot") {
    if (!("snapshot" in payload)) {
      return invalid("run.snapshot payload must use the { snapshot } envelope");
    }
    if (Object.keys(payload).length !== 1) {
      return invalid(
        "run.snapshot payload may contain only the snapshot field",
      );
    }
    const snapshot = validateSnapshot(payload.snapshot, runId, limits);
    envelope.payload = { snapshot: snapshot as unknown as JsonObject };
  }
  if (utf8Bytes(JSON.stringify(envelope)) > limits.maxRecordBytes) {
    return invalid("Observation exceeds record byte limit");
  }
  return envelope;
}

export function importJournal(
  text: string,
  partialLimits: Partial<RuntimeLimits> = {},
): ReplayJournal {
  if (typeof text !== "string") return invalid("Journal input must be text");
  const limits = resolveLimits(partialLimits);
  const maxLines = limits.maxRuns * limits.maxHistoryPerRun;
  if (!Number.isSafeInteger(maxLines))
    return invalid("Configured journal import limit is too large");
  const events: ObservationEnvelope[] = [];
  const gaps: ReplayGap[] = [];
  const lastSeq = new Map<string, number>();
  const identities = new Map<string, Set<string>>();
  const runIds = new Set<string>();
  let incomplete = false;
  let offset = 0;
  let lineNumber = 0;

  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(offset, end);
    offset = newline === -1 ? text.length : newline + 1;
    lineNumber++;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0)
      return invalid(`Empty journal line at ${lineNumber}`);
    if (lineNumber > maxLines)
      return invalid("Journal import exceeds bounded record count");
    if (utf8Bytes(line) > limits.maxRecordBytes) {
      return invalid(`Journal line ${lineNumber} exceeds record byte limit`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return invalid(`Journal line ${lineNumber} is not valid JSON`);
    }
    const envelope = validateEnvelope(raw, limits);
    runIds.add(envelope.runId);
    if (runIds.size > limits.maxRuns)
      return invalid("Journal import exceeds run limit");
    const previous = lastSeq.get(envelope.runId) ?? 0;
    if (envelope.seq <= previous) {
      return invalid(
        `Observation sequence is duplicate or out of order at line ${lineNumber}`,
      );
    }
    if (envelope.seq > previous + 1) {
      gaps.push({
        runId: envelope.runId,
        fromSeq: previous + 1,
        toSeq: envelope.seq - 1,
      });
      incomplete = true;
    }
    lastSeq.set(envelope.runId, envelope.seq);
    if (envelope.sourceIdentity !== undefined) {
      let seen = identities.get(envelope.runId);
      if (!seen) {
        seen = new Set();
        identities.set(envelope.runId, seen);
      }
      const identity = `${envelope.source}\0${envelope.sourceIdentity}`;
      if (seen.has(identity)) {
        return invalid(`Duplicate source identity at line ${lineNumber}`);
      }
      seen.add(identity);
    }
    events.push(envelope);
  }
  return { events, gaps, incomplete };
}

export function replayJournal(
  text: string,
  partialLimits: Partial<RuntimeLimits> = {},
): { runs: RunSnapshot[]; incomplete: boolean } {
  const limits = resolveLimits(partialLimits);
  const journal = importJournal(text, limits);
  const snapshots = new Map<string, RunSnapshot>();
  const revisions = new Map<string, number>();
  for (const event of journal.events) {
    if (event.kind !== "run.snapshot") continue;
    const value = event.payload.snapshot;
    const snapshot = validateSnapshot(value, event.runId, limits);
    const previousRevision = revisions.get(event.runId);
    if (
      previousRevision !== undefined &&
      snapshot.revision < previousRevision
    ) {
      return invalid(
        `run.snapshot revision moved backwards for ${event.runId}`,
      );
    }
    revisions.set(event.runId, snapshot.revision);
    snapshots.set(event.runId, snapshot);
  }

  let incomplete = journal.incomplete;
  const runs: RunSnapshot[] = [];
  for (const runId of new Set(journal.events.map((event) => event.runId))) {
    const snapshot = snapshots.get(runId);
    if (!snapshot) {
      incomplete = true;
      continue;
    }
    const runIncomplete =
      journal.gaps.some((gap) => gap.runId === runId) ||
      snapshot.completeness === "incomplete";
    if (runIncomplete) {
      snapshot.completeness = "incomplete";
      incomplete = true;
    }
    runs.push(snapshot);
  }
  runs.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.agentRunId.localeCompare(right.agentRunId),
  );
  return { runs, incomplete };
}
