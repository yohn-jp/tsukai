import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createMemoryJournal, replayJournal, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, createRunService, createMockHarness, startResidentOwner, connectOwner, createFileDurableStore, collectLiveProjection, projectReplay, renderOperatorProjection, SUPPORTED_PI_VERSION, SUPPORTED_PI_REVISION, createHarnessRuntime, createPiHarnessAdapter, createClaudeCodeHarnessAdapter, createJinushiClaudeCodeExecutionPort, HarnessCapabilityError, PI_CAPABILITIES, CLAUDE_CODE_CAPABILITIES, SUPPORTED_CLAUDE_CODE_VERSION } from 'tsukai';
import { createMockRuntime, createMockExecutionPort, createPiCertificationExecutionPort } from 'tsukai/testing';
import { mkdtempSync, rmSync } from 'node:fs';
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
  assert.equal(live.fleet[0].agentRunId, created.agentRunId);
  assert.equal(live.fleet[0].lineage, 'root');
  assert.ok(live.completeness.status === 'complete' || live.completeness.status === 'incomplete');
  assert.ok(Array.isArray(live.timeline));
  const rendered = renderOperatorProjection(live, 'text');
  assert.match(rendered, /^completeness=/);
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
  assert.equal(replayedLive.fleet[0].agentRunId, created.agentRunId);
  assert.equal(replayedLive.fleet[0].outcome, 'completed');
  await client.close();
  await owner.close();
} finally { rmSync(stateDir, { recursive: true, force: true }); }
`;
  await writeFile(join(consumer, "sdk.mjs"), script);
  run(process.execPath, ["sdk.mjs"]);

  const cli = join(consumer, "node_modules", ".bin", "tsukai");
  assert.match(run(cli, ["--help"]), /mock preview/);
  assert.equal(run(cli, ["--version"]).trim(), "0.1.0");
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
    `import { type RunSnapshot, type PiDuplexExecutionPort, type PiRunCreateInput, type DurableStore, type OwnerClient, type ResidentOwner, type HarnessCapabilities, type HarnessAdapter, type ClaudeCodeRunCreateInput, createMemoryJournal, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, startResidentOwner, connectOwner } from 'tsukai';\nimport { createMockRuntime, createPiCertificationExecutionPort } from 'tsukai/testing';\nconst journal = createMemoryJournal();\nconst runtime = createMockRuntime();\nconst port: PiDuplexExecutionPort | undefined = undefined;\nconst input: PiRunCreateInput = { harness: 'pi', request: { prompt: 'hello' } };\nconst snapshot: RunSnapshot | undefined = undefined;\nconst store: DurableStore | undefined = undefined;\nconst owner: ResidentOwner | undefined = undefined;\nconst ownerClient: OwnerClient | undefined = undefined;\nconst caps: HarnessCapabilities | undefined = undefined;\nconst adapter: HarnessAdapter | undefined = undefined;\nconst claudeInput: ClaudeCodeRunCreateInput = { harness: 'claude-code', request: { prompt: 'hello' } };\nvoid [caps, adapter, claudeInput, journal, runtime, port, input, snapshot, store, owner, ownerClient, startResidentOwner, connectOwner, createPiRuntime, createJinushiClient, createJinushiPiExecutionPort, createPiCertificationExecutionPort];\n`,
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
