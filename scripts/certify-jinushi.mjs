import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  createJinushiClient,
  createJinushiPiExecutionPort,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { createPiRpcClient } from "../dist/adapters/pi/protocol.js";

const executable = process.env.TSUKAI_PI_EXECUTABLE;
const sourceDir = process.env.TSUKAI_PI_SOURCE_DIR;
const stateDir = process.env.TSUKAI_JINUSHI_STATE_DIR;
const workspace = process.env.TSUKAI_JINUSHI_WORKSPACE;

function requireAbsolute(name, value) {
  assert(value, `Set ${name}`);
  assert(isAbsolute(value), `${name} must be an absolute path`);
  return realpathSync(value);
}

function verifyPiSource() {
  const sourceRoot = requireAbsolute("TSUKAI_PI_SOURCE_DIR", sourceDir);
  const actualExecutable = requireAbsolute("TSUKAI_PI_EXECUTABLE", executable);
  const executableWithinSource = relative(sourceRoot, actualExecutable);
  assert(
    executableWithinSource &&
      !executableWithinSource.startsWith("..") &&
      !isAbsolute(executableWithinSource),
    "Pi executable must be inside the fixed upstream checkout",
  );
  const sourceRevision = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  assert.equal(
    sourceRevision,
    SUPPORTED_PI_REVISION,
    "Pi source revision is unsupported",
  );
  const trackedChanges = execFileSync(
    "git",
    ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  assert.equal(trackedChanges, "", "Pi source checkout must be clean");
  const version = execFileSync(actualExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  assert.equal(
    version,
    SUPPORTED_PI_VERSION,
    "Installed Pi version is unsupported",
  );
  return actualExecutable;
}

async function certifyJinushi() {
  const actualExecutable = verifyPiSource();
  const actualStateDir = requireAbsolute(
    "TSUKAI_JINUSHI_STATE_DIR",
    stateDir,
  );
  const actualWorkspace = requireAbsolute(
    "TSUKAI_JINUSHI_WORKSPACE",
    workspace,
  );

  const jinushi = createJinushiClient(actualStateDir);
  const capabilities = await jinushi.capabilities();
  assert.equal(typeof capabilities.backend, "string");
  assert(capabilities.backend.length > 0);

  const port = createJinushiPiExecutionPort({
    client: jinushi,
    executable: actualExecutable,
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
      { cwd: actualWorkspace },
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

    console.log(
      JSON.stringify({
        lane: "jinushi-credential-free",
        status: "PASSED",
        backend: transport.backend,
        executionRunId: transport.executionRunId,
        sessionId: state.data.sessionId,
        exitCode: receipt.exitCode,
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
      }),
    );
  } finally {
    await port.dispose();
  }
}

try {
  await certifyJinushi();
} catch (error) {
  console.error(
    `Jinushi certification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
