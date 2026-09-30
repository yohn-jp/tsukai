import type {
  JsonObject,
  JsonValue,
  ObservationEnvelope,
  RunSnapshot,
} from "../contracts/types.js";

export type ProjectionMetricAvailability =
  "observed" | "derived" | "unavailable";

export interface ProjectionProvenance {
  availability: ProjectionMetricAvailability;
  source: "runtime" | "harness" | "execution" | "journal" | "projection";
  eventSeqs: number[];
  explanation: string;
  /** Harness whose native evidence a harness-sourced value came from. */
  harness?: RunSnapshot["harness"]["name"];
}

export type ProjectionMetric =
  | {
      availability: "observed" | "derived";
      value: number;
      provenance: ProjectionProvenance;
    }
  | { availability: "unavailable"; provenance: ProjectionProvenance };

export interface ProjectedTiming {
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  terminalAt?: string;
  provenance: {
    createdAt: ProjectionProvenance;
    updatedAt: ProjectionProvenance;
    startedAt?: ProjectionProvenance;
    terminalAt?: ProjectionProvenance;
  };
}

export interface FleetRun {
  agentRunId: string;
  parentRunId?: string;
  lineage: "root" | "child" | "orphan";
  lifecycle: RunSnapshot["lifecycle"];
  semantic: RunSnapshot["semantic"];
  activity: RunSnapshot["activity"];
  outcome?: RunSnapshot["outcome"];
  reason?: string;
  harness: RunSnapshot["harness"];
  metadata: Record<string, string>;
  workspace?: RunSnapshot["workspace"];
  execution?: RunSnapshot["execution"];
  receipt?: RunSnapshot["receipt"];
  recovery?: RunSnapshot["recovery"];
  completeness: RunSnapshot["completeness"];
  timing: ProjectedTiming;
}

export interface RunTreeNode extends FleetRun {
  children: RunTreeNode[];
}

export interface ProjectionGap {
  runId: string;
  kind: "event" | "output" | "journal" | "observation";
  code: string;
  fromSeq?: number;
  toSeq?: number;
  detectedAt?: string;
  provenance: ProjectionProvenance;
}

export interface TimelineEvent {
  type: "event";
  id: string;
  runId: string;
  seq: number;
  at: string;
  source: ObservationEnvelope["source"];
  kind: string;
  metadata: JsonObject;
  provenance: ProjectionProvenance;
}

export interface TimelineGap {
  type: "gap";
  id: string;
  runId: string;
  at?: string;
  kind: ProjectionGap["kind"];
  code: string;
  fromSeq?: number;
  toSeq?: number;
  provenance: ProjectionProvenance;
}

export type TimelineEntry = TimelineEvent | TimelineGap;

export interface ToolSummary {
  calls: ProjectionMetric;
  errors: ProjectionMetric;
  latencyMs: ProjectionMetric;
  latencySamples: ProjectionMetric;
}

export interface UsageSummary {
  inputTokens: ProjectionMetric;
  outputTokens: ProjectionMetric;
  totalTokens: ProjectionMetric;
  cost: ProjectionMetric;
}

export interface RetrySummary {
  attempts: ProjectionMetric;
  failures: ProjectionMetric;
}

export interface CompactionSummary {
  started: ProjectionMetric;
  aborted: ProjectionMetric;
}

export interface RunMetrics {
  tool: ToolSummary;
  usage: UsageSummary;
  retry: RetrySummary;
  compaction: CompactionSummary;
}

export interface RunCompleteness {
  status: "complete" | "incomplete";
  recoveryUncertain: boolean;
  gaps: ProjectionGap[];
}

export interface OperatorProjection {
  fleet: FleetRun[];
  tree: RunTreeNode[];
  timeline: TimelineEntry[];
  metrics: Record<string, RunMetrics>;
  completeness: {
    status: "complete" | "incomplete";
    runs: Record<string, RunCompleteness>;
  };
}

export interface ProjectionInput {
  snapshots: readonly RunSnapshot[];
  events: readonly ObservationEnvelope[];
  gaps?: readonly ProjectionGap[];
}

const EMPTY_EVENT_SEQS: number[] = [];

function provenance(
  availability: ProjectionMetricAvailability,
  source: ProjectionProvenance["source"],
  explanation: string,
  eventSeqs: readonly number[] = EMPTY_EVENT_SEQS,
): ProjectionProvenance {
  return {
    availability,
    source,
    eventSeqs: [...eventSeqs].sort((left, right) => left - right),
    explanation,
  };
}

function unavailable(
  explanation: string,
  source: ProjectionProvenance["source"] = "projection",
): ProjectionMetric {
  return {
    availability: "unavailable",
    provenance: provenance("unavailable", source, explanation),
  };
}

function metric(
  value: number | undefined,
  availability: "observed" | "derived",
  source: ProjectionProvenance["source"],
  explanation: string,
  eventSeqs: readonly number[],
): ProjectionMetric {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return unavailable(explanation);
  }
  return {
    value,
    availability,
    provenance: provenance(availability, source, explanation, eventSeqs),
  };
}

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (
    value === undefined ||
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  )
    return undefined;
  return value as Record<string, JsonValue>;
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const key of Object.keys(value).sort())
    result[key] = canonicalJson(value[key]!);
  return result;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function eventNativeType(event: ObservationEnvelope): string | undefined {
  const pi = record(event.payload.pi);
  return stringValue(pi?.nativeType) ?? stringValue(event.payload.nativeType);
}

function piPayload(
  event: ObservationEnvelope,
): Record<string, JsonValue> | undefined {
  return record(event.payload.pi);
}

function eventAt(event: ObservationEnvelope): string {
  return event.sourceTime ?? event.receivedAt;
}

function sortedEvents(
  events: readonly ObservationEnvelope[],
): ObservationEnvelope[] {
  const seen = new Set<string>();
  return [...events]
    .filter((event) => {
      const key = `${event.runId}\0${event.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.runId.localeCompare(right.runId) || left.seq - right.seq,
    );
}

function gapKey(gap: ProjectionGap): string {
  return `${gap.runId}\0${gap.kind}\0${gap.code}\0${gap.fromSeq ?? ""}\0${gap.toSeq ?? ""}`;
}

function sortGaps(gaps: readonly ProjectionGap[]): ProjectionGap[] {
  const unique = new Map<string, ProjectionGap>();
  for (const gap of gaps) {
    const candidate = {
      ...gap,
      provenance: {
        ...gap.provenance,
        eventSeqs: [...gap.provenance.eventSeqs],
      },
    };
    const key = gapKey(gap);
    const existing = unique.get(key);
    if (
      existing === undefined ||
      JSON.stringify(candidate) < JSON.stringify(existing)
    )
      unique.set(key, candidate);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.runId.localeCompare(right.runId) ||
      (left.fromSeq ?? Number.MAX_SAFE_INTEGER) -
        (right.fromSeq ?? Number.MAX_SAFE_INTEGER) ||
      left.kind.localeCompare(right.kind) ||
      left.code.localeCompare(right.code),
  );
}

function snapshotEvents(
  events: readonly ObservationEnvelope[],
  runId: string,
): ObservationEnvelope[] {
  return events.filter((event) => event.runId === runId);
}

function timing(
  snapshot: RunSnapshot,
  events: readonly ObservationEnvelope[],
): ProjectedTiming {
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const start = sorted.find((event) => {
    if (event.kind !== "run.snapshot") return false;
    const value = record(event.payload.snapshot);
    const lifecycle = stringValue(value?.lifecycle);
    return lifecycle === "starting" || lifecycle === "running";
  });
  const terminal = sorted.find((event) => {
    if (event.kind !== "run.snapshot") return false;
    return (
      stringValue(record(event.payload.snapshot)?.lifecycle) === "terminal"
    );
  });
  const created = provenance(
    "observed",
    "runtime",
    "canonical run snapshot metadata",
  );
  const updated = provenance(
    "observed",
    "runtime",
    "canonical run snapshot metadata",
  );
  return {
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    ...(start === undefined ? {} : { startedAt: eventAt(start) }),
    ...(terminal === undefined ? {} : { terminalAt: eventAt(terminal) }),
    provenance: {
      createdAt: created,
      updatedAt: updated,
      ...(start === undefined
        ? {}
        : {
            startedAt: provenance(
              "derived",
              start.source,
              "first starting/running snapshot",
              [start.seq],
            ),
          }),
      ...(terminal === undefined
        ? {}
        : {
            terminalAt: provenance(
              "derived",
              terminal.source,
              "first terminal snapshot or execution receipt",
              [terminal.seq],
            ),
          }),
    },
  } as ProjectedTiming;
}

function toFleetRun(
  snapshot: RunSnapshot,
  hasParent: boolean,
  events: readonly ObservationEnvelope[],
): FleetRun {
  const metadata: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const key of Object.keys(snapshot.metadata).sort())
    metadata[key] = snapshot.metadata[key]!;
  return {
    agentRunId: snapshot.agentRunId,
    ...(snapshot.parentRunId === undefined
      ? {}
      : { parentRunId: snapshot.parentRunId }),
    lineage:
      snapshot.parentRunId === undefined
        ? "root"
        : hasParent
          ? "child"
          : "orphan",
    lifecycle: snapshot.lifecycle,
    semantic: snapshot.semantic,
    activity: snapshot.activity,
    ...(snapshot.outcome === undefined ? {} : { outcome: snapshot.outcome }),
    ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
    harness: { ...snapshot.harness },
    metadata,
    ...(snapshot.workspace === undefined
      ? {}
      : { workspace: { ...snapshot.workspace } }),
    ...(snapshot.execution === undefined
      ? {}
      : { execution: { ...snapshot.execution } }),
    ...(snapshot.receipt === undefined
      ? {}
      : { receipt: { ...snapshot.receipt } }),
    ...(snapshot.recovery === undefined
      ? {}
      : {
          recovery: {
            ...snapshot.recovery,
            gaps: snapshot.recovery.gaps.map((gap) => ({ ...gap })),
          },
        }),
    completeness: snapshot.completeness,
    timing: timing(snapshot, events),
  };
}

function metricFromCount(
  count: number,
  canEstablishZero: boolean,
  source: ProjectionProvenance["source"],
  explanation: string,
  eventSeqs: readonly number[],
): ProjectionMetric {
  if (eventSeqs.length === 0 && !canEstablishZero)
    return unavailable(explanation);
  return metric(
    count,
    eventSeqs.length === 0 ? "observed" : "derived",
    source,
    explanation,
    eventSeqs,
  );
}

interface UsageObservation {
  scope: string;
  values: Record<string, JsonValue>;
  seq: number;
}

function usageObservations(
  events: readonly ObservationEnvelope[],
): UsageObservation[] {
  const observations: UsageObservation[] = [];
  for (const event of events) {
    const pi = piPayload(event);
    const assistant = record(pi?.assistant);
    const usage =
      record(pi?.usage) ??
      record(assistant?.usage) ??
      record(event.payload.usage);
    if (usage === undefined) continue;
    const values = record(usage.values) ?? usage;
    const scope = stringValue(usage.scope) ?? "unknown";
    observations.push({ scope, values, seq: event.seq });
  }
  return observations.sort((left, right) => left.seq - right.seq);
}

function usageMetric(
  observations: readonly UsageObservation[],
  key: string,
  cost: boolean,
): ProjectionMetric {
  const usable = observations
    .map((observation) => ({
      value: cost
        ? numberValue(record(observation.values.cost)?.[key])
        : numberValue(observation.values[key]),
      seq: observation.seq,
      scope: observation.scope,
    }))
    .filter(
      (entry): entry is { value: number; seq: number; scope: string } =>
        entry.value !== undefined,
    );
  if (usable.length === 0)
    return unavailable(
      "No authoritative provider usage evidence was recorded",
      "harness",
    );
  const delta = usable.some((entry) => /delta/i.test(entry.scope));
  const final = usable.filter((entry) => /final/i.test(entry.scope));
  const selected = final.length > 0 ? final : usable;
  const value =
    delta || final.length > 0
      ? selected.reduce((sum, entry) => sum + entry.value, 0)
      : selected.at(-1)!.value;
  return metric(
    value,
    "observed",
    "harness",
    cost ? "provider-reported cost" : "provider-reported usage",
    selected.map((entry) => entry.seq),
  );
}

function metricsFor(
  events: readonly ObservationEnvelope[],
  completeness: "complete" | "incomplete",
): RunMetrics {
  const toolEvents = events.filter((event) => event.kind === "harness.tool");
  const starts = toolEvents.filter(
    (event) => eventNativeType(event) === "tool_execution_start",
  );
  const ends = toolEvents.filter(
    (event) => eventNativeType(event) === "tool_execution_end",
  );
  const callEvents = starts.length > 0 ? starts : ends;
  const errorEvents = ends.filter((event) => {
    const pi = piPayload(event);
    return pi?.isError === true || record(pi?.toolResult)?.isError === true;
  });
  const latencyEvents = ends
    .map((event) => ({
      event,
      duration:
        numberValue(piPayload(event)?.durationMs) ??
        numberValue(event.payload.durationMs),
    }))
    .filter(
      (entry): entry is { event: ObservationEnvelope; duration: number } =>
        entry.duration !== undefined,
    );
  const completeEvidence = completeness === "complete";
  const callSeqs = callEvents.map((event) => event.seq);
  const errorSeqs = errorEvents.map((event) => event.seq);
  const latencySeqs = latencyEvents.map((entry) => entry.event.seq);
  const usage = usageObservations(events);
  const retries = events.filter((event) => {
    const native = eventNativeType(event);
    return (
      event.kind === "harness.retry" &&
      (native === "agent_retry" ||
        native === "auto_retry_start" ||
        native === "summarization_retry_attempt_start")
    );
  });
  const retryFailures = events.filter(
    (event) =>
      eventNativeType(event) === "auto_retry_end" &&
      piPayload(event)?.success === false,
  );
  const compactions = events.filter(
    (event) => eventNativeType(event) === "compaction_start",
  );
  const abortedCompactions = events.filter(
    (event) =>
      eventNativeType(event) === "compaction_end" &&
      (piPayload(event)?.aborted === true ||
        piPayload(event)?.willRetry === true),
  );
  return {
    tool: {
      calls: metricFromCount(
        callEvents.length,
        completeEvidence,
        "harness",
        "Tool call count requires complete harness evidence",
        callSeqs,
      ),
      errors: metricFromCount(
        errorEvents.length,
        completeEvidence && callEvents.length > 0,
        "harness",
        "Tool error count requires tool execution evidence",
        errorSeqs,
      ),
      latencyMs:
        latencyEvents.length === 0
          ? unavailable(
              "No authoritative tool duration was recorded",
              "harness",
            )
          : metric(
              latencyEvents.reduce((sum, entry) => sum + entry.duration, 0),
              "derived",
              "harness",
              "sum of provider-reported tool durations",
              latencySeqs,
            ),
      latencySamples:
        latencyEvents.length === 0
          ? unavailable(
              "No authoritative tool duration was recorded",
              "harness",
            )
          : metric(
              latencyEvents.length,
              "observed",
              "harness",
              "count of tool duration observations",
              latencySeqs,
            ),
    },
    usage: {
      inputTokens: usageMetric(usage, "input", false),
      outputTokens: usageMetric(usage, "output", false),
      totalTokens: usageMetric(usage, "totalTokens", false),
      cost: usageMetric(usage, "total", true),
    },
    retry: {
      attempts: metricFromCount(
        retries.length,
        completeEvidence,
        "harness",
        "Retry count requires complete harness evidence",
        retries.map((event) => event.seq),
      ),
      failures: metricFromCount(
        retryFailures.length,
        completeEvidence && retries.length > 0,
        "harness",
        "Retry failure count requires retry evidence",
        retryFailures.map((event) => event.seq),
      ),
    },
    compaction: {
      started: metricFromCount(
        compactions.length,
        completeEvidence,
        "harness",
        "Compaction count requires complete harness evidence",
        compactions.map((event) => event.seq),
      ),
      aborted: metricFromCount(
        abortedCompactions.length,
        completeEvidence && compactions.length > 0,
        "harness",
        "Compaction failure count requires compaction evidence",
        abortedCompactions.map((event) => event.seq),
      ),
    },
  };
}

function claudeCodePayload(
  event: ObservationEnvelope,
): Record<string, JsonValue> | undefined {
  return record(event.payload.claudeCode);
}

function claudeCodeNative(event: ObservationEnvelope): string | undefined {
  return stringValue(claudeCodePayload(event)?.nativeType);
}

/**
 * Claude Code evidence (stream-json, namespaced under `claudeCode`). Only what
 * the harness reports is projected: it reports no tool durations or retry
 * outcomes, so those stay unavailable rather than zero.
 */
function claudeCodeMetricsFor(
  events: readonly ObservationEnvelope[],
  completeness: "complete" | "incomplete",
): RunMetrics {
  const completeEvidence = completeness === "complete";
  const calls = events.filter(
    (event) =>
      event.kind === "harness.tool" && claudeCodeNative(event) === "tool_use",
  );
  const errors = events.filter(
    (event) =>
      event.kind === "harness.tool" &&
      claudeCodeNative(event) === "tool_result" &&
      claudeCodePayload(event)?.isError === true,
  );
  const results = events.filter(
    (event) =>
      event.kind === "harness.result" && claudeCodeNative(event) === "result",
  );
  const tokens = (key: string): ProjectionMetric => {
    const usable = results
      .map((event) => ({
        seq: event.seq,
        value: numberValue(
          record(record(claudeCodePayload(event)?.usage)?.values)?.[key],
        ),
      }))
      .filter(
        (entry): entry is { seq: number; value: number } =>
          entry.value !== undefined,
      );
    if (usable.length === 0)
      return unavailable(
        "No authoritative Claude Code result usage was recorded",
        "harness",
      );
    return metric(
      usable.reduce((sum, entry) => sum + entry.value, 0),
      "observed",
      "harness",
      "harness-reported per-turn result usage",
      usable.map((entry) => entry.seq),
    );
  };
  const costs = results
    .map((event) => ({
      seq: event.seq,
      value: numberValue(record(claudeCodePayload(event)?.cost)?.total),
    }))
    .filter(
      (entry): entry is { seq: number; value: number } =>
        entry.value !== undefined,
    );
  const retries = events.filter(
    (event) =>
      event.kind === "harness.retry" &&
      claudeCodeNative(event) === "system/api_retry",
  );
  const compactions = events.filter(
    (event) => claudeCodeNative(event) === "system/compact_boundary",
  );
  const failedCompactions = events.filter(
    (event) =>
      claudeCodeNative(event) === "system/status" &&
      claudeCodePayload(event)?.compactOutcome === "failed",
  );
  return {
    tool: {
      calls: metricFromCount(
        calls.length,
        completeEvidence,
        "harness",
        "Tool call count requires complete harness evidence",
        calls.map((event) => event.seq),
      ),
      errors: metricFromCount(
        errors.length,
        completeEvidence && calls.length > 0,
        "harness",
        "Tool error count requires tool execution evidence",
        errors.map((event) => event.seq),
      ),
      latencyMs: unavailable(
        "Claude Code stream-json reports no tool duration",
        "harness",
      ),
      latencySamples: unavailable(
        "Claude Code stream-json reports no tool duration",
        "harness",
      ),
    },
    usage: {
      inputTokens: tokens("input"),
      outputTokens: tokens("output"),
      totalTokens: unavailable(
        "Claude Code reports no total token count",
        "harness",
      ),
      // total_cost_usd is a cumulative estimate: the latest value, not a sum.
      cost:
        costs.length === 0
          ? unavailable("No Claude Code cost estimate was recorded", "harness")
          : metric(
              costs.at(-1)!.value,
              "observed",
              "harness",
              "harness-reported cumulative cost estimate",
              [costs.at(-1)!.seq],
            ),
    },
    retry: {
      attempts: metricFromCount(
        retries.length,
        completeEvidence,
        "harness",
        "Retry count requires complete harness evidence",
        retries.map((event) => event.seq),
      ),
      failures: unavailable("Claude Code reports no retry outcome", "harness"),
    },
    compaction: {
      started: metricFromCount(
        compactions.length,
        completeEvidence,
        "harness",
        "Compaction count requires complete harness evidence",
        compactions.map((event) => event.seq),
      ),
      aborted: metricFromCount(
        failedCompactions.length,
        completeEvidence && compactions.length > 0,
        "harness",
        "Compaction failure count requires compaction evidence",
        failedCompactions.map((event) => event.seq),
      ),
    },
  };
}

function harnessAttributed(
  value: ProjectionProvenance,
  harness: RunSnapshot["harness"]["name"] | undefined,
): ProjectionProvenance {
  return value.source === "harness" && harness !== undefined
    ? { ...value, harness }
    : value;
}

/** Marks every harness-sourced metric with the run's harness identity. */
function attributeHarness(
  metrics: RunMetrics,
  harness: RunSnapshot["harness"]["name"],
): RunMetrics {
  const mark = (value: ProjectionMetric): ProjectionMetric =>
    value.provenance.source === "harness"
      ? { ...value, provenance: { ...value.provenance, harness } }
      : value;
  const section = <T extends object>(values: T): T => {
    const copy = { ...values } as Record<string, ProjectionMetric>;
    for (const key of Object.keys(copy)) copy[key] = mark(copy[key]!);
    return copy as T;
  };
  return {
    tool: section(metrics.tool),
    usage: section(metrics.usage),
    retry: section(metrics.retry),
    compaction: section(metrics.compaction),
  };
}

function eventMetadata(event: ObservationEnvelope): JsonObject {
  return canonicalJson(event.payload) as JsonObject;
}

function makeGapFromEvent(
  event: ObservationEnvelope,
): ProjectionGap | undefined {
  if (event.kind !== "run.gap") return undefined;
  const kind = stringValue(event.payload.kind);
  const code = stringValue(event.payload.code);
  if (
    kind !== "event" &&
    kind !== "output" &&
    kind !== "journal" &&
    kind !== "observation"
  )
    return undefined;
  if (code === undefined) return undefined;
  return {
    runId: event.runId,
    kind,
    code,
    detectedAt: eventAt(event),
    provenance: provenance(
      "observed",
      event.source,
      "canonical run.gap observation",
      [event.seq],
    ),
  };
}

function makeTimeline(
  events: readonly ObservationEnvelope[],
  gaps: readonly ProjectionGap[],
  harnesses: ReadonlyMap<string, RunSnapshot["harness"]["name"]>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    const gap = makeGapFromEvent(event);
    if (gap !== undefined) {
      entries.push({
        type: "gap",
        id: `${event.runId}:gap:${event.seq}`,
        runId: event.runId,
        at: eventAt(event),
        kind: gap.kind,
        code: gap.code,
        provenance: gap.provenance,
      });
      continue;
    }
    entries.push({
      type: "event",
      id: `${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      at: eventAt(event),
      source: event.source,
      kind: event.kind,
      metadata: eventMetadata(event),
      provenance: harnessAttributed(
        provenance("observed", event.source, "canonical journal observation", [
          event.seq,
        ]),
        harnesses.get(event.runId),
      ),
    });
  }
  const known = new Set(
    entries
      .filter((entry): entry is TimelineGap => entry.type === "gap")
      .map((entry) => `${entry.runId}\0${entry.kind}\0${entry.code}`),
  );
  for (const gap of gaps) {
    const key = `${gap.runId}\0${gap.kind}\0${gap.code}`;
    if (known.has(key)) continue;
    entries.push({
      type: "gap",
      id: `${gap.runId}:gap:${gap.kind}:${gap.code}:${gap.fromSeq ?? ""}`,
      runId: gap.runId,
      ...(gap.detectedAt === undefined ? {} : { at: gap.detectedAt }),
      kind: gap.kind,
      code: gap.code,
      ...(gap.fromSeq === undefined ? {} : { fromSeq: gap.fromSeq }),
      ...(gap.toSeq === undefined ? {} : { toSeq: gap.toSeq }),
      provenance: gap.provenance,
    });
  }
  return entries.sort(
    (left, right) =>
      (left.at ?? "").localeCompare(right.at ?? "") ||
      left.runId.localeCompare(right.runId) ||
      (left.type === "event"
        ? left.seq
        : (left.fromSeq ?? Number.MAX_SAFE_INTEGER)) -
        (right.type === "event"
          ? right.seq
          : (right.fromSeq ?? Number.MAX_SAFE_INTEGER)) ||
      left.id.localeCompare(right.id),
  );
}

function completenessFor(
  snapshot: RunSnapshot,
  gaps: readonly ProjectionGap[],
): RunCompleteness {
  const runGaps = sortGaps(
    gaps.filter((gap) => gap.runId === snapshot.agentRunId),
  );
  const recoveryUncertain =
    snapshot.recovery?.state === "pending" ||
    snapshot.recovery?.state === "reconciling" ||
    snapshot.recovery?.state === "uncertain" ||
    snapshot.lifecycle === "uncertain" ||
    snapshot.lifecycle === "reconciling";
  return {
    status:
      snapshot.completeness === "incomplete" ||
      recoveryUncertain ||
      runGaps.length > 0
        ? "incomplete"
        : "complete",
    recoveryUncertain,
    gaps: runGaps,
  };
}

export function projectObservation(input: ProjectionInput): OperatorProjection {
  const sortedSnapshots = [...input.snapshots].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.agentRunId.localeCompare(right.agentRunId),
  );
  const events = sortedEvents(input.events);
  const byId = new Map(
    sortedSnapshots.map((snapshot) => [snapshot.agentRunId, snapshot]),
  );
  const gaps: ProjectionGap[] = [...(input.gaps ?? [])];
  for (const event of events) {
    const gap = makeGapFromEvent(event);
    if (gap !== undefined) gaps.push(gap);
  }
  for (const snapshot of sortedSnapshots) {
    for (const gap of snapshot.recovery?.gaps ?? []) {
      gaps.push({
        runId: snapshot.agentRunId,
        kind: gap.kind,
        code: gap.code,
        detectedAt: gap.detectedAt,
        provenance: provenance(
          "observed",
          "runtime",
          "canonical recovery gap",
          [],
        ),
      });
    }
  }
  const normalizedGaps = sortGaps(gaps);
  const runCompleteness: Record<string, RunCompleteness> = Object.create(
    null,
  ) as Record<string, RunCompleteness>;
  for (const snapshot of sortedSnapshots) {
    runCompleteness[snapshot.agentRunId] = completenessFor(
      snapshot,
      normalizedGaps,
    );
  }
  const fleet = sortedSnapshots.map((snapshot) => {
    const run = toFleetRun(
      snapshot,
      snapshot.parentRunId !== undefined && byId.has(snapshot.parentRunId),
      snapshotEvents(events, snapshot.agentRunId),
    );
    if (runCompleteness[snapshot.agentRunId]?.status === "incomplete") {
      run.completeness = "incomplete";
    }
    return run;
  });
  const nodes = new Map<string, RunTreeNode>();
  for (const run of fleet) nodes.set(run.agentRunId, { ...run, children: [] });
  const roots: RunTreeNode[] = [];
  for (const run of fleet) {
    const node = nodes.get(run.agentRunId)!;
    const parent =
      run.parentRunId === undefined ? undefined : nodes.get(run.parentRunId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const orderTree = (node: RunTreeNode): void => {
    node.children.sort((left, right) =>
      left.agentRunId.localeCompare(right.agentRunId),
    );
    for (const child of node.children) orderTree(child);
  };
  roots.sort((left, right) => left.agentRunId.localeCompare(right.agentRunId));
  for (const root of roots) orderTree(root);
  const metrics: Record<string, RunMetrics> = Object.create(null) as Record<
    string,
    RunMetrics
  >;
  for (const snapshot of sortedSnapshots) {
    const runEvents = snapshotEvents(events, snapshot.agentRunId);
    const runStatus = runCompleteness[snapshot.agentRunId]!.status;
    metrics[snapshot.agentRunId] = attributeHarness(
      snapshot.harness.name === "claude-code"
        ? claudeCodeMetricsFor(runEvents, runStatus)
        : metricsFor(runEvents, runStatus),
      snapshot.harness.name,
    );
  }
  const status =
    normalizedGaps.length > 0 ||
    Object.values(runCompleteness).some(
      (value) => value.status === "incomplete",
    )
      ? "incomplete"
      : "complete";
  return {
    fleet,
    tree: roots,
    timeline: makeTimeline(
      events,
      normalizedGaps,
      new Map(
        sortedSnapshots.map((snapshot) => [
          snapshot.agentRunId,
          snapshot.harness.name,
        ]),
      ),
    ),
    metrics,
    completeness: { status, runs: runCompleteness },
  };
}
