import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";
import { createPiRpcClient } from "../dist/adapters/pi/protocol.js";
import { createPiCertificationExecutionPort } from "../dist/testing/index.js";

const executable = process.env.TSUKAI_PI_EXECUTABLE;
const sourceDir = process.env.TSUKAI_PI_SOURCE_DIR;
const provider = process.env.TSUKAI_PI_LIVE_PROVIDER;
const model = process.env.TSUKAI_PI_LIVE_MODEL;

async function certifyTransport() {
  const port = createPiCertificationExecutionPort({ executable });
  let client;
  let resolveExit;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  try {
    const transport = await port.open("m1a-protocol-certification", {
      onStdout(chunk) {
        client?.push(chunk);
      },
      onStderr() {},
      onExit(receipt) {
        client?.finish();
        resolveExit(receipt);
      },
      onError(error) {
        client?.fail(error);
      },
    });
    client = createPiRpcClient(transport, () => {});
    const response = await client.request({ type: "get_state" });
    assert.equal(response.success, true);
    assert.equal(typeof response.data?.sessionId, "string");
    assert(response.data.sessionId.length > 0);
    await transport.closeInput();
    await transport.retire("settled");
    const receipt = await exit;
    assert.equal(receipt.status, "exited");
    assert.equal(receipt.executionRunId, transport.executionRunId);
    console.log(
      JSON.stringify({
        lane: "credential-free",
        status: "PASSED",
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
        sessionId: response.data.sessionId,
        exitCode: receipt.exitCode,
      }),
    );
  } finally {
    await port.dispose();
  }
}

async function certifyLivePrompt() {
  if (!provider || !model) {
    console.log(
      JSON.stringify({
        lane: "provider-backed",
        status: "ENVIRONMENT_BLOCKED",
        reason:
          "Set TSUKAI_PI_LIVE_PROVIDER and TSUKAI_PI_LIVE_MODEL to opt in",
      }),
    );
    return;
  }
  const port = createPiCertificationExecutionPort({
    executable,
    inheritProviderAuth: true,
    provider,
    model,
  });
  const runtime = createPiRuntime({
    execution: port,
    piVersion: SUPPORTED_PI_VERSION,
    piRevision: SUPPORTED_PI_REVISION,
    commandTimeoutMs: 60_000,
  });
  try {
    const created = await runtime.runs.create({
      harness: "pi",
      request: {
        prompt: "Reply briefly with the word ready. Do not call tools.",
      },
    });
    const terminal = await runtime.runs.wait(created.agentRunId, {
      timeoutMs: 120_000,
    });
    if (terminal.outcome !== "completed") {
      console.error(
        JSON.stringify({
          lane: "provider-backed",
          outcome: terminal.outcome,
          reason: terminal.reason,
          lifecycle: terminal.lifecycle,
          semantic: terminal.semantic,
          receiptStatus: terminal.receipt?.status,
        }),
      );
    }
    assert.equal(terminal.outcome, "completed");
    assert.equal(terminal.receipt?.status, "exited");
    assert.equal(typeof terminal.execution?.sessionId, "string");
    assert.equal(terminal.execution.piRevision, SUPPORTED_PI_REVISION);
    const history = runtime.journal.read(created.agentRunId).items;
    assert(history.some((entry) => entry.kind === "harness.message"));
    assert(history.some((entry) => entry.kind === "harness.agent_settled"));
    console.log(
      JSON.stringify({
        lane: "provider-backed",
        status: "PASSED",
        provider,
        model,
        sessionId: terminal.execution.sessionId,
        outcome: terminal.outcome,
        piRevision: SUPPORTED_PI_REVISION,
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

try {
  assert(
    executable && sourceDir,
    "Set TSUKAI_PI_EXECUTABLE and TSUKAI_PI_SOURCE_DIR to the fixed upstream build",
  );
  const sourceRoot = realpathSync(sourceDir);
  const actualExecutable = realpathSync(executable);
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
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  assert.equal(
    version,
    SUPPORTED_PI_VERSION,
    "Installed Pi version is unsupported",
  );
  await certifyTransport();
  await certifyLivePrompt();
} catch (error) {
  console.error(
    `Pi certification failed: ${error instanceof Error ? error.name : "unknown error"}`,
  );
  process.exitCode = 1;
}
