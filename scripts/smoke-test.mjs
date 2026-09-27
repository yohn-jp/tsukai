#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const index = process.argv.indexOf("--tarball");
assert.notEqual(index, -1, "--tarball is required");
assert.ok(process.argv[index + 1], "--tarball requires a path");
const tarball = resolve(process.argv[index + 1]);
assert.ok(existsSync(tarball), `tarball not found: ${tarball}`);

const consumer = mkdtempSync(join(tmpdir(), "tsukai-smoke-"));
try {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);

  const bin = join(consumer, "node_modules", ".bin", "tsukai");
  assert.ok(existsSync(bin), "npm did not create the tsukai launcher");
  assert.equal(run(bin, ["--version"], consumer).trim(), "0.1.0");
  assert.match(run(bin, ["--help"], consumer), /tsukai 0\.1\.0/);

  writeFileSync(
    join(consumer, "sdk.mjs"),
    "import { createMemoryJournal, createPiRuntime, createJinushiClient } from 'tsukai';\n" +
      "import { createMockRuntime } from 'tsukai/testing';\n" +
      "if (![createMemoryJournal, createPiRuntime, createJinushiClient, createMockRuntime].every(v => typeof v === 'function')) process.exit(1);\n",
  );
  run(process.execPath, ["sdk.mjs"], consumer);
  console.log("tsukai packed-package smoke passed");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
