import type { PhysicalReceipt, RunCreateInput } from "./types.js";

export interface PiRunRequest {
  prompt: string;
}
export type PiRunCreateInput = RunCreateInput<PiRunRequest, "pi">;

/** Physical execution is supplied by the caller. The Pi adapter never starts a process. */
export interface PiTransportObserver {
  onStdout(chunk: Uint8Array): void;
  onStderr(chunk: Uint8Array): void;
  onExit(receipt: PhysicalReceipt): void;
  onError(error: Error): void;
  /**
   * Transport cursor after all earlier bytes were delivered. `stdoutOffset` is
   * a transport offset; the harness adapter derives its record-aligned cursor.
   */
  onProgress?(cursor: {
    eventSeq: number;
    stdoutOffset: number;
    stderrOffset: number;
  }): void;
}

export interface PiDuplexExecution {
  readonly executionRunId: string;
  readonly backend: string;
  readonly pid?: number;
  /** Resolve only after bytes have been accepted with stdin backpressure honored. */
  write(bytes: Uint8Array): Promise<void>;
  /** Requests orderly shutdown; physical exit is reported separately. */
  closeInput(): Promise<void>;
  /** Requests physical retirement through the execution owner. */
  retire(reason: "settled" | "cancel"): Promise<void>;
}

/** Backend evidence from re-attaching to a known execution identity. */
export type PiAttachResult =
  | { status: "attached"; execution: PiDuplexExecution }
  | { status: "missing"; reason: string }
  | { status: "ambiguous"; reason: string };

export interface PiDuplexExecutionPort {
  open(
    agentRunId: string,
    observer: PiTransportObserver,
    workspace?: { cwd: string; workspaceSessionId?: string },
  ): Promise<PiDuplexExecution>;
  /**
   * Re-attach to an existing execution. Stdout is re-delivered from offset 0 so
   * the harness can rebuild decoder state; `onOpen` hands over the execution
   * before any byte is delivered. Never starts a process.
   */
  attach?(
    executionRunId: string,
    observer: PiTransportObserver,
    resume: { eventSeq: number; stderrOffset: number },
    onOpen: (execution: PiDuplexExecution) => void,
  ): Promise<PiAttachResult>;
  /** Stop observing without retiring any execution. */
  detach?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiRpcCommand {
  type: "get_state" | "prompt" | "abort";
  message?: string;
}

export interface PiRpcResponse {
  id: string;
  type: "response";
  command: PiRpcCommand["type"];
  success: boolean;
  data?: unknown;
  error?: string;
}
