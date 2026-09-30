# Tsukai

Tsukai is an AgentRun lifecycle and observation SDK. M1a adds Pi 0.99.1 RPC protocol integration over an injected execution/byte-transport port. The existing mock preview still exercises lifecycle, recording, and replay over dedicated synthetic Node fixture processes.

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

M1a certifies the published npm artifact `@earendil-works/pi-coding-agent@0.99.1` (upstream tag `v0.99.1`, commit `d86654abb8862e201933517d6f1fce9f88dd117f`, registry integrity `sha512-cWUrTOqA5M73cOYMgsh9PlhDrsBhavd+n5kVY6F7BGbGl1RjqCteVCoeVMVqhngoGACVDyw1tbLjajL8l9jrHg==`). Its RPC types and implementation provide `prompt.data.disposition` (`started`, `queued`, or `handled`) and `agent_settled`, so no source checkout or patched build is required. Tsukai accepts only `started` for a fresh AgentRun; `queued`/`handled` fail explicitly, and a missing or unknown disposition fails closed. Other Pi versions are rejected rather than guessed compatible.

The exact artifact is pinned as a development dependency. `pnpm run certify:pi` verifies that the pnpm lockfile pins the audited registry integrity, that the installed package files match the audited artifact digest, and that `pi --version` reports 0.99.1. It then starts `pi --mode rpc --no-session`, obtains `get_state` and a real session ID, closes stdin, and proves process exit without a provider call. To certify another installation of the same published artifact, set `TSUKAI_PI_EXECUTABLE` to the absolute path of that package's `dist/bundle/cli.js`; the same name, version, digest, and version checks apply.

Set `TSUKAI_PI_LIVE_PROVIDER` and `TSUKAI_PI_LIVE_MODEL` to opt into provider-backed prompt certification; it uses the caller's existing Pi auth configuration without copying it into the repository or package. The credential-free and provider-backed lanes report separately.

The Pi adapter does not spawn a process. M1a's direct Pi runner remains testing infrastructure. There is no production direct-spawn fallback.

## Jinushi execution integration (M1b)

`createJinushiClient(stateDir)` connects to Jinushi's local protocol v1 IPC. `createJinushiPiExecutionPort({ client, executable, environment })` supplies the production `PiDuplexExecutionPort` to `createPiRuntime`. Pass an admitted absolute `workspace.cwd` when creating each AgentRun. The port submits one noninteractive Jinushi Run for one Pi RPC process, sends RPC bytes through Jinushi input, reads ordered stdout by offset, keeps stderr as bounded diagnostics, and reports Jinushi terminal receipts as physical evidence. Tsukai continues to own AgentRun and Pi semantics; `executionRunId` is the Jinushi Run ID, separate from the Pi `sessionId`.

Jinushi [#5](https://github.com/yohn-jp/jinushi/issues/5) and [#8](https://github.com/yohn-jp/jinushi/issues/8) are integrated on current Jinushi main. Tsukai now uses a stable submission identity for retry-safe Run creation and request identity plus Run generation for retry-safe physical input/close/cancel controls. Per-Run observation consumes Jinushi's notifier-driven follow surface and preserves explicit event/output gaps. Restart recovery over these identities is M2; see [the resident owner](#resident-owner-and-durability-m2) and [the frozen M1b contract](docs/M1B-JINUSHI.md).

For live M1b certification, run `pnpm run certify:jinushi` with `TSUKAI_JINUSHI_STATE_DIR` and `TSUKAI_JINUSHI_WORKSPACE` set to absolute local paths (and optionally `TSUKAI_PI_EXECUTABLE`, verified as above). The command uses the real Jinushi supervisor and the certified published Pi RPC executable. It certifies transport (`get_state`, retirement, terminal receipt), a full AgentRun with distinct AgentRun/Jinushi Run/Pi session IDs, cancellation, and retry/idempotency of submission, input, close-input, and cancel. The provider-backed lane reports ENVIRONMENT_BLOCKED unless credentials are configured; see [the M1b closure evidence](docs/M1B-JINUSHI.md#closure-evidence-issue-12).

## Resident owner and durability (M2)

`startResidentOwner({ stateDir, createService })` (or `tsukai owner serve`) runs the canonical in-machine AgentRun authority: one `RunService` over a `createFileDurableStore` registry and metadata-only journal, behind an access-controlled Unix-domain socket (private directory, 0600 socket, per-start token; no TCP/HTTP listener). `connectOwner({ stateDir })` returns a reconnecting client whose `runs` operations (`create`, `get`, `list`, `children`, `wait`, `cancel`, `events`, `result`) execute in the owner; disconnecting a client never cancels a run.

Intent is persisted before any external start and the Jinushi execution binding is persisted before the prompt is written or establishment is acknowledged. After an owner restart, persisted runs are reconciled against Jinushi by stable execution identity and cursor: still running, physically terminal, reconciling, or uncertain. Restart never relaunches an execution, resends a prompt, or infers completion from missing evidence; lost events/output/journal records stay visible as `recovery.gaps` and `completeness: "incomplete"`. Prompts, assistant text, and raw output are never persisted by default, so `result().reportedText` is unavailable after a restart unless re-derived from live output. Design, ordering, limitations, and certification evidence: [docs/M2-OWNER.md](docs/M2-OWNER.md).

`pnpm run certify:owner` is the live restart certification (real Jinushi supervisor, real Pi 0.99.1, owner killed with SIGKILL and restarted); it reports ENVIRONMENT_BLOCKED when `TSUKAI_JINUSHI_STATE_DIR`, `TSUKAI_JINUSHI_WORKSPACE`, or `TSUKAI_JINUSHI_BIN` are unset.

## Recording and replay

`tsukai demo` shows multiple mock runs, their events and results, and their relationship. `demo --json` writes one metadata observation envelope per LF-delimited line to stdout. Diagnostics go to stderr. `replay` validates an exported journal and reconstructs its public metadata projection without starting workers. Metadata replay cannot recover discarded result text. Histories and subscriptions have finite limits and expose incomplete history as gaps.

Package imports have no startup side effects. The mock owner lives only for the SDK or CLI invocation and cleans up its fixtures on `dispose`. It has no daemon, restart recovery, detached execution, workspace grants, operating-system sandbox, or production process supervision (the resident owner above is the separate, Jinushi-backed M2 path). Synthetic fixtures do not certify live Pi or Jinushi integration; the separate Pi certification command exercises the installed real Pi executable.

## Publication preparation

`pnpm run test:package` builds and packs the package, installs the tarball in a fresh temporary consumer outside this repository, and tests public imports, declarations, CLI, demo/replay, and bundled fixture execution. The tarball contains compiled assets and declarations, with no source tests or temporary state. This preview has not been published by this implementation session. Registry name availability and publishing authorization are separate checks. Do not publish, tag, or merge solely because package tests pass.

Pull requests and pushes to `main` run the shared yohn-jp TypeScript CLI CI through `.github/workflows/ci.yml`: format, lint, typecheck, tests, build, packed-package validation, and `pnpm run conformance` (the packed-consumer test plus credential-free Pi 0.99.1 certification). The workflow reports a single `verify` status.

The [architecture](docs/ARCHITECTURE.md), [implementation roadmap](docs/IMPLEMENTATION.md), and [agent instructions](AGENTS.md) define the boundaries.
