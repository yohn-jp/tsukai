// Certification-only owner process. It is the same resident owner as
// `tsukai owner serve`, except that retirement of the Jinushi-owned Pi process
// waits for a gate file. That holds a settled run physically alive so the
// certification can kill this process (SIGKILL) across a real restart boundary.
import { existsSync } from "node:fs";
import {
  createJinushiClient,
  createJinushiPiExecutionPort,
  createPiRuntime,
  startResidentOwner,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../dist/index.js";

const [stateDir, jinushiDir, executable] = process.argv.slice(2);
const gate = process.env.TSUKAI_CERT_GATE_FILE;
if (!stateDir || !jinushiDir || !executable || !gate) {
  console.error("usage: certify-owner-child <state> <jinushi-state> <pi>");
  process.exit(2);
}

async function gated() {
  while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 20));
}

function gateExecution(execution) {
  return {
    get executionRunId() {
      return execution.executionRunId;
    },
    get backend() {
      return execution.backend;
    },
    get pid() {
      return execution.pid;
    },
    write: (bytes) => execution.write(bytes),
    closeInput: async () => {
      await gated();
      return execution.closeInput();
    },
    retire: async (reason) => {
      await gated();
      return execution.retire(reason);
    },
  };
}

const owner = await startResidentOwner({
  stateDir,
  createService: (store) => {
    const port = createJinushiPiExecutionPort({
      client: createJinushiClient(jinushiDir),
      executable,
      environment: { mode: "inherit-supervisor" },
    });
    return createPiRuntime({
      // Same port surface as `tsukai owner serve`: a restarted certification
      // owner must re-attach by Jinushi Run ID exactly like production, or
      // reconciliation correctly reports `execution-port-cannot-attach`.
      execution: {
        executionProfile: port.executionProfile,
        open: async (...args) => gateExecution(await port.open(...args)),
        attach: async (executionRunId, observer, resume, onOpen) => {
          let gatedExecution;
          const wrap = (execution) =>
            (gatedExecution ??= gateExecution(execution));
          const result = await port.attach(
            executionRunId,
            observer,
            resume,
            (execution) => onOpen(wrap(execution)),
          );
          return result.status === "attached"
            ? { ...result, execution: wrap(result.execution) }
            : result;
        },
        detach: () => port.detach(),
        dispose: () => port.dispose(),
      },
      piVersion: SUPPORTED_PI_VERSION,
      piRevision: SUPPORTED_PI_REVISION,
      durableStore: store,
    });
  },
});
console.log(JSON.stringify({ ready: true, pid: owner.pid }));
