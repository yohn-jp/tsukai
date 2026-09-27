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

export interface PiDuplexExecutionPort {
  open(
    agentRunId: string,
    observer: PiTransportObserver,
    workspace?: { cwd: string; workspaceSessionId?: string },
  ): Promise<PiDuplexExecution>;
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
