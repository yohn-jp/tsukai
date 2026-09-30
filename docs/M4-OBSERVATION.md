# M4: operator observation projections and replay/profile consumers

Scope: Issue #15. M4 adds a read-side projection layer over canonical M2/M3 state (durable snapshots, journal, and the resident owner's read APIs) and an operator CLI surface to consume it. It adds no lifecycle authority: projections cannot create, cancel, retry, resume, or otherwise mutate an AgentRun, and they never attach directly to Pi/Jinushi streams as an alternative source of truth.

## Projection model

`projectObservation({ snapshots, events, gaps })` in `src/observation/projection.ts` is the single deterministic function that both live and historical consumers call:

- **Live**: `collectLiveProjection(runs)` in `src/observation/operator.ts` paginates the resident owner's `list`/`eventsPage` read operations (no other operation is reachable — its parameter type is `Pick<OwnerRunOperations, "list" | "eventsPage">`) and calls `projectObservation`.
- **Historical**: `projectReplay(text)` imports a durable journal export (`importJournal`/`replayJournal`, extended this milestone to accept `pi`-harness snapshots and the M2 `recovery` projection, not just the M0 mock harness) and calls the same `projectObservation`.

Both paths produce byte-identical `OperatorProjection` output for equivalent evidence (`test/observation/projection.test.ts`, "produces the same projection from live journal evidence and replay"). Sorting is by stable keys only (`agentRunId`, `seq`, timestamps as strings) — never map/filesystem iteration order, wall-clock render time, or random IDs.

## Fleet / tree / timeline

- **Fleet** (`FleetRun[]`): one row per AgentRun with lineage, lifecycle/semantic/activity, outcome/reason, harness, workspace/execution/receipt identity, recovery, completeness, and derived start/terminal timing (each timing field carries its own provenance).
- **Tree** (`RunTreeNode[]`): built from `parentRunId` only; a parent not present in the projected snapshot set marks the child `lineage: "orphan"` rather than dropping or misattributing it. Tree structure is visualization only — nothing in the projection or CLI reads it back as authorization or scheduling input.
- **Timeline** (`TimelineEntry[]`): a normalized merge of journal events and gaps across every projected run, ordered by `(at, runId, seq)`. Gaps (`event`/`output`/`journal`/`observation`, sourced from `run.gap` observations, M2 `recovery.gaps`, and journal-import/retention gaps) are first-class entries, never synthesized to fill a visual hole.

## Metrics and provenance

`RunMetrics` (tool calls/errors/latency, usage tokens/cost, retry attempts/failures, compaction started/aborted) is a `ProjectionMetric` per field: `{ availability: "unavailable" }` or `{ availability: "observed" | "derived", value, provenance }`. `provenance` always carries `source` (`runtime`/`harness`/`execution`/`journal`/`projection`) and the originating `eventSeqs`.

- Tool/retry/compaction counts are `0` only when the run's evidence is complete (`completeEvidence`); otherwise they are `unavailable`, never a guessed zero.
- Usage/cost are sourced only from Pi-native `usage`/`cost` payloads already present in harness observations (per `ARCHITECTURE.md` §7); nothing is estimated from text length or invented pricing. No such evidence exists in the current Pi 0.99.1 mapping beyond what the harness adapter already records, so usage/cost render `unavailable` on any run that lacks it.
- Tool latency sums only provider-reported `durationMs` on `tool_execution_end`; it is never derived from wall-clock render time.

## Completeness

`RunCompleteness` (`status`, `recoveryUncertain`, `gaps`) is computed per run from the M2 `completeness` field, `recovery.state` (`pending`/`reconciling`/`uncertain`), `lifecycle` (`uncertain`/`reconciling`), and any gap evidence; the aggregate `OperatorProjection.completeness.status` is `incomplete` if any run or any gap is. A run cannot read as `complete` while any of these signals is present — covered by `test/observation/projection.test.ts` ("makes event and recovery gaps explicit and prevents complete status").

## Operator consumer

Two CLI entry points extend the existing thin CLI (`src/cli/`) rather than adding a separate application:

- `tsukai replay <journal-path> [--json]` — historical projection from a durable journal export, rendered as text or JSON.
- `tsukai observe --state-dir D [--json]` — live projection collected from the resident owner over the same access-controlled local IPC socket M2/M3 clients already use.

`renderOperatorProjection` (`src/observation/render.ts`) is presentation-only and is the sole place untrusted harness-derived strings (run IDs, metadata, reasons, tool names carried in timeline metadata) are escaped before text rendering (`escapeDisplayText`); the JSON renderer relies on `JSON.stringify`'s own string escaping and is not interpolated into HTML/text elsewhere.

## Privacy

No new persistence was added. `eventsPage` (added to `RunOperations`/`OwnerRunOperations`/the owner IPC as `event-page`) is a bounded read over the existing metadata-only journal (`DurableStore.journal.read`, already present from M2); it exposes nothing beyond what `events()` streaming already exposed. Projection and rendering code read only already-persisted metadata: no prompts, assistant text, thinking, tool arguments/results, credentials, raw environment, or raw stderr are read, projected, or rendered.

## Verification

`test/observation/projection.test.ts` covers: live/historical projection agreement, live collection through the finite owner read surface, deterministic tree construction and orphan handling, Pi-harness/recovery replay, explicit event/recovery gaps preventing `complete` status, unavailable-vs-zero metrics, snapshot immutability and display escaping, deterministic multi-run timeline ordering under input reordering, and provenance preservation. `test/owner/owner.test.ts` adds `eventsPage` coverage and an end-to-end `tsukai observe` CLI run against a live resident owner. `scripts/test-package.mjs` exercises `collectLiveProjection`/`projectReplay`/`renderOperatorProjection` and both `tsukai replay` and the live projection path against the packed public package.
