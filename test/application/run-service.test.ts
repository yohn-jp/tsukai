import { describe, expect, it } from "vitest";
import type {
  ExecutionBinding,
  ObservationDraft,
  ObservationEnvelope,
  ObservationPage,
  PhysicalReceipt,
  RunCreateInput,
} from "../../src/contracts/types.js";
import type {
  ExecutionObserver,
  ExecutionPort,
  HarnessDecoder,
  HarnessPort,
  JournalPort,
} from "../../src/contracts/ports.js";
import type { RuntimeLimits } from "../../src/contracts/limits.js";
import {
  RunNotFoundError,
  UnsupportedBackendError,
  WaitTimeoutError,
} from "../../src/contracts/types.js";
import { createRunService } from "../../src/application/index.js";

type TestSignal =
  | {
      type: "observation";
      draft: Omit<ObservationDraft, "runId">;
    }
  | {
      type: "settlement";
      status: "success" | "error" | "abort";
      reason: string;
      reportedText?: string;
    };

class TestExecution implements ExecutionPort {
  readonly observers = new Map<string, ExecutionObserver>();
  readonly retirements: Array<{
    executionRunId: string;
    reason: "settled" | "cancel";
  }> = [];
  readonly inputs: string[] = [];
  beforeBinding?: (agentRunId: string, observer: ExecutionObserver) => void;
  private nextPid = 4000;

  async start(
    agentRunId: string,
    _request: RunCreateInput["request"],
    observer: ExecutionObserver,
  ): Promise<ExecutionBinding> {
    this.observers.set(agentRunId, observer);
    this.beforeBinding?.(agentRunId, observer);
    return {
      executionRunId: `execution-${agentRunId}`,
      backend: "mock-fixture",
      pid: this.nextPid++,
    };
  }

  async input(
    executionRunId: string,
    _command: { kind: "release" },
  ): Promise<void> {
    this.inputs.push(executionRunId);
  }

  async retire(
    executionRunId: string,
    reason: "settled" | "cancel",
  ): Promise<void> {
    this.retirements.push({ executionRunId, reason });
  }

  async dispose(): Promise<void> {}

  emit(agentRunId: string, signal: TestSignal): void {
    this.observers
      .get(agentRunId)
      ?.onOutput(new TextEncoder().encode(`${JSON.stringify(signal)}\n`));
  }

  exit(agentRunId: string, receipt?: Partial<PhysicalReceipt>): void {
    const executionRunId = `execution-${agentRunId}`;
    this.observers.get(agentRunId)?.onExit({
      executionRunId,
      status: "exited",
      exitCode: 0,
      signal: null,
      forced: false,
      ...receipt,
    });
  }
}

class TestHarness implements HarnessPort {
  decoder(): HarnessDecoder {
    let pending = "";
    const decode = (chunk: Uint8Array): TestSignal[] => {
      pending += new TextDecoder().decode(chunk);
      const signals: TestSignal[] = [];
      let delimiter = pending.indexOf("\n");
      while (delimiter >= 0) {
        const frame = pending.slice(0, delimiter);
        pending = pending.slice(delimiter + 1);
        if (frame.length > 0) signals.push(JSON.parse(frame) as TestSignal);
        delimiter = pending.indexOf("\n");
      }
      return signals;
    };
    return {
      push: decode,
      finish: () => {
        if (pending.length === 0) return [];
        const frame = pending;
        pending = "";
        return [JSON.parse(frame) as TestSignal];
      },
    };
  }
}

class TestJournal implements JournalPort {
  readonly records: ObservationEnvelope[] = [];
  private readonly waiters = new Set<() => void>();

  append(draft: ObservationDraft): ObservationEnvelope {
    const sameRun = this.records.filter(
      (record) => record.runId === draft.runId,
    );
    const envelope: ObservationEnvelope = {
      ...draft,
      schemaVersion: 1,
      seq: (sameRun.at(-1)?.seq ?? 0) + 1,
      receivedAt: new Date().toISOString(),
    };
    this.records.push(envelope);
    for (const wake of this.waiters) wake();
    return envelope;
  }

  read(runId: string, afterSeq = 0, limit = 100): ObservationPage {
    const records = this.records.filter(
      (record) => record.runId === runId && record.seq > afterSeq,
    );
    return {
      items: records.slice(0, limit),
      retainedFrom: records[0]?.seq ?? afterSeq + 1,
      gap: false,
      ...(records.length > limit
        ? { nextCursor: String(records[limit - 1]?.seq) }
        : {}),
    };
  }

  async *subscribe(
    runId: string,
    afterSeq = 0,
  ): AsyncIterable<ObservationEnvelope> {
    let cursor = afterSeq;
    while (true) {
      const page = this.read(runId, cursor, 100);
      for (const record of page.items) {
        cursor = record.seq;
        yield record;
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }

  export(runId?: string): string {
    return JSON.stringify(
      this.records.filter(
        (record) => runId === undefined || record.runId === runId,
      ),
    );
  }

  close(): void {}
}

function createTestService(limits?: Partial<RuntimeLimits>) {
  const execution = new TestExecution();
  const journal = new TestJournal();
  const service = createRunService({
    execution,
    harness: new TestHarness(),
    journal,
    ...(limits === undefined ? {} : { limits }),
  });
  return { service, execution, journal };
}

const request = (scenario: RunCreateInput["request"]["scenario"] = "hold") => ({
  harness: "mock" as const,
  request: { scenario },
});

const success = (reportedText = "reported answer") => ({
  type: "settlement" as const,
  status: "success" as const,
  reason: "agent-settled-success",
  reportedText,
});

describe("createRunService", () => {
  it("registers parent and child runs and returns isolated paged snapshots", async () => {
    const { service, execution } = createTestService();
    const parent = await service.runs.create({
      ...request(),
      metadata: { task: "parent" },
    });
    const child = await service.runs.create({
      ...request(),
      parentRunId: parent.agentRunId,
      metadata: { task: "child" },
    });

    expect(child.parentRunId).toBe(parent.agentRunId);
    expect(
      service.runs
        .children(parent.agentRunId)
        .items.map((run) => run.agentRunId),
    ).toEqual([child.agentRunId]);
    expect(service.runs.list({ limit: 1 }).items).toHaveLength(1);
    expect(
      service.runs.list({ cursor: parent.agentRunId, limit: 1 }).items[0]
        ?.agentRunId,
    ).toBe(child.agentRunId);
    expect(execution.observers.size).toBe(2);

    parent.metadata.task = "caller mutation";
    parent.lifecycle = "terminal";
    expect(service.runs.get(parent.agentRunId).metadata.task).toBe("parent");
    expect(service.runs.get(parent.agentRunId).lifecycle).toBe("running");

    expect(() => service.runs.get("missing")).toThrow(RunNotFoundError);
    expect(() => service.runs.children("missing")).toThrow(RunNotFoundError);
    expect(() => service.runs.result("missing")).toThrow(RunNotFoundError);
  });

  it("rejects a non-mock backend instead of selecting a fallback", async () => {
    const { service } = createTestService();
    await expect(
      service.runs.create({
        harness: "pi",
        request: { scenario: "normal" },
      } as unknown as RunCreateInput),
    ).rejects.toBeInstanceOf(UnsupportedBackendError);
  });

  it("registers the run projection before synchronous fixture output can arrive", async () => {
    const execution = new TestExecution();
    const journal = new TestJournal();
    const service = createRunService({
      execution,
      harness: new TestHarness(),
      journal,
    });
    execution.beforeBinding = (agentRunId, observer) => {
      execution.emit(agentRunId, success("settled before binding"));
      execution.exit(agentRunId);
      expect(observer).toBeDefined();
    };

    const run = await service.runs.create(request());

    expect(run.lifecycle).toBe("terminal");
    expect(run.outcome).toBe("completed");
    expect(journal.records[0]).toMatchObject({
      runId: run.agentRunId,
      seq: 1,
      kind: "run.snapshot",
      payload: { snapshot: { lifecycle: "accepted" } },
    });
    expect(service.runs.result(run.agentRunId)).toMatchObject({
      ready: true,
      reportedText: "settled before binding",
    });
  });

  it("enforces injected run and metadata bounds", async () => {
    const { service, execution } = createTestService({
      maxRuns: 1,
      maxMetadataEntries: 1,
      maxMetadataValueBytes: 4,
    });
    await expect(
      service.runs.create({ ...request(), metadata: { value: "longer" } }),
    ).rejects.toThrow(RangeError);
    await expect(
      service.runs.create({
        ...request(),
        metadata: { first: "1", second: "2" },
      }),
    ).rejects.toThrow(RangeError);
    await service.runs.create({ ...request(), metadata: { value: "okay" } });
    await expect(service.runs.create(request())).rejects.toThrow(RangeError);
    expect(execution.observers.size).toBe(1);
  });

  it("does not complete a settled operation until the execution has exited", async () => {
    const { service, execution, journal } = createTestService();
    const run = await service.runs.create(request());

    execution.emit(run.agentRunId, success("private reported result"));

    expect(service.runs.get(run.agentRunId).lifecycle).toBe("stopping");
    expect(service.runs.result(run.agentRunId)).toEqual({
      ready: false,
      agentRunId: run.agentRunId,
    });
    expect(execution.retirements).toEqual([
      {
        executionRunId:
          run.execution?.executionRunId ?? `execution-${run.agentRunId}`,
        reason: "settled",
      },
    ]);

    const snapshots = journal.records.filter(
      (event) => event.kind === "run.snapshot",
    );
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(snapshots)).not.toContain("private reported result");

    execution.exit(run.agentRunId);
    await expect(service.runs.wait(run.agentRunId)).resolves.toMatchObject({
      lifecycle: "terminal",
      semantic: "settled",
      outcome: "completed",
    });
    expect(service.runs.result(run.agentRunId)).toEqual({
      ready: true,
      agentRunId: run.agentRunId,
      outcome: "completed",
      reason: "agent-settled-success",
      reportedText: "private reported result",
      receipt: {
        executionRunId: `execution-${run.agentRunId}`,
        status: "exited",
        exitCode: 0,
        signal: null,
        forced: false,
      },
    });
  });

  it("keeps a waiter pending through semantic settlement and resolves it after exit", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());
    let resolved = false;
    const waiting = service.runs.wait(run.agentRunId).then((snapshot) => {
      resolved = true;
      return snapshot;
    });

    execution.emit(run.agentRunId, success());
    expect(resolved).toBe(false);
    execution.exit(run.agentRunId);

    await expect(waiting).resolves.toMatchObject({
      lifecycle: "terminal",
      outcome: "completed",
    });
    expect(resolved).toBe(true);
  });

  it("uses the first cancel intent, waits for physical exit, and does not cascade", async () => {
    const { service, execution } = createTestService();
    const parent = await service.runs.create(request());
    const child = await service.runs.create({
      ...request(),
      parentRunId: parent.agentRunId,
    });

    const first = service.runs.cancel(parent.agentRunId);
    const second = service.runs.cancel(parent.agentRunId);
    await expect(first).resolves.toMatchObject({ lifecycle: "stopping" });
    await expect(second).resolves.toMatchObject({ lifecycle: "stopping" });
    expect(execution.retirements).toEqual([
      { executionRunId: `execution-${parent.agentRunId}`, reason: "cancel" },
    ]);
    execution.emit(parent.agentRunId, success("late result after cancel"));
    expect(service.runs.get(parent.agentRunId).semantic).toBe("aborted");
    expect(service.runs.result(parent.agentRunId)).toEqual({
      ready: false,
      agentRunId: parent.agentRunId,
    });

    execution.exit(parent.agentRunId);
    await expect(service.runs.wait(parent.agentRunId)).resolves.toMatchObject({
      outcome: "cancelled",
      lifecycle: "terminal",
    });
    expect(service.runs.get(child.agentRunId).lifecycle).toBe("running");
  });

  it("does not treat agent_end or continuation observations as settlement", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());
    for (const kind of ["agent_end", "retry", "compaction", "continuation"]) {
      execution.emit(run.agentRunId, {
        type: "observation",
        draft: { source: "harness", kind, payload: {} },
      });
      expect(service.runs.get(run.agentRunId).lifecycle).toBe("running");
      expect(service.runs.result(run.agentRunId)).toEqual({
        ready: false,
        agentRunId: run.agentRunId,
      });
    }

    execution.emit(run.agentRunId, success());
    execution.exit(run.agentRunId);
    expect(service.runs.result(run.agentRunId)).toMatchObject({
      ready: true,
      outcome: "completed",
    });
  });

  it("preserves normal settlement when cancellation arrives during cleanup", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());
    execution.emit(run.agentRunId, success());

    await service.runs.cancel(run.agentRunId);
    expect(service.runs.get(run.agentRunId).outcome).toBeUndefined();
    expect(execution.retirements).toEqual([
      { executionRunId: `execution-${run.agentRunId}`, reason: "settled" },
      { executionRunId: `execution-${run.agentRunId}`, reason: "cancel" },
    ]);

    execution.exit(run.agentRunId);
    expect(service.runs.result(run.agentRunId)).toMatchObject({
      ready: true,
      outcome: "completed",
    });
  });

  it("classifies a crash without settlement as interrupted and explicit error as failed", async () => {
    const { service, execution } = createTestService();
    const crash = await service.runs.create(request("crash"));
    execution.exit(crash.agentRunId, { exitCode: 17 });
    expect(service.runs.result(crash.agentRunId)).toMatchObject({
      ready: true,
      outcome: "interrupted",
      reason: "execution-exited-before-settlement",
    });

    const failed = await service.runs.create(request("error"));
    execution.emit(failed.agentRunId, {
      type: "settlement",
      status: "error",
      reason: "fixture-harness-error",
    });
    execution.exit(failed.agentRunId, { exitCode: 1 });
    expect(service.runs.result(failed.agentRunId)).toMatchObject({
      ready: true,
      outcome: "failed",
      reason: "fixture-harness-error",
    });
  });

  it("treats waiter timeout and abort as wait cancellation only", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());

    await expect(
      service.runs.wait(run.agentRunId, { timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.runs.wait(run.agentRunId, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(service.runs.get(run.agentRunId).lifecycle).toBe("running");
    expect(execution.retirements).toEqual([]);
  });

  it("returns explicit uncertainty on transport loss and resolves it with later exit evidence", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());
    execution.observers
      .get(run.agentRunId)
      ?.onError(new Error("private transport detail"));

    await expect(service.runs.wait(run.agentRunId)).resolves.toMatchObject({
      lifecycle: "uncertain",
      completeness: "incomplete",
    });
    expect(service.runs.result(run.agentRunId)).toEqual({
      ready: false,
      agentRunId: run.agentRunId,
    });
    expect(JSON.stringify(service.runs.get(run.agentRunId))).not.toContain(
      "private transport detail",
    );

    execution.exit(run.agentRunId, { exitCode: 2 });
    expect(service.runs.result(run.agentRunId)).toMatchObject({
      ready: true,
      outcome: "interrupted",
    });
  });

  it("establishes each subscription after registering the run", async () => {
    const { service, execution } = createTestService();
    const run = await service.runs.create(request());
    const iterator = service.runs
      .events(run.agentRunId, 0)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.snapshot", seq: 1 },
    });

    execution.exit(run.agentRunId, { exitCode: 1 });
    const next = await iterator.next();
    expect(next.done).toBe(false);
    await iterator.return?.();
  });
});
