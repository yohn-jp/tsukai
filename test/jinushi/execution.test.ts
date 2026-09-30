import { describe, expect, it } from "vitest";
import type { PiTransportObserver } from "../../src/contracts/pi.js";
import type {
  JinushiClient,
  JinushiEvent,
  JinushiEventPage,
  JinushiOutputPage,
  JinushiRun,
  JinushiRunSpec,
} from "../../src/adapters/jinushi/contract.js";
import {
  createJinushiPiExecutionPort,
  JinushiEffectUncertainError,
  type JinushiPiExecutionPortOptions,
} from "../../src/adapters/jinushi/execution.js";

function run(
  state: JinushiRun["state"],
  options: {
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutRetainedFrom?: number;
    stderrRetainedFrom?: number;
    historyComplete?: boolean;
    receipt?: JinushiRun["receipt"];
  } = {},
): JinushiRun {
  return {
    runId: "jinushi-run-1",
    generation: 1,
    state,
    ownership: { backend: "linux-cgroup-v2", pid: 43210 },
    output: {
      stdout: {
        observedBytes: options.stdoutBytes ?? 0,
        retainedFrom: options.stdoutRetainedFrom ?? 0,
      },
      stderr: {
        observedBytes: options.stderrBytes ?? 0,
        retainedFrom: options.stderrRetainedFrom ?? 0,
      },
      historyComplete: options.historyComplete ?? true,
    },
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
  };
}

function event(
  seq: number,
  kind: string,
  output?: { stream: string; bytes?: number; observedBytes?: number },
): JinushiEvent {
  return {
    version: 1,
    runId: "jinushi-run-1",
    seq,
    kind,
    ...(output === undefined ? {} : { payload: { output } }),
  };
}

class FakeJinushiClient implements JinushiClient {
  spec: JinushiRunSpec | undefined;
  submissionIds: string[] = [];
  runCalls = 0;
  inputCalls: Uint8Array[] = [];
  closeInputCalls = 0;
  writerAcquireCalls = 0;
  writerReleaseCalls = 0;
  cancelCalls = 0;
  awaitCalls = 0;
  readonly outputCalls: Array<{ stream: "stdout" | "stderr"; offset: number }> =
    [];
  current = run("accepted");
  stdout = new Uint8Array();
  stderr = new Uint8Array();
  runFailure: Error | undefined;
  inputFailure: Error | undefined;
  closeInputFailure: Error | undefined;
  cancelFailure: Error | undefined;
  followCallback: ((page: JinushiEventPage) => Promise<void>) | undefined;
  followSignal: AbortSignal | undefined;
  awaitedRun: JinushiRun | undefined;

  async capabilities(): Promise<{ backend: string }> {
    return { backend: "linux-cgroup-v2" };
  }

  async run(submissionId: string, spec: JinushiRunSpec): Promise<JinushiRun> {
    this.runCalls += 1;
    this.submissionIds.push(submissionId);
    this.spec = spec;
    if (this.runFailure !== undefined) throw this.runFailure;
    this.current = run("accepted");
    return this.current;
  }

  async acquireWriter(_runId: string, _ownerId: string): Promise<string> {
    this.writerAcquireCalls += 1;
    return "writer-token";
  }

  async releaseWriter(
    _runId: string,
    _ownerId: string,
    _writerToken: string,
  ): Promise<void> {
    this.writerReleaseCalls += 1;
  }

  async input(
    _runId: string,
    _requestId: string,
    _expectedGeneration: number,
    _writerToken: string,
    bytes: Uint8Array,
  ): Promise<JinushiRun> {
    this.inputCalls.push(new Uint8Array(bytes));
    if (this.inputFailure !== undefined) throw this.inputFailure;
    this.current = { ...this.current, generation: this.current.generation + 1 };
    return this.current;
  }

  async closeInput(
    _runId: string,
    _requestId: string,
    _expectedGeneration: number,
    _writerToken: string,
  ): Promise<JinushiRun> {
    this.closeInputCalls += 1;
    if (this.closeInputFailure !== undefined) throw this.closeInputFailure;
    this.current = { ...this.current, generation: this.current.generation + 1 };
    return this.current;
  }

  async output(
    _runId: string,
    stream: "stdout" | "stderr",
    offset: number,
    limit: number,
  ): Promise<JinushiOutputPage> {
    this.outputCalls.push({ stream, offset });
    const retainedFrom = this.current.output[stream].retainedFrom;
    const source = stream === "stdout" ? this.stdout : this.stderr;
    const data = source.slice(offset, offset + limit);
    return {
      run: this.current,
      data,
      retainedFrom,
      gap: offset < retainedFrom,
    };
  }

  async followEvents(
    _runId: string,
    _after: number,
    signal: AbortSignal,
    onPage: (page: JinushiEventPage) => Promise<void>,
  ): Promise<void> {
    this.followCallback = onPage;
    this.followSignal = signal;
    const start = run("running");
    this.current = start;
    queueMicrotask(() => {
      void onPage({
        run: start,
        events: [
          event(1, "run.accepted"),
          event(2, "run.starting"),
          event(3, "run.running"),
        ],
        retainedFrom: 1,
        gap: false,
      });
    });
    if (signal.aborted) return;
    await new Promise<void>((resolveFollow) => {
      signal.addEventListener("abort", () => resolveFollow(), { once: true });
    });
  }

  async inspect(_runId: string): Promise<JinushiRun> {
    return this.current;
  }

  async await(_runId: string): Promise<JinushiRun> {
    this.awaitCalls += 1;
    return this.awaitedRun ?? this.current;
  }

  async cancel(
    _runId: string,
    _requestId: string,
    _expectedGeneration: number,
  ): Promise<JinushiRun> {
    this.cancelCalls += 1;
    if (this.cancelFailure !== undefined) throw this.cancelFailure;
    this.current = { ...this.current, generation: this.current.generation + 1 };
    return this.current;
  }

  async emit(page: JinushiEventPage): Promise<void> {
    this.current = page.run ?? this.current;
    await this.followCallback?.(page);
  }
}

function options(client: JinushiClient): JinushiPiExecutionPortOptions {
  return {
    client,
    executable: "/opt/pi/bin/pi",
    environment: {
      mode: "replace",
      set: { PATH: "/usr/bin", HOME: "/tmp/pi-home", PI_OFFLINE: "1" },
    },
  };
}

function observed(): {
  observer: PiTransportObserver;
  stdout: Buffer[];
  stderr: Buffer[];
  errors: Error[];
  exits: Array<{
    status: string;
    exitCode: number | null;
    signal: string | null;
  }>;
  timeline: string[];
} {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const errors: Error[] = [];
  const timeline: string[] = [];
  const exits: Array<{
    status: string;
    exitCode: number | null;
    signal: string | null;
  }> = [];
  return {
    stdout,
    stderr,
    errors,
    exits,
    timeline,
    observer: {
      onStdout: (bytes) => {
        timeline.push("stdout");
        stdout.push(Buffer.from(bytes));
      },
      onStderr: (bytes) => {
        timeline.push("stderr");
        stderr.push(Buffer.from(bytes));
      },
      onError: (error) => errors.push(error),
      onExit: (receipt) => {
        timeline.push("exit");
        exits.push({
          status: receipt.status,
          exitCode: receipt.exitCode,
          signal: receipt.signal,
        });
      },
    },
  };
}

describe("Jinushi Pi execution adapter", () => {
  it("submits one fixed Pi Run, preserves ordered streams, and drains output before receipt", async () => {
    const client = new FakeJinushiClient();
    const capture = observed();
    const port = createJinushiPiExecutionPort({
      ...options(client),
      maxStderrBytes: 3,
      outputPageBytes: 5,
      limits: { outputBytes: 4096, wallTimeMs: 30_000 },
    });
    const execution = await port.open("agent-run-1", capture.observer, {
      cwd: "/work/project",
      workspaceSessionId: "opaque-session",
    });

    expect(client.runCalls).toBe(1);
    expect(client.submissionIds[0]).toMatch(/^tsukai-[0-9a-f]{64}$/);
    expect(client.spec).toEqual({
      argv: [
        "/opt/pi/bin/pi",
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--no-tools",
      ],
      cwd: "/work/project",
      environment: {
        mode: "replace",
        set: { PATH: "/usr/bin", HOME: "/tmp/pi-home", PI_OFFLINE: "1" },
      },
      interactive: false,
      lifetime: { mode: "detached" },
      limits: { outputBytes: 4096, wallTimeMs: 30_000 },
      correlation: { "tsukai.agentRunId": "agent-run-1" },
    });
    expect(execution.executionRunId).toBe("jinushi-run-1");
    expect(execution.backend).toBe("linux-cgroup-v2");
    expect(execution.pid).toBe(43210);

    await execution.write(Buffer.from('{"type":"get_state"}\n'));
    expect(client.inputCalls).toHaveLength(1);
    expect(client.writerAcquireCalls).toBe(1);
    expect(client.writerReleaseCalls).toBe(1);

    client.stdout = Buffer.from('{"type":"response"}\n');
    client.stderr = Buffer.from("diagnostic-data");
    const completed = run("terminal", {
      stdoutBytes: client.stdout.byteLength,
      stderrBytes: client.stderr.byteLength,
      receipt: {
        version: 1,
        runId: "jinushi-run-1",
        outcome: "exited",
        exitCode: 7,
        forced: false,
        cleanup: "complete",
        output: { historyComplete: true },
        evidenceIncomplete: false,
      },
    });
    await client.emit({
      run: completed,
      events: [
        event(4, "output.chunk", {
          stream: "stdout",
          bytes: client.stdout.byteLength,
        }),
        event(5, "output.chunk", {
          stream: "stderr",
          bytes: client.stderr.byteLength,
        }),
        event(6, "run.terminal"),
      ],
      retainedFrom: 1,
      gap: false,
    });

    expect(Buffer.concat(capture.stdout).toString()).toBe(
      client.stdout.toString(),
    );
    expect(Buffer.concat(capture.stderr).toString()).toBe("dia");
    expect(capture.exits).toEqual([
      { status: "exited", exitCode: 7, signal: null },
    ]);
    expect(capture.timeline.at(-1)).toBe("exit");
    expect(
      client.outputCalls
        .filter((call) => call.stream === "stdout")
        .map((call) => call.offset),
    ).toEqual([0, 5, 10, 15]);
    expect(capture.errors).toEqual([]);
    await port.dispose();
  });

  it("surfaces ambiguous Run and input effects without retrying", async () => {
    const runClient = new FakeJinushiClient();
    runClient.runFailure = Object.assign(new Error("IPC EOF"), {
      ambiguousEffect: true,
    });
    const runPort = createJinushiPiExecutionPort(options(runClient));
    await expect(
      runPort.open("agent-run-ambiguous", observed().observer, {
        cwd: "/work/project",
      }),
    ).rejects.toBeInstanceOf(JinushiEffectUncertainError);
    expect(runClient.runCalls).toBe(2);
    expect(new Set(runClient.submissionIds).size).toBe(1);

    const inputClient = new FakeJinushiClient();
    inputClient.inputFailure = Object.assign(new Error("IPC EOF"), {
      ambiguousEffect: true,
    });
    const inputCapture = observed();
    const inputPort = createJinushiPiExecutionPort(options(inputClient));
    const execution = await inputPort.open(
      "agent-run-input",
      inputCapture.observer,
      {
        cwd: "/work/project",
      },
    );
    await expect(
      execution.write(Buffer.from("command\n")),
    ).rejects.toBeInstanceOf(JinushiEffectUncertainError);
    expect(inputClient.inputCalls).toHaveLength(2);
    expect(inputClient.writerAcquireCalls).toBe(1);
    expect(inputClient.writerReleaseCalls).toBe(1);
    await inputPort.dispose().catch(() => undefined);
  });

  it("reports retained output gaps and never turns cancellation acknowledgement into exit", async () => {
    const client = new FakeJinushiClient();
    const capture = observed();
    const port = createJinushiPiExecutionPort(options(client));
    const execution = await port.open("agent-run-gap", capture.observer, {
      cwd: "/work/project",
    });
    client.stdout = Buffer.from("lost");
    const gapRun = run("running", {
      stdoutBytes: client.stdout.byteLength,
      stdoutRetainedFrom: client.stdout.byteLength,
      historyComplete: false,
    });
    await client.emit({
      run: gapRun,
      events: [event(4, "output.gap", { stream: "stdout", observedBytes: 4 })],
      retainedFrom: 1,
      gap: false,
    });
    expect(capture.errors.some((error) => error.message.includes("gap"))).toBe(
      true,
    );
    expect(capture.stdout).toEqual([]);
    expect(capture.exits).toEqual([]);
    await port.dispose().catch(() => undefined);

    const terminalGapClient = new FakeJinushiClient();
    const terminalGapCapture = observed();
    const terminalGapPort = createJinushiPiExecutionPort(
      options(terminalGapClient),
    );
    await terminalGapPort.open(
      "agent-run-terminal-gap",
      terminalGapCapture.observer,
      {
        cwd: "/work/project",
      },
    );
    terminalGapClient.stdout = Buffer.from("lost");
    terminalGapClient.current = run("terminal", {
      stdoutBytes: terminalGapClient.stdout.byteLength,
      stdoutRetainedFrom: terminalGapClient.stdout.byteLength,
      historyComplete: false,
      receipt: {
        version: 1,
        runId: "jinushi-run-1",
        outcome: "exited",
        exitCode: 0,
        forced: false,
        cleanup: "complete",
        output: { historyComplete: false },
        evidenceIncomplete: true,
      },
    });
    await terminalGapClient.emit({
      run: terminalGapClient.current,
      events: [event(4, "output.gap", { stream: "stdout", observedBytes: 4 })],
      retainedFrom: 1,
      gap: false,
    });
    expect(
      terminalGapCapture.errors.some((error) => error.message.includes("gap")),
    ).toBe(true);
    expect(terminalGapCapture.exits).toEqual([]);
    expect(terminalGapClient.cancelCalls).toBe(0);
    await terminalGapPort.dispose();

    const uncertainClient = new FakeJinushiClient();
    const uncertainCapture = observed();
    const uncertainPort = createJinushiPiExecutionPort(
      options(uncertainClient),
    );
    await uncertainPort.open("agent-run-uncertain", uncertainCapture.observer, {
      cwd: "/work/project",
    });
    const uncertain = run("uncertain");
    await uncertainClient.emit({
      run: uncertain,
      events: [event(4, "run.uncertain")],
      retainedFrom: 1,
      gap: false,
    });
    expect(
      uncertainCapture.errors.some((error) => error.message.includes("prove")),
    ).toBe(true);
    expect(uncertainCapture.exits).toEqual([]);
    await uncertainPort.dispose();
    expect(uncertainClient.cancelCalls).toBe(0);

    const cancelClient = new FakeJinushiClient();
    const cancelCapture = observed();
    const cancelPort = createJinushiPiExecutionPort(options(cancelClient));
    const cancelExecution = await cancelPort.open(
      "agent-run-cancel",
      cancelCapture.observer,
      { cwd: "/work/project" },
    );
    const terminal = run("terminal", {
      receipt: {
        version: 1,
        runId: "jinushi-run-1",
        outcome: "cancelled",
        signal: "SIGTERM",
        forced: true,
        cleanup: "complete",
        output: { historyComplete: true },
        evidenceIncomplete: false,
      },
    });
    cancelClient.awaitedRun = terminal;
    await cancelExecution.retire("cancel");
    expect(cancelClient.cancelCalls).toBe(1);
    expect(cancelClient.awaitCalls).toBe(1);
    expect(cancelCapture.exits).toEqual([
      { status: "exited", exitCode: null, signal: "SIGTERM" },
    ]);
    await cancelPort.dispose();
  });

  it("accepts close-input racing with a known terminal receipt", async () => {
    const client = new FakeJinushiClient();
    client.closeInputFailure = Object.assign(new Error("Run is terminal"), {
      code: "already-terminal",
    });
    const port = createJinushiPiExecutionPort(options(client));
    const execution = await port.open("agent-run-race", observed().observer, {
      cwd: "/work/project",
    });
    client.current = run("terminal", {
      receipt: {
        version: 1,
        runId: "jinushi-run-1",
        outcome: "exited",
        exitCode: 0,
        forced: false,
        cleanup: "complete",
        output: { historyComplete: true },
        evidenceIncomplete: false,
      },
    });
    await expect(execution.closeInput()).resolves.toBeUndefined();
    expect(client.closeInputCalls).toBe(1);
    await port.dispose();
  });
});
