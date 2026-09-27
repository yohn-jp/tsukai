import { describe, expect, it } from "vitest";
import {
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type PiDuplexExecutionPort,
  type PiTransportObserver,
} from "../../src/index.js";

class FakePiPort implements PiDuplexExecutionPort {
  observer?: PiTransportObserver;
  writes: string[] = [];
  retired = false;
  retireCalls = 0;
  constructor(
    private readonly settle: boolean,
    private readonly autoExit = true,
    private readonly disposition:
      "started" | "queued" | "handled" | null = "started",
    private readonly eventsBeforePromptResponse = false,
    private readonly closeInputFails = false,
  ) {}

  emitExit(exitCode = 0) {
    if (this.retired) return;
    this.retired = true;
    this.observer?.onExit({
      executionRunId: "physical-1",
      status: "exited",
      exitCode,
      signal: null,
      forced: false,
    });
  }

  async open(_agentRunId: string, observer: PiTransportObserver) {
    this.observer = observer;
    return {
      executionRunId: "physical-1",
      backend: "injected-test",
      write: async (bytes: Uint8Array) => {
        const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
          id: string;
          type: string;
        };
        this.writes.push(record.type);
        const emit = (value: object) =>
          observer.onStdout(Buffer.from(`${JSON.stringify(value)}\n`));
        if (record.type === "get_state") {
          emit({
            id: record.id,
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionId: "session-1" },
          });
        } else if (record.type === "prompt") {
          const emitTranscript = () => {
            if (!this.settle) return;
            emit({ type: "agent_start" });
            emit({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "private answer" }],
                stopReason: "stop",
                usage: { input: 2, output: 3, totalTokens: 5 },
              },
            });
            emit({ type: "agent_end", messages: [], willRetry: false });
            emit({ type: "agent_settled" });
          };
          if (this.eventsBeforePromptResponse) emitTranscript();
          emit({
            id: record.id,
            type: "response",
            command: "prompt",
            success: true,
            ...(this.disposition === null
              ? {}
              : { data: { disposition: this.disposition } }),
          });
          if (!this.eventsBeforePromptResponse) emitTranscript();
        } else if (record.type === "abort") {
          emit({
            id: record.id,
            type: "response",
            command: "abort",
            success: true,
          });
        }
      },
      closeInput: async () => {
        if (this.closeInputFails) throw new Error("close-input response lost");
        if (this.autoExit) this.emitExit();
      },
      retire: async () => {
        this.retireCalls++;
        if (this.closeInputFails && this.autoExit) this.emitExit();
      },
    };
  }
  async dispose() {
    this.retired = true;
  }
}

describe("injected Pi runtime", () => {
  it("separates prompt acceptance, semantic settlement, and physical exit", async () => {
    const execution = new FakePiPort(true);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "private prompt" },
      });
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(execution.writes).toEqual(["get_state", "prompt"]);
      expect(terminal.execution?.sessionId).toBe("session-1");
      expect(terminal.execution?.piRevision).toBe(SUPPORTED_PI_REVISION);
      expect(terminal.outcome).toBe("completed");
      expect(terminal.receipt?.status).toBe("exited");
      expect(runtime.runs.result(created.agentRunId)).toMatchObject({
        ready: true,
        reportedText: "private answer",
      });
      const journal = runtime.journal.export(created.agentRunId);
      expect(journal).not.toContain("private answer");
      expect(journal).not.toContain("private prompt");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps waiter abort independent and makes repeated cancellation idempotent", async () => {
    const execution = new FakePiPort(false);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "work" },
      });
      const controller = new AbortController();
      const waiter = runtime.runs.wait(created.agentRunId, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
      const [first, second] = await Promise.all([
        runtime.runs.cancel(created.agentRunId),
        runtime.runs.cancel(created.agentRunId),
      ]);
      expect(first.agentRunId).toBe(second.agentRunId);
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(terminal.outcome).toBe("cancelled");
      expect(terminal.receipt?.status).toBe("exited");
      expect(execution.writes.filter((type) => type === "abort")).toHaveLength(
        1,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("still requests physical retirement after an uncertain close-input", async () => {
    const execution = new FakePiPort(false, true, "started", false, true);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "work" },
      });
      await runtime.runs.cancel(created.agentRunId);
      expect(execution.retireCalls).toBe(1);
      expect(execution.retired).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("waits for physical retirement and preserves a settled outcome after late cancel", async () => {
    const execution = new FakePiPort(true, false);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "work" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runtime.runs.result(created.agentRunId).ready).toBe(false);
      await runtime.runs.cancel(created.agentRunId);
      execution.emitExit();
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(terminal.outcome).toBe("completed");
    } finally {
      await runtime.dispose();
    }
  });

  it("marks a crash before settlement as interrupted", async () => {
    const execution = new FakePiPort(false, false);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "work" },
      });
      execution.emitExit(7);
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(terminal.outcome).toBe("interrupted");
      expect(terminal.completeness).toBe("incomplete");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects a runtime without prompt disposition even when terminal events arrive first", async () => {
    const execution = new FakePiPort(true, true, null, true);
    const runtime = createPiRuntime({
      execution,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "private prompt" },
      });
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(terminal.outcome).toBe("failed");
      expect(terminal.reason).toBe("pi-rpc-disposition-unsupported");
      expect(terminal.receipt?.status).toBe("exited");
      const journal = runtime.journal.export(created.agentRunId);
      expect(journal).not.toContain("private answer");
      expect(journal).not.toContain("harness.agent_settled");
    } finally {
      await runtime.dispose();
    }
  });

  it.each(["queued", "handled"] as const)(
    "reports unexpected %s prompt disposition",
    async (disposition) => {
      const execution = new FakePiPort(false, true, disposition);
      const runtime = createPiRuntime({
        execution,
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
      });
      try {
        const created = await runtime.runs.create({
          harness: "pi",
          request: { prompt: "work" },
        });
        const terminal = await runtime.runs.wait(created.agentRunId, {
          timeoutMs: 2000,
        });
        expect(terminal.outcome).toBe("failed");
        expect(terminal.reason).toBe(`pi-prompt-${disposition}`);
      } finally {
        await runtime.dispose();
      }
    },
  );
});
