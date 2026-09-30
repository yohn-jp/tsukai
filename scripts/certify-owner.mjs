import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  connectOwner,
  createJinushiClient,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { resolveCertifiedPi } from "./pi-artifact.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist/cli/index.js");
const child = join(root, "scripts/certify-owner-child.mjs");

const jinushiDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspace = process.env.TSUKAI_JINUSHI_WORKSPACE;
const jinushiBin = process.env.TSUKAI_JINUSHI_BIN;

function blocked(reason) {
  console.log(
    JSON.stringify({
      lane: "owner-restart",
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

function report(lane, fields) {
  console.log(JSON.stringify({ lane, status: "PASSED", ...fields }));
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
    assert(Array.isArray(parsed.runs ?? []), "unexpected jinushi list output");
    all.push(...(parsed.runs ?? []));
    if (!parsed.nextCursor) return all;
    cursor = parsed.nextCursor;
  }
}

function runsFor(agentRunId) {
  return jinushiRuns().filter(
    (run) => run.spec?.correlation?.["tsukai.agentRunId"] === agentRunId,
  );
}

/** Start an owner process and resolve after its ready line. */
function spawnOwner(args, env = {}) {
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((r) =>
    proc.once("exit", (code, signal) => r({ code, signal })),
  );
  const ready = new Promise((resolveReady, reject) => {
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.startsWith("{"));
      if (line) resolveReady(JSON.parse(line));
    });
    proc.once("exit", () => reject(new Error("owner exited before ready")));
  });
  return { proc, ready, exited };
}

const gatedOwner = (stateDir, pi, gate) =>
  spawnOwner([child, stateDir, jinushiDir, pi], {
    TSUKAI_CERT_GATE_FILE: gate,
  });
const cliOwner = (stateDir, pi) =>
  spawnOwner([
    cli,
    "owner",
    "serve",
    "--state-dir",
    stateDir,
    "--jinushi-state-dir",
    jinushiDir,
    "--pi-executable",
    pi,
  ]);

function scanForContent(dir, markers) {
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const text = readFileSync(full, "utf8");
        for (const marker of markers) {
          assert(!text.includes(marker), `${full} persisted content`);
        }
      }
    }
  };
  walk(dir);
}

async function stdoutRecords(jinushi, executionRunId) {
  const page = await jinushi.output(executionRunId, "stdout", 0, 65_536);
  return Buffer.from(page.data)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function scenario(name, pi, jinushi, afterKill) {
  const stateDir = mkdtempSync(join(tmpdir(), "tsukai-cert-"));
  const gate = join(stateDir, "..", `gate-${randomUUID()}`);
  const marker = `tsukai-m2-cert-prompt-${randomUUID()}`;
  let first;
  let second;
  let client;
  try {
    first = gatedOwner(stateDir, pi, gate);
    await first.ready;
    client = await connectOwner({ stateDir });
    const created = await client.runs.create({
      harness: "pi",
      request: { prompt: marker },
      workspace: { cwd: workspace },
      metadata: { lane: name },
    });
    const { agentRunId } = created;
    const executionRunId = created.execution.executionRunId;
    // The semantic decision is durable while physical retirement is gated.
    const before = await until(async () => {
      const snapshot = await client.runs.get(agentRunId);
      return snapshot.lifecycle === "stopping" && snapshot;
    }, "settlement under gate");
    assert.equal((await jinushi.inspect(executionRunId)).state, "running");
    const totalBefore = jinushiRuns().length;
    assert.equal(runsFor(agentRunId).length, 1);

    // Owner death: no shutdown hook, no cleanup.
    first.proc.kill("SIGKILL");
    await first.exited;
    await client.close();
    assert.equal((await jinushi.inspect(executionRunId)).state, "running");
    writeFileSync(gate, "");
    await afterKill({ jinushi, executionRunId });

    second = cliOwner(stateDir, pi);
    await second.ready;
    const reconnected = await connectOwner({ stateDir });
    client = reconnected;
    const seen = await reconnected.runs.get(agentRunId);
    assert.equal(seen.agentRunId, agentRunId);
    assert.equal(seen.execution.executionRunId, executionRunId);
    assert.equal(seen.execution.sessionId, before.execution.sessionId);
    const terminal = await reconnected.runs.wait(agentRunId, {
      timeoutMs: 90_000,
    });
    assert.equal(terminal.lifecycle, "terminal");
    assert.equal(
      terminal.reason,
      before.reason,
      "recovered outcome matches the durable decision",
    );
    assert.equal(terminal.receipt.status, "exited");
    assert.equal(terminal.receipt.executionRunId, executionRunId);
    assert.equal(terminal.recovery.epoch, 1);
    assert.equal(terminal.recovery.state, "terminal");
    assert.notEqual(terminal.outcome, undefined);
    const lifecycle = await jinushi.inspect(executionRunId);
    assert.equal(lifecycle.state, "terminal");
    // Repeated reconciliation converges without effects.
    assert.deepEqual((await reconnected.reconcile()).runs, []);
    assert.deepEqual(await reconnected.runs.get(agentRunId), terminal);
    // No duplicate execution and no second prompt.
    assert.equal(runsFor(agentRunId).length, 1);
    assert.equal(jinushiRuns().length, totalBefore);
    const records = await stdoutRecords(jinushi, executionRunId);
    const responses = records.filter((r) => r.type === "response");
    assert.equal(responses.filter((r) => r.command === "prompt").length, 1);
    assert.equal(responses.filter((r) => r.command === "get_state").length, 1);
    scanForContent(join(stateDir, "store"), [marker]);
    report(name, {
      agentRunId,
      executionRunId,
      sessionId: terminal.execution.sessionId,
      outcomeBeforeRestart: before.reason,
      outcome: terminal.outcome,
      reason: terminal.reason,
      receipt: terminal.receipt,
      recoveryEpoch: terminal.recovery.epoch,
      jinushiRunsForAgentRun: 1,
      promptResponses: 1,
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
    });
  } finally {
    await client?.close().catch(() => undefined);
    for (const owner of [first, second]) {
      if (
        owner &&
        owner.proc.exitCode === null &&
        owner.proc.signalCode === null
      ) {
        owner.proc.kill("SIGTERM");
        await owner.exited;
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(gate, { force: true });
  }
}

async function main() {
  const { executable, provenance } = resolveCertifiedPi(
    SUPPORTED_PI_VERSION,
    process.env.TSUKAI_PI_EXECUTABLE,
  );
  const jinushi = createJinushiClient(realpathSync(jinushiDir));
  const capabilities = await jinushi.capabilities();

  // Lane 1: the execution is still physically live when the owner restarts.
  await scenario(
    "owner-restart-running-execution",
    executable,
    jinushi,
    async () => {},
  );

  // Lane 2: the execution reaches a physical terminal state while no owner lives.
  await scenario(
    "owner-restart-physically-terminal",
    executable,
    jinushi,
    async ({ executionRunId }) => {
      const owner = "owner-certification-operator";
      const token = await jinushi.acquireWriter(executionRunId, owner);
      const run = await jinushi.inspect(executionRunId);
      await jinushi.closeInput(
        executionRunId,
        randomUUID(),
        run.generation,
        token,
      );
      await jinushi
        .releaseWriter(executionRunId, owner, token)
        .catch(() => undefined);
      const final = await jinushi.await(executionRunId);
      assert.equal(final.state, "terminal");
    },
  );

  console.log(
    JSON.stringify({
      lane: "owner-restart",
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
    `Owner restart certification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
