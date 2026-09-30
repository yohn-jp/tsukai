# Tsukai architecture

Status: design baseline, 2026-09-27; product-semantics authority. This document defines the target architecture. Implementation state is recorded in `IMPLEMENTATION.md`: M0 through M5.5 are merged on `main`, and M6 (Mottainai adoption, #17) remains. Capabilities described here for M6 are not claims of existing implementation.

## 1. Purpose and boundaries

Tsukai is the local Agent Run lifecycle and observation layer. A human, Mottainai, or an authorized parent agent can create an independently executed agent run, observe it, wait for it, retrieve its result, and request cancellation through the same semantic API.

| Owner | Responsibility | Explicit exclusion |
| --- | --- | --- |
| Tsukai | AgentRun identity, lineage, semantic lifecycle, harness binding, result, observation | Task decomposition, model inference, physical process supervision, workspace grants |
| Mottainai | Task decomposition, assignment, scheduling, context/prompt policy, evaluation | Duplicate Tsukai run registry or Jinushi supervisor |
| Jinushi | Process-tree ownership, stdio/PTY, limits, physical observation, termination, reconciliation, receipt | Agent meanings or task-success judgment |
| Nawabari | Workspace/session/filesystem authority and its admission contract | Agent reasoning, result evaluation |
| Harness | Model/tool loop, native session, native events | Tsukai identity or cross-product authority |

These are target integration boundaries, not assertions that all current neighboring implementations have already migrated. Initial Tsukai development does not edit or import Mottainai internals, modify Jinushi/Nawabari, or require their unreleased code.

## 2. Deployment and packaging

```text
Human / Mottainai / authorized Pi tool extension
                    |
              Tsukai SDK client
                    |
          Tsukai local runtime owner
          |          |            |
     Run service  Observation  Journal/projections
          |          ^
       Harness adapter -----------+
          |                       |
     Execution port <---- physical evidence
          |
       Jinushi -------------------+
          |
    +-----+------------------+
    |                        |
Pi RPC process A       Pi RPC process B
    |                        |
workspace A            workspace B
    ^                        ^
    +--- admitted through Nawabari ---+
```

TypeScript SDK is the public programming surface; process isolation is a separate deployment decision. The runtime owner never shares a process with real harness instances. Production execution is delegated to Jinushi. Pi is started with an argv array equivalent to `pi --mode rpc`, ordinary pipes rather than PTY, and explicit admitted cwd/configuration.

There is one writer/controller for a managed run. Jinushi owns the process and its byte transport; the Tsukai harness adapter is the sole RPC command writer and response correlator. UI, CLI, and parent agents subscribe to Tsukai projections, not competing readers/writers on Pi stdin/stdout. A Jinushi execution ID is not itself an attachable pipe: the real adapter must compose Jinushi's actual input/output and cursor contracts.

The target owner is resident and local, with local authenticated/OS-access-controlled IPC. Owner restart recovery requires durable state and reconciliation. The M0 mock preview instead hosts an ephemeral owner in one SDK/CLI process and declares that limitation; the resident owner is the M2 path (see `M2-OWNER.md`).

Ship one package, `tsukai`, with internal domain, application, observation, and adapter modules. Public SDK and a thin CLI are projections of the same service. Do not pre-create one package per layer or implement other harness adapters before Pi integration is proven.

## 3. Identity and cardinality

`AgentRun` is one submitted unit of agent work and one execution attempt. It is not the Pi conversation/session, a single turn, an OS PID, or a Jinushi Run.

A run contains a generated opaque `runId`, optional immutable `parentRunId`, harness identity/version, bounded caller metadata, lifecycle/revision, semantic observation, optional physical execution binding, optional workspace binding, and result/receipt references.

After successful launch, one AgentRun binds to one dedicated Jinushi Run and harness process. Pre-launch failure legitimately has no execution binding. A process is not reused for a second AgentRun. Multiple tool subprocesses inside that harness are not additional AgentRuns. Retrying a failed workload creates a new AgentRun; it never resurrects a terminal one. A future explicit Pi-session continuation can reference earlier conversation state without reusing run identity.

Use explicit names such as `agentRunId`, `executionRunId`, and `workspaceSessionId` across boundaries. Pi `sessionId` and optional source turn/tool identifiers are observations, not authority tokens. PID is never a public destructive-control target.

Parent must exist in the same runtime and be nonterminal when a child is created. Parent links cannot be changed and cannot form cycles. Parent completion/cancellation does not automatically complete/cancel children. Children have independent execution lifetimes; explicit subtree control is a later feature. Metadata such as Issue, repository, worktree, or Mottainai task reference is correlation only.

## 4. Lifecycle, activity, and results

Do not flatten physical and semantic state into one guessed status.

- Lifecycle: `accepted`, `starting`, `running`, `stopping`, `reconciling`, `uncertain`, `terminal`.
- Semantic evidence: `pending`, `active`, `settled`, `failed`, `aborted`, `unknown`.
- Terminal outcome: `completed`, `failed`, `cancelled`, `interrupted`, with a machine-readable reason.
- Activity: observed model output, tool execution, retry, compaction, explicit input wait, idle, or unknown; it is a projection, not the lifecycle authority.
- Physical execution: backend identity, status, capabilities, and eventual receipt; preserve unavailable/uncertain evidence.

Normal flow is accepted -> starting -> running -> stopping -> terminal. Startup failure may go directly to terminal only after absence/termination of owned execution is established. Observation loss enters reconciling/uncertain, never assumed completion. Uncertain is not terminal; later authoritative evidence may resolve it. Terminal outcome is immutable.

`completed` means the submitted harness operation settled normally and required physical retirement was proven. It does not mean correct code, green tests, accepted review, or task success. Final assistant output is a reported result, not independently verified truth.

The owner serializes semantic settlement, cancellation, physical evidence, and finalization. The first accepted semantic settlement or user-cancel intent determines the semantic outcome candidate. A later cancel after normal settlement only accelerates cleanup; it does not rewrite completed work as user-cancelled. Unexpected termination before adequate semantic evidence is `interrupted`; an explicit harness error is `failed`. Preserve physical exit/forced-cleanup facts separately even when a normal semantic result already exists.

Record the outcome candidate, request retirement through the execution port, then finalize after the backend proves terminal execution. Pi can remain alive after its agent operation settles. Do not invent a Pi RPC `shutdown` command. Use Jinushi's supported retirement/termination sequence; distinguish normal-result cleanup from user cancellation. Acknowledging Pi `abort` or delivering a signal proves neither process-tree termination nor terminal Tsukai state.

`wait` resolves on terminal or explicit uncertainty, or reports wait timeout/AbortSignal cancellation. Cancelling a waiter does not cancel the run. Run cancellation is explicit, idempotent, and applied to stable run identity. Repeated result retrieval cannot rerun a workload. Retrieval before terminal returns a typed not-ready result rather than a fabricated empty success.

## 5. Application surface

Initial semantic operations are `runs.create`, `get`, `list`, `children`, `wait`, `cancel`, `events`, and `result`. `create` accepts a harness-specific request behind validated boundaries, caller metadata, optional parent, and explicit workspace configuration. Lists/history are bounded and paged/cursored. Unknown IDs are explicit not-found errors.

Creation must register run identity and establish event subscription before starting work, so the first event cannot race ahead of registration. A production durable owner persists intent before requesting external start and persists the binding before acknowledging successful establishment. The adapter must verify backend start reconciliation/idempotency behavior; ambiguous start is uncertain and must not be blindly retried into a second process.

The package may expose a service factory with injected execution, harness, and store ports. Core never imports Pi session implementation or Jinushi transport details. Transport DTOs are validated at adapters. Public snapshots/results are immutable copies, not writable internal records.

Pi integration can expose `agent_spawn`, `agent_status`, `agent_wait`, `agent_result`, and `agent_cancel` as a thin tool extension. The extension requests Tsukai operations; it does not own a hidden child-agent runtime. Tool wiring and process isolation are not alternatives: an extension may request independently supervised child processes.

`create` may also carry an immutable, caller-admitted execution profile (provider, model, admitted tools, admitted harness extensions such as governance guards). The caller owns that policy; Tsukai validates it against the selected adapter's advertised configurability, binds it to the AgentRun at creation, projects it deterministically into the harness-native invocation submitted to Jinushi, and persists its safe identity so restart cannot change it. The profile is not an argv, environment, or workspace escape hatch: it cannot set cwd or widen the separately admitted workspace. Omitting it keeps default deny (no tools, no extensions). See `M5.5-PROFILE.md`.

An authorized parent receives access scoped to its allowed runs and workspace permissions. Lineage alone does not confer authorization. Do not give an agent an unrestricted control token for every runtime run. Automatic task decomposition, recursive scheduling, policy-driven retries, prompt construction, and judging results remain outside Tsukai.

## 6. Pi integration contract

The first production protocol is Pi RPC JSONL over stdin/stdout. `stderr` is diagnostic data, never protocol input. No TUI scraping and no promise of attaching to an unrelated existing interactive Pi process.

The upstream RPC documentation distinguishes prompt acceptance, low-level `agent_end`, and fully settled `agent_settled`. `agent_end` may precede retry/compaction/queued continuations. `agent_settled` still requires checking final success/error/abort evidence; it does not alone certify success. A prompt response with `success: true` is acceptance, not a completed task. [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

Pin and record the tested Pi package/version and a completion-mapping contract. The current upstream package source uses `@earendil-works/pi-coding-agent`; do not copy an obsolete package name from conversation history. Reject or explicitly mark unsupported versions rather than implementing a speculative fallback based on silence. [Package source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)

Parse UTF-8 incrementally. LF is the record delimiter; optionally strip a preceding CR. Preserve Unicode separators inside strings. Bound record bytes and queued input; reject malformed/oversized frames without fabricating observations. A chunk is not a record. Commands require request IDs, bounded pending requests, and rejection/cleanup on transport termination.

Turn/message/tool/retry/compaction/usage events are native evidence mapped to a small stable observation vocabulary. Keep supported native fields behind namespaced, validated payloads rather than forcing every harness detail into the common model. Do not invent IDs that appear to be source-native; locally assigned indexes must be identified as such.

Queue/steer/input UI interaction is supported only when implemented and advertised by the adapter. Unsupported required interaction produces an explicit blocked/unsupported result, never automatic approval. SDK embedding inside a separately supervised custom worker remains a possible future adapter, not another initial implementation.

## 7. Observation and recording

An observation envelope contains `schemaVersion`, `runId`, per-run monotonic `seq`, `source`, optional source cursor/identity, `kind`, source time when available, receive time, and a bounded validated payload. Backend and harness versions belong to provenance. The owner assigns sequence after ingestion; wall-clock timestamps do not define causal order across independent sources.

Maintain an append-only accepted-event stream and deterministic projections. A known duplicate source cursor cannot count usage twice. Replayed sources must have cursor/identity support; sources without it must not claim exactly-once continuity. Explicit gaps/truncation identify the missing interval or retained-from watermark. Persist before projecting/publishing in a durable deployment; disk/append failure is not a successful record.

Retain bounded event history and bound each subscriber queue. Slow consumers may receive an explicit history gap or stream error, never cause unbounded buffering. Validate imported journals before projection. Replay only reconstructs observations; it must not execute tools, spawn workers, send prompts, or reproduce external side effects.

Default recording is metadata-only: lifecycle, identifiers, tool names/status, durations, and available usage. Prompt/assistant text, thinking output, tool arguments/results, filesystem contents, and raw stderr are not persisted by default. Explicit local content capture uses a documented allowlist, bounds, and provenance; known credentials/raw environments are always excluded. Metadata-only history is not a lossless transcript. Results may be returned to an authorized caller separately; metadata replay cannot reconstruct discarded result text.

Usage must distinguish per-message deltas from cumulative session totals. Preserve unavailable metrics as unavailable, not zero. Report provider-reported cost or explicitly estimated cost with provenance; do not invent billing accuracy. Repeated reads, retries, idle gaps, or long reasoning are observations, not automatic judgments of wasted work.

Useful projections include fleet status, parent/child tree, execution timeline, tool latency/error counts, available token/cost summaries, retry/compaction counts, and event completeness. Web dashboards, richer profiling, and export integrations are consumers of this model, not additional authorities.

## 8. Failure, recovery, and security

Physical liveness does not prove semantic progress; a quiet agent is not necessarily hung. Collector disconnection does not itself stop an agent. In a production detached execution, owner restart reattaches/reconciles by backend identity and cursor; it does not resend a prompt or relaunch missing work. Lost history remains a gap even if current state becomes known.

Process isolation is not filesystem or security isolation. Run cwd and workspace binding must come from admitted caller/Nawabari configuration. Backend absence or unsupported isolation must be explicit; never silently fall back from Jinushi to direct spawn for production.

Use local OS access control for the owner endpoint. Do not expose an unauthenticated remote HTTP control plane. Treat harness output as untrusted data, including UI rendering and replay imports. Reading an observation is not permission to signal its process or access another workspace. Security-sensitive control and cleanup follow ownership evidence, not labels or arbitrary PIDs.

## 9. Delivery boundaries

M0 is complete on `main`: the mock preview provides real AgentRun lifecycle/projection/recording/replay logic over explicitly synthetic harness events and independently spawned fixed fixtures. Its storage and owner are ephemeral. M0 proves the package contract, not production integration.

Delivery after M0 is gated as follows. M1a through M5.5 are complete on `main`; M6 has not started.

- **M1a — Pi RPC protocol integration:** real Pi RPC framing, command correlation, native-event mapping, settlement semantics, and explicit live transport certification over an injected execution/transport boundary. Any direct Pi spawn is certification/testing infrastructure only.
- **M1b — Jinushi production execution:** bind AgentRun physical ownership to the then-current accepted Jinushi API and certify cancellation/retirement without a production direct-spawn fallback.
- **M2 — resident owner/durability:** local IPC, durable registry/journal, restart reconciliation, explicit uncertainty, and reconnectable clients.
- **M3 — agent-facing control:** scoped parent-agent spawn/status/wait/result/cancel tools over independent AgentRuns.
- **M4 — operator observation:** fleet/tree/timeline/resource/usage consumers and replay/profiling UI.
- **M5 — multi-harness:** add capability-aware harness adapters without reducing Pi-native observation to a lowest-common-denominator schema.
- **M5.5 — admitted execution profiles:** typed, immutable, capability-checked provider/model/tool/extension configuration of an AgentRun; prerequisite discovered in the M6 preflight (#25).
- **M6 — Mottainai adoption:** move AgentRun lifecycle/observation responsibility out of Mottainai while leaving decomposition, scheduling, prompt/context policy, and evaluation there.

`IMPLEMENTATION.md` selects the currently authorized milestone and its acceptance criteria. Completion of one milestone is not authorization to continue automatically into the next.

## Source boundary checked for this design

Jinushi's [runtime contract](https://github.com/yohn-jp/jinushi/blob/505ae003cdb731f97514552acf75e679b89ae771/docs/RUNTIME_CONTRACT.md) separates physical exit from task success, stable Run identity from PID, waiter cancellation from execution cancellation, and proven termination from uncertainty. It also defines bounded I/O and event gaps. Exact integration APIs must be read from the then-current accepted implementation; illustrative JSON in that document is not a frozen wire schema.

Pi's [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) positions RPC for subprocess isolation. Upstream source links are reference evidence, not permission to accept arbitrary future protocol changes without compatibility tests.
