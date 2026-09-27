import type {
  ExecutionBinding,
  ObservationDraft,
  ObservationEnvelope,
  ObservationPage,
  PhysicalReceipt,
  RunCreateInput,
} from "./types.js";

export interface ExecutionObserver {
  /** Called before the adapter submits a prompt or reports establishment. */
  onEstablished?(binding: ExecutionBinding): Promise<void>;
  onOutput(chunk: Uint8Array): void;
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
  resume?(
    binding: ExecutionBinding,
    observer: ExecutionObserver,
    cursor: { eventSeq: number; stdoutOffset: number; stderrOffset: number },
  ): Promise<void>;
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
