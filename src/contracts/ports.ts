import type {
  ExecutionBinding,
  ObservationDraft,
  ObservationEnvelope,
  ObservationPage,
  PhysicalReceipt,
  RunCreateInput,
} from "./types.js";

/** An execution error that identifies lost (not merely delayed) evidence. */
export interface ObservationGapError extends Error {
  gapKind: "event" | "output" | "journal";
}

export function isObservationGap(error: unknown): error is ObservationGapError {
  const kind = (error as { gapKind?: unknown } | null)?.gapKind;
  return kind === "event" || kind === "output" || kind === "journal";
}

export interface ExecutionCursor {
  eventSeq: number;
  stdoutOffset: number;
  stderrOffset: number;
}

/** Backend evidence gathered while re-attaching to a persisted execution. */
export type ResumeOutcome =
  | { status: "attached"; physical: "running" | "terminal" }
  /** The backend positively reports that it has no such execution. */
  | { status: "missing"; reason: string }
  /** The backend was unreachable, contradictory, or could not prove either state. */
  | { status: "ambiguous"; reason: string };

export interface ExecutionObserver {
  /**
   * Called with the backend execution identity before the adapter submits a
   * prompt or reports establishment. A durable owner persists the binding here.
   */
  onEstablished?(binding: ExecutionBinding): Promise<void>;
  /**
   * `sourceIdentity` is stable for the same backend bytes so a replay after a
   * crash cannot duplicate an observation.
   */
  onOutput(chunk: Uint8Array, sourceIdentity?: string): void;
  /**
   * Historical output re-delivered on resume only to rebuild harness decoder
   * state. Signals derived from it are discarded: they were already settled
   * and persisted before the cursor advanced.
   */
  onReplay?(chunk: Uint8Array): void;
  /** Prompt dispatch phases, reported before the write and after acceptance. */
  onDispatch?(phase: "requested" | "accepted"): void;
  onExit(receipt: PhysicalReceipt): void;
  onError(error: Error): void;
  onSignal?(signal: HarnessSignal): void;
  onBindingUpdate?(binding: ExecutionBinding): void;
  /** Backend cursors are committed only after preceding observations. */
  onProgress?(cursor: {
    eventSeq: number;
    stdoutOffset: number;
    stderrOffset: number;
  }): void;
}

export interface ExecutionPort<Request = RunCreateInput["request"]> {
  start(
    agentRunId: string,
    request: Request,
    observer: ExecutionObserver,
    workspace?: { cwd: string; workspaceSessionId?: string },
  ): Promise<ExecutionBinding>;
  /**
   * Re-attach to an existing execution by backend identity and cursor. It must
   * never start a process or resend a prompt.
   */
  resume?(
    binding: ExecutionBinding,
    observer: ExecutionObserver,
    cursor: ExecutionCursor,
  ): Promise<ResumeOutcome>;
  /** Stop observing without retiring any execution (owner shutdown). */
  detach?(): Promise<void>;
  input(executionRunId: string, command: { kind: "release" }): Promise<void>;
  retire(executionRunId: string, reason: "settled" | "cancel"): Promise<void>;
  dispose(): Promise<void>;
}

export type HarnessSignal =
  | { type: "observation"; draft: Omit<ObservationDraft, "runId"> }
  | {
      type: "settlement";
      status: "success" | "error" | "abort";
      reason: string;
      reportedText?: string;
    };

export interface HarnessDecoder {
  push(chunk: Uint8Array): HarnessSignal[];
  finish(): HarnessSignal[];
}

export interface HarnessPort {
  decoder(): HarnessDecoder;
}

export interface JournalPort {
  append(draft: ObservationDraft): ObservationEnvelope;
  read(runId: string, afterSeq?: number, limit?: number): ObservationPage;
  subscribe(
    runId: string,
    afterSeq?: number,
  ): AsyncIterable<ObservationEnvelope>;
  export(runId?: string): string;
  close(): void;
}
