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
import { createMemoryJournal, replayJournal, createPiRuntime, SUPPORTED_PI_VERSION, SUPPORTED_PI_REVISION } from 'tsukai';
import { createMockRuntime, createPiCertificationExecutionPort } from 'tsukai/testing';
const journal = createMemoryJournal();
assert.equal(typeof replayJournal, 'function');
assert.equal(typeof createPiRuntime, 'function');
assert.equal(typeof createPiCertificationExecutionPort, 'function');
assert.equal(SUPPORTED_PI_VERSION, '0.87.1');
assert.equal(SUPPORTED_PI_REVISION, '2b0a123de98318c2ff8069661721ce0c3794c34e');
assert.equal(journal.read('missing').items.length, 0);
const runtime = createMockRuntime();
try {
  const run = await runtime.runs.create({ harness: 'mock', request: { scenario: 'normal' } });
  const terminal = await runtime.runs.wait(run.agentRunId, { timeoutMs: 5000 });
  assert.equal(terminal.outcome, 'completed');
  assert.equal(runtime.runs.result(run.agentRunId).ready, true);
} finally { await runtime.dispose(); }
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
  assert(replayed.runs.length >= 3);
  assert(replayed.runs.every((entry) => entry.lifecycle === "terminal"));
  assert(!JSON.stringify(replayed).includes("secret"));

  await writeFile(
    join(consumer, "types.ts"),
    `import { type RunSnapshot, type PiDuplexExecutionPort, type PiRunCreateInput, createMemoryJournal, createPiRuntime } from 'tsukai';\nimport { createMockRuntime, createPiCertificationExecutionPort } from 'tsukai/testing';\nconst journal = createMemoryJournal();\nconst runtime = createMockRuntime();\nconst port: PiDuplexExecutionPort | undefined = undefined;\nconst input: PiRunCreateInput = { harness: 'pi', request: { prompt: 'hello' } };\nconst snapshot: RunSnapshot | undefined = undefined;\nvoid [journal, runtime, port, input, snapshot, createPiRuntime, createPiCertificationExecutionPort];\n`,
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
