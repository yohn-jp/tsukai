#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createMockRuntime } from "../testing/index.js";
import {
  projectReplay,
  renderOperatorProjection,
} from "../observation/index.js";
import { ownerCommand } from "./owner.js";

const VERSION = "0.1.0";
const HELP = `tsukai ${VERSION} — ephemeral mock preview

Usage:
  tsukai --help
  tsukai --version
  tsukai demo [--json]
  tsukai replay <journal-path> [--json]
  tsukai observe --state-dir D [--json]
  tsukai owner serve --state-dir D --jinushi-state-dir D --pi-executable P
  tsukai owner status --state-dir D
  tsukai run create --state-dir D --cwd D [--parent ID] [--label L]  (prompt on stdin)
  tsukai run get|result|cancel <id> --state-dir D
  tsukai run wait <id> --state-dir D [--timeout-ms N]
  tsukai run list --state-dir D
  tsukai run grant|revoke <id> --state-dir D   (operator: agent credential for a run)

demo --json writes metadata-only JSONL to stdout; diagnostics use stderr.
Each invocation owns only its own temporary mock workers.
owner/run commands talk to the resident local owner over an access-controlled
Unix socket; TSUKAI_STATE_DIR may replace --state-dir.`;

async function demo(json: boolean): Promise<void> {
  const runtime = createMockRuntime();
  try {
    const parent = await runtime.runs.create({
      harness: "mock",
      request: { scenario: "hold" },
      metadata: { label: "parent" },
    });
    const child = await runtime.runs.create({
      harness: "mock",
      request: { scenario: "normal" },
      parentRunId: parent.agentRunId,
      metadata: { label: "child" },
    });
    const sibling = await runtime.runs.create({
      harness: "mock",
      request: { scenario: "error" },
      metadata: { label: "independent" },
    });
    await runtime.release(parent.agentRunId);
    const snapshots = await Promise.all(
      [parent, child, sibling].map((run) =>
        runtime.runs.wait(run.agentRunId, { timeoutMs: 5000 }),
      ),
    );
    if (json) {
      process.stdout.write(runtime.journal.export());
    } else {
      console.log(
        "Tsukai mock preview (ephemeral owner; synthetic fixture processes)",
      );
      for (const snapshot of snapshots) {
        const result = runtime.runs.result(snapshot.agentRunId);
        console.log(
          `${snapshot.agentRunId} parent=${snapshot.parentRunId ?? "-"} execution=${snapshot.execution?.executionRunId ?? "-"} outcome=${snapshot.outcome}`,
        );
        console.log(`  result: ${JSON.stringify(result)}`);
        for (const event of runtime.journal.read(snapshot.agentRunId).items)
          console.log(`  event ${event.seq}: ${event.kind}`);
      }
    }
  } finally {
    await runtime.dispose();
  }
}

async function replay(path: string, json: boolean): Promise<void> {
  const text = await readFile(path, "utf8");
  const projection = projectReplay(text);
  if (json) {
    process.stdout.write(renderOperatorProjection(projection, "json"));
  } else {
    process.stdout.write(renderOperatorProjection(projection, "text"));
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(HELP);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    return;
  }
  if (
    args[0] === "demo" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--json"))
  ) {
    await demo(args.includes("--json"));
    return;
  }
  if (
    args[0] === "replay" &&
    (args.length === 2 || (args.length === 3 && args[2] === "--json")) &&
    args[1] &&
    args[1] !== "--json"
  ) {
    await replay(args[1], args.includes("--json"));
    return;
  }
  if (args[0] === "owner" || args[0] === "run" || args[0] === "observe") {
    await ownerCommand(args);
    return;
  }
  throw new Error("Invalid command or arguments. Use tsukai --help.");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
