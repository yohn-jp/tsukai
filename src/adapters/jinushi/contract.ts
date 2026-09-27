/** Jinushi protocol v1 projection, frozen against jinushi main@630592a. */
export interface JinushiRunSpec {
  argv: string[];
  cwd: string;
  environment: { mode: "replace" | "inherit-supervisor"; set?: Record<string, string>; unset?: string[] };
  interactive: false;
  lifetime: { mode: "detached" };
  limits?: { outputBytes?: number; wallTimeMs?: number };
  correlation: Record<string, string>;
}

export interface JinushiReceipt {
  version: number;
  runId: string;
  outcome: string;
  exitCode?: number;
  signal?: string;
  forced: boolean;
  cleanup: string;
  output: { historyComplete: boolean };
  evidenceIncomplete: boolean;
}

export interface JinushiRun {
  runId: string;
  state: "accepted" | "starting" | "running" | "terminating" | "reconciling" | "terminal" | "uncertain";
  ownership?: { backend: string; pid?: number };
  output: {
    stdout: { observedBytes: number; retainedFrom: number };
    stderr: { observedBytes: number; retainedFrom: number };
    historyComplete: boolean;
  };
  receipt?: JinushiReceipt;
}

export interface JinushiEvent {
  version: number;
  runId: string;
  seq: number;
  kind: string;
  payload?: { output?: { stream: string; bytes?: number; observedBytes?: number } };
}

export interface JinushiEventPage {
  run?: JinushiRun;
  events: JinushiEvent[];
  retainedFrom: number;
  gap: boolean;
}

export interface JinushiOutputPage {
  run?: JinushiRun;
  data: Uint8Array;
  retainedFrom: number;
  gap: boolean;
}

/** Each mutation is a single attempt. Transport loss never proves nonexecution. */
export interface JinushiClient {
  capabilities(): Promise<{ backend: string }>;
  run(spec: JinushiRunSpec): Promise<JinushiRun>;
  input(runId: string, bytes: Uint8Array): Promise<void>;
  closeInput(runId: string): Promise<void>;
  output(runId: string, stream: "stdout" | "stderr", offset: number, limit: number): Promise<JinushiOutputPage>;
  followEvents(runId: string, after: number, signal: AbortSignal, onPage: (page: JinushiEventPage) => Promise<void>): Promise<void>;
  inspect(runId: string): Promise<JinushiRun>;
  await(runId: string, signal?: AbortSignal): Promise<JinushiRun>;
  cancel(runId: string): Promise<void>;
}
