# Tsukai

Tsukai is an AgentRun lifecycle and observation SDK. Version `0.1.0` is a **mock preview**: it exercises real lifecycle, recording, and replay behavior over dedicated synthetic Node fixture processes. It does not run an LLM or connect to Pi, Jinushi, Nawabari, or Mottainai.

## Install and use

Requires Node.js 24 or newer. This repository uses pnpm 11.27.0 for development.

```sh
pnpm install
pnpm run verify
pnpm run test:package
pnpm exec tsukai --help
pnpm exec tsukai demo
pnpm exec tsukai demo --json > demo.jsonl
pnpm exec tsukai replay demo.jsonl --json
```

After package publication, consumers can install `tsukai` with their package manager. Until then, `pnpm pack` produces the installable tarball. The package exports the ordinary SDK and observation/replay utilities at `tsukai`, and explicit mock fixtures at `tsukai/testing`.

```ts
import { createMockRuntime } from "tsukai/testing";

const runtime = createMockRuntime();
try {
  const run = await runtime.runs.create({
    harness: "mock",
    request: { scenario: "normal" },
  });
  const terminal = await runtime.runs.wait(run.agentRunId, { timeoutMs: 5000 });
  console.log(terminal.outcome, runtime.runs.result(run.agentRunId));
} finally {
  await runtime.dispose();
}
```

See [the SDK example](examples/sdk.ts) for parent/child runs. `runs` also provides `get`, bounded `list` and `children`, `events`, `cancel`, and `result`. A timeout or aborted wait leaves its worker running. `cancel` targets the run explicitly. Result text is returned separately from the default journal.

## Recording and replay

`tsukai demo` shows multiple mock runs, their events and results, and their relationship. `demo --json` writes one metadata observation envelope per LF-delimited line to stdout. Diagnostics go to stderr. `replay` validates an exported journal and reconstructs its public metadata projection without starting workers. Metadata replay cannot recover discarded result text. Histories and subscriptions have finite limits and expose incomplete history as gaps.

Package imports have no startup side effects. The mock owner lives only for the SDK or CLI invocation and cleans up its fixtures on `dispose`. It has no daemon, restart recovery, detached execution, workspace grants, operating-system sandbox, or production process supervision. Synthetic protocol tests and physical fixture tests do not certify live Pi or Jinushi integration. Real backend requests fail explicitly as unsupported.

## Publication preparation

`pnpm run test:package` builds and packs the package, installs the tarball in a fresh temporary consumer outside this repository, and tests public imports, declarations, CLI, demo/replay, and bundled fixture execution. The tarball contains compiled assets and declarations, with no source tests or temporary state. This preview has not been published by this implementation session. Registry name availability and publishing authorization are separate checks. Do not publish, tag, or merge solely because package tests pass.

The [architecture](docs/ARCHITECTURE.md), [M0 scope](docs/IMPLEMENTATION.md), and [agent instructions](AGENTS.md) define the boundaries.
