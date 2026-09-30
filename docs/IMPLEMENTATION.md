# Implementation roadmap

Status: M0, M1a, and M1b are complete. M1b was re-certified by Issue #12 against Jinushi `main@3db1f2ac953e5646e433e180f17150556c308eff` and the published Pi 0.99.1 artifact (evidence in [M1B-JINUSHI.md](M1B-JINUSHI.md)); provider-backed semantic certification remains ENVIRONMENT_BLOCKED without local credentials. M2 (resident ownership, #13) is not started; PR #7 only established durability/recovery seams. M1a's supported Pi is the published `@earendil-works/pi-coding-agent@0.99.1` npm artifact (see [M1a Pi 0.99.1 refresh](#m1a-pi-0991-refresh)). `docs/ARCHITECTURE.md` remains the product-semantics authority.

## Baseline

M0 established the publishable mock preview: the TypeScript AgentRun service, explicit mock runtime, independently spawned fixed fixtures, bounded observation/journal behavior, deterministic replay, CLI demo/replay, and packed-consumer verification. Those behaviors remain regression requirements.

M0 did **not** certify live Pi, Jinushi, durable ownership, parent-agent tools, or a dashboard. Do not relabel M0 evidence as proof of those capabilities.

## Delivery roadmap

| Milestone | Scope | Completion boundary |
| --- | --- | --- |
| M1a | Pi RPC protocol integration and live transport certification | Tsukai can drive and observe a separately executed Pi RPC process through an injected execution/transport boundary; direct spawn exists only as explicit certification/test infrastructure |
| M1b (complete) | Jinushi production execution adapter | Production AgentRuns launch/retire Pi through current accepted Jinushi contracts and preserve physical/semantic evidence separation |
| M2 | Resident local owner and durability | Cross-client local IPC, durable registry/journal, restart reconciliation, explicit uncertainty and event gaps |
| M3 | Agent-facing control surface | Scoped `agent_spawn/status/wait/result/cancel`, parent/child runs, independent child execution |
| M4 | Operator observability | Fleet/tree/timeline/resource/usage projections and replay/profile UI consumers |
| M5 | Multi-harness adapters | Additional harnesses behind capability-aware adapters without degrading Pi-native observations to a lowest-common-denominator model |
| M6 | Mottainai adoption | Mottainai consumes Tsukai as the AgentRun layer; orchestration policy remains outside Tsukai |

Milestones are sequential architectural gates, not permission for one implementation session to run through the whole roadmap.

# M1a: Pi RPC protocol integration

## Goal

Replace the synthetic-only harness boundary with a real Pi RPC adapter while preserving the M0 AgentRun semantics. M1a proves that Tsukai can speak the real Pi subprocess protocol and correlate native session/events without making Tsukai the production process supervisor.

Production process ownership is still reserved for Jinushi. Because Jinushi does not yet expose an accepted executable integration surface in its current repository, M1a must not guess one. Instead, M1a introduces the production-shaped execution/byte-transport seam and an explicit test/certification runner that may spawn Pi directly.

## Upstream contract

The M1a implementation must re-read the then-current upstream Pi RPC documentation and package metadata before coding. The design baseline verified on 2026-09-27 is:

- package: `@earendil-works/pi-coding-agent`;
- RPC process form: `pi --mode rpc --no-session` for a fresh isolated run;
- protocol: strict LF-delimited JSON records on stdin/stdout; stderr is diagnostics only;
- every concurrently outstanding command uses a unique request ID and responses are correlated by ID;
- a successful `prompt` response means accepted/queued/handled, not completed;
- `agent_end` is not terminal because retry, compaction recovery, steering, or follow-up work may continue;
- `agent_settled` means Pi will not continue automatically, but final success/error/abort evidence still determines semantic outcome;
- closing stdin requests orderly Pi shutdown; process exit remains physical evidence, not semantic task success.

Do not copy private Pi source or freeze undocumented internals. If the installed/upstream protocol materially contradicts this document, stop with a concrete contract blocker rather than inventing compatibility behavior.

### M1a Pi 0.99.1 refresh

The original M1a certification pinned upstream source revision `2b0a123de98318c2ff8069661721ce0c3794c34e` (package metadata 0.87.1) because the published npm 0.87.1 build lacked `prompt.data.disposition`. That source-checkout requirement is obsolete.

Issue #11 re-read Pi tag `v0.99.1` (commit `d86654abb8862e201933517d6f1fce9f88dd117f`) and the published `@earendil-works/pi-coding-agent@0.99.1` artifact (registry integrity `sha512-cWUrTOqA5M73cOYMgsh9PlhDrsBhavd+n5kVY6F7BGbGl1RjqCteVCoeVMVqhngoGACVDyw1tbLjajL8l9jrHg==`, `gitHead` equal to the tag commit). Its exported RPC types and RPC mode implementation provide `prompt` responses with `data.disposition` of `started`, `queued`, or `handled`, a field-less `agent_settled` event after automatic continuation ends, delta-only `message_update` records, and a `system` message before the user message in each run. None of these contradict this document.

- `SUPPORTED_PI_VERSION` is `0.99.1`; `SUPPORTED_PI_REVISION` is the audited tag commit.
- The exact published artifact is an exact-version development dependency. Credential-free certification verifies the lockfile integrity, the installed artifact file digest, and `pi --version`, then performs real `get_state`, records the Pi session ID, closes stdin, and proves process exit.
- Deterministic transcript fixtures under `test/pi/fixtures/pi-0.99.1/` were captured from that executable with a credential-free local faux provider; they cover normal success, explicit provider error, and abort.
- Tsukai keeps its independent byte-oriented RPC client and injected execution/transport port. Pi's spawning `RpcClient` is not used for production execution.
- The repository's pull-request and `main` checks use the shared `yohn-jp/.github` TypeScript CLI CI workflow, with `test:package` as the package conformance script.

Provider-backed prompt certification remains opt-in and is reported ENVIRONMENT_BLOCKED when provider credentials or model access are unavailable.

## M1a architecture

~~~text
Tsukai application/domain
        |
        +---- Pi harness adapter
        |       |
        |       +-- command correlation
        |       +-- Pi native-event mapping
        |       +-- session/provenance capture
        |
        +---- execution/transport port
                |
                +-- M1a certification runner (testing only)
                |       |
                |       +-- real pi --mode rpc process
                |
                +-- M1b Jinushi adapter (future production path)
~~~

The Pi harness adapter does not call `child_process.spawn` itself. It consumes a duplex execution/transport capability supplied by the execution port. Production code cannot silently select the certification runner.

One Tsukai AgentRun still maps to one dedicated Pi process/execution attempt. Pi `sessionId` is recorded as harness identity/provenance and never replaces `agentRunId` or the future Jinushi execution Run ID.

## In scope

- A real Pi RPC adapter behind the existing service/port boundaries.
- Bounded incremental UTF-8 JSONL decoding and encoding for real Pi records.
- Unique command IDs, bounded pending-command state, response correlation, timeout/transport-close rejection, and cleanup.
- Pi handshake/state capture sufficient to record session identity and tested runtime provenance.
- Initial prompt submission for one fresh AgentRun.
- Mapping of Pi native events into the stable observation envelope while retaining supported Pi-specific fields under validated namespaced payloads.
- Correct semantic treatment of `agent_start/end`, `turn_*`, `message_*`, `tool_execution_*`, queue, retry, compaction, usage, and `agent_settled` records that are present in the supported Pi version.
- Result extraction from authoritative completed assistant-message evidence without enabling default transcript persistence.
- Explicit cancellation path: semantic abort request and physical retirement remain distinct operations.
- Explicit `tsukai/testing` or certification-only direct Pi process runner. It may execute only the configured Pi executable/argv contract; it is not a general process launcher.
- Protocol transcript fixtures/captured-shape tests that do not require provider credentials.
- An opt-in live Pi certification command/test that starts the real Pi RPC process. Provider-backed prompt certification may require local provider/model credentials and must report environment-blocked when they are unavailable.
- README/package documentation describing exactly what M1a proves and what remains uncertified.

## Explicit exclusions

- No Jinushi API guessing, vendoring, direct repository edits, or fake Jinushi adapter.
- No production direct-spawn fallback.
- No durable owner, daemon, restart recovery, local HTTP/IPC server, or detached cross-invocation control.
- No Pi extension/plugin or parent-agent `agent_spawn` tools yet.
- No Mottainai migration, Nawabari implementation, scheduler, task decomposition, recursive subagents, or policy retries.
- No Codex/Claude/Gemini/OpenCode adapters.
- No dashboard or broad profiling UI.
- No automatic approval of extension UI requests or interactive prompts. Unsupported required interaction is explicit.
- No provider credentials in tests, fixtures, logs, journals, package artifacts, or repository configuration.

## Contract decisions

### Transport ownership

The execution/transport port owns process establishment, stdin/stdout/stderr byte transport, physical observation, and retirement. The Pi adapter is the sole RPC writer and response correlator for its run. No second consumer competes for Pi stdout.

The M1a certification runner is allowed to spawn the known Pi executable only because it is test/certification infrastructure. It must be explicit at construction/use and must not satisfy or masquerade as the future production Jinushi adapter.

### Framing and backpressure

Use byte-oriented LF framing. A chunk is not a record. Accept optional CR before LF. Unicode U+2028/U+2029 inside JSON strings are content, not delimiters. Enforce finite record bytes, buffered bytes, pending requests, and subscriber queues. Malformed/oversized records fail explicitly without fabricating successful observations.

Read stdout continuously and honor stdin write backpressure. stderr is bounded diagnostic evidence and never parsed as protocol data.

### Prompt submission

Register the AgentRun and event subscription before the first prompt. A successful Pi `prompt` response records acceptance/disposition only. Normal M1a creation expects a fresh process and a newly started prompt; unexpected queued/handled behavior must be represented explicitly rather than guessed as completion.

### Semantic settlement

`agent_end` never finalizes an AgentRun. Retry, compaction, queue, and continuation events remain observable after it.

`agent_settled` closes Pi's automatic-continuation window. Tsukai then derives the semantic outcome candidate from authoritative final assistant/provider evidence: normal completion, explicit error, or abort. Missing/contradictory evidence is not converted to success.

Tsukai terminal state still requires proven physical retirement according to the execution port. Semantic completion and physical process exit are separate facts.

### Cancellation and retirement

`runs.cancel` is idempotent. While Pi is active, request Pi abort through RPC where supported, but abort acknowledgement is not terminal evidence. Then request execution retirement through the execution port. Finalize only after physical terminal evidence is proven. A late cancel after normal semantic settlement may accelerate retirement but must not rewrite a completed semantic candidate as user-cancelled.

Wait timeout or AbortSignal cancellation affects only the waiter.

### Observation/privacy

Default recording remains metadata-only. Do not persist prompt text, assistant text, thinking deltas, tool arguments/results, raw stderr, filesystem content, or environment values by default. The authorized caller may receive the final result separately from the journal.

Preserve unavailable usage/cost as unavailable. Pi cumulative usage must not be double-counted as per-event deltas. Native Pi fields that are not common Tsukai semantics belong in bounded namespaced payloads.

## Suggested module ownership

Existing module boundaries remain valid. Add only the minimum adjacent structure required, for example:

~~~text
src/adapters/pi/               Pi RPC protocol/harness adapter
src/execution/                 execution/duplex port if not already canonical
src/testing/pi/                explicit live certification runner/helpers
test/pi/                       protocol and adapter tests
scripts/                       optional live certification entry point
~~~

Do not reorganize the M0 codebase merely to match these example paths. Reuse canonical contracts/helpers where they already exist.

## Execution checkpoints

### C0 — main session: inspect and freeze the seam

Fetch latest `origin/main`, read AGENTS.md, architecture, this document, current source/tests, and the latest accepted M0 implementation. Re-read current Pi RPC docs/package metadata. Confirm no equivalent M1a PR is already active.

Create an isolated implementation worktree/branch. Before dispatching workers, the main session fixes any shared contract changes required for the execution/transport seam, Pi request/provenance shapes, and focused test commands. Keep public API additions minimal and backwards compatible unless this milestone explicitly requires otherwise. Commit the shared base.

### C1 — parallel implementation

Use up to 20 subagents, but prefer a small number of disjoint streams. A good split is:

| Stream | Ownership | Proof |
| --- | --- | --- |
| A | Pi RPC framing, command correlation, protocol validation | fragmentation, CRLF, Unicode separators, malformed/oversized frames, concurrent IDs, transport close/backpressure |
| B | Pi event mapping and semantic settlement | `agent_end` non-terminal, retry/compaction/queue continuation, settled success/error/abort, usage/privacy |
| C | certification execution runner and physical retirement integration | distinct real Pi process identity, clean startup/get_state/shutdown, crash/cancel/cleanup isolation |
| D | package/docs/consumer integration if needed | public imports, optional certification command, packed package remains clean |

Shared contracts, package metadata/lockfile, root exports, and final integration remain owned by the main session. Workers use distinct worktrees/branches from the committed C0 base, run focused verification, commit, and return SHA/evidence. They do not open independent PRs or merge.

### C2 — integration and verification

Integrate worker commits, resolve only required seams, and run focused tests followed by `pnpm run verify` and `pnpm run test:package` on the final HEAD.

Add a deterministic credential-free Pi protocol/transport certification that can run whenever the Pi executable/package is installed. Keep provider-backed certification opt-in. If provider credentials/model access are absent, report that lane as ENVIRONMENT_BLOCKED rather than green or failed product logic.

Verify that M0 mock behavior and package-consumer tests remain green. Ensure the packed package does not contain credentials, captured private transcripts, temporary session state, or developer-local Pi configuration.

### C3 — handoff

Commit, push, and create one PR to `main` using `gh`. Do not merge, tag, release, publish npm, begin M1b, or modify Jinushi/Nawabari/Mottainai. Report PR URL, base/head SHA, verification, live-certification status, tested Pi version/provenance, and remaining limitations.

## M1a acceptance criteria

1. Existing M0 tests, `pnpm run verify`, and `pnpm run test:package` remain green on the integrated HEAD.
2. Pi RPC support is a real adapter over an injected duplex execution/transport boundary; the production adapter itself does not spawn a process.
3. The explicit certification runner can start the supported real Pi executable in RPC mode, issue at least a correlated `get_state`, record a real Pi `sessionId`, close/retire it, and prove the process ended. This lane requires no model call.
4. Command IDs support multiple in-flight requests; unknown/duplicate responses, timeout, malformed input, EOF, and process exit reject/clean pending operations deterministically.
5. JSONL framing satisfies the byte/Unicode/bounds rules and never treats stderr as protocol.
6. Prompt acceptance is not completion. `agent_end` is non-terminal. Retry/compaction/queue continuation before `agent_settled` is preserved.
7. Complete transcript fixtures prove normal success, explicit provider/harness error, abort, and contradictory/missing terminal evidence without fabricating success.
8. Terminal Tsukai completion occurs only after semantic outcome candidate plus proven execution retirement; crash-before-settlement is interrupted/failed according to established architecture rather than completed.
9. Repeated/concurrent cancel is idempotent; waiter cancellation does not cancel the AgentRun; late cancel cannot rewrite an already selected normal semantic outcome.
10. Default journal/export remains metadata-only and replay-safe. Pi-specific observations are bounded/validated and cannot inject arbitrary persisted secrets.
11. Usage/cost mapping distinguishes cumulative values and unknown values so metrics are not double-counted or converted from unavailable to zero.
12. The packed public package exposes only intentional Pi integration surface; certification/testing helpers are explicitly separated and no source/private imports are required by consumers.
13. README states M1a's exact support: Pi RPC protocol integration is implemented; production physical execution is not Jinushi-backed until M1b; resident/durable control is not yet implemented.
14. If a configured provider/model is available, an opt-in end-to-end live prompt certification may prove real message/tool/settlement events. If unavailable, the final report names that certification ENVIRONMENT_BLOCKED and relies only on the deterministic protocol/transport evidence above.

## M1b entry condition

Do not start M1b until Jinushi has an accepted implementation/API sufficient to start a non-interactive Run, write stdin, consume stdout/stderr with explicit ordering/gap semantics, inspect/await physical lifecycle, and retire the owned Run. At M1b start, read the then-current Jinushi implementation and contract; do not code from the illustrative schema in old documents.

The original M1b implementation was integrated against Jinushi `90e52ca` while retry-safe submission/control and notifier-driven observation were still incomplete. Those dependencies are now implemented on Jinushi main: #5 provides durable submission identities plus generation-checked request identities, and #8 provides notifier-driven observation and writer ownership. The M1b closure scope is therefore to align the existing adapter to the current contract, use the Jinushi retry guarantees rather than a Tsukai-side substitute, rerun focused/full/package verification, and perform live Jinushi + Pi certification when the required local environment is available. Do not begin M2 until that closure evidence is recorded.

## Later milestone invariants

- M2 may add durability/IPC but cannot move process ownership from Jinushi into Tsukai.
- M3 may expose parent-agent tools but lineage alone never grants authorization.
- M4 is a projection/consumer layer and cannot become a second lifecycle authority.
- M5 adapters advertise capabilities; Pi-native evidence is not discarded merely because another harness lacks an equivalent event.
- M6 removes duplicate AgentRun responsibility from Mottainai rather than copying orchestration policy into Tsukai.
