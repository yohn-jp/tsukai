import type { OwnerRunOperations } from "../owner/client.js";
import type { ObservationEnvelope, RunSnapshot } from "../contracts/types.js";
import { importJournal, replayJournal } from "./replay.js";
import {
  projectObservation,
  type OperatorProjection,
  type ProjectionGap,
  type ProjectionProvenance,
} from "./projection.js";

type LiveReadOperations = Pick<OwnerRunOperations, "list" | "eventsPage">;

function journalProvenance(explanation: string): ProjectionProvenance {
  return {
    availability: "observed",
    source: "journal",
    eventSeqs: [],
    explanation,
  };
}

export function projectReplay(text: string): OperatorProjection {
  const imported = importJournal(text);
  const replayed = replayJournal(text);
  const gaps: ProjectionGap[] = imported.gaps.map((gap) => ({
    runId: gap.runId,
    kind: "journal",
    code: "journal-sequence-gap",
    fromSeq: gap.fromSeq,
    toSeq: gap.toSeq,
    provenance: journalProvenance("missing journal sequence during replay"),
  }));
  return projectObservation({
    snapshots: replayed.runs,
    events: imported.events,
    gaps,
  });
}

async function allRuns(runs: LiveReadOperations): Promise<RunSnapshot[]> {
  const snapshots: RunSnapshot[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await runs.list(cursor === undefined ? undefined : { cursor });
    snapshots.push(...page.items);
    if (page.nextCursor === undefined) return snapshots;
    cursor = page.nextCursor;
  }
}

async function allEvents(
  runs: LiveReadOperations,
  snapshots: readonly RunSnapshot[],
): Promise<{ events: ObservationEnvelope[]; gaps: ProjectionGap[] }> {
  const events: ObservationEnvelope[] = [];
  const gaps: ProjectionGap[] = [];
  for (const snapshot of [...snapshots].sort((left, right) =>
    left.agentRunId.localeCompare(right.agentRunId),
  )) {
    let afterSeq = 0;
    for (;;) {
      const page = await runs.eventsPage(snapshot.agentRunId, afterSeq);
      if (page.gap) {
        gaps.push({
          runId: snapshot.agentRunId,
          kind: "journal",
          code: "journal-retention-gap",
          fromSeq: afterSeq + 1,
          toSeq: page.retainedFrom - 1,
          provenance: journalProvenance(
            "journal history was no longer retained by the resident owner",
          ),
        });
      }
      events.push(...page.items);
      if (page.nextCursor === undefined) break;
      afterSeq = Number(page.nextCursor);
    }
  }
  return { events, gaps };
}

/** Collects only resident-owner read APIs. It never subscribes to harness streams. */
export async function collectLiveProjection(
  runs: LiveReadOperations,
): Promise<OperatorProjection> {
  const snapshots = await allRuns(runs);
  const history = await allEvents(runs, snapshots);
  return projectObservation({ ...history, snapshots });
}
