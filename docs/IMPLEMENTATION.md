# M0: publishable mock preview

## Goal and authority

Implement a functioning, publishable `tsukai` preview in one bounded main session. Its useful behavior is a TypeScript AgentRun service, isolated mock workers, safe event recording, and deterministic replay. It is not an empty name-reservation package and does not perform real LLM work.

`ARCHITECTURE.md` fixes product semantics; this document selects the initial scope. The implementation agent may choose private types, file details, and algorithms inside these boundaries. It may not add production integrations or reinterpret the contract. No separate Issue needs to be created to restate this task.

## In scope

- One TypeScript/ESM npm package named `tsukai`, initial version `0.1.0`, with generated public declarations and a lockfile.
- Strict TypeScript and a supported Node.js LTS baseline, selected and recorded before workers are dispatched.
- Public lifecycle and observation types; an injected-port run service implementing the operations in architecture section 5.
- Explicit `tsukai/testing` entry point with `createMockRuntime`; no automatic mock fallback from a requested real harness/backend.
- One dedicated fixed Node fixture process per mock run, behind a mock execution port. Fixtures use synthetic Pi-shaped events; they are not real Pi processes or a Jinushi backend.
- A bounded in-memory journal, live subscription, metadata-only export, safe import/replay, and deterministic snapshot projection.
- Thin CLI: `tsukai --help`, `--version`, `demo [--json]`, and `replay <journal-path> [--json]`. The demo hosts the ephemeral owner; separate CLI invocations do not control its past runs.
- SDK example, public package-consumer tests, README with capabilities and limitations, and publication instructions.

The root package exports the ordinary SDK/types and observation/replay surface. Testing fixtures and factory are exposed only through the explicit testing subpath. A real Pi or Jinushi request must fail as unsupported in M0. Package imports have no side effects: they do not start workers, contact the network, or write user state.

## Explicit exclusions

No live Pi, Codex, Claude, Gemini, or OpenCode integration; no provider/API credentials; no real Jinushi adapter or changes to neighboring repositories; no production direct-spawn fallback; no Nawabari implementation; no resident daemon, restart recovery, IPC/HTTP server, Web UI, plugin marketplace, Pi tools, distributed execution, Mottainai migration, scheduler, or auto-retry of whole workloads.

The mock worker may simulate native retry events to test observation semantics. This does not authorize a scheduling/retry engine. UI renderers, release automation, and broad organization CI work are not prerequisites for this preview.

## Module/write boundaries

```text
src/contracts/                 shared types and validated protocol shapes
src/domain/                    lifecycle and immutable run projections
src/application/               run service and operation ordering
src/observation/               framing, native mapping, journal, import/replay
src/adapters/mock/              fixed worker transport and mock harness adapter
src/testing/                   explicit factory, fixture worker and scenarios
src/cli/                       thin CLI projections
src/index.ts                   root exports
examples/                      public SDK examples
test/                          corresponding unit/integration/package tests
scripts/                       verification and tarball consumer harness
```

The main session owns shared contracts, root exports, package/lock/config files, CLI, and integration. Each worker owns tests beside its assigned source responsibility. Directly necessary helper/test files inside the assigned area are allowed; file lists are not artificially closed. Cross-area corrections are assigned by the main session, not edited concurrently.

## Fixed execution checkpoints

### C0 — main session: establish the common base

Fetch current `origin/main`, read these documents and AGENTS.md, and confirm no M0 implementation is already accepted or running in another PR. Create `feat/mock-preview` in an isolated worktree. Do not rewrite a newer main from a historical SHA.

Select/record Node and pnpm versions; create package/build/test scaffolding and shared types/ports. Name the service factory and freeze the method signatures and mock transport contract in code before dispatch. Include a documented finite retention/record-size/subscriber limit; tests may inject smaller limits. Freeze test conventions and focused commands as well.

The port contract covers start/binding, ordered input/output, physical observation/retirement, harness observation/settlement, and journal append/read/subscribe. Production adapter APIs are not guessed. Commit this shared base. This is scaffolding evidence, not completed implementation.

### C1 — fixed parallel work, at most 20 subagents total/concurrent

Use three primary implementation workers unless a smaller split is faster. Additional helpers may work only on disjoint subdivisions of these same streams; 20 is a ceiling, not a utilization goal. Every worker has a distinct branch/worktree from the committed C0 base. Do not use sibling uncommitted files as dependencies.

| Stream | Owns | Required proof |
| --- | --- | --- |
| A | `src/domain`, `src/application`, corresponding tests | Lifecycle, lineage, operation ordering, outcome/physical separation, wait/cancel/result semantics |
| B | `src/observation`, corresponding tests | Bounded UTF-8 JSONL, Pi-shaped settlement mapping, journal/subscriptions, privacy, validated replay |
| C | `src/adapters/mock`, `src/testing`, corresponding tests | Distinct fixture processes, deterministic scenario control, input/output/retirement, no arbitrary executable or shell |

Worker cycle: write the acceptance-focused failing test, implement, run its focused tests/type checks, commit, and return SHA plus evidence. Workers do not make independent PRs, change shared contracts/package metadata, merge main, or review/approve the final PR. Unimplemented sibling modules are not a reason for every worker to invent a duplicate dependency.

### C2 — main session: integrate and certify

Integrate the three committed streams into the integration worktree; local merges/cherry-picks of owned worker branches are authorized. Resolve necessary integration corrections without changing architecture. Finish public exports/factories, CLI, SDK example, and packed-consumer harness.

Implement `pnpm run verify` for format/static checks, type checking, build, and all local behavior tests. Implement `pnpm run test:package` to pack the package, install the produced tarball into a clean temporary consumer outside the repository, and execute the public SDK, CLI and declaration tests. It must not resolve unpublished source paths or import private internals. Keep builds and packaging finite and clean temporary workers/files in success and failure paths.

Run focused tests, then final integrated verify and package-consumer tests. Repeat only checks affected by subsequent fixes. Update README with actual support, install/use commands, and limitations. A clean environment must not require Pi, Jinushi, API keys, global tools from a developer profile, or access to another repository.

### C3 — publication handoff and stop

Commit and push `feat/mock-preview`; create exactly one PR to `main` through `gh`. Use any applicable current repository/org PR template; do not invent linked/closed Issues. State verification and actual CI state accurately. If blocked, publish available coherent work as a clearly marked draft with the concrete blocker rather than discarding it or claiming completion.

Do not merge the PR, create a release/tag, publish npm, close Issues, or start the next milestone. Those actions are separate from implementing a publishable package. Report the exact final SHA, tests, tarball contents, package-name check, PR, and remaining limitations.

## Acceptance criteria

1. Importing the packed root/testing entries and type declarations works from a clean consumer. The CLI help/version reports the built package version. No unpublished files or development dependencies are needed at runtime.
2. The public SDK creates multiple mock runs, including a parent/child relationship, retrieves/list/children snapshots, streams events, waits, cancels, and retrieves terminal results. Snapshots cannot mutate service state. A missing ID returns a typed not-found error.
3. At least three overlapping fixtures have distinct actual PIDs/execution IDs. Ending/cancelling one does not terminate the others or the owner. The fixture adapter only starts its bundled worker through the current Node executable. `dispose` performs bounded cleanup of its fixtures; M0 does not claim detached survival.
4. A deterministic normal trace returns a final reported result only after semantic settlement and proven fixture retirement. A crash without settlement is interrupted, never completed. Explicit harness error is failed. A cancellation request is not terminal until the worker has actually ended.
5. `agent_end` followed by native retry/compaction/continuation is not terminal. The synthetic `agent_settled` plus final success/error/abort evidence controls the semantic candidate. Prompt acceptance and quiet output never manufacture completion.
6. Concurrent/repeated cancel is idempotent. Wait timeout/aborted waiting leaves the worker running. Later completion-vs-cancel ordering follows the architecture; final result and outcome cannot be overwritten by late/duplicate events. Parent/child completion and cancellation do not cascade implicitly.
7. Framing handles fragmented UTF-8, multiple records per chunk, CRLF, and Unicode separators inside strings. Malformed/oversized records and truncated final frames have explicit error/gap behavior. Use LF framing rather than a generic Unicode line splitter.
8. Journal order/cursors and live subscriptions are bounded. Known duplicate source identity does not double-count metrics. Retention expiry/slow consumers report gaps or explicit stream errors. Unknown metrics stay unavailable. Version, schema, sequence, and run consistency are validated on imported journals.
9. The recorded metadata stream replays to the same final public projection as the live reducer for the retained complete history. Replay of incomplete history preserves an explicit incomplete state; it never executes commands or creates processes. Default export excludes synthetic prompt/text/thinking/tool-content secrets used by privacy tests.
10. `tsukai demo` shows multiple runs, their relationship, events, terminal results, and explicit mock/ephemeral provenance. For `demo --json`, stdout is the metadata journal as one observation envelope per LF-delimited line; diagnostics go to stderr. `tsukai demo --json > demo.jsonl` followed by `tsukai replay demo.jsonl --json` must work through the installed CLI. Replay reports metadata projections, not discarded result text, and never starts a worker.
11. `pnpm run verify` and `pnpm run test:package` pass on the final integrated HEAD. Tests use deterministic fixture gates/short bounded timeouts rather than long sleeps or live providers. Physical fixture tests and synthetic protocol tests are reported separately from unperformed live Pi/Jinushi certification.
12. README and package metadata clearly describe mock-preview status. Packaging includes compiled worker assets and declarations, excludes secrets/transcripts/temp state, and contains no placeholder-only public API. The final PR is unmerged and npm remains unpublished by this implementation session.

## npm readiness

The intended public unscoped name is `tsukai`. Check `npm view tsukai name version --json` and registry authentication/access when preparing publication. A real registry not-found response means no visible package at that instant; network/auth failure does not establish availability, and an availability check does not reserve a name. If another publisher owns the name, report that fact without renaming this product or overwriting anything.

Prepare a tarball and verify it; never publish as a test. Do not invent credentials or an author/license declaration absent authority. The public package needs genuine functionality rather than an empty reservation: npm's [package-name policy](https://docs.npmjs.com/policies/disputes/) disallows packages with no genuine function used only to reserve a name. Recording/replay and the executable mock SDK are the initial functionality. Actual name acquisition occurs only through a separately authorized successful npm publication.
