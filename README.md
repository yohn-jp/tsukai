# Tsukai

Tsukai is an AgentRun lifecycle and observation SDK. M1a adds Pi 0.87.1 RPC protocol integration over an injected execution/byte-transport port. The existing mock preview still exercises lifecycle, recording, and replay over dedicated synthetic Node fixture processes.

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

After package publication, consumers can install `tsukai` with their package manager. Until then, `pnpm pack` produces the installable tarball. The package exports the SDK, Pi adapter, and observation/replay utilities at `tsukai`. Explicit mock fixtures and the direct Pi certification runner are at `tsukai/testing`.

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

## Pi RPC integration (M1a)

`createPiRuntime({ execution, piVersion: SUPPORTED_PI_VERSION, piRevision: SUPPORTED_PI_REVISION })` accepts a caller-supplied `PiDuplexExecutionPort`. Each AgentRun uses one dedicated Pi RPC process. The adapter correlates `get_state`, `prompt`, and `abort` responses, records the Pi session ID and revision as provenance, maps native events, and waits for semantic settlement plus proven physical exit. A successful prompt response and `agent_end` are not completion. Missing or unsupported `prompt.data.disposition` fails closed, even if native events arrive before the response.

M1a certifies `@earendil-works/pi-coding-agent` source revision `2b0a123de98318c2ff8069661721ce0c3794c34e` (package metadata version 0.87.1), which includes disposition in its RPC implementation and exported types. The published npm 0.87.1 build lacks that field and is unsupported for Pi AgentRuns; the version string alone does not establish compatibility. Build the fixed upstream revision outside this repository and set `TSUKAI_PI_SOURCE_DIR` to its checkout and `TSUKAI_PI_EXECUTABLE` to its built `packages/coding-agent/dist/bundle/cli.js` before running `pnpm run certify:pi`. The command verifies the checkout SHA and executable location, starts `pi --mode rpc --no-session`, obtains `get_state` and a real session ID, closes stdin, and proves process exit without a provider call.

Set `TSUKAI_PI_LIVE_PROVIDER` and `TSUKAI_PI_LIVE_MODEL` as well to opt into provider-backed prompt certification; it uses the caller's existing Pi auth configuration without copying it into the repository or package. The credential-free and provider-backed lanes report separately.

The Pi adapter does not spawn a process. M1a's direct Pi runner remains testing infrastructure. There is no production direct-spawn fallback.

## Jinushi execution integration (M1b)

`createJinushiClient(stateDir)` connects to Jinushi's local protocol v1 IPC. `createJinushiPiExecutionPort({ client, executable, environment })` supplies the production `PiDuplexExecutionPort` to `createPiRuntime`. Pass an admitted absolute `workspace.cwd` when creating each AgentRun. The port submits one noninteractive Jinushi Run for one Pi RPC process, sends RPC bytes through Jinushi input, reads ordered stdout by offset, keeps stderr as bounded diagnostics, and reports Jinushi terminal receipts as physical evidence. Tsukai continues to own AgentRun and Pi semantics; `executionRunId` is the Jinushi Run ID, separate from the Pi `sessionId`.

Jinushi [#5](https://github.com/yohn-jp/jinushi/issues/5) and [#8](https://github.com/yohn-jp/jinushi/issues/8) are integrated on current Jinushi main. Tsukai now uses a stable submission identity for retry-safe Run creation and request identity plus Run generation for retry-safe physical input/close/cancel controls. Per-Run observation consumes Jinushi's notifier-driven follow surface and preserves explicit event/output gaps. The current Tsukai runtime is still ephemeral and has no resident owner or Tsukai restart recovery; that remains M2. See [the frozen M1b contract](docs/M1B-JINUSHI.md).

## Recording and replay

`tsukai demo` shows multiple mock runs, their events and results, and their relationship. `demo --json` writes one metadata observation envelope per LF-delimited line to stdout. Diagnostics go to stderr. `replay` validates an exported journal and reconstructs its public metadata projection without starting workers. Metadata replay cannot recover discarded result text. Histories and subscriptions have finite limits and expose incomplete history as gaps.

Package imports have no startup side effects. The mock owner lives only for the SDK or CLI invocation and cleans up its fixtures on `dispose`. It has no daemon, restart recovery, detached execution, workspace grants, operating-system sandbox, or production process supervision. Synthetic fixtures do not certify live Pi or Jinushi integration; the separate Pi certification command exercises the installed real Pi executable.

## Publication preparation

`pnpm run test:package` builds and packs the package, installs the tarball in a fresh temporary consumer outside this repository, and tests public imports, declarations, CLI, demo/replay, and bundled fixture execution. The tarball contains compiled assets and declarations, with no source tests or temporary state. This preview has not been published by this implementation session. Registry name availability and publishing authorization are separate checks. Do not publish, tag, or merge solely because package tests pass.

The [architecture](docs/ARCHITECTURE.md), [implementation roadmap](docs/IMPLEMENTATION.md), and [agent instructions](AGENTS.md) define the boundaries.
