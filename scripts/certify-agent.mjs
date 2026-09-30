// Live M3 certification: a scoped agent credential spawns and controls an
// independent child through the resident owner over real Jinushi + Pi 0.99.1.
// The owner runs as a separate OS process whose physical retirement is gated
// (certify-owner-child), so parent and child stay nonterminal across a SIGKILL
// restart of the owner. Without the environment it reports ENVIRONMENT_BLOCKED.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  connectAgent,
  connectOwner,
  createJinushiClient,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { resolveCertifiedPi } from "./pi-artifact.mjs";

const root = resolve(import.meta.dirname, "..");
const child = join(root, "scripts/certify-owner-child.mjs");
const jinushiDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspace = process.env.TSUKAI_JINUSHI_WORKSPACE;
const jinushiBin = process.env.TSUKAI_JINUSHI_BIN;

function blocked(reason) {
  console.log(
    JSON.stringify({
      lane: "agent-control",
      status: "ENVIRONMENT_BLOCKED",
      reason,
    }),
  );
  process.exit(3);
}
if (
  !jinushiDir ||
  !isAbsolute(jinushiDir) ||
  !workspace ||
  !isAbsolute(workspace)
) {
  blocked("Set absolute TSUKAI_JINUSHI_STATE_DIR and TSUKAI_JINUSHI_WORKSPACE");
}
if (!jinushiBin || !isAbsolute(jinushiBin)) {
  blocked("Set TSUKAI_JINUSHI_BIN to the absolute path of the jinushi binary");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert(Date.now() < deadline, `timed out waiting for ${label}`);
    await sleep(50);
  }
}

function jinushiRuns() {
  const all = [];
  let cursor = "";
  for (;;) {
    const args = ["list", "--state-dir", jinushiDir, "--limit", "128"];
    if (cursor) args.push("--cursor", cursor);
    const parsed = JSON.parse(
      execFileSync(jinushiBin, args, { encoding: "utf8" }),
    );
    all.push(...(parsed.runs ?? []));
    if (!parsed.nextCursor) return all;
    cursor = parsed.nextCursor;
  }
}
const runsFor = (agentRunId) =>
  jinushiRuns().filter(
    (r) => r.spec?.correlation?.["tsukai.agentRunId"] === agentRunId,
  );

function gatedOwner(stateDir, pi, gate) {
  const proc = spawn(process.execPath, [child, stateDir, jinushiDir, pi], {
    env: { ...process.env, TSUKAI_CERT_GATE_FILE: gate },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((r) =>
    proc.once("exit", (code, signal) => r({ code, signal })),
  );
  const ready = new Promise((resolveReady, reject) => {
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.split("\n").some((l) => l.startsWith("{"))) resolveReady();
    });
    proc.once("exit", () => reject(new Error("owner exited before ready")));
  });
  return { proc, ready, exited };
}

async function main() {
  const { executable, provenance } = resolveCertifiedPi(
    SUPPORTED_PI_VERSION,
    process.env.TSUKAI_PI_EXECUTABLE,
  );
  const jinushi = createJinushiClient(realpathSync(jinushiDir));
  const stateDir = mkdtempSync(join(tmpdir(), "tsukai-agent-cert-"));
  const gate = join(stateDir, "..", `gate-${randomUUID()}`);
  const marker = `tsukai-m3-cert-prompt-${randomUUID()}`;
  const owners = [];
  const clients = [];
  try {
    const first = gatedOwner(stateDir, executable, gate);
    owners.push(first);
    await first.ready;
    const op = await connectOwner({ stateDir });
    clients.push(op);
    const mkRoot = async () => {
      const run = await op.runs.create({
        harness: "pi",
        request: { prompt: `${marker}-root` },
        workspace: { cwd: workspace },
      });
      const { token } = await op.grantAgentControl(run.agentRunId);
      const agent = await connectAgent({ stateDir, agentToken: token });
      clients.push(agent);
      return { run, token, agent };
    };
    const parent = await mkRoot();
    const stranger = await mkRoot();

    // Parent -> child through the production resident-owner path.
    const spawned = await parent.agent.agent_spawn({
      harness: "pi",
      request: { prompt: `${marker}-child` },
    });
    assert.equal(spawned.parentRunId, parent.run.agentRunId);
    assert.equal(spawned.spawnedBy, parent.run.agentRunId);
    assert.notEqual(spawned.agentRunId, parent.run.agentRunId);
    assert.deepEqual(spawned.workspace, parent.run.workspace);
    const childId = spawned.agentRunId;
    const seen = await until(async () => {
      const s = await parent.agent.agent_status(childId);
      return s.execution?.sessionId && s;
    }, "child Pi session");
    const parentNow = await op.runs.get(parent.run.agentRunId);
    assert.notEqual(
      seen.execution.executionRunId,
      parentNow.execution.executionRunId,
    );
    assert.notEqual(seen.execution.sessionId, parentNow.execution.sessionId);
    assert.equal(runsFor(childId).length, 1);
    assert.equal(runsFor(parent.run.agentRunId).length, 1);
    const totalBefore = jinushiRuns().length;

    // Cross-run control is rejected.
    for (const call of [
      () => stranger.agent.agent_status(childId),
      () => stranger.agent.agent_result(childId),
      () => stranger.agent.agent_cancel(childId),
      () => stranger.agent.agent_wait(childId, { timeoutMs: 100 }),
    ]) {
      await assert.rejects(call, (e) => e.code === "FORBIDDEN");
    }

    // Owner death (no cleanup), restart over the same state, same credentials.
    first.proc.kill("SIGKILL");
    await first.exited;
    const second = gatedOwner(stateDir, executable, gate);
    owners.push(second);
    await second.ready;
    const after = await parent.agent.agent_status(childId);
    assert.equal(after.agentRunId, childId);
    assert.equal(after.execution.executionRunId, seen.execution.executionRunId);
    assert.equal(after.execution.sessionId, seen.execution.sessionId);
    assert.equal(after.spawnedBy, parent.run.agentRunId);
    assert.ok(after.recovery.epoch >= 1);
    // M2 reconciliation re-attaches by Jinushi Run ID and cursor. Only an
    // attached run has the authoritative Jinushi evidence that can later drive
    // it to terminal; without it the run correctly stays `uncertain`.
    let observed;
    const reattached = await until(async () => {
      observed = await op.runs.get(childId);
      return observed.recovery?.state === "attached" && observed;
    }, "child re-attach after owner restart").catch((error) => {
      error.message += ` (last: ${observed?.lifecycle}/${JSON.stringify(observed?.recovery)})`;
      throw error;
    });
    // Nonterminal: the durable semantic decision (if any) waits on retirement.
    assert.ok(["running", "stopping"].includes(reattached.lifecycle));
    assert.equal(runsFor(childId).length, 1);
    await assert.rejects(
      () => stranger.agent.agent_status(childId),
      (e) => e.code === "FORBIDDEN",
    );
    const early = await parent.agent.agent_result(childId);
    assert.equal(early.ready, false);

    // Waiter cancellation does not cancel the child.
    const controller = new AbortController();
    const waiting = parent.agent.agent_wait(childId, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(waiting, (e) => e.name === "AbortError");
    assert.notEqual((await op.runs.get(childId)).lifecycle, "terminal");

    // Canonical cancellation of the child; the parent keeps running.
    // The cancel is requested while the parent's credential is still valid; the
    // gate then releases physical retirement for the whole owner.
    const cancelling = parent.agent.agent_cancel(childId);
    await sleep(500);
    writeFileSync(gate, "");
    const cancelled = await cancelling;
    assert.equal(cancelled.agentRunId, childId);
    // `runs.wait` completes on terminal OR explicit uncertainty (M2), so waiter
    // completion alone is not terminal evidence. Terminal is certified only
    // together with the Jinushi receipt and Jinushi's own terminal state.
    const done = await op.runs.wait(childId, { timeoutMs: 90_000 });
    assert.ok(
      done.lifecycle === "terminal" || done.lifecycle === "uncertain",
      `wait completed on non-final lifecycle ${done.lifecycle}`,
    );
    assert.equal(
      done.lifecycle,
      "terminal",
      `child stayed uncertain (${done.recovery?.reason}) after re-attached cancellation`,
    );
    // The recorded semantic decision wins: a credential-free Pi may settle
    // `failed` before the cancellation lands, otherwise it is `cancelled`.
    assert.ok(["cancelled", "failed"].includes(done.outcome));
    assert.equal(done.recovery.state, "terminal");
    assert.equal(done.receipt.status, "exited");
    assert.equal(done.receipt.executionRunId, seen.execution.executionRunId);
    const [physical] = runsFor(childId);
    assert.equal(physical.state, "terminal");
    assert.equal(runsFor(childId).length, 1);
    assert.equal(jinushiRuns().length, totalBefore);
    // No re-execution: result retrieval reads recorded state only.
    const result = await op.runs.result(childId);
    assert.equal(result.ready, true);
    assert.equal(jinushiRuns().length, totalBefore);
    console.log(
      JSON.stringify({
        lane: "agent-control",
        status: "PASSED",
        parentAgentRunId: parent.run.agentRunId,
        childAgentRunId: childId,
        childExecutionRunId: seen.execution.executionRunId,
        childSessionId: seen.execution.sessionId,
        childOutcome: done.outcome,
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
        ...provenance,
      }),
    );
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    for (const o of owners) {
      if (o.proc.exitCode === null && o.proc.signalCode === null) {
        o.proc.kill("SIGTERM");
        await o.exited;
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(gate, { force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `Agent control certification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
