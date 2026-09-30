# M3: scoped agent-facing AgentRun control

Scope: Issue #14. M3 exposes `agent_spawn`, `agent_status`, `agent_wait`, `agent_result`, and `agent_cancel` over the M2 resident owner. It is a thin projection of the canonical RunService. It adds no runtime, lifecycle model, scheduler, retry policy, decomposition, evaluation, or prompt policy (Mottainai), and no workspace authority (Nawabari).

## Surface

Agent clients use `connectAgent({ stateDir, agentToken })`. The connection speaks only the five operations; every other operation, including the operator ones, returns `FORBIDDEN`. The operator token file is never read by an agent client.

| Operation      | Canonical mapping                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- |
| `agent_spawn`  | `runs.create` with owner-set `parentRunId` = `spawnedBy` = the authenticated principal    |
| `agent_status` | `runs.get` (full snapshot: lifecycle, recovery, gaps, completeness, execution identities) |
| `agent_wait`   | `runs.wait`; aborting or dropping only ends that wait                                     |
| `agent_result` | `runs.result`; retrieval only, `ready: false` until terminal                              |
| `agent_cancel` | `runs.cancel` (idempotent, stable identity)                                               |

A spawned child is a normal durable AgentRun with its own AgentRun ID, Jinushi Run, and Pi session. There is no in-process child execution.

## Authorization model

- The operator (holder of `owner.token`, unchanged from M2) admits root runs and issues a scoped credential for one nonterminal AgentRun: `client.grantAgentControl(id)` / `tsukai run grant <id>`. The secret is shown once; `<stateDir>/authz/grants.json` (0600, atomic) stores only its SHA-256, one active credential per AgentRun. Re-granting rotates; `revokeAgentControl` revokes.
- The credential's principal is that AgentRun. It is valid only while the principal is nonterminal, and each operation re-checks that and the credential's currency (rotation/revocation is immediate, also on open connections).
- A principal controls exactly the runs it spawned: the run's durable `spawnedBy` equals the principal. `spawnedBy` is set only by the owner from the authenticated connection, is validated equal to `parentRunId`, is persisted in the run record in the same commit as the child's identity (no crash window), and cannot be supplied through the operator `create`. A claimed `parentRunId`, an operator-created run with a matching parent, or a known ID grants nothing. Unknown and unauthorized IDs are indistinguishable (`FORBIDDEN`).
- A principal cannot admit an execution profile (#25): `agent_spawn` with `executionProfile` is `FORBIDDEN`, so children keep default deny; profiles are operator-admitted only.
- Authority is not transitive and not recursive: a child gets no credential automatically and the parent does not control grandchildren. Subtree control remains a later feature.
- Restart does not widen authority: both the grant hashes and `spawnedBy` are durable; nothing else confers control.

Limitation: same-user processes can read `owner.token`. Keep it away from agents; only the scoped credential should reach an agent. Isolating an agent from the operator token needs OS-level sandboxing, which Tsukai does not provide.

## Workspace boundary

Tsukai does not authorize filesystem access. A child carries exactly the workspace scope the owner already holds for its parent (`cwd` and `workspaceSessionId`); omission inherits it, and any different value (sub-path, parent path, other session, or a workspace when the parent has none) is rejected with `FORBIDDEN` before anything starts. A different scope needs external (Nawabari) admission through the operator channel.

## M2 composition

Everything resolves through the resident owner's RunService, so reconnect and restart follow M2: the same client reconnects lazily (`agent_spawn` is never auto-retried), the child stays the same AgentRun, reconciliation reattaches by Jinushi Run ID and cursor, and no prompt is resent or process relaunched. `uncertain` and incomplete evidence, recovery gaps, and `ready: false` pass through unchanged. Reported text is not durable (M2), so it is absent after a restart.

## Verification

`test/owner/agent.test.ts` (deterministic fake Jinushi, real file store and IPC) covers spawn independence and identities, the full operation set, cross-run and forged-lineage rejection, waiter vs. run cancellation, canonical cancellation, no re-execution on retrieval, reconnect, owner restart, uncertainty and gaps, workspace non-widening, rotation/revocation/principal end, and credential non-persistence. `pnpm run certify:agent` is the live lane (Jinushi supervisor + certified Pi 0.99.1); without the environment it reports `ENVIRONMENT_BLOCKED` (exit 3).
