import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createJinushiClient,
  createJinushiPiExecutionPort,
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

async function certifyJinushi() {
  const { executable: actualExecutable, provenance } = resolveCertifiedPi(
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
        ...provenance,
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
