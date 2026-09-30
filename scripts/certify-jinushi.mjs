import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createJinushiClient,
  createJinushiPiExecutionPort,
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { createPiRpcClient } from "../dist/adapters/pi/protocol.js";
import { resolveCertifiedPi } from "./pi-artifact.mjs";

const stateDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspace = process.env.TSUKAI_JINUSHI_WORKSPACE;

function requireAbsolute(name, value) {
  assert(value, `Set ${name}`);
  assert(isAbsolute(value), `${name} must be an absolute path`);
  return realpathSync(value);
}

const PI_RPC_ARGS = [
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
];

function report(lane, fields) {
  console.log(JSON.stringify({ lane, status: "PASSED", ...fields }));
}

async function expectFailure(promise, message) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail(message);
}

/** Lane 1: transport only. One Jinushi-owned Pi, get_state, orderly retirement. */
async function certifyTransport(jinushi, executable, workspace, provenance) {
  const port = createJinushiPiExecutionPort({
    client: jinushi,
    executable,
    environment: { mode: "inherit-supervisor" },
  });
  let rpc;
  let resolveExit;
  let rejectExit;
  const exit = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  try {
    const transport = await port.open(
      `m1b-certification-${randomUUID()}`,
      {
        onStdout(chunk) {
          rpc?.push(chunk);
        },
        onStderr() {},
        onExit(receipt) {
          rpc?.finish();
          resolveExit(receipt);
        },
        onError(error) {
          rpc?.fail(error);
          rejectExit(error);
        },
      },
      { cwd: workspace },
    );
    rpc = createPiRpcClient(transport, () => {});
    const state = await rpc.request({ type: "get_state" });
    assert.equal(state.success, true);
    assert.equal(typeof state.data?.sessionId, "string");
    assert(state.data.sessionId.length > 0);
    await transport.closeInput();
    await transport.retire("settled");
    const receipt = await exit;
    assert.equal(receipt.status, "exited");
    assert.equal(receipt.executionRunId, transport.executionRunId);
    const run = await jinushi.inspect(transport.executionRunId);
    assert.equal(run.state, "terminal");
    assert.equal(run.receipt?.runId, transport.executionRunId);
    report("jinushi-transport", {
      backend: transport.backend,
      executionRunId: transport.executionRunId,
      sessionId: state.data.sessionId,
      exitCode: receipt.exitCode,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      ...provenance,
    });
  } finally {
    await port.dispose();
  }
}

/**
 * Lane 2: one Tsukai AgentRun over the real Jinushi port. Without provider
 * credentials Pi settles with an explicit provider error, which exercises
 * start, session capture, stdin, ordered stdout, semantic settlement, and
 * physical retirement without a model.
 */
async function certifyAgentRun(jinushi, executable, workspace) {
  const port = createJinushiPiExecutionPort({
    client: jinushi,
    executable,
    environment: { mode: "inherit-supervisor" },
  });
  const runtime = createPiRuntime({
    execution: port,
    piVersion: SUPPORTED_PI_VERSION,
    piRevision: SUPPORTED_PI_REVISION,
    commandTimeoutMs: 30_000,
  });
  try {
    const created = await runtime.runs.create({
      harness: "pi",
      request: { prompt: "Reply with the word ready." },
      workspace: { cwd: workspace },
    });
    const terminal = await runtime.runs.wait(created.agentRunId, {
      timeoutMs: 60_000,
    });
    assert.equal(terminal.lifecycle, "terminal");
    assert.equal(terminal.receipt?.status, "exited");
    assert(terminal.outcome !== undefined);
    const binding = terminal.execution;
    assert(binding, "terminal AgentRun must carry its execution binding");
    assert.equal(terminal.receipt.executionRunId, binding.executionRunId);
    assert.equal(typeof binding.sessionId, "string");
    assert.equal(binding.piVersion, SUPPORTED_PI_VERSION);
    assert.equal(binding.piRevision, SUPPORTED_PI_REVISION);
    assert.equal(
      new Set([created.agentRunId, binding.executionRunId, binding.sessionId])
        .size,
      3,
      "AgentRun, Jinushi Run, and Pi session identities must stay distinct",
    );

    const kinds = runtime.journal
      .read(created.agentRunId, 0, 200)
      .items.map((entry) => entry.kind);
    const at = (kind) => kinds.indexOf(kind);
    for (const kind of [
      "harness.session",
      "harness.prompt_accepted",
      "harness.agent_end",
      "harness.agent_settled",
      "execution.exit",
    ]) {
      assert(at(kind) >= 0, `missing journal evidence ${kind}`);
    }
    assert(at("harness.session") < at("harness.prompt_accepted"));
    assert(at("harness.agent_end") <= at("harness.agent_settled"));
    // Semantic settlement precedes, and never substitutes for, physical exit.
    assert(at("harness.agent_settled") < at("execution.exit"));

    const physical = await jinushi.inspect(binding.executionRunId);
    assert.equal(physical.state, "terminal");
    assert.equal(physical.receipt?.runId, binding.executionRunId);
    assert.equal(physical.receipt?.exitCode, terminal.receipt.exitCode);

    // The AgentRun submission identity must resolve to that same physical Run
    // with the exact specification, and never to a second execution.
    const spec = {
      argv: [executable, ...PI_RPC_ARGS],
      cwd: workspace,
      environment: { mode: "inherit-supervisor" },
      interactive: false,
      lifetime: { mode: "detached" },
      correlation: { "tsukai.agentRunId": created.agentRunId },
    };
    const submissionId = `tsukai-${createHash("sha256").update(created.agentRunId, "utf8").digest("hex")}`;
    const replay = await jinushi.run(submissionId, spec);
    assert.equal(replay.runId, binding.executionRunId);
    const conflict = await expectFailure(
      jinushi.run(submissionId, { ...spec, cwd: tmpdirDifferent(workspace) }),
      "changed specification must not reuse a submission identity",
    );
    assert(conflict instanceof Error);

    report("jinushi-agent-run", {
      agentRunId: created.agentRunId,
      executionRunId: binding.executionRunId,
      sessionId: binding.sessionId,
      outcome: terminal.outcome,
      reason: terminal.reason,
      exitCode: terminal.receipt.exitCode,
      forced: terminal.receipt.forced,
      journalKinds: kinds.filter((kind) => !kind.startsWith("run.")),
    });

    // Late cancel after terminal state must be a no-op that cannot rewrite it.
    await runtime.runs.cancel(created.agentRunId);
    assert.equal(
      runtime.runs.get(created.agentRunId).outcome,
      terminal.outcome,
    );
  } finally {
    await runtime.dispose();
  }
}

function tmpdirDifferent(workspace) {
  return workspace.endsWith("/") ? `${workspace}.` : `${workspace}/.`;
}

/** Lane 3: cancellation through a real AgentRun keeps intent and retirement separate. */
async function certifyAgentRunCancel(jinushi, executable, workspace) {
  const port = createJinushiPiExecutionPort({
    client: jinushi,
    executable,
    environment: { mode: "inherit-supervisor" },
  });
  const runtime = createPiRuntime({
    execution: port,
    piVersion: SUPPORTED_PI_VERSION,
    piRevision: SUPPORTED_PI_REVISION,
    commandTimeoutMs: 30_000,
  });
  try {
    const created = await runtime.runs.create({
      harness: "pi",
      request: { prompt: "Reply with the word ready." },
      workspace: { cwd: workspace },
    });
    await Promise.all([
      runtime.runs.cancel(created.agentRunId),
      runtime.runs.cancel(created.agentRunId),
    ]);
    const terminal = await runtime.runs.wait(created.agentRunId, {
      timeoutMs: 60_000,
    });
    assert.equal(terminal.lifecycle, "terminal");
    assert.equal(terminal.receipt?.status, "exited");
    // Cancel is either honored, or arrived after semantic settlement and
    // must not have rewritten the selected semantic outcome.
    assert(["cancelled", "failed", "completed"].includes(terminal.outcome));
    const physical = await jinushi.inspect(terminal.execution.executionRunId);
    assert.equal(physical.state, "terminal");
    assert.equal(physical.receipt?.runId, terminal.execution.executionRunId);
    report("jinushi-agent-run-cancel", {
      agentRunId: created.agentRunId,
      executionRunId: terminal.execution.executionRunId,
      outcome: terminal.outcome,
      forced: terminal.receipt.forced,
    });
  } finally {
    await runtime.dispose();
  }
}

/**
 * Lane 4: retry/idempotency against the real supervisor. Replaying the same
 * submission or control request identity must not repeat a physical effect.
 */
async function certifyRetrySemantics(jinushi, executable, workspace) {
  const submissionId = `m1b-cert-${randomUUID()}`;
  const spec = {
    argv: [executable, ...PI_RPC_ARGS],
    cwd: workspace,
    environment: { mode: "inherit-supervisor" },
    interactive: false,
    lifetime: { mode: "detached" },
    correlation: { "tsukai.certification": submissionId },
  };
  const first = await jinushi.run(submissionId, spec);
  const second = await jinushi.run(submissionId, spec);
  assert.equal(second.runId, first.runId, "submission replay changed the Run");

  const ownerA = `owner-a-${randomUUID()}`;
  const ownerB = `owner-b-${randomUUID()}`;
  const token = await jinushi.acquireWriter(first.runId, ownerA);
  await expectFailure(
    jinushi.acquireWriter(first.runId, ownerB),
    "a second owner must not acquire a held writer lease",
  );

  let run = await jinushi.inspect(first.runId);
  for (
    let attempt = 0;
    attempt < 100 && run.state !== "running";
    attempt += 1
  ) {
    assert(!["terminal", "uncertain"].includes(run.state));
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = await jinushi.inspect(first.runId);
  }
  assert.equal(run.state, "running");
  const frame = new TextEncoder().encode(
    `${JSON.stringify({ id: "retry-probe", type: "get_state" })}\n`,
  );
  const inputId = `input-${randomUUID()}`;
  const afterInput = await jinushi.input(
    first.runId,
    inputId,
    run.generation,
    token,
    frame,
  );
  // Ambiguous-response retry: same identity and generation.
  const replayedInput = await jinushi.input(
    first.runId,
    inputId,
    run.generation,
    token,
    frame,
  );
  assert.equal(replayedInput.runId, afterInput.runId);
  // The stale generation is explicit failure under a fresh identity.
  await expectFailure(
    jinushi.input(
      first.runId,
      `input-${randomUUID()}`,
      run.generation + 1000,
      token,
      frame,
    ),
    "a wrong generation must fail explicitly",
  );

  // Wait for the single response then verify it was delivered exactly once.
  let text = "";
  for (let attempt = 0; attempt < 100 && !text.includes("\n"); attempt += 1) {
    const page = await jinushi.output(first.runId, "stdout", 0, 65_536);
    text = new TextDecoder().decode(page.data);
    if (!text.includes("\n")) await new Promise((r) => setTimeout(r, 100));
  }
  const responses = text
    .split("\n")
    .filter((line) => line.includes('"retry-probe"'));
  assert.equal(responses.length, 1, "replayed input executed more than once");

  run = await jinushi.inspect(first.runId);
  const closeId = `close-${randomUUID()}`;
  const closed = await jinushi.closeInput(
    first.runId,
    closeId,
    run.generation,
    token,
  );
  const closedAgain = await jinushi.closeInput(
    first.runId,
    closeId,
    run.generation,
    token,
  );
  assert.equal(closedAgain.runId, closed.runId);
  await jinushi.releaseWriter(first.runId, ownerA, token);

  const cancelId = `cancel-${randomUUID()}`;
  const current = await jinushi.inspect(first.runId);
  if (current.state !== "terminal") {
    const cancelled = await jinushi.cancel(
      first.runId,
      cancelId,
      current.generation,
    );
    const cancelledAgain = await jinushi.cancel(
      first.runId,
      cancelId,
      current.generation,
    );
    assert.equal(cancelledAgain.runId, cancelled.runId);
  }
  const final = await jinushi.await(first.runId);
  assert.equal(final.state, "terminal");
  assert.equal(final.receipt?.runId, first.runId);
  await expectFailure(
    jinushi.acquireWriter(first.runId, ownerB),
    "a terminal Run must not grant a writer lease",
  );
  report("jinushi-retry-idempotency", {
    executionRunId: first.runId,
    generation: final.generation,
    exitCode: final.receipt.exitCode,
    forced: final.receipt.forced,
  });
}

async function main() {
  const { executable, provenance } = resolveCertifiedPi(
    SUPPORTED_PI_VERSION,
    process.env.TSUKAI_PI_EXECUTABLE,
  );
  const actualStateDir = requireAbsolute("TSUKAI_JINUSHI_STATE_DIR", stateDir);
  const actualWorkspace = requireAbsolute(
    "TSUKAI_JINUSHI_WORKSPACE",
    workspace,
  );
  const jinushi = createJinushiClient(actualStateDir);
  const capabilities = await jinushi.capabilities();
  assert.equal(typeof capabilities.backend, "string");
  assert(capabilities.backend.length > 0);

  await certifyTransport(jinushi, executable, actualWorkspace, provenance);
  await certifyAgentRun(jinushi, executable, actualWorkspace);
  await certifyAgentRunCancel(jinushi, executable, actualWorkspace);
  await certifyRetrySemantics(jinushi, executable, actualWorkspace);
  if (
    !process.env.TSUKAI_PI_LIVE_PROVIDER ||
    !process.env.TSUKAI_PI_LIVE_MODEL
  ) {
    console.log(
      JSON.stringify({
        lane: "jinushi-provider-backed",
        status: "ENVIRONMENT_BLOCKED",
        reason:
          "Set TSUKAI_PI_LIVE_PROVIDER and TSUKAI_PI_LIVE_MODEL with local provider credentials to opt in",
      }),
    );
  } else {
    // The Jinushi Pi port fixes the Pi argv; selecting a provider model is not
    // part of M1b, so this lane must not be reported as passed or blocked.
    throw new Error(
      "Provider-backed Jinushi certification is not implemented; unset TSUKAI_PI_LIVE_PROVIDER/MODEL",
    );
  }
  console.log(
    JSON.stringify({
      lane: "jinushi-credential-free",
      status: "PASSED",
      backend: capabilities.backend,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      ...provenance,
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `Jinushi certification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
