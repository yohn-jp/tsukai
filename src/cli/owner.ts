import { isAbsolute } from "node:path";
import { createJinushiClient } from "../adapters/jinushi/client.js";
import { createJinushiPiExecutionPort } from "../adapters/jinushi/execution.js";
import {
  createPiRuntime,
  SUPPORTED_PI_REVISION,
  SUPPORTED_PI_VERSION,
} from "../adapters/pi/index.js";
import { connectOwner } from "../owner/client.js";
import { startResidentOwner } from "../owner/server.js";

interface Flags {
  positional: string[];
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set([
  "--state-dir",
  "--jinushi-state-dir",
  "--pi-executable",
  "--cwd",
  "--parent",
  "--label",
  "--timeout-ms",
]);

function parse(args: string[]): Flags {
  const flags: Flags = { positional: [], values: new Map() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      flags.positional.push(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`Unknown option ${arg}`);
    const value = args[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    flags.values.set(arg, value);
  }
  return flags;
}

function stateDir(flags: Flags): string {
  const value = flags.values.get("--state-dir") ?? process.env.TSUKAI_STATE_DIR;
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(
      "--state-dir (or TSUKAI_STATE_DIR) must be an absolute path",
    );
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > 60 * 1024) throw new Error("Prompt on stdin is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

async function serve(flags: Flags): Promise<void> {
  const jinushiDir = flags.values.get("--jinushi-state-dir");
  const executable = flags.values.get("--pi-executable");
  if (jinushiDir === undefined || !isAbsolute(jinushiDir)) {
    throw new Error("--jinushi-state-dir must be an absolute path");
  }
  if (executable === undefined || !isAbsolute(executable)) {
    throw new Error("--pi-executable must be an absolute path");
  }
  // Production execution is Jinushi-owned; there is no direct-spawn fallback.
  const owner = await startResidentOwner({
    stateDir: stateDir(flags),
    createService: (store) =>
      createPiRuntime({
        execution: createJinushiPiExecutionPort({
          client: createJinushiClient(jinushiDir),
          executable,
          environment: { mode: "inherit-supervisor" },
        }),
        piVersion: SUPPORTED_PI_VERSION,
        piRevision: SUPPORTED_PI_REVISION,
        durableStore: store,
      }),
  });
  print({ ready: true, pid: owner.pid, socketPath: owner.socketPath });
  const stop = (): void => {
    // Stopping the owner never retires Jinushi-owned executions.
    void owner.close("detach").finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export async function ownerCommand(args: string[]): Promise<void> {
  const [group, verb, ...rest] = args;
  const flags = parse(rest);
  if (group === "owner" && verb === "serve") return serve(flags);
  const client = await connectOwner({ stateDir: stateDir(flags) });
  try {
    if (group === "owner" && verb === "status") {
      print(await client.status());
      return;
    }
    if (group !== "run") throw new Error("Unknown command");
    const id = flags.positional[0];
    if (verb === "create") {
      const cwd = flags.values.get("--cwd");
      if (cwd === undefined) throw new Error("--cwd is required");
      const parent = flags.values.get("--parent");
      const label = flags.values.get("--label");
      print(
        await client.runs.create({
          harness: "pi",
          request: { prompt: await readStdin() },
          workspace: { cwd },
          ...(parent === undefined ? {} : { parentRunId: parent }),
          ...(label === undefined ? {} : { metadata: { label } }),
        }),
      );
    } else if (verb === "list") {
      print(await client.runs.list());
    } else if (id === undefined) {
      throw new Error(`run ${String(verb)} requires a run id`);
    } else if (verb === "get") {
      print(await client.runs.get(id));
    } else if (verb === "result") {
      print(await client.runs.result(id));
    } else if (verb === "grant") {
      // Operator-only; the secret is printed once and only its hash is stored.
      print(await client.grantAgentControl(id));
    } else if (verb === "revoke") {
      print(await client.revokeAgentControl(id));
    } else if (verb === "cancel") {
      print(await client.runs.cancel(id));
    } else if (verb === "wait") {
      const timeout = flags.values.get("--timeout-ms");
      print(
        await client.runs.wait(id, {
          ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
        }),
      );
    } else {
      throw new Error("Unknown command");
    }
  } finally {
    await client.close();
  }
}
