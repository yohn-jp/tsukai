import type { ExecutionCursor, JournalPort } from "./ports.js";
import type { Outcome, RunSnapshot, SemanticState } from "./types.js";

/**
 * Only semantic metadata and backend cursors are durable by default. Prompt
 * text, reported assistant text, stdout/stderr bytes, and environments are never
 * part of this state.
 */
export interface DurableRunState {
  /** Includes the recovery projection and the execution binding once known. */
  snapshot: RunSnapshot;
  candidate?: { outcome: Outcome; semantic: SemanticState; reason: string };
  cancelIntentSeen: boolean;
  /**
   * Backend cursor. `stdoutOffset` is aligned to a complete protocol record and
   * is committed only after every observation derived from earlier bytes.
   */
  cursor: ExecutionCursor;
  /** Persisted before the adapter is asked to start any external execution. */
  intent: { startRequested: boolean };
  /** Prompt dispatch phase; absent until the harness reports one. */
  dispatch?: "requested" | "accepted";
  retirementRequests: ("settled" | "cancel")[];
  /** Journal head when this state was written; detects lost journal tails. */
  journalSeq: number;
}

/** Synchronous commits make a returned mutation durable before its side effect. */
export interface DurableStore extends JournalPort {
  loadRuns(): DurableRunState[];
  saveRun(state: DurableRunState): void;
  /** Last durable journal sequence and whether a torn/corrupt tail was dropped. */
  journalHead(runId: string): { lastSeq: number; truncated: boolean };
  /** Entries that could not be loaded; they are preserved, never silently dropped. */
  issues(): { entry: string; reason: string }[];
}
