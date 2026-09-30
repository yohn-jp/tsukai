import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  connectOwner,
  createJinushiClient,
  executionProfileFingerprint,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { resolveCertifiedPi } from "./pi-artifact.mjs";

/**
 * #25 live certification: a tool-enabled governed Pi run through the real
 * resident owner (`tsukai owner serve`) -> real Jinushi supervisor -> the
 * certified Pi 0.99.1 artifact, configured only through a typed execution
 * profile (provider, model, admitted tools, admitted extensions).
 *
 * The structural lanes are credential-free: an admitted certification
 * extension registers a scripted provider (Pi's own `fauxProvider`), so the
 * model's tool calls are deterministic while every tool actually executes in
 * Pi against an isolated temporary workspace. Provider-backed semantic
 * success is a separate opt-in lane.
 */
const jinushiDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspaceRoot = process.env.TSUKAI_JINUSHI_WORKSPACE;
const liveProvider = process.env.TSUKAI_PI_LIVE_PROVIDER;
const liveModel = process.env.TSUKAI_PI_LIVE_MODEL;
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "cli", "index.js");

const CERT_FILE = "TSUKAI_PROFILE_CERT.txt";
const CERT_CONTENT = "tsukai execution profile certification\n";
const PROVIDER = "tsukai-cert";
const MODEL = "scripted-coder";

function blocked(lane, reason) {
  console.log(JSON.stringify({ lane, status: "ENVIRONMENT_BLOCKED", reason }));
}

function report(lane, fields) {
  console.log(JSON.stringify({ lane, status: "PASSED", ...fields }));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
  !workspaceRoot ||
  !isAbsolute(workspaceRoot)
) {
  blocked(
    "execution-profile",
    "Set absolute TSUKAI_JINUSHI_STATE_DIR (running supervisor) and TSUKAI_JINUSHI_WORKSPACE",
  );
  process.exit(3);
}

const jinushi = createJinushiClient(realpathSync(jinushiDir));
const { executable: piExecutable } = resolveCertifiedPi(
  SUPPORTED_PI_VERSION,
  process.env.TSUKAI_PI_EXECUTABLE,
);
const scratch = realpathSync(
  mkdtempSync(join(workspaceRoot, "tsukai-profile-cert-")),
);
const extensionDir = join(scratch, "extensions");
mkdirSync(extensionDir, { mode: 0o700 });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Certification-only provider extension. Each provider call appends one line
 * to `calls` (so a resent prompt or relaunched process is visible) and
 * returns the next scripted step; an optional gate holds the first step.
 */
function writeProviderExtension(name, calls, gate) {
  const path = join(extensionDir, `${name}.ts`);
  writeFileSync(
    path,
    `import { appendFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const CALLS = ${JSON.stringify(calls)};
const GATE = ${JSON.stringify(gate ?? null)};
const PROVIDER = ${JSON.stringify(PROVIDER)};
const MODEL = ${JSON.stringify(MODEL)};

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: PROVIDER, api: PROVIDER, models: [{ id: MODEL }] });
  const as = (message: ReturnType<typeof fauxAssistantMessage>) => ({ ...message, provider: PROVIDER, api: PROVIDER, model: MODEL });
  const step = (index: number, reply: () => ReturnType<typeof fauxAssistantMessage>) => async () => {
    appendFileSync(CALLS, index + "\\n");
    if (index === 1 && GATE !== null) {
      while (!existsSync(GATE)) await new Promise((done) => setTimeout(done, 50));
    }
    return as(reply());
  };
  faux.setResponses([
    step(1, () => fauxAssistantMessage(fauxToolCall("write", { path: ${JSON.stringify(CERT_FILE)}, content: ${JSON.stringify(CERT_CONTENT)} }))),
    step(2, () => fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin HEAD" }))),
    step(3, () => fauxAssistantMessage(fauxToolCall("governed_execution", {}))),
    step(4, () => fauxAssistantMessage(fauxToolCall("read", { path: ${JSON.stringify(CERT_FILE)} }))),
    step(5, () => fauxAssistantMessage("certification steps finished")),
  ]);
  pi.registerProvider(faux.provider);
}
`,
  );
  return { path, sha256: sha256(path) };
}

/** Certification governance guard: blocks `git push`, adds one custom read-only tool. */
const guard = (() => {
  const path = join(extensionDir, "guard.ts");
  writeFileSync(
    path,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (event.toolName === "bash" && /\\bgit\\s+push\\b/.test(command)) {
      return { block: true, reason: "certification guard blocked git push" };
    }
  });
  pi.registerTool({
    name: "governed_execution",
    label: "Governed execution",
    description: "Read-only admitted execution facts.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "admitted execution facts" }], details: {} };
    },
  });
}
`,
  );
  return { path, sha256: sha256(path) };
})();

const CODING_TOOLS = [
  { source: "builtin", name: "read" },
  { source: "builtin", name: "write" },
  { source: "builtin", name: "edit" },
  { source: "builtin", name: "bash" },
  { source: "extension", extension: "guard", name: "governed_execution" },
];

function lanePaths(lane) {
  const dir = join(scratch, lane);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  return { dir, workspace, calls, gate: join(dir, "gate") };
}

function profileFor(provider, tools, extras = {}) {
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    model: MODEL,
    tools,
    extensions: [
      { id: "cert-provider", path: provider.path, sha256: provider.sha256 },
      { id: "guard", path: guard.path, sha256: guard.sha256 },
    ],
    ...extras,
  };
}

/** Starts the real resident owner CLI as its own OS process. */
async function startOwner(stateDir) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "owner",
      "serve",
      "--state-dir",
      stateDir,
      "--jinushi-state-dir",
      realpathSync(jinushiDir),
      "--pi-executable",
      piExecutable,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout });
  await new Promise((ready, fail) => {
    child.once("exit", (code) => fail(new Error(`owner exited ${code}`)));
    lines.on("line", (line) => {
      if (line.includes('"ready":true')) ready();
    });
  });
  return child;
}

function calls(paths) {
  return readFileSync(paths.calls, "utf8").trim().split("\n").filter(Boolean);
}

function tools(events) {
  return events
    .filter((event) => event.kind === "harness.tool")
    .map((event) => event.payload.pi)
    .filter((pi) => pi && pi.nativeType === "tool_execution_end");
}

const stateDir = join(scratch, "owner");
let owner = await startOwner(stateDir);
let operator = await connectOwner({ stateDir });
let failed = false;

try {
  // Lane 1: the M6 blocker, removed. Admitted coding tools and extensions
  // execute in Pi under Jinushi and really edit the isolated workspace.
  {
    const lane = "tool-enabled-governed-run";
    const paths = lanePaths(lane);
    const provider = writeProviderExtension(lane, paths.calls);
    const profile = profileFor(provider, CODING_TOOLS);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
      metadata: { lane },
      executionProfile: profile,
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.outcome, "completed", `${lane}: ${done.reason}`);
    assert.equal(done.workspace.cwd, paths.workspace);
    assert.equal(
      readFileSync(join(paths.workspace, CERT_FILE), "utf8"),
      CERT_CONTENT,
    );
    const effective = done.executionProfile;
    assert.equal(effective.fingerprint, executionProfileFingerprint(effective));
    assert.deepEqual(
      effective.tools.map((tool) => tool.name),
      ["bash", "edit", "governed_execution", "read", "write"],
    );
    assert.deepEqual(
      effective.extensions.map((entry) => entry.id),
      ["cert-provider", "guard"],
    );
    const events = (await operator.runs.eventsPage(created.agentRunId, 0, 1000))
      .items;
    const profileEvent = events.find(
      (event) => event.kind === "harness.profile",
    );
    assert.equal(profileEvent.payload.modelVerified, "exact");
    assert.equal(profileEvent.payload.reportedModel, MODEL);
    const ended = tools(events);
    const byName = Object.fromEntries(
      ended.map((entry) => [entry.toolName, entry.isError]),
    );
    assert.equal(byName.write, false, "write tool executed");
    assert.equal(byName.bash, true, "guard extension blocked git push");
    assert.equal(
      byName.governed_execution,
      false,
      "custom extension tool executed",
    );
    assert.equal(byName.read, false, "read tool executed");
    assert.deepEqual(calls(paths), ["1", "2", "3", "4", "5"]);
    const physical = await jinushi.inspect(done.execution.executionRunId);
    assert.equal(physical.state, "terminal");
    const journal = JSON.stringify(events);
    assert(!journal.includes(guard.path), "extension path is not journaled");
    assert(
      !journal.includes(CERT_CONTENT.trim()),
      "tool content is not journaled",
    );
    report(lane, {
      agentRunId: done.agentRunId,
      executionRunId: done.execution.executionRunId,
      piSessionId: done.execution.sessionId,
      fingerprint: effective.fingerprint,
      toolResults: byName,
      workspaceEdit: CERT_FILE,
      receipt: physical.receipt?.outcome,
    });
  }

  // Lane 2: default deny inside a profile. Same scripted model and
  // extensions, but no admitted tools: Pi exposes none and nothing is written.
  {
    const lane = "profile-default-deny-tools";
    const paths = lanePaths(lane);
    const provider = writeProviderExtension(lane, paths.calls);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
      executionProfile: profileFor(provider, []),
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.outcome, "completed", `${lane}: ${done.reason}`);
    assert(!existsSync(join(paths.workspace, CERT_FILE)), "no tool may write");
    const ended = tools(
      (await operator.runs.eventsPage(created.agentRunId, 0, 1000)).items,
    );
    assert(
      ended.every((entry) => entry.isError === true),
      "every tool call fails",
    );
    report(lane, {
      agentRunId: done.agentRunId,
      toolCalls: ended.length,
      workspaceEdit: false,
    });
  }

  // Lane 3: the allowlist is exact. Only `read` is admitted.
  {
    const lane = "profile-tool-allowlist";
    const paths = lanePaths(lane);
    const provider = writeProviderExtension(lane, paths.calls);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
      executionProfile: profileFor(provider, [
        { source: "builtin", name: "read" },
      ]),
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.outcome, "completed", `${lane}: ${done.reason}`);
    assert(
      !existsSync(join(paths.workspace, CERT_FILE)),
      "write is not admitted",
    );
    const ended = tools(
      (await operator.runs.eventsPage(created.agentRunId, 0, 1000)).items,
    );
    const byName = Object.fromEntries(
      ended.map((entry) => [entry.toolName, entry.isError]),
    );
    assert.equal(byName.write, true);
    assert.equal(byName.bash, true);
    assert.equal(byName.governed_execution, true);
    report(lane, { agentRunId: done.agentRunId, toolResults: byName });
  }

  // Lane 4: model identity is exact. Pi would fuzzy-resolve `scripted` to
  // the registered model; Tsukai fails the run before writing the prompt.
  {
    const lane = "profile-model-exact";
    const paths = lanePaths(lane);
    const provider = writeProviderExtension(lane, paths.calls);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
      executionProfile: {
        ...profileFor(provider, CODING_TOOLS),
        model: "scripted",
      },
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.outcome, "failed");
    assert.equal(done.reason, "pi-model-mismatch");
    assert.deepEqual(calls(paths), [], "the prompt never reached the provider");
    report(lane, { agentRunId: done.agentRunId, reason: done.reason });
  }

  // Lane 5: no profile keeps the M5 behavior (no extensions: the scripted
  // provider does not exist, no tools, no edit).
  {
    const lane = "no-profile-default-deny";
    const paths = lanePaths(lane);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    assert.equal(done.executionProfile, undefined);
    assert.notEqual(
      done.outcome,
      "completed",
      "credential-free default Pi cannot succeed",
    );
    assert(!existsSync(join(paths.workspace, CERT_FILE)));
    report(lane, {
      agentRunId: done.agentRunId,
      outcome: done.outcome,
      reason: done.reason,
    });
  }

  // Lane 6: owner SIGKILL mid-run, real restart. Same AgentRun, same
  // profile, same Jinushi Run; no relaunch and no resent prompt.
  {
    const lane = "profile-owner-restart";
    const paths = lanePaths(lane);
    const provider = writeProviderExtension(lane, paths.calls, paths.gate);
    const created = await operator.runs.create({
      harness: "pi",
      request: { prompt: "Run the certification steps." },
      workspace: { cwd: paths.workspace },
      executionProfile: profileFor(provider, CODING_TOOLS),
    });
    await until(() => calls(paths).length === 1, "first provider call");
    await operator.close();
    owner.kill("SIGKILL");
    await new Promise((done) => owner.once("exit", done));
    owner = await startOwner(stateDir);
    operator = await connectOwner({ stateDir });
    await operator.reconcile();
    const restored = await operator.runs.get(created.agentRunId);
    assert.deepEqual(restored.executionProfile, created.executionProfile);
    assert.equal(
      restored.execution.executionRunId,
      created.execution.executionRunId,
    );
    assert.equal(restored.recovery?.epoch, 1);
    writeFileSync(paths.gate, "");
    // `wait` also resolves on explicit uncertainty (M2); later harness
    // evidence resolves it, so poll for the terminal state.
    const done = await until(
      async () => {
        const current = await operator.runs.get(created.agentRunId);
        return current.lifecycle === "terminal" ? current : undefined;
      },
      "terminal after restart",
      120_000,
    );
    assert.equal(done.outcome, "completed", `${lane}: ${done.reason}`);
    assert.deepEqual(done.executionProfile, created.executionProfile);
    assert.equal(
      readFileSync(join(paths.workspace, CERT_FILE), "utf8"),
      CERT_CONTENT,
    );
    assert.deepEqual(
      calls(paths),
      ["1", "2", "3", "4", "5"],
      "no relaunch or resent prompt",
    );
    report(lane, {
      agentRunId: done.agentRunId,
      executionRunId: done.execution.executionRunId,
      recovery: done.recovery?.state,
      fingerprint: done.executionProfile.fingerprint,
    });
  }

  // Lane 7: provider-backed semantic success, only with real credentials.
  if (!liveProvider || !liveModel) {
    blocked(
      "provider-backed-profile-run",
      "Set TSUKAI_PI_LIVE_PROVIDER and TSUKAI_PI_LIVE_MODEL with provider credentials in the Jinushi supervisor environment",
    );
  } else {
    const lane = "provider-backed-profile-run";
    const paths = lanePaths(lane);
    const created = await operator.runs.create({
      harness: "pi",
      request: {
        prompt: `Use the write tool to create ${CERT_FILE} containing exactly: ${CERT_CONTENT.trim()}`,
      },
      workspace: { cwd: paths.workspace },
      executionProfile: {
        schemaVersion: 1,
        provider: liveProvider,
        model: liveModel,
        tools: [
          { source: "builtin", name: "read" },
          { source: "builtin", name: "write" },
        ],
      },
    });
    const done = await operator.runs.wait(created.agentRunId, {
      timeoutMs: 600_000,
    });
    assert.equal(done.outcome, "completed", `${lane}: ${done.reason}`);
    assert.equal(
      readFileSync(join(paths.workspace, CERT_FILE), "utf8").trim(),
      CERT_CONTENT.trim(),
    );
    report(lane, { agentRunId: done.agentRunId });
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await operator.close().catch(() => undefined);
  owner.kill("SIGTERM");
  if (!failed) rmSync(scratch, { recursive: true, force: true });
  else console.error(`certification scratch kept at ${scratch}`);
}
process.exit(failed ? 1 : 0);
