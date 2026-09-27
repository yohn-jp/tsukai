import type {
  ExecutionBinding,
  ObservationDraft,
  ObservationEnvelope,
  ObservationPage,
  PhysicalReceipt,
  RunCreateInput,
} from "./types.js";

export interface ExecutionObserver {
  onOutput(chunk: Uint8Array): void;
  onExit(receipt: PhysicalReceipt): void;
  onError(error: Error): void;
}

export interface ExecutionPort<Request = RunCreateInput["request"]> {
  start(
    agentRunId: string,
    request: Request,
    observer: ExecutionObserver,
  ): Promise<ExecutionBinding>;
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
