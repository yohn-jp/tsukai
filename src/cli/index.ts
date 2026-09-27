#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createMockRuntime } from "../testing/index.js";
import { replayJournal } from "../observation/index.js";

const VERSION = "0.1.0";
const HELP = `tsukai ${VERSION} — ephemeral mock preview

Usage:
  tsukai --help
  tsukai --version
  tsukai demo [--json]
  tsukai replay <journal-path> [--json]

demo --json writes metadata-only JSONL to stdout; diagnostics use stderr.
Each invocation owns only its own temporary mock workers.`;

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
  const projection = replayJournal(text);
  if (json) {
    process.stdout.write(`${JSON.stringify(projection)}\n`);
  } else {
    console.log(
      "Tsukai metadata replay (no workers started; result text unavailable)",
    );
    for (const run of projection.runs)
      console.log(
        `${run.agentRunId} parent=${run.parentRunId ?? "-"} lifecycle=${run.lifecycle} outcome=${run.outcome ?? "-"} completeness=${run.completeness}`,
      );
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
  throw new Error("Invalid command or arguments. Use tsukai --help.");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
