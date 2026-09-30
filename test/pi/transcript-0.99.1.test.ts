import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessSignal } from "../../src/contracts/ports.js";
import { createPiHarness } from "../../src/adapters/pi/semantic.js";
import {
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type PiDuplexExecutionPort,
  type PiTransportObserver,
} from "../../src/index.js";

// Transcripts captured from the published @earendil-works/pi-coding-agent@0.99.1
// executable in `--mode rpc --no-session`, driven by a credential-free faux
// provider registered through a local extension. Only local absolute paths
// inside Pi's system prompt were replaced by placeholders.
type Scenario = "success" | "error" | "abort";
type PiRecord = Record<string, unknown> & { type: string };

function fixture(scenario: Scenario): PiRecord[] {
  return readFileSync(
    new URL(`./fixtures/pi-0.99.1/${scenario}.jsonl`, import.meta.url),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as PiRecord);
}

function response(records: PiRecord[], command: string): PiRecord {
  const found = records.find(
    (record) => record.type === "response" && record.command === command,
  );
  if (!found) throw new Error(`fixture has no ${command} response`);
  return found;
}

function events(records: PiRecord[]): PiRecord[] {
  return records.filter((record) => record.type !== "response");
}

function encode(records: PiRecord[]): Uint8Array {
  return new TextEncoder().encode(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
}

function decode(bytes: Uint8Array, chunkSize = bytes.byteLength) {
  const decoder = createPiHarness().decoder();
  const signals: HarnessSignal[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    signals.push(...decoder.push(bytes.subarray(offset, offset + chunkSize)));
  }
  signals.push(...decoder.finish());
  return signals;
}

function settlements(signals: HarnessSignal[]) {
  return signals.filter((signal) => signal.type === "settlement");
}

describe("Pi 0.99.1 RPC response shapes", () => {
  it("reports the documented prompt disposition and a bounded session id", () => {
    const records = fixture("success");
    const state = response(records, "get_state");
    expect(state.success).toBe(true);
    expect((state.data as { sessionId?: unknown }).sessionId).toBeTypeOf(
      "string",
    );
    expect(response(records, "prompt")).toMatchObject({
      success: true,
      data: { disposition: "started" },
    });
    expect(response(fixture("abort"), "abort")).toMatchObject({
      success: true,
    });
  });
});

describe("Pi 0.99.1 semantic transcripts", () => {
  it.each([
    ["success", "success", "pi_assistant_stop", "ready"],
    ["error", "error", "pi_assistant_error", undefined],
    ["abort", "abort", "pi_assistant_aborted", undefined],
  ] as const)(
    "maps the captured %s transcript to one settlement",
    (scenario, status, reason, reportedText) => {
      const bytes = encode(events(fixture(scenario)));
      for (const chunkSize of [bytes.byteLength, 7]) {
        const signals = decode(bytes, chunkSize);
        const settled = settlements(signals);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ status, reason });
        expect(
          settled[0]?.type === "settlement"
            ? settled[0].reportedText
            : undefined,
        ).toBe(reportedText);
        const observed = JSON.stringify(
          signals.filter((signal) => signal.type === "observation"),
        );
        expect(observed).not.toContain("Reply ready");
        expect(observed).not.toContain("expert coding assistant");
        expect(observed).not.toContain('"ready"');
        expect(observed).not.toContain("synthetic provider failure");
      }
    },
  );

  it("keeps agent_end non-terminal until agent_settled arrives", () => {
    const captured = events(fixture("success"));
    const settledIndex = captured.findIndex(
      (record) => record.type === "agent_settled",
    );
    expect(captured[settledIndex - 1]?.type).toBe("agent_end");
    expect(
      settlements(decode(encode(captured.slice(0, settledIndex)))),
    ).toEqual([]);
  });

  it("does not settle a system message as the final assistant evidence", () => {
    const messageEvents = new Set([
      "message_start",
      "message_update",
      "message_end",
    ]);
    const captured = events(fixture("success")).filter(
      (record) =>
        !messageEvents.has(record.type) ||
        (record.message as { role?: unknown } | undefined)?.role === "system",
    );
    expect(captured.some((record) => record.type === "message_end")).toBe(true);
    expect(settlements(decode(encode(captured)))[0]).toMatchObject({
      status: "error",
      reason: "agent_settled_continuation_missing_final_message",
    });
  });
});

class TranscriptPort implements PiDuplexExecutionPort {
  readonly writes: string[] = [];
  private readonly records: PiRecord[];
  private exited = false;

  constructor(
    scenario: Scenario,
    private readonly promptResponse?: (record: PiRecord) => PiRecord,
  ) {
    this.records = fixture(scenario);
  }

  async open(_agentRunId: string, observer: PiTransportObserver) {
    const captured = events(this.records);
    // In the captured abort transcript, the abort command arrives after the
    // assistant started streaming and Pi responds only after agent_settled.
    const abortAt = captured.findIndex(
      (record) =>
        record.type === "message_end" &&
        (record.message as { stopReason?: unknown }).stopReason === "aborted",
    );
    const emit = (record: PiRecord) =>
      observer.onStdout(Buffer.from(`${JSON.stringify(record)}\n`));
    const exit = () => {
      if (this.exited) return;
      this.exited = true;
      observer.onExit({
        executionRunId: "transcript-1",
        status: "exited",
        exitCode: 0,
        signal: null,
        forced: false,
      });
    };
    return {
      executionRunId: "transcript-1",
      backend: "injected-transcript",
      write: async (bytes: Uint8Array) => {
        const command = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
          id: string;
          type: string;
        };
        this.writes.push(command.type);
        const reply = (record: PiRecord) => emit({ ...record, id: command.id });
        if (command.type === "get_state") {
          reply(response(this.records, "get_state"));
        } else if (command.type === "prompt") {
          const accepted = response(this.records, "prompt");
          reply(this.promptResponse ? this.promptResponse(accepted) : accepted);
          for (const record of abortAt < 0
            ? captured
            : captured.slice(0, abortAt))
            emit(record);
        } else if (command.type === "abort") {
          if (abortAt >= 0)
            for (const record of captured.slice(abortAt)) emit(record);
          reply(response(this.records, "abort"));
        }
      },
      closeInput: async () => exit(),
      retire: async () => exit(),
    };
  }

  async dispose() {
    this.exited = true;
  }
}

function runtimeFor(port: PiDuplexExecutionPort) {
  return createPiRuntime({
    execution: port,
    piVersion: SUPPORTED_PI_VERSION,
    piRevision: SUPPORTED_PI_REVISION,
  });
}

describe("Pi 0.99.1 injected runtime transcripts", () => {
  it("completes only after settlement and proven exit, keeping content out of the journal", async () => {
    const execution = new TranscriptPort("success");
    const runtime = runtimeFor(execution);
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "Reply ready" },
      });
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(execution.writes).toEqual(["get_state", "prompt"]);
      expect(terminal).toMatchObject({
        outcome: "completed",
        receipt: { status: "exited" },
        execution: {
          sessionId: (
            response(fixture("success"), "get_state").data as {
              sessionId: string;
            }
          ).sessionId,
          piVersion: "0.99.1",
          piRevision: "d86654abb8862e201933517d6f1fce9f88dd117f",
        },
      });
      expect(runtime.runs.result(created.agentRunId)).toMatchObject({
        ready: true,
        reportedText: "ready",
      });
      const journal = runtime.journal.export(created.agentRunId);
      expect(journal).toContain("harness.prompt_accepted");
      expect(journal).toContain("harness.agent_end");
      expect(journal).toContain("harness.agent_settled");
      expect(journal).not.toContain("Reply ready");
      expect(journal).not.toContain("expert coding assistant");
      expect(journal).not.toContain('"ready"');
    } finally {
      await runtime.dispose();
    }
  });

  it("fails an explicit provider error without fabricating success", async () => {
    const runtime = runtimeFor(new TranscriptPort("error"));
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "Reply ready" },
      });
      const terminal = await runtime.runs.wait(created.agentRunId, {
        timeoutMs: 2000,
      });
      expect(terminal.outcome).toBe("failed");
      expect(terminal.reason).toBe("pi_assistant_error");
      expect(terminal.receipt?.status).toBe("exited");
      expect(runtime.journal.export(created.agentRunId)).not.toContain(
        "synthetic provider failure",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps user cancellation separate from the captured abort settlement", async () => {
    const execution = new TranscriptPort("abort");
    const runtime = runtimeFor(execution);
    try {
      const created = await runtime.runs.create({
        harness: "pi",
        request: { prompt: "Reply ready" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runtime.runs.get(created.agentRunId).lifecycle).not.toBe(
        "terminal",
      );
      await Promise.all([
        runtime.runs.cancel(created.agentRunId),
        runtime.runs.cancel(created.agentRunId),
      ]);
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

  it.each([
    ["unknown", { disposition: "deferred" }],
    ["missing", {}],
  ] as const)(
    "fails closed on an %s prompt disposition",
    async (_label, data) => {
      const runtime = runtimeFor(
        new TranscriptPort("success", (accepted) => ({ ...accepted, data })),
      );
      try {
        const created = await runtime.runs.create({
          harness: "pi",
          request: { prompt: "Reply ready" },
        });
        const terminal = await runtime.runs.wait(created.agentRunId, {
          timeoutMs: 2000,
        });
        expect(terminal.outcome).toBe("failed");
        expect(terminal.reason).toBe("pi-rpc-disposition-unsupported");
        const journal = runtime.journal.export(created.agentRunId);
        expect(journal).not.toContain("harness.agent_settled");
        expect(journal).not.toContain("harness.prompt_accepted");
      } finally {
        await runtime.dispose();
      }
    },
  );
});
