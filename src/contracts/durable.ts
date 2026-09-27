import type { JournalPort } from "./ports.js";
import type { Outcome, RunSnapshot, SemanticState } from "./types.js";

/** Only semantic metadata and backend cursors are durable by default. */
export interface DurableRunState {
  snapshot: RunSnapshot;
  candidate?: { outcome: Outcome; semantic: SemanticState; reason: string };
  cancelIntentSeen: boolean;
  cursor: { eventSeq: number; stdoutOffset: number; stderrOffset: number };
}

/** Synchronous commits make a returned mutation durable before its side effect. */
export interface DurableStore extends JournalPort {
  loadRuns(): DurableRunState[];
  saveRun(state: DurableRunState): void;
}
