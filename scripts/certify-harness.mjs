import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeHarnessAdapter,
  createFileDurableStore,
  createHarnessRuntime,
  createJinushiClaudeCodeExecutionPort,
  createJinushiClient,
  createJinushiPiExecutionPort,
  createPiHarnessAdapter,
  HarnessCapabilityError,
  PI_CAPABILITIES,
  projectObservation,
  projectReplay,
  SUPPORTED_CLAUDE_CODE_VERSION,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { resolveCertifiedPi } from "./pi-artifact.mjs";

/**
 * M5 live certification: the same cross-harness AgentRun contract, run
 * against real Jinushi-owned Pi RPC and Claude Code stream-json processes.
 * Credential-free: both harnesses settle with their explicit provider/auth
 * error, which must be `failed`, never success.
 */
const jinushiDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspace = process.env.TSUKAI_JINUSHI_WORKSPACE;
const claudeExecutable = process.env.TSUKAI_CLAUDE_CODE_EXECUTABLE;
const PROMPT = "tsukai m5 certification prompt";

function blocked(lane, reason) {
  console.log(JSON.stringify({ lane, status: "ENVIRONMENT_BLOCKED", reason }));
}

function report(lane, fields) {
  console.log(JSON.stringify({ lane, status: "PASSED", ...fields }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

if (
  !jinushiDir ||
  !isAbsolute(jinushiDir) ||
  !workspace ||
  !isAbsolute(workspace)
) {
  blocked(
    "harness-contract",
    "Set absolute TSUKAI_JINUSHI_STATE_DIR and TSUKAI_JINUSHI_WORKSPACE",
  );
  process.exit(3);
}

const jinushi = createJinushiClient(realpathSync(jinushiDir));
const cwd = realpathSync(workspace);
const claudeHome = mkdtempSync(join(tmpdir(), "tsukai-m5-claude-home-"));

const { executable: piExecutable } = resolveCertifiedPi(
  SUPPORTED_PI_VERSION,
  process.env.TSUKAI_PI_EXECUTABLE,
);

function resolveClaude() {
  if (!claudeExecutable || !isAbsolute(claudeExecutable)) {
    return { blocked: "Set TSUKAI_CLAUDE_CODE_EXECUTABLE to an absolute path" };
  }
  const version = execFileSync(claudeExecutable, ["--version"], {
    encoding: "utf8",
    env: { HOME: claudeHome, PATH: "/usr/bin:/bin" },
  }).trim();
  if (version !== `${SUPPORTED_CLAUDE_CODE_VERSION} (Claude Code)`) {
    return {
      blocked: `Claude Code ${version} is not the verified ${SUPPORTED_CLAUDE_CODE_VERSION}`,
    };
  }
  return { executable: realpathSync(claudeExecutable), version };
}

/** Optionally withholds input closure and retirement, like an owner that dies first. */
function gated(port, gate) {
  if (gate === undefined) return port;
  return {
    ...port,
    async open(agentRunId, observer, ws) {
      const execution = await port.open(agentRunId, observer, ws);
      return {
        executionRunId: execution.executionRunId,
        backend: execution.backend,
        pid: execution.pid,
        write: (bytes) => execution.write(bytes),
        closeInput: () => gate,
        retire: () => gate,
      };
    },
  };
}

function adapters(claude, gate) {
  const list = [
    createPiHarnessAdapter({
      execution: gated(
        createJinushiPiExecutionPort({
          client: jinushi,
          executable: piExecutable,
          environment: { mode: "inherit-supervisor" },
        }),
        gate,
      ),
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    }),
  ];
  if (claude.executable !== undefined) {
    list.push(
      createClaudeCodeHarnessAdapter({
        execution: gated(
          createJinushiClaudeCodeExecutionPort({
            client: jinushi,
            executable: claude.executable,
            // Credential-free by construction: no API key, private HOME.
            environment: {
              mode: "replace",
              set: { HOME: claudeHome, PATH: "/usr/bin:/bin" },
            },
          }),
          gate,
        ),
        claudeCodeVersion: SUPPORTED_CLAUDE_CODE_VERSION,
      }),
    );
  }
  return list;
}

function owner(stateDir, claude, gate) {
  const store = createFileDurableStore({ dir: stateDir });
  return createHarnessRuntime({
    adapters: adapters(claude, gate),
    durableStore: store,
  });
}

const PROFILES = {
  pi: {
    capabilities: PI_CAPABILITIES,
    errorReason: "pi_assistant_error",
    namespace: "pi",
  },
  "claude-code": {
    capabilities: CLAUDE_CODE_CAPABILITIES,
    errorReason: "claude_code_result_api_error",
    namespace: "claudeCode",
  },
};

function journal(runtime, id) {
  return runtime.runs.eventsPage(id, 0, 100).items;
}

async function certifyAgentRun(harness, claude, stateDir) {
  const profile = PROFILES[harness];
  const runtime = owner(stateDir, claude);
  try {
    const created = await runtime.runs.create({
      harness,
      request: { prompt: PROMPT },
      workspace: { cwd },
    });
    const done = await runtime.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.lifecycle, "terminal");
    assert.equal(
      done.outcome,
      "failed",
      "credential-free run must not succeed",
    );
    assert.equal(done.reason, profile.errorReason);
    assert.equal(done.harness.name, harness);
    assert.equal(done.receipt?.status, "exited");
    const ids = [
      done.agentRunId,
      done.execution.executionRunId,
      done.execution.sessionId,
    ];
    assert.equal(new Set(ids).size, 3, "identities must be distinct");
    assert.ok(done.execution.sessionId, "native session identity observed");
    const physical = await jinushi.inspect(done.execution.executionRunId);
    assert.equal(physical.state, "terminal");
    assert.equal(physical.receipt.runId, done.execution.executionRunId);

    const capabilities = runtime.runs.capabilities(done.agentRunId);
    assert.deepEqual(capabilities, profile.capabilities);
    for (const operation of ["steer", "followUp"]) {
      const error = await runtime.runs[operation](
        done.agentRunId,
        "more",
      ).catch((caught) => caught);
      assert.ok(error instanceof HarnessCapabilityError);
      assert.equal(error.code, "HARNESS_CAPABILITY_UNSUPPORTED");
    }

    const events = journal(runtime, done.agentRunId);
    const kinds = events.map((event) => event.kind);
    assert.equal(
      kinds.filter((kind) => kind === "harness.settlement").length,
      1,
    );
    assert.ok(
      kinds.indexOf("harness.settlement") < kinds.indexOf("execution.exit"),
    );
    assert.ok(
      events.some((event) => event.payload[profile.namespace] !== undefined) ||
        harness === "pi",
    );
    const exported = runtime.journal.export(done.agentRunId);
    assert.ok(!exported.includes(PROMPT), "journal persisted the prompt");
    const live = projectObservation({ snapshots: [done], events });
    const replay = projectReplay(exported);
    assert.equal(JSON.stringify(replay), JSON.stringify(live));
    for (const entry of live.timeline) {
      if (entry.type === "event" && entry.source === "harness")
        assert.equal(entry.provenance.harness, harness);
    }
    report(`${harness}-agent-run`, {
      agentRunId: done.agentRunId,
      executionRunId: done.execution.executionRunId,
      sessionId: done.execution.sessionId,
      harness: done.harness,
      outcome: done.outcome,
      reason: done.reason,
      exitCode: done.receipt.exitCode,
      forced: done.receipt.forced,
      journalKinds: kinds,
    });
  } finally {
    await runtime.detach();
  }
}

async function certifyCancel(harness, claude, stateDir) {
  const runtime = owner(stateDir, claude);
  try {
    const created = await runtime.runs.create({
      harness,
      request: { prompt: PROMPT },
      workspace: { cwd },
    });
    await Promise.all([
      runtime.runs.cancel(created.agentRunId),
      runtime.runs.cancel(created.agentRunId),
    ]);
    const done = await runtime.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.lifecycle, "terminal");
    // Cancel either won (cancelled) or arrived after the explicit error
    // settled, in which case the settled outcome is never rewritten.
    assert.ok(
      done.outcome === "cancelled" ||
        (done.outcome === "failed" &&
          done.reason === PROFILES[harness].errorReason),
      `unexpected cancel outcome ${done.outcome}/${done.reason}`,
    );
    const physical = await jinushi.inspect(done.execution.executionRunId);
    assert.equal(physical.state, "terminal");
    report(`${harness}-cancel`, {
      agentRunId: done.agentRunId,
      executionRunId: done.execution.executionRunId,
      outcome: done.outcome,
      reason: done.reason,
      forced: done.receipt.forced,
    });
  } finally {
    await runtime.detach();
  }
}

async function certifyRestart(harness, claude, stateDir) {
  // Owner A never closes input or retires: it "dies" with the harness alive.
  const gate = new Promise(() => undefined);
  const first = owner(stateDir, claude, gate);
  const created = await first.runs.create({
    harness,
    request: { prompt: PROMPT },
    workspace: { cwd },
  });
  await until(
    () => first.runs.get(created.agentRunId).semantic === "failed",
    "first owner observed settlement",
    120_000,
  );
  const executionRunId = first.runs.get(created.agentRunId).execution
    .executionRunId;
  await first.detach();
  const alive = await jinushi.inspect(executionRunId);
  assert.notEqual(alive.state, "terminal", "harness must outlive the owner");

  const second = owner(stateDir, claude);
  try {
    await second.reconcile();
    const done = await second.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.agentRunId, created.agentRunId);
    assert.equal(done.harness.name, harness, "restart must not switch harness");
    assert.equal(done.execution.executionRunId, executionRunId);
    assert.equal(done.lifecycle, "terminal");
    assert.equal(done.outcome, "failed");
    assert.equal(done.reason, PROFILES[harness].errorReason);
    assert.ok(done.execution.sessionId);
    const kinds = journal(second, done.agentRunId).map((event) => event.kind);
    // One prompt, one settlement: nothing was replayed or relaunched.
    assert.equal(
      kinds.filter((kind) => kind === "harness.settlement").length,
      1,
    );
    assert.equal(kinds.filter((kind) => kind === "harness.session").length, 1);
    report(`${harness}-owner-restart`, {
      agentRunId: done.agentRunId,
      executionRunId,
      sessionId: done.execution.sessionId,
      outcome: done.outcome,
      recovery: done.recovery?.state,
      epoch: done.recovery?.epoch,
    });
  } finally {
    await second.detach();
  }
}

async function main() {
  const claude = resolveClaude();
  const harnesses = ["pi"];
  if (claude.blocked) blocked("claude-code-contract", claude.blocked);
  else harnesses.push("claude-code");
  for (const harness of harnesses) {
    const stateDir = mkdtempSync(join(tmpdir(), `tsukai-m5-${harness}-`));
    try {
      await certifyAgentRun(harness, claude, join(stateDir, "run"));
      await certifyCancel(harness, claude, join(stateDir, "cancel"));
      await certifyRestart(harness, claude, join(stateDir, "restart"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
  if (!process.env.ANTHROPIC_API_KEY)
    blocked(
      "claude-code-provider-backed",
      "No provider credentials: success-path semantics are certified only by SDK-typed fixtures",
    );
  if (!process.env.TSUKAI_PI_LIVE_PROVIDER)
    blocked("pi-provider-backed", "Set TSUKAI_PI_LIVE_PROVIDER to opt in");
  rmSync(claudeHome, { recursive: true, force: true });
  if (claude.blocked) process.exit(3);
}

await main();
