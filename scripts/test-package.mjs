import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "tsukai-package-"));
const consumer = join(temp, "consumer");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    timeout: 30000,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

try {
  await mkdir(consumer);
  run("pnpm", ["run", "build"], { cwd: root });
  const packOutput = run(
    "npm",
    ["pack", "--json", "--pack-destination", temp],
    { cwd: root },
  );
  const [packed] = JSON.parse(packOutput);
  assert.equal(packed.name, "tsukai");
  const files = packed.files.map((file) => file.path);
  assert(
    files.includes("dist/testing/fixture-worker.js"),
    "fixture worker missing from package",
  );
  assert(
    files.includes("dist/index.d.ts"),
    "declarations missing from package",
  );
  assert(
    files.includes("dist/testing/pi/execution.js"),
    "explicit Pi certification runner missing from package",
  );
  assert(files.includes("dist/adapters/jinushi/client.js"));
  assert(files.includes("dist/adapters/jinushi/execution.js"));
  assert(files.includes("dist/owner/server.js"));
  assert(files.includes("dist/durable/file-store.js"));
  assert(
    files.every(
      (file) =>
        !/(^|\/)(test|examples|docs|node_modules|\.env|\.npmrc|\.pi|auth\.json|session)(\/|$)/.test(
          file,
        ),
    ),
  );
  const tarball = join(temp, packed.filename);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);

  const script = `import assert from 'node:assert/strict';
import { createMemoryJournal, replayJournal, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, createRunService, createMockHarness, startResidentOwner, connectOwner, connectAgent, createFileDurableStore, collectLiveProjection, projectReplay, renderOperatorProjection, SUPPORTED_PI_VERSION, SUPPORTED_PI_REVISION, createHarnessRuntime, createPiHarnessAdapter, createClaudeCodeHarnessAdapter, createJinushiClaudeCodeExecutionPort, HarnessCapabilityError, PI_CAPABILITIES, CLAUDE_CODE_CAPABILITIES, SUPPORTED_CLAUDE_CODE_VERSION, ExecutionProfileError, EXECUTION_PROFILE_SCHEMA_VERSION, executionProfileFingerprint, PI_EXECUTION_PROFILE_CAPABILITIES, CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES } from 'tsukai';
import { createMockRuntime, createMockExecutionPort, createPiCertificationExecutionPort } from 'tsukai/testing';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const journal = createMemoryJournal();
assert.equal(typeof replayJournal, 'function');
assert.equal(typeof createPiRuntime, 'function');
assert.equal(typeof createJinushiClient, 'function');
assert.equal(typeof createJinushiPiExecutionPort, 'function');
assert.equal(typeof createPiCertificationExecutionPort, 'function');
assert.equal(typeof createFileDurableStore, 'function');
assert.equal(typeof collectLiveProjection, 'function');
assert.equal(typeof projectReplay, 'function');
assert.equal(typeof renderOperatorProjection, 'function');
assert.equal(SUPPORTED_PI_VERSION, '0.99.1');
assert.equal(SUPPORTED_CLAUDE_CODE_VERSION, '2.1.285');
assert.equal(PI_CAPABILITIES.harness.name, 'pi');
assert.equal(CLAUDE_CODE_CAPABILITIES.evidenceNamespace, 'claudeCode');
assert.equal(CLAUDE_CODE_CAPABILITIES.steer.tsukai, 'unsupported');
assert.equal(typeof createJinushiClaudeCodeExecutionPort, 'function');
{
  const unusedPort = { async open() { throw new Error('not used'); }, async dispose() {} };
  const multi = createHarnessRuntime({
    adapters: [
      createPiHarnessAdapter({ execution: unusedPort, piVersion: SUPPORTED_PI_VERSION, piRevision: SUPPORTED_PI_REVISION }),
      createClaudeCodeHarnessAdapter({ execution: unusedPort, claudeCodeVersion: SUPPORTED_CLAUDE_CODE_VERSION }),
    ],
  });
  assert.deepEqual(multi.harnesses().map((entry) => entry.harness.name), ['pi', 'claude-code']);
  await assert.rejects(multi.runs.create({ harness: 'codex', request: { prompt: 'x' } }), /Unsupported/);
  assert.equal(new HarnessCapabilityError('pi', 'steer', 'available').code, 'HARNESS_CAPABILITY_UNSUPPORTED');
  await multi.dispose();
}
// Execution profile (#25) through the public package and the owner IPC.
{
  assert.equal(EXECUTION_PROFILE_SCHEMA_VERSION, 1);
  assert.equal(PI_CAPABILITIES.executionProfile.tools.tsukai, 'configurable');
  assert.equal(PI_EXECUTION_PROFILE_CAPABILITIES.model.verification, 'exact');
  assert.equal(CLAUDE_CODE_CAPABILITIES.executionProfile.provider.tsukai, 'unsupported');
  assert.equal(CLAUDE_CODE_EXECUTION_PROFILE_CAPABILITIES.model.tsukai, 'configurable');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tsukai-profile-')));
  const extension = join(dir, 'guard.ts');
  const body = 'export default () => {};';
  writeFileSync(extension, body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  // A Jinushi-protocol stub records the submitted Run specification and
  // refuses to start it; the profile must already be bound and projected.
  const specs = [];
  const client = {
    async capabilities() { return { backend: 'consumer-stub' }; },
    async run(_submissionId, spec) { specs.push(spec); throw new Error('consumer stub does not start processes'); },
  };
  const stateDir = join(dir, 'owner');
  const owner = await startResidentOwner({
    stateDir,
    createService: (store) => createPiRuntime({
      execution: createJinushiPiExecutionPort({ client, executable: '/opt/pi/bin/pi', environment: { mode: 'replace', set: {} } }),
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      durableStore: store,
    }),
  });
  const operator = await connectOwner({ stateDir });
  try {
    const capabilities = await (async () => {
      const probe = await operator.runs.create({ harness: 'pi', request: { prompt: 'probe' }, workspace: { cwd: dir } });
      return operator.runs.capabilities(probe.agentRunId);
    })();
    assert.equal(capabilities.executionProfile.extensions.tsukai, 'configurable');
    assert.equal(capabilities.harness.name, 'pi');
    assert.equal(capabilities.steer.tsukai, 'unsupported');
    const profile = {
      schemaVersion: 1,
      provider: 'acme',
      model: 'coder-1',
      tools: [{ source: 'builtin', name: 'read' }, { source: 'extension', extension: 'guard', name: 'governed_execution' }],
      extensions: [{ id: 'guard', path: extension, sha256 }],
    };
    const created = await operator.runs.create({ harness: 'pi', request: { prompt: 'p' }, workspace: { cwd: dir }, executionProfile: profile });
    const inspected = await operator.runs.get(created.agentRunId);
    assert.deepEqual(inspected.executionProfile.extensions, [{ id: 'guard', sha256 }]);
    assert.equal(inspected.executionProfile.fingerprint, executionProfileFingerprint(inspected.executionProfile));
    assert.deepEqual(specs.at(-1).argv.slice(-8), ['--provider', 'acme', '--model', 'coder-1', '--tools', 'governed_execution,read', '--extension', extension]);
    assert.equal(specs.at(-1).cwd, dir);
    await assert.rejects(operator.runs.steer(created.agentRunId, 'x'), (error) => error.code === 'HARNESS_CAPABILITY_UNSUPPORTED');
    await assert.rejects(
      operator.runs.create({ harness: 'pi', request: { prompt: 'p' }, executionProfile: { schemaVersion: 1, argv: ['--mode', 'json'] } }),
      (error) => error.code === 'EXECUTION_PROFILE_INVALID',
    );
    assert.equal(new ExecutionProfileError('EXECUTION_PROFILE_UNSUPPORTED', 'pi', 'tools', 'x').code, 'EXECUTION_PROFILE_UNSUPPORTED');
  } finally {
    await operator.close();
    await owner.close('detach');
    rmSync(dir, { recursive: true, force: true });
  }
}
assert.equal(SUPPORTED_PI_REVISION, 'd86654abb8862e201933517d6f1fce9f88dd117f');
assert.equal(journal.read('missing').items.length, 0);
const runtime = createMockRuntime();
try {
  const run = await runtime.runs.create({ harness: 'mock', request: { scenario: 'normal' } });
  const terminal = await runtime.runs.wait(run.agentRunId, { timeoutMs: 5000 });
  assert.equal(terminal.outcome, 'completed');
  assert.equal(runtime.runs.result(run.agentRunId).ready, true);
} finally { await runtime.dispose(); }
// Resident owner over the packed package: durable registry and local IPC.
const stateDir = mkdtempSync(join(tmpdir(), 'tsukai-consumer-'));
const service = (store) => createRunService({ execution: createMockExecutionPort(), harness: createMockHarness(), journal: store, durableStore: store });
try {
  let owner = await startResidentOwner({ stateDir, createService: service });
  let client = await connectOwner({ stateDir });
  const created = await client.runs.create({ harness: 'mock', request: { scenario: 'normal' } });
  const settled = await client.runs.wait(created.agentRunId, { timeoutMs: 5000 });
  assert.equal(settled.outcome, 'completed');
  // Operator projection layer over the resident owner's read-only APIs only.
  const live = await collectLiveProjection(client.runs);
  assert.equal(live.fleet.length, 1);
  assert.equal(typeof live.metrics, 'object');
  assert.ok(Array.isArray(live.tree));
  assert.equal(live.fleet[0].agentRunId, created.agentRunId);
  assert.equal(live.fleet[0].lineage, 'root');
  assert.ok(live.completeness.status === 'complete' || live.completeness.status === 'incomplete');
  assert.ok(Array.isArray(live.timeline));
  const rendered = renderOperatorProjection(live, 'text');
  assert.match(rendered, /^completeness=/);
  // Full AgentRun operation set through the packed resident-owner client.
  const listed = await client.runs.list({ limit: 10 });
  assert.ok(listed.items.some((run) => run.agentRunId === created.agentRunId));
  const settledResult = await client.runs.result(created.agentRunId);
  assert.equal(settledResult.ready, true);
  assert.equal(settledResult.outcome, 'completed');
  const page = await client.runs.eventsPage(created.agentRunId, 0, 100);
  assert.ok(page.items.length > 0);
  assert.ok(page.items.every((event) => event.runId === created.agentRunId));
  const streamed = [];
  for await (const event of client.runs.events(created.agentRunId)) {
    streamed.push(event);
    if (streamed.length === page.items.length) break;
  }
  assert.deepEqual(streamed.map((event) => event.seq), page.items.map((event) => event.seq));
  const held = await client.runs.create({ harness: 'mock', request: { scenario: 'hold' } });
  assert.notEqual((await client.runs.get(held.agentRunId)).lifecycle, 'terminal');
  const heldChild = await client.runs.create({ harness: 'mock', request: { scenario: 'normal' }, parentRunId: held.agentRunId });
  const kids = await client.runs.children(held.agentRunId);
  assert.deepEqual(kids.items.map((run) => run.agentRunId), [heldChild.agentRunId]);
  await client.runs.wait(heldChild.agentRunId, { timeoutMs: 5000 });
  const waiter = new AbortController();
  const aborted = client.runs.wait(held.agentRunId, { signal: waiter.signal });
  waiter.abort();
  await assert.rejects(aborted, (error) => error.name === 'AbortError');
  assert.notEqual((await client.runs.get(held.agentRunId)).lifecycle, 'terminal');
  await client.runs.cancel(held.agentRunId);
  const cancelled = await client.runs.wait(held.agentRunId, { timeoutMs: 5000 });
  assert.equal(cancelled.lifecycle, 'terminal');
  assert.equal(cancelled.outcome, 'cancelled');
  // Scoped agent-facing control over the same owner.
  const principal = await client.runs.create({ harness: 'mock', request: { scenario: 'hold' } });
  const { token } = await client.grantAgentControl(principal.agentRunId);
  const agent = await connectAgent({ stateDir, agentToken: token });
  try {
    const spawned = await agent.agent_spawn({ harness: 'mock', request: { scenario: 'normal' } });
    assert.equal(spawned.parentRunId, principal.agentRunId);
    const spawnedDone = await agent.agent_wait(spawned.agentRunId, { timeoutMs: 5000 });
    assert.equal(spawnedDone.outcome, 'completed');
    assert.equal((await agent.agent_result(spawned.agentRunId)).ready, true);
    assert.equal((await agent.agent_status(spawned.agentRunId)).agentRunId, spawned.agentRunId);
  } finally {
    await agent.close();
  }
  await client.runs.cancel(principal.agentRunId);
  await client.runs.wait(principal.agentRunId, { timeoutMs: 5000 });
  assert.equal((await client.status()).pid, owner.pid);
  await client.close();
  await owner.close();
  owner = await startResidentOwner({ stateDir, createService: service });
  client = await connectOwner({ stateDir });
  const again = await client.runs.get(created.agentRunId);
  assert.equal(again.agentRunId, created.agentRunId);
  assert.equal(again.outcome, 'completed');
  assert.equal(again.execution.executionRunId, settled.execution.executionRunId);
  // Historical projection from durable state agrees with the live one.
  const replayedLive = await collectLiveProjection(client.runs);
  const replayedRun = replayedLive.fleet.find((entry) => entry.agentRunId === created.agentRunId);
  assert.equal(replayedRun.outcome, 'completed');
  await client.close();
  await owner.close();
} finally { rmSync(stateDir, { recursive: true, force: true }); }
`;
  await writeFile(join(consumer, "sdk.mjs"), script);
  run(process.execPath, ["sdk.mjs"]);

  const cli = join(consumer, "node_modules", ".bin", "tsukai");
  {
    const help = run(cli, ["--help"]);
    assert.match(help, /AgentRun lifecycle and observation/);
    assert.match(help, /mock preview/);
    assert.match(help, /owner serve/);
  }
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(packed.version, version);
  assert.equal(run(cli, ["--version"]).trim(), version);
  const jsonl = run(cli, ["demo", "--json"]);
  for (const line of jsonl.trim().split("\n"))
    assert.equal(JSON.parse(line).schemaVersion, 1);
  const recordPath = join(consumer, "demo.jsonl");
  await writeFile(recordPath, jsonl);
  const replayed = JSON.parse(run(cli, ["replay", recordPath, "--json"]));
  assert(replayed.fleet.length >= 3);
  assert(replayed.fleet.every((entry) => entry.lifecycle === "terminal"));
  assert(replayed.tree.length >= 1, "operator tree must be projected");
  assert(replayed.timeline.length > 0, "operator timeline must be projected");
  assert(
    Object.keys(replayed.metrics).length === replayed.fleet.length,
    "operator metrics must cover every projected run",
  );
  assert(
    ["complete", "incomplete"].includes(replayed.completeness.status),
    "operator completeness must be explicit",
  );
  assert(!JSON.stringify(replayed).includes("secret"));

  const replayedText = run(cli, ["replay", recordPath]);
  assert.match(replayedText, /^completeness=/);
  assert.match(replayedText, /\nfleet:\n/);
  assert.match(replayedText, /\ntree:\n/);
  assert.match(replayedText, /\ntimeline:\n/);
  assert.match(replayedText, /\nmetrics:\n/);

  await writeFile(
    join(consumer, "types.ts"),
    `import { type RunSnapshot, type PiDuplexExecutionPort, type PiRunCreateInput, type DurableStore, type OwnerClient, type ResidentOwner, type HarnessCapabilities, type HarnessAdapter, type ClaudeCodeRunCreateInput, type ExecutionProfile, type EffectiveExecutionProfile, type ExecutionProfileCapabilities, createMemoryJournal, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, startResidentOwner, connectOwner } from 'tsukai';\nimport { createMockRuntime, createPiCertificationExecutionPort } from 'tsukai/testing';\nconst journal = createMemoryJournal();\nconst runtime = createMockRuntime();\nconst port: PiDuplexExecutionPort | undefined = undefined;\nconst input: PiRunCreateInput = { harness: 'pi', request: { prompt: 'hello' } };\nconst snapshot: RunSnapshot | undefined = undefined;\nconst store: DurableStore | undefined = undefined;\nconst owner: ResidentOwner | undefined = undefined;\nconst ownerClient: OwnerClient | undefined = undefined;\nconst caps: HarnessCapabilities | undefined = undefined;\nconst adapter: HarnessAdapter | undefined = undefined;\nconst claudeInput: ClaudeCodeRunCreateInput = { harness: 'claude-code', request: { prompt: 'hello' } };\nconst profile: ExecutionProfile = { schemaVersion: 1, model: 'm', tools: [{ source: 'builtin', name: 'read' }] };\nconst profiled: PiRunCreateInput = { harness: 'pi', request: { prompt: 'hello' }, executionProfile: profile };\nconst effective = (value: RunSnapshot): EffectiveExecutionProfile | undefined => value.executionProfile;\nconst profileCaps = (value: HarnessCapabilities): ExecutionProfileCapabilities => value.executionProfile;\nvoid [profiled, effective, profileCaps, caps, adapter, claudeInput, journal, runtime, port, input, snapshot, store, owner, ownerClient, startResidentOwner, connectOwner, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, createPiCertificationExecutionPort];\n`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
      },
      files: ["types.ts"],
    }),
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"]);
  console.log(
    `Packed consumer passed: ${packed.filename} (${files.length} files)`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
