# AGENTS.md — Tsukai

Tsukai owns Agent Run lifecycle and observation. It is not an orchestrator, LLM harness, process supervisor, or workspace authority.

## Authority

1. Latest explicit user instruction.
2. Accepted Issue/Implementation scope; until an Issue exists, `docs/IMPLEMENTATION.md` defines the initial task.
3. `docs/ARCHITECTURE.md`, canonical public types, validators, and tests.
4. This file and applicable organization governance.

Do not reinterpret a settled boundary. Report concrete contradictions; do not invent requirements or silently amend architectural semantics to make implementation easier. An Issue is not required merely to duplicate the initial implementation document.

## Ownership invariants

- Tsukai owns AgentRun identity, lineage, semantic lifecycle, result, and observation projection.
- Jinushi owns production process start, stdio, resource evidence, termination, and physical receipts.
- Nawabari owns workspace/session/filesystem authority. A path or correlation label is not authorization.
- Mottainai owns decomposition, scheduling policy, prompt/context policy, and task evaluation.
- One execution attempt uses one dedicated harness process. A Pi session, AgentRun, and Jinushi Run are distinct identities.
- Pi RPC is the production integration direction. Do not embed multiple real AgentSessions into the owner process.
- Separate semantic settlement, task correctness, physical exit, and cleanup. None implies all the others.
- Cancellation acknowledgement, silent output, stream loss, and `agent_end` are not proof of successful completion.
- Observation cannot grant control authority. Missing/unsupported evidence is not zero or success.

## Implementation

Use TypeScript with strict checking. Keep one npm package with internal modules; do not introduce a monorepo or package-per-layer scheme.

The initial mock backend is explicit and separate from production integrations. Only its fixture execution adapter may spawn its fixed, bundled Node worker. It must not accept arbitrary executable/shell input or claim Jinushi ownership, OS sandboxing, durable execution, or live Pi certification.

Keep untrusted bytes and harness-specific types at adapters. Validate framing and payloads; bound buffers, histories, and subscribers. Never persist credentials or raw environments. Content recording is explicit, not the default.

Prefer existing canonical utilities when materially needed. Do not build a general CLI framework, plugin marketplace, scheduler, provider SDK, or compatibility fallback for this milestone.

## Git and delegation

Use isolated git worktrees and task branches. Do not implement directly on `main`, overwrite another worker's files, reset/stash unrelated changes, or force-push.

Inari is suspended. Do not call any `inari` command. Use `git` and `gh` directly.

The architecture/bootstrap commit on 2026-09-27 is explicitly authorized on main. That exception does not authorize later implementation commits, PR merges, tag creation, npm publication, or Issue closure.

Parallel workers have non-overlapping write ownership. Shared contracts, package metadata, lockfile, exports, and integration belong to the main session. A cap of 20 subagents is a maximum, not a target.

## Verification and publication

The initial implementation must provide `pnpm run verify` and `pnpm run test:package` as specified in `docs/IMPLEMENTATION.md`. Before those scripts exist, do not claim they have run.

Use focused tests during changes, then full verification and packed-consumer tests on the final integrated HEAD. Do not repeat full verification for unchanged files or force every partial worker through an unintegrated package suite.

Distinguish implemented, committed, verified, PR-created, CI-passed, merged, and published. Test mocks do not prove live integrations. Environment-blocked or missing CI is not green.

Finish at the requested boundary. The initial implementation handoff ends with one PR to main. Review, merge, tag, release, and npm publish require separate authorization.
