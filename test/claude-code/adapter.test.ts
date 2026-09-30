import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessSignal } from "../../src/contracts/ports.js";
import type { DuplexExecution } from "../../src/contracts/harness.js";
import { createClaudeCodeHarness } from "../../src/adapters/claude-code/semantic.js";
import { createClaudeCodeClient } from "../../src/adapters/claude-code/protocol.js";
import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeHarnessAdapter,
  createJinushiClaudeCodeExecutionPort,
  SUPPORTED_CLAUDE_CODE_VERSION,
} from "../../src/index.js";
import {
  claudeSuccessTranscript,
  FakeSupervisor,
  type FakeRun,
} from "../durable/fake-supervisor.js";
import { PROMPT, tempDir, until, WORKSPACE } from "../durable/harness.js";
import { startContractOwner, type ContractOwner } from "../harness/contract.js";

// Captured from the installed Claude Code 2.1.285 CLI in headless stream-json
// mode without credentials (the adapter's exact argv). Only the working
// directory and model name were replaced by placeholders.
function fixture(name: "auth-error" | "interrupt"): string {
  return readFileSync(
    new URL(`./fixtures/claude-code-2.1.285/${name}.jsonl`, import.meta.url),
    "utf8",
  );
}

function decode(text: string, chunkSize?: number): HarnessSignal[] {
  const decoder = createClaudeCodeHarness().decoder();
  const bytes = new TextEncoder().encode(text);
  const size = chunkSize ?? bytes.byteLength;
  const signals: HarnessSignal[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size)
    signals.push(...decoder.push(bytes.subarray(offset, offset + size)));
  signals.push(...decoder.finish());
  return signals;
}

const lines = (records: object[]): string =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

const settlementOf = (signals: HarnessSignal[]) =>
  signals.filter((signal) => signal.type === "settlement");

describe("Claude Code stream-json decoder", () => {
  it("maps the captured credential-free transcript to an explicit error", () => {
    const signals = decode(fixture("auth-error"), 7);
    expect(settlementOf(signals)).toEqual([
      {
        type: "settlement",
        status: "error",
        reason: "claude_code_result_api_error",
      },
    ]);
    const observations = signals.flatMap((signal) =>
      signal.type === "observation" ? [signal.draft] : [],
    );
    expect(observations.map((draft) => draft.kind)).toEqual([
      "harness.session",
      "harness.message",
      "harness.result",
    ]);
    expect(observations[0]!.payload).toMatchObject({
      claudeCode: {
        nativeType: "system/init",
        claudeCodeVersion: "2.1.285",
        permissionMode: "dontAsk",
        toolCount: 0,
      },
    });
    expect(observations[1]!.payload).toMatchObject({
      claudeCode: {
        nativeType: "assistant",
        errorKind: "authentication_failed",
      },
    });
    // Zeroed usage/cost on an error result is not evidence: none is recorded.
    const result = observations[2]!.payload.claudeCode as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      nativeType: "result",
      subtype: "success",
      isError: true,
      terminalReason: "api_error",
      usageAvailable: false,
    });
    expect(result.usage).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(JSON.stringify(observations)).not.toContain("Not logged in");
  });

  it("settles success only from a non-error completed result", () => {
    const run = { runId: "r1" } as FakeRun;
    const signals = decode(lines(claudeSuccessTranscript(run)));
    expect(settlementOf(signals)).toEqual([
      {
        type: "settlement",
        status: "success",
        reason: "claude_code_result_success",
        reportedText: "private answer",
      },
    ]);
    const tools = signals.flatMap((signal) =>
      signal.type === "observation" && signal.draft.kind === "harness.tool"
        ? [signal.draft.payload.claudeCode]
        : [],
    );
    expect(tools).toEqual([
      { nativeType: "tool_use", toolUseId: "toolu_1", toolName: "Read" },
      { nativeType: "tool_result", toolUseId: "toolu_1", isError: true },
    ]);
    const result = signals.find(
      (signal) =>
        signal.type === "observation" && signal.draft.kind === "harness.result",
    );
    expect(result).toMatchObject({
      draft: {
        payload: {
          claudeCode: {
            usage: {
              scope: "result_turn_final",
              values: { input: 11, output: 7 },
            },
            cost: { scope: "session_cumulative_estimate", total: 0.25 },
          },
        },
      },
    });
    expect(
      JSON.stringify(signals.filter((s) => s.type === "observation")),
    ).not.toMatch(/private|"input":\{/);
  });

  it.each([
    [
      { terminal_reason: "aborted_streaming" },
      "abort",
      "claude_code_aborted_streaming",
    ],
    [
      {
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
      },
      "error",
      "claude_code_result_max_turns",
    ],
    [
      { queued_turn_count: 1 },
      "error",
      "claude_code_result_queued_continuation",
    ],
    [{ is_error: undefined }, "error", "claude_code_result_missing_status"],
  ])("maps result %j to %s", (patch, status, reason) => {
    const decoded = decode(
      lines([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          terminal_reason: "completed",
          result: "x",
          ...patch,
        },
      ]),
    );
    expect(settlementOf(decoded)).toEqual([
      expect.objectContaining({ type: "settlement", status, reason }),
    ]);
  });

  it("maps retry and compaction evidence under its namespace", () => {
    const signals = decode(
      lines([
        {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 500,
          error_status: 529,
          error: "overloaded",
        },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "auto",
            pre_tokens: 1000,
            post_tokens: 100,
          },
        },
        {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
        },
      ]),
    );
    expect(
      signals.map((signal) =>
        signal.type === "observation" ? signal.draft.kind : signal.type,
      ),
    ).toEqual(["harness.retry", "harness.compaction", "harness.compaction"]);
    expect(signals[0]).toMatchObject({
      draft: {
        payload: {
          claudeCode: {
            nativeType: "system/api_retry",
            attempt: 1,
            errorStatus: 529,
          },
        },
      },
    });
    expect(signals[2]).toMatchObject({
      draft: { payload: { claudeCode: { compactOutcome: "failed" } } },
    });
  });

  it("rejects malformed, oversized, and control records explicitly", () => {
    expect(() => decode("not json\n")).toThrow(/valid JSON/);
    expect(() => decode('{"type":"control_request"}\n')).toThrow(/filtered/);
    expect(() => decode('{"type":"system"}')).toThrow(/Truncated/);
    const decoder = createClaudeCodeHarness({ maxRecordBytes: 32 }).decoder();
    expect(() =>
      decoder.push(new TextEncoder().encode(`{"type":"${"x".repeat(64)}"}`)),
    ).toThrow(/record byte limit/);
  });
});

describe("Claude Code stream-json client", () => {
  const execution = (writes: string[]): DuplexExecution => ({
    executionRunId: "run-1",
    backend: "test",
    async write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
    },
    async closeInput() {},
    async retire() {},
  });

  it("filters the captured interrupt control_response from events", async () => {
    const writes: string[] = [];
    const events: string[] = [];
    const client = createClaudeCodeClient(execution(writes), (record) =>
      events.push(String(record.type)),
    );
    const interrupted = client.interrupt(1_000);
    await until(() => writes.length === 1);
    expect(JSON.parse(writes[0]!)).toEqual({
      type: "control_request",
      request_id: "tsukai-0",
      request: { subtype: "interrupt" },
    });
    const bytes = new TextEncoder().encode(fixture("interrupt"));
    for (let offset = 0; offset < bytes.byteLength; offset += 5)
      client.push(bytes.subarray(offset, offset + 5));
    await expect(interrupted).resolves.toEqual({ subtype: "success" });
    expect(events).toEqual(["system", "assistant", "result"]);
  });

  it("writes exactly one user message and fails on unknown control responses", async () => {
    const writes: string[] = [];
    const failures: Error[] = [];
    const client = createClaudeCodeClient(execution(writes), () => undefined, {
      onFailure: (error) => failures.push(error),
    });
    await client.sendUserMessage("hello");
    await expect(client.sendUserMessage("again")).rejects.toThrow(
      /exactly one/,
    );
    expect(JSON.parse(writes[0]!)).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
      session_id: "",
    });
    client.push(
      new TextEncoder().encode(
        '{"type":"control_response","response":{"subtype":"success","request_id":"nope"}}\n',
      ),
    );
    expect(failures[0]?.message).toMatch(/unknown request_id/);
  });
});

describe("Claude Code adapter over the Jinushi port", () => {
  let dir: ReturnType<typeof tempDir>;
  let sup: FakeSupervisor;
  let owners: ContractOwner[];
  const start = (): ContractOwner => {
    const owner = startContractOwner(dir.dir, sup);
    owners.push(owner);
    return owner;
  };
  const create = (owner: ContractOwner) =>
    owner.runtime.runs.create({
      harness: "claude-code",
      request: { prompt: PROMPT },
      workspace: WORKSPACE,
    });

  beforeEach(() => {
    dir = tempDir();
    sup = new FakeSupervisor();
    owners = [];
  });
  afterEach(async () => {
    for (const owner of owners)
      if (!owner.store.isDead) await owner.runtime.detach();
    dir.cleanup();
  });

  it("pins the verified CLI version at construction and at session start", async () => {
    expect(() =>
      createClaudeCodeHarnessAdapter({
        execution: createJinushiClaudeCodeExecutionPort({
          client: sup.view(),
          executable: "/opt/claude-code/bin/claude",
          environment: { mode: "inherit-supervisor" },
        }),
        claudeCodeVersion: "2.0.0",
      }),
    ).toThrow(/Unsupported Claude Code version/);
    sup.claudeTranscript = (run) => {
      const records = claudeSuccessTranscript(run);
      (records[0] as { claude_code_version: string }).claude_code_version =
        "9.9.9";
      return records;
    };
    const owner = start();
    const run = await create(owner);
    const done = await owner.runtime.runs.wait(run.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({
      lifecycle: "terminal",
      outcome: "failed",
      reason: "claude_code_version_mismatch",
    });
  });

  it("records the verified argv and native identity in the binding", async () => {
    const owner = start();
    const run = await create(owner);
    const done = await owner.runtime.runs.wait(run.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(sup.specs[0]!.argv).toEqual([
      "/opt/claude-code/bin/claude",
      "-p",
      "--bare",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
    ]);
    expect(done.execution).toMatchObject({
      backend: "fake-backend",
      sessionId: `claude-session-${sup.only().runId}`,
      harnessVersion: SUPPORTED_CLAUDE_CODE_VERSION,
    });
    expect(done.execution?.piVersion).toBeUndefined();
    expect(sup.only().inputCommands.map((command) => command.type)).toEqual([
      "user",
    ]);
  });

  it("fails required interaction explicitly instead of approving it", async () => {
    sup.claudeTranscript = (run) => [
      claudeSuccessTranscript(run)[0]!,
      {
        type: "control_request",
        request_id: "perm-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
      },
    ];
    const owner = start();
    const run = await create(owner);
    const done = await owner.runtime.runs.wait(run.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({
      outcome: "failed",
      reason: "claude_code_required_interaction_unsupported",
    });
    expect(
      sup
        .only()
        .inputCommands.filter((command) => command.type === "control_response"),
    ).toHaveLength(0);
  });

  it("keeps implicit prompt receipt uncertain until harness evidence arrives", async () => {
    sup.holdTranscript = true;
    sup.claudeHoldBeforeInit = true;
    const first = start();
    const run = await create(first);
    await until(() => sup.promptsSeen(sup.only()) === 1);
    first.crash();

    const second = start();
    await second.runtime.reconcile();
    // Claude Code acknowledges nothing: without output the delivery is unproven.
    expect(second.runtime.runs.get(run.agentRunId)).toMatchObject({
      lifecycle: "uncertain",
      recovery: { reason: "prompt-delivery-unconfirmed" },
    });
    expect(sup.prompts).toBe(1);
    sup.releaseTranscript(sup.only());
    const done = await until(() => {
      const snapshot = second.runtime.runs.get(run.agentRunId);
      return snapshot.lifecycle === "terminal" ? snapshot : undefined;
    });
    expect(done).toMatchObject({ outcome: "completed" });
    expect(sup.prompts).toBe(1);
    expect(sup.runCalls).toBe(1);
  });

  it("does not interrupt a run that already settled when cancelled late", async () => {
    sup.exitOnCloseInput = false;
    const owner = start();
    const run = await create(owner);
    await until(
      () => owner.runtime.runs.get(run.agentRunId).semantic === "settled",
    );
    const cancelling = owner.runtime.runs.cancel(run.agentRunId);
    sup.terminate(sup.only(), 0);
    await cancelling;
    const done = await owner.runtime.runs.wait(run.agentRunId, {
      timeoutMs: 2_000,
    });
    expect(done).toMatchObject({ outcome: "completed" });
    expect(
      sup
        .only()
        .inputCommands.filter((command) => command.type === "control_request"),
    ).toHaveLength(0);
  });

  it("publishes capabilities that match the verified protocol authority", () => {
    expect(CLAUDE_CODE_CAPABILITIES).toMatchObject({
      protocol: "claude-code-stream-json",
      evidenceNamespace: "claudeCode",
      session: { identity: "after-prompt" },
      prompt: { acceptance: "implicit" },
      cancellation: { abort: "native" },
      steer: { tsukai: "unsupported", native: "unverified" },
      followUp: { tsukai: "unsupported", native: "available" },
      observations: { toolDurations: "unavailable", cost: "estimated" },
    });
  });
});
