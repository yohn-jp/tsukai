/** Jinushi protocol v1 projection, checked against jinushi main@3db1f2a (protocol code identical to 44c5003). */
export interface JinushiRunSpec {
  argv: string[];
  cwd: string;
  environment: {
    mode: "replace" | "inherit-supervisor";
    set?: Record<string, string>;
    unset?: string[];
  };
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
  generation: number;
  state:
    | "accepted"
    | "starting"
    | "running"
    | "terminating"
    | "reconciling"
    | "terminal"
    | "uncertain";
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
  payload?: {
    output?: { stream: string; bytes?: number; observedBytes?: number };
  };
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

/** Retry-safe identities are supplied explicitly; callers may replay only the same identified mutation. */
export interface JinushiClient {
  capabilities(): Promise<{ backend: string }>;
  run(submissionId: string, spec: JinushiRunSpec): Promise<JinushiRun>;
  acquireWriter(runId: string, ownerId: string): Promise<string>;
  releaseWriter(
    runId: string,
    ownerId: string,
    writerToken: string,
  ): Promise<void>;
  input(
    runId: string,
    requestId: string,
    expectedGeneration: number,
    writerToken: string,
    bytes: Uint8Array,
  ): Promise<JinushiRun>;
  closeInput(
    runId: string,
    requestId: string,
    expectedGeneration: number,
    writerToken: string,
  ): Promise<JinushiRun>;
  output(
    runId: string,
    stream: "stdout" | "stderr",
    offset: number,
    limit: number,
  ): Promise<JinushiOutputPage>;
  followEvents(
    runId: string,
    after: number,
    signal: AbortSignal,
    onPage: (page: JinushiEventPage) => Promise<void>,
  ): Promise<void>;
  inspect(runId: string): Promise<JinushiRun>;
  await(runId: string, signal?: AbortSignal): Promise<JinushiRun>;
  cancel(
    runId: string,
    requestId: string,
    expectedGeneration: number,
  ): Promise<JinushiRun>;
}
