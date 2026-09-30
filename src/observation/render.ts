import type {
  FleetRun,
  OperatorProjection,
  ProjectionMetric,
  RunMetrics,
  RunTreeNode,
  TimelineEntry,
} from "./projection.js";

/** Escapes untrusted identifiers, metadata, and reasons before text rendering. */
export function escapeDisplayText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

function value(value: string | number | undefined): string {
  return value === undefined ? "unavailable" : escapeDisplayText(String(value));
}

function metric(metric: ProjectionMetric): string {
  if (metric.availability === "unavailable") return "unavailable";
  return `${metric.value} [${metric.availability}]`;
}

function runLine(run: FleetRun): string {
  const metadata = Object.keys(run.metadata)
    .sort()
    .map(
      (key) =>
        `${escapeDisplayText(key)}=${escapeDisplayText(run.metadata[key]!)}`,
    )
    .join(",");
  return `${escapeDisplayText(run.agentRunId)} parent=${escapeDisplayText(run.parentRunId ?? "-")} lineage=${run.lineage} lifecycle=${run.lifecycle} semantic=${run.semantic} outcome=${escapeDisplayText(run.outcome ?? "-")} completeness=${run.completeness} metadata=${metadata || "-"} created=${value(run.timing.createdAt)} updated=${value(run.timing.updatedAt)} started=${value(run.timing.startedAt)} terminal=${value(run.timing.terminalAt)}`;
}

function treeLines(node: RunTreeNode, indent: string, lines: string[]): void {
  lines.push(`${indent}${runLine(node)}`);
  for (const child of node.children) treeLines(child, `${indent}  `, lines);
}

function metricLine(runId: string, metrics: RunMetrics): string {
  return `${escapeDisplayText(runId)} tools(calls=${metric(metrics.tool.calls)},errors=${metric(metrics.tool.errors)},latencyMs=${metric(metrics.tool.latencyMs)},latencySamples=${metric(metrics.tool.latencySamples)}) usage(input=${metric(metrics.usage.inputTokens)},output=${metric(metrics.usage.outputTokens)},total=${metric(metrics.usage.totalTokens)},cost=${metric(metrics.usage.cost)}) retry(attempts=${metric(metrics.retry.attempts)},failures=${metric(metrics.retry.failures)}) compaction(started=${metric(metrics.compaction.started)},aborted=${metric(metrics.compaction.aborted)})`;
}

function timelineLine(entry: TimelineEntry): string {
  if (entry.type === "gap") {
    const range =
      entry.fromSeq === undefined
        ? ""
        : ` seq=${entry.fromSeq}-${entry.toSeq ?? entry.fromSeq}`;
    return `${escapeDisplayText(entry.runId)} ${entry.at ?? "unknown-time"} GAP ${entry.kind}/${escapeDisplayText(entry.code)}${range}`;
  }
  return `${escapeDisplayText(entry.runId)} ${entry.at} ${entry.source} ${escapeDisplayText(entry.kind)} seq=${entry.seq}`;
}

export function renderOperatorProjection(
  projection: OperatorProjection,
  format: "text" | "json" = "text",
): string {
  if (format === "json") return `${JSON.stringify(projection)}\n`;
  const lines = [
    `completeness=${projection.completeness.status}`,
    "fleet:",
    ...projection.fleet.map(runLine),
    "tree:",
  ];
  for (const root of projection.tree) treeLines(root, "  ", lines);
  lines.push(
    "timeline:",
    ...projection.timeline.map(timelineLine),
    "metrics:",
    ...Object.keys(projection.metrics)
      .sort()
      .map((runId) => metricLine(runId, projection.metrics[runId]!)),
  );
  return `${lines.join("\n")}\n`;
}
