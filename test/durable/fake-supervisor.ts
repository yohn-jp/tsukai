import { createHash } from "node:crypto";
import { JinushiClientError } from "../../src/adapters/jinushi/client.js";
import type {
  JinushiClient,
  JinushiEvent,
  JinushiEventPage,
  JinushiOutputPage,
  JinushiRun,
  JinushiRunSpec,
} from "../../src/adapters/jinushi/contract.js";

export interface FakeRun {
  runId: string;
  generation: number;
  state: JinushiRun["state"];
  stdout: Buffer;
  stdoutRetainedFrom: number;
  stderr: Buffer;
  events: JinushiEvent[];
  eventsRetainedFrom: number;
  inputCommands: { type: string; id?: string }[];
  inputClosed: boolean;
  exitCode: number | null;
  forced: boolean;
  specDigest: string;
  waiters: Set<() => void>;
  heldTranscript: boolean;
  promptDisposition: "started" | "queued";
}

/** An in-memory Jinushi that outlives any number of Tsukai owner instances. */
export class FakeSupervisor {
  readonly runs = new Map<string, FakeRun>();
  private readonly submissions = new Map<string, string>();
  runStarts = 0;
  /** Number of times the physical Run would have been created. */
  runCalls = 0;
  /** Prompts Pi received over stdin, across every owner life. */
  prompts = 0;
  /** While true every call fails as an unreachable supervisor. */
  outage = false;
  /** Withhold the Pi transcript after the prompt is accepted. */
  holdTranscript = false;
  /** Pi exits as soon as its stdin closes (a real Pi does). */
  exitOnCloseInput = true;
  promptDisposition: "started" | "queued" = "started";
  private sequence = 0;

  view(): FakeClientView {
    return new FakeClientView(this);
  }

  run(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`fake run ${runId} missing`);
    return run;
  }

  only(): FakeRun {
    const all = [...this.runs.values()];
    if (all.length !== 1) throw new Error(`expected 1 run, have ${all.length}`);
    return all[0]!;
  }

  snapshot(run: FakeRun): JinushiRun {
    const terminal = run.state === "terminal";
    return {
      runId: run.runId,
      generation: run.generation,
      state: run.state,
      ownership: {
        backend: "fake-backend",
        pid: 4000 + Number(run.runId.slice(-1)),
      },
      output: {
        stdout: {
          observedBytes: run.stdout.length,
          retainedFrom: run.stdoutRetainedFrom,
        },
        stderr: { observedBytes: run.stderr.length, retainedFrom: 0 },
        historyComplete: true,
      },
      ...(terminal
        ? {
            receipt: {
              version: 1,
              runId: run.runId,
              outcome: "exited",
              ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
              forced: run.forced,
              cleanup: "complete",
              output: { historyComplete: true },
              evidenceIncomplete: false,
            },
          }
        : {}),
    };
  }

  create(submissionId: string, spec: JinushiRunSpec): FakeRun {
    this.runCalls += 1;
    const digest = createHash("sha256")
      .update(JSON.stringify(spec))
      .digest("hex");
    const existing = this.submissions.get(submissionId);
    if (existing !== undefined) {
      const run = this.run(existing);
      if (run.specDigest !== digest) throw remote("submission-conflict");
      return run;
    }
    this.sequence += 1;
    const run: FakeRun = {
      runId: `jinushi-run-${this.sequence}`,
      generation: 1,
      state: "running",
      stdout: Buffer.alloc(0),
      stdoutRetainedFrom: 0,
      stderr: Buffer.alloc(0),
      events: [],
      eventsRetainedFrom: 1,
      inputCommands: [],
      inputClosed: false,
      exitCode: null,
      forced: false,
      specDigest: digest,
      waiters: new Set(),
      heldTranscript: false,
      promptDisposition: this.promptDisposition,
    };
    this.runs.set(run.runId, run);
    this.submissions.set(submissionId, run.runId);
    this.runStarts += 1;
    this.event(run, "run.accepted");
    this.event(run, "run.running");
    return run;
  }

  event(run: FakeRun, kind: string): void {
    run.events.push({
      version: 1,
      runId: run.runId,
      seq: (run.events.at(-1)?.seq ?? 0) + 1,
      kind,
    });
    run.generation += 1;
    this.wake(run);
  }

  emitStdout(run: FakeRun, value: object): void {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    run.stdout = Buffer.concat([run.stdout, bytes]);
    this.event(run, "output");
  }

  /** The documented Pi 0.99.1 shape for a normal, settled prompt. */
  emitTranscript(run: FakeRun, text = "private answer"): void {
    this.emitStdout(run, { type: "agent_start" });
    this.emitStdout(run, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input: 2, output: 3, totalTokens: 5 },
      },
    });
    this.emitStdout(run, { type: "agent_end", messages: [], willRetry: false });
    this.emitStdout(run, { type: "agent_settled" });
    run.heldTranscript = false;
  }

  releaseTranscript(run: FakeRun): void {
    if (run.heldTranscript) this.emitTranscript(run);
  }

  terminate(run: FakeRun, exitCode: number, forced = false): void {
    if (run.state === "terminal") return;
    run.state = "terminal";
    run.exitCode = exitCode;
    run.forced = forced;
    this.event(run, "run.terminal");
  }

  /** Drop retained stdout before `offset` (history compaction). */
  compactStdout(run: FakeRun, offset: number): void {
    run.stdoutRetainedFrom = offset;
  }

  compactEvents(run: FakeRun, retainedFrom: number): void {
    run.eventsRetainedFrom = retainedFrom;
    run.events = run.events.filter((event) => event.seq >= retainedFrom);
  }

  promptsSeen(run: FakeRun): number {
    return run.inputCommands.filter((command) => command.type === "prompt")
      .length;
  }

  handleInput(run: FakeRun, bytes: Uint8Array): void {
    for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      const command = JSON.parse(line) as { type: string; id: string };
      run.inputCommands.push(command);
      if (command.type === "get_state") {
        this.emitStdout(run, {
          id: command.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: `pi-session-${run.runId}` },
        });
      } else if (command.type === "prompt") {
        this.prompts += 1;
        this.emitStdout(run, {
          id: command.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { disposition: run.promptDisposition },
        });
        if (run.promptDisposition === "started") {
          if (this.holdTranscript) run.heldTranscript = true;
          else this.emitTranscript(run);
        }
      } else if (command.type === "abort") {
        this.emitStdout(run, {
          id: command.id,
          type: "response",
          command: "abort",
          success: true,
        });
      }
    }
  }

  wake(run: FakeRun): void {
    for (const wake of [...run.waiters]) wake();
  }
}

function remote(code: string): JinushiClientError {
  return new JinushiClientError(`Jinushi failed: ${code}`, {
    kind: "remote",
    operation: "inspect",
    code,
  });
}

function unreachable(operation: string): JinushiClientError {
  return new JinushiClientError("Jinushi is unreachable", {
    kind: "transport",
    operation,
  });
}

/** One owner's connection. `kill()` severs it the way a process death would. */
export class FakeClientView implements JinushiClient {
  private killed = false;
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly sup: FakeSupervisor) {}

  kill(): void {
    this.killed = true;
    for (const controller of this.controllers) controller.abort();
    for (const run of this.sup.runs.values()) this.sup.wake(run);
  }

  private check(operation: string): void {
    if (this.killed || this.sup.outage) throw unreachable(operation);
  }

  private find(runId: string): FakeRun {
    const run = this.sup.runs.get(runId);
    if (run === undefined) throw remote("run-not-found");
    return run;
  }

  async capabilities(): Promise<{ backend: string }> {
    this.check("capabilities");
    return { backend: "fake-backend" };
  }

  async run(submissionId: string, spec: JinushiRunSpec): Promise<JinushiRun> {
    this.check("run");
    return this.sup.snapshot(this.sup.create(submissionId, spec));
  }

  async acquireWriter(): Promise<string> {
    this.check("writer-acquire");
    return "writer-token";
  }

  async releaseWriter(): Promise<void> {
    this.check("writer-release");
  }

  async input(
    runId: string,
    _requestId: string,
    _expectedGeneration: number,
    _writerToken: string,
    bytes: Uint8Array,
  ): Promise<JinushiRun> {
    this.check("input");
    const run = this.find(runId);
    if (run.state === "terminal" || run.inputClosed)
      throw remote("already-terminal");
    this.sup.handleInput(run, bytes);
    return this.sup.snapshot(run);
  }

  async closeInput(runId: string): Promise<JinushiRun> {
    this.check("close-input");
    const run = this.find(runId);
    if (run.state === "terminal") throw remote("already-terminal");
    run.inputClosed = true;
    run.generation += 1;
    if (this.sup.exitOnCloseInput) this.sup.terminate(run, 0);
    return this.sup.snapshot(run);
  }

  async output(
    runId: string,
    stream: "stdout" | "stderr",
    offset: number,
    limit: number,
  ): Promise<JinushiOutputPage> {
    this.check("output");
    const run = this.find(runId);
    const source = stream === "stdout" ? run.stdout : run.stderr;
    const retainedFrom = stream === "stdout" ? run.stdoutRetainedFrom : 0;
    return {
      run: this.sup.snapshot(run),
      data: new Uint8Array(source.subarray(offset, offset + limit)),
      retainedFrom,
      gap: offset < retainedFrom,
    };
  }

  async followEvents(
    runId: string,
    after: number,
    signal: AbortSignal,
    onPage: (page: JinushiEventPage) => Promise<void>,
  ): Promise<void> {
    this.check("events");
    const run = this.find(runId);
    const controller = new AbortController();
    this.controllers.add(controller);
    const stop = (): void => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    try {
      let cursor = after;
      const gap = run.eventsRetainedFrom > after + 1;
      let first = true;
      for (;;) {
        if (controller.signal.aborted || this.killed) return;
        const pending = run.events.filter((event) => event.seq > cursor);
        if (pending.length > 0 || (first && gap)) {
          cursor = pending.at(-1)?.seq ?? cursor;
          await onPage({
            run: this.sup.snapshot(run),
            events: pending,
            retainedFrom: run.eventsRetainedFrom,
            gap: first && gap,
          });
          first = false;
        }
        if (
          run.state === "terminal" &&
          run.events.every((event) => event.seq <= cursor)
        ) {
          return;
        }
        if (run.events.some((event) => event.seq > cursor)) continue;
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            run.waiters.delete(wake);
            controller.signal.removeEventListener("abort", wake);
            resolve();
          };
          run.waiters.add(wake);
          controller.signal.addEventListener("abort", wake, { once: true });
        });
      }
    } finally {
      signal.removeEventListener("abort", stop);
      this.controllers.delete(controller);
    }
  }

  async inspect(runId: string): Promise<JinushiRun> {
    this.check("inspect");
    return this.sup.snapshot(this.find(runId));
  }

  async await(runId: string): Promise<JinushiRun> {
    this.check("await");
    const run = this.find(runId);
    while (run.state !== "terminal") {
      if (this.killed) throw unreachable("await");
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          run.waiters.delete(wake);
          resolve();
        };
        run.waiters.add(wake);
      });
    }
    return this.sup.snapshot(run);
  }

  async cancel(runId: string): Promise<JinushiRun> {
    this.check("cancel");
    const run = this.find(runId);
    if (run.state === "terminal") throw remote("already-terminal");
    this.sup.terminate(run, 143, true);
    return this.sup.snapshot(run);
  }
}
