import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeHarnessAdapter,
  createHarnessRuntime,
  createJinushiClaudeCodeExecutionPort,
  createJinushiPiExecutionPort,
  createPiHarnessAdapter,
  HarnessCapabilityError,
  PI_CAPABILITIES,
  projectObservation,
  projectReplay,
  SUPPORTED_CLAUDE_CODE_VERSION,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessName,
  type HarnessRuntime,
  type ObservationEnvelope,
  type RunSnapshot,
} from "../../src/index.js";
import { createFileDurableStore } from "../../src/durable/file-store.js";
import {
  FakeSupervisor,
  type FakeClientView,
  type FakeRun,
} from "../durable/fake-supervisor.js";
import {
  CrashStore,
  PROMPT,
  tempDir,
  until,
  WORKSPACE,
} from "../durable/harness.js";

export type ContractHarness = "pi" | "claude-code";

/**
 * One harness under the shared contract. Everything harness-specific (argv,
 * native transcripts, capability constants) lives here; the assertions in
 * {@link defineHarnessContract} are identical for every harness.
 */
export interface HarnessProfile {
  name: ContractHarness;
  version: string;
  capabilities: Readonly<HarnessCapabilities>;
  executable: string;
  /** Arguments Jinushi must receive after the executable. */
  argv: readonly string[];
  /** A native transcript that settles with an explicit harness error. */
  errorTranscript(run: FakeRun): object[];
  errorReason: string;
  /** A settled success whose native evidence carries usage and cost. */
  usageTranscript?: (run: FakeRun) => object[];
  successReason: string;
  /** Native stdin record type written for the abort/interrupt request. */
  abortCommand: string;
}

function claudeFixture(name: string): object[] {
  return readFileSync(
    new URL(
      `../claude-code/fixtures/claude-code-2.1.285/${name}.jsonl`,
      import.meta.url,
    ),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as object);
}

export const PI_PROFILE: HarnessProfile = {
  name: "pi",
  version: SUPPORTED_PI_VERSION,
  capabilities: PI_CAPABILITIES,
  executable: "/opt/pi/bin/pi",
  argv: ["--mode", "rpc", "--no-session"],
  errorTranscript: () => [
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ],
  errorReason: "pi_assistant_error",
  usageTranscript: () => [
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "private answer" }],
        stopReason: "stop",
        usage: {
          input: 2,
          output: 3,
          totalTokens: 5,
          cost: { input: 0.01, output: 0.02, total: 0.03 },
        },
      },
    },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ],
  successReason: "pi_assistant_stop",
  abortCommand: "abort",
};

export const CLAUDE_CODE_PROFILE: HarnessProfile = {
  name: "claude-code",
  version: SUPPORTED_CLAUDE_CODE_VERSION,
  capabilities: CLAUDE_CODE_CAPABILITIES,
  executable: "/opt/claude-code/bin/claude",
  argv: ["-p", "--bare", "--input-format", "stream-json"],
  // Captured from the real CLI without credentials: `subtype: "success"` with
  // `is_error: true` and `terminal_reason: "api_error"`.
  errorTranscript: () => claudeFixture("auth-error"),
  errorReason: "claude_code_result_api_error",
  successReason: "claude_code_result_success",
  abortCommand: "control_request",
};

function adapterFor(
  profile: HarnessProfile,
  view: FakeClientView,
): HarnessAdapter<unknown, HarnessName> {
  const port = {
    client: view,
    executable: profile.executable,
    environment: { mode: "replace" as const, set: { PATH: "/usr/bin" } },
  };
  if (profile.name === "pi") {
    return createPiHarnessAdapter({
      execution: createJinushiPiExecutionPort(port),
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      commandTimeoutMs: 2_000,
    }) as HarnessAdapter<unknown, HarnessName>;
  }
  return createClaudeCodeHarnessAdapter({
    execution: createJinushiClaudeCodeExecutionPort(port),
    claudeCodeVersion: SUPPORTED_CLAUDE_CODE_VERSION,
    commandTimeoutMs: 2_000,
  }) as HarnessAdapter<unknown, HarnessName>;
}

export interface ContractOwner {
  runtime: HarnessRuntime;
  store: CrashStore;
  view: FakeClientView;
  crash(): void;
}

/** A resident-owner-shaped runtime: one RunService, both harness adapters. */
export function startContractOwner(
  dir: string,
  sup: FakeSupervisor,
  profiles: readonly HarnessProfile[] = [PI_PROFILE, CLAUDE_CODE_PROFILE],
): ContractOwner {
  const store = new CrashStore(
    createFileDurableStore({ dir: join(dir, "store"), fsync: false }),
  );
  const view = sup.view();
  const runtime = createHarnessRuntime({
    adapters: profiles.map((profile) => adapterFor(profile, view)),
    durableStore: store,
  });
  return {
    runtime,
    store,
    view,
    crash() {
      view.kill();
      store.die();
    },
  };
}

function journal(owner: ContractOwner, runId: string): ObservationEnvelope[] {
  return owner.runtime.runs.eventsPage(runId, 0, 100).items;
}

/**
 * The cross-harness AgentRun contract. Every assertion here is a semantic
 * that is genuinely common to all harnesses; the same suite runs for each.
 */
export function defineHarnessContract(profile: HarnessProfile): void {
  describe(`harness contract: ${profile.name}`, () => {
    let dir: ReturnType<typeof tempDir>;
    let sup: FakeSupervisor;
    let owners: ContractOwner[];
    const start = (profiles?: readonly HarnessProfile[]): ContractOwner => {
      const owner = startContractOwner(dir.dir, sup, profiles);
      owners.push(owner);
      return owner;
    };
    const create = (owner: ContractOwner, prompt = PROMPT) =>
      owner.runtime.runs.create({
        harness: profile.name,
        request: { prompt },
        workspace: WORKSPACE,
      });

    beforeEach(() => {
      dir = tempDir();
      sup = new FakeSupervisor();
      owners = [];
    });
    afterEach(async () => {
      for (const owner of owners) {
        if (!owner.store.isDead) await owner.runtime.detach();
      }
      dir.cleanup();
    });

    it("advertises machine-readable capabilities for the run", async () => {
      const owner = start();
      const run = await create(owner);
      const capabilities = owner.runtime.runs.capabilities(run.agentRunId);
      expect(JSON.parse(JSON.stringify(capabilities))).toEqual(
        profile.capabilities,
      );
      expect(capabilities).toMatchObject({
        schemaVersion: 1,
        harness: { name: profile.name, version: profile.version },
        cancellation: { retirement: "execution-owner" },
      });
      expect(
        owner.runtime.harnesses().map((entry) => entry.harness.name),
      ).toEqual(["pi", "claude-code"]);
      await owner.runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
    });

    it("creates an independent AgentRun on one Jinushi-owned execution", async () => {
      const owner = start();
      const first = await create(owner);
      const second = await create(owner);
      const done = await Promise.all(
        [first, second].map((run) =>
          owner.runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 }),
        ),
      );
      expect(new Set(done.map((run) => run.agentRunId)).size).toBe(2);
      expect(sup.runs.size).toBe(2);
      for (const run of done) {
        expect(run.harness).toEqual({
          name: profile.name,
          version: profile.version,
        });
        expect(run.execution?.backend).toBe("fake-backend");
        expect(sup.runs.has(run.execution!.executionRunId)).toBe(true);
        expect(run.execution?.sessionId).toMatch(/session/);
        expect(run.execution?.sessionId).not.toBe(run.agentRunId);
        expect(run.execution?.sessionId).not.toBe(
          run.execution?.executionRunId,
        );
      }
      expect(done[0]!.execution!.executionRunId).not.toBe(
        done[1]!.execution!.executionRunId,
      );
      expect(done[0]!.execution!.sessionId).not.toBe(
        done[1]!.execution!.sessionId,
      );
      for (const spec of sup.specs) {
        expect(spec.argv[0]).toBe(profile.executable);
        expect(spec.argv.slice(1, 1 + profile.argv.length)).toEqual([
          ...profile.argv,
        ]);
        // The prompt reaches the harness over stdin, never argv.
        expect(JSON.stringify(spec)).not.toContain(PROMPT);
        expect(spec.cwd).toBe(WORKSPACE.cwd);
      }
      for (const run of sup.runs.values()) expect(sup.promptsSeen(run)).toBe(1);
    });

    it("finalizes only after semantic settlement and physical retirement", async () => {
      const owner = start();
      const run = await create(owner);
      const done = await owner.runtime.runs.wait(run.agentRunId, {
        timeoutMs: 2_000,
      });
      expect(done).toMatchObject({
        lifecycle: "terminal",
        semantic: "settled",
        outcome: "completed",
        reason: profile.successReason,
        receipt: { status: "exited", exitCode: 0, forced: false },
      });
      const result = owner.runtime.runs.result(run.agentRunId);
      expect(result).toMatchObject({ ready: true, outcome: "completed" });
      expect(result.ready && result.reportedText).toBe("private answer");
      const kinds = journal(owner, run.agentRunId).map((event) => event.kind);
      expect(kinds.indexOf("harness.settlement")).toBeGreaterThan(-1);
      expect(kinds.indexOf("harness.settlement")).toBeLessThan(
        kinds.indexOf("execution.exit"),
      );
      expect(kinds).toContain("harness.session");
    });

    it("maps an explicit harness error to failed, never success", async () => {
      sup.claudeTranscript = profile.errorTranscript;
      sup.piTranscript = profile.errorTranscript;
      const owner = start();
      const run = await create(owner);
      const done = await owner.runtime.runs.wait(run.agentRunId, {
        timeoutMs: 2_000,
      });
      expect(done).toMatchObject({
        lifecycle: "terminal",
        semantic: "failed",
        outcome: "failed",
        reason: profile.errorReason,
      });
      expect(done.receipt?.status).toBe("exited");
    });

    it("cancels through a native abort request and execution retirement", async () => {
      sup.holdTranscript = true;
      const owner = start();
      const run = await create(owner);
      await until(() => sup.promptsSeen(sup.only()) === 1);
      const waiter = new AbortController();
      const waiting = owner.runtime.runs.wait(run.agentRunId, {
        signal: waiter.signal,
      });
      waiter.abort();
      await expect(waiting).rejects.toThrow(/aborted/);
      expect(owner.runtime.runs.get(run.agentRunId).lifecycle).not.toBe(
        "terminal",
      );
      const [first, second] = await Promise.all([
        owner.runtime.runs.cancel(run.agentRunId),
        owner.runtime.runs.cancel(run.agentRunId),
      ]);
      expect(first.agentRunId).toBe(second.agentRunId);
      const done = await owner.runtime.runs.wait(run.agentRunId, {
        timeoutMs: 2_000,
      });
      expect(done).toMatchObject({
        lifecycle: "terminal",
        outcome: "cancelled",
        reason: "user-cancelled",
      });
      expect(done.receipt?.status).toBe("exited");
      const commands = sup.only().inputCommands.map((command) => command.type);
      expect(
        commands.filter((type) => type === profile.abortCommand),
      ).toHaveLength(1);
      expect(sup.only().inputClosed).toBe(true);
    });

    it("rejects unsupported controls before anything reaches the harness", async () => {
      sup.holdTranscript = true;
      const owner = start();
      const run = await create(owner);
      await until(() => sup.promptsSeen(sup.only()) === 1);
      const before = sup.only().inputCommands.length;
      for (const operation of ["steer", "followUp"] as const) {
        const attempt =
          operation === "steer"
            ? owner.runtime.runs.steer(run.agentRunId, "more")
            : owner.runtime.runs.followUp(run.agentRunId, "more");
        const error = await attempt.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HarnessCapabilityError);
        expect(error).toMatchObject({
          code: "HARNESS_CAPABILITY_UNSUPPORTED",
          harness: profile.name,
          capability: operation,
          native: profile.capabilities[operation].native,
        });
      }
      expect(sup.only().inputCommands).toHaveLength(before);
      expect(sup.prompts).toBe(1);
      await owner.runtime.runs.cancel(run.agentRunId);
    });

    it("recovers the same AgentRun after owner restart without replaying the prompt", async () => {
      sup.holdTranscript = true;
      const first = start();
      const run = await create(first);
      await until(() => sup.promptsSeen(sup.only()) === 1);
      await until(
        () => first.runtime.runs.get(run.agentRunId).execution?.executionRunId,
      );
      first.crash();

      const second = start();
      await second.runtime.reconcile();
      const restored = second.runtime.runs.get(run.agentRunId);
      expect(restored.harness).toEqual({
        name: profile.name,
        version: profile.version,
      });
      expect(restored.execution?.executionRunId).toBe(sup.only().runId);
      sup.releaseTranscript(sup.only());
      const done = await second.runtime.runs.wait(run.agentRunId, {
        timeoutMs: 2_000,
      });
      expect(done).toMatchObject({
        lifecycle: "terminal",
        outcome: "completed",
      });
      expect(done.execution?.sessionId).toMatch(/session/);
      expect(sup.runCalls).toBe(1);
      expect(sup.prompts).toBe(1);
      expect(sup.promptsSeen(sup.only())).toBe(1);
    });

    it("never switches a persisted run to another harness adapter on restart", async () => {
      sup.holdTranscript = true;
      const first = start();
      const run = await create(first);
      await until(() => sup.promptsSeen(sup.only()) === 1);
      first.crash();

      const other = profile.name === "pi" ? CLAUDE_CODE_PROFILE : PI_PROFILE;
      const second = start([other]);
      await second.runtime.reconcile();
      const restored = second.runtime.runs.get(run.agentRunId);
      expect(restored).toMatchObject({
        harness: { name: profile.name },
        lifecycle: "uncertain",
        recovery: { state: "uncertain", reason: "harness-adapter-unavailable" },
      });
      expect(sup.runCalls).toBe(1);
      expect(sup.prompts).toBe(1);
      expect(() => second.runtime.runs.capabilities(run.agentRunId)).toThrow(
        HarnessCapabilityError,
      );
    });

    it("projects observations with harness provenance and live/replay agreement", async () => {
      if (profile.usageTranscript !== undefined) {
        sup.piTranscript = profile.usageTranscript;
        sup.claudeTranscript = profile.usageTranscript;
      }
      const owner = start();
      const run = await create(owner);
      await owner.runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
      const snapshot: RunSnapshot = owner.runtime.runs.get(run.agentRunId);
      const events = journal(owner, run.agentRunId);
      const live = projectObservation({ snapshots: [snapshot], events });
      const replay = projectReplay(
        owner.runtime.journal.export(run.agentRunId),
      );
      expect(JSON.stringify(replay)).toBe(JSON.stringify(live));

      expect(live.fleet[0]).toMatchObject({
        agentRunId: run.agentRunId,
        harness: { name: profile.name },
        outcome: "completed",
      });
      const harnessEvents = live.timeline.filter(
        (entry) => entry.type === "event" && entry.source === "harness",
      );
      expect(harnessEvents.length).toBeGreaterThan(0);
      for (const entry of harnessEvents) {
        expect(entry.provenance.harness).toBe(profile.name);
      }
      const native = events.filter(
        (event) =>
          event.source === "harness" &&
          event.payload[profile.capabilities.evidenceNamespace] !== undefined,
      );
      expect(native.length).toBeGreaterThan(0);

      const metrics = live.metrics[run.agentRunId]!;
      const all = [
        ...Object.values(metrics.tool),
        ...Object.values(metrics.usage),
        ...Object.values(metrics.retry),
        ...Object.values(metrics.compaction),
      ];
      for (const value of all) {
        if (value.provenance.source === "harness")
          expect(value.provenance.harness).toBe(profile.name);
      }
      // A metric the harness cannot report is unavailable, never zero.
      if (profile.capabilities.observations.toolDurations === "unavailable") {
        expect(metrics.tool.latencyMs.availability).toBe("unavailable");
      }
      if (profile.capabilities.observations.usage !== "unavailable") {
        expect(metrics.usage.outputTokens.availability).toBe("observed");
      }
      if (profile.capabilities.observations.cost !== "unavailable") {
        expect(metrics.usage.cost).not.toMatchObject({
          availability: "unavailable",
        });
      }
    });

    it("keeps the durable journal metadata-only", async () => {
      const owner = start();
      const run = await create(owner);
      await owner.runtime.runs.wait(run.agentRunId, { timeoutMs: 2_000 });
      const exported = owner.runtime.journal.export(run.agentRunId);
      expect(exported).not.toContain(PROMPT);
      expect(exported).not.toContain("private answer");
      expect(exported).not.toContain("private tool output");
    });
  });
}
