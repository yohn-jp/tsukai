# M2: resident owner, durability, and restart reconciliation

Scope: Issue #13. M2 adds the resident local owner, a durable AgentRun registry and metadata-only journal, local IPC, and restart reconciliation. It does not add the M3 agent-facing tools, dashboards, other harnesses, or Mottainai migration, and it does not move process ownership out of Jinushi.

## Ownership and data flow

```text
client (SDK/CLI) --Unix socket + token--> resident owner --> RunService --> DurableStore (disk)
                                                                  |
                                                     Pi harness adapter --> Jinushi port --> Jinushi --> Pi

restart: new owner --> DurableStore --> Jinushi inspect + follow + output --> reconcile --> same AgentRun
```

- The resident owner is the only AgentRun authority in the machine. Clients hold no RunService, no lifecycle logic, and no control authority of their own.
- Jinushi still owns the process, stdio, resource evidence, termination, and receipts. Tsukai never spawns production processes.
- Pi stays the agent runtime. Nawabari and Mottainai responsibilities are unchanged; a `workspace.cwd` remains caller-admitted input, not authorization.
- One state directory has one live owner. The durable store's lock (process-id liveness, stale locks of dead processes are replaced) fails a second owner before it can touch any run.

## Durable state (metadata only)

`createFileDurableStore({ dir })` implements the `DurableStore` seam from PR #7:

- `runs/<agentRunId>.json`: the authoritative projection, written atomically (temp file, fsync, rename, directory fsync) on every state change.
- `journal/<agentRunId>.jsonl`: append-only, fsynced before an observation is projected or published. Journal payloads go through the existing metadata filter, so prompts, assistant text, tool arguments/results, stdout/stderr bytes, and environments never reach disk.
- Persisted per run: identity, parent/lineage, harness identity, lifecycle/semantic/outcome/reason/completeness, the **execution intent** (`startRequested`), the **Jinushi execution binding** (including Pi session identity once observed), the **outcome candidate** (without reported text), cancel intent, retirement requests, prompt **dispatch phase** (`requested`/`accepted`), the **backend cursor** (`eventSeq`, record-aligned `stdoutOffset`, `stderrOffset`), the journal head, and the **recovery** projection (state, epoch, attempts, reason, gaps).
- Also persisted because they are caller inputs to the run projection: caller metadata (already restricted to non-private keys) and the admitted `workspace.cwd`.
- Not persisted: prompt, reported assistant text (so `result()` after a restart has no `reportedText` unless it is re-derived from live output), raw output, credentials, environments. Loading whitelists fields, so injected content is dropped.
- The store directory must be private (no group/other bits). Unsafe run identities are refused as file keys. Corrupt entries are kept on disk and surfaced through `issues()`; a torn journal tail is truncated to the last verified record (evidence kept as `.corrupt-*`).

## Crash-safe ordering

1. Create the AgentRun identity and persist it (`accepted`). A failed commit aborts `create` before anything external exists.
2. Persist the execution **intent** (`startRequested`, lifecycle `starting`).
3. Ask Jinushi to start. The submission identity is derived from the AgentRun identity (Jinushi M1b contract).
4. Receive the Jinushi execution identity.
5. Persist the **binding** in `onEstablished`, which the Pi adapter awaits **before** `get_state` or the prompt is written. If that commit fails, the adapter retires the orphan instead of continuing.
6. Persist dispatch `requested`, then write the prompt. Persist `accepted` after the prompt response.
7. Only then is establishment acknowledged to the client.

Consequences after a crash: intent without binding means the prompt was never written; binding without dispatch means the prompt was never written; `requested` without `accepted` may or may not have reached Pi and is resolved from the stdout stream. Cursors advance only after every earlier frame was applied and committed. Stdout-derived observations carry a stable `sourceIdentity` (`pi:stdout:<end offset>`), so replaying frames in the crash window cannot duplicate a journal record. Retirement requests and the outcome candidate are persisted before the physical request.

## Restart reconciliation

On start the owner loads durable runs synchronously, then reconciles (`service.reconcile()`, repeated on a timer and on the `reconcile` IPC operation). Classification uses only durable facts plus read-only Jinushi evidence; nothing starts a process or sends a prompt.

| Durable fact        | Result                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| terminal            | unchanged (terminal outcome is immutable)                                               |
| no intent persisted | terminal `failed`, `owner-restarted-before-start` (no external start can have happened) |
| intent, no binding  | `uncertain`, `execution-start-unconfirmed-after-restart`; never retried                 |
| binding             | `reconciling`, then attach by Jinushi Run ID and cursor                                 |

Attach (`inspect`, then event follow from the persisted `eventSeq`, stdout re-delivered from offset 0):

- Jinushi `run-not-found` → `uncertain` `execution-missing-from-backend` (never terminal).
- Unreachable, invalid, or contradictory backend → `uncertain` with the reason; retried on later reconciles, so later authoritative evidence resolves it.
- Live → `running` (or `stopping` if the outcome candidate is durable, in which case the persisted retirement decision is re-issued idempotently). If the prompt was never confirmed and no harness activity is observed → `uncertain` (`prompt-not-dispatched` / `prompt-delivery-unconfirmed`). Cancellation remains possible.
- Terminal with a receipt → finalized from the candidate if one is durable, otherwise from frames after the cursor; with no usable classification evidence it stays `uncertain` with the receipt recorded (`physical-exit-with-observation-gap`).

Decoder state is content-derived and therefore never persisted. Instead stdout is re-delivered from offset 0 and frames that end at or before the cursor rebuild the decoder with their signals discarded (they were already settled); responses written by an earlier owner are recognized as foreign and only recover the session ID or prompt acceptance. Frames after the cursor are applied normally. If retained stdout no longer reaches offset 0, the decoder cannot be rebuilt: the gap is recorded, semantic classification is not guessed, and only the physical receipt is tracked.

## Explicit uncertainty and gaps

`RunSnapshot.recovery` exposes `state` (`pending`, `reconciling`, `attached`, `terminal`, `uncertain`), `epoch` (owner restarts), `attempts`, `reason`, and `gaps`. Gaps (`event`, `output`, `journal`, `observation`) only grow; they set `completeness: "incomplete"` even after the current state becomes known, and a `run.gap` observation is journaled. A dropped journal tail or a journal shorter than the last persisted state is a `journal` gap; journal sequence numbers continue from the last verified record and are never back-filled. Missing or unsupported evidence is never translated to zero or success.

Limitations: the durable registry has no retention or garbage collection yet (terminal runs stay until a later milestone; the owner refuses to start if the store holds more runs than `maxRuns` instead of dropping any). Jinushi event history is evaluated when the follow's first page arrives, not synchronously at attach.

Limitations (by the current Jinushi contract): there is no read-only lookup by submission identity or correlation, so a start whose binding was not persisted stays `uncertain` and its orphaned Jinushi Run (idle, never given a prompt) must be retired by an operator; Tsukai does not look up Runs by correlation label because a label is not authority. Jinushi event and output retention bound how much history can be replayed.

## Local IPC

- Unix-domain socket `<stateDir>/owner.sock` (mode 0600) in a 0700 directory, JSONL frames bounded to 256 KiB, bounded connections and in-flight requests. There is no TCP, HTTP, or other network listener. Windows is unsupported and rejected explicitly.
- The owner writes a fresh random token (`owner.token`, 0600) at start. The first frame must be `hello` with that token (constant-time comparison); any other first frame, a wrong token, or silence past the hello timeout closes the connection. The client verifies that the state directory, socket, and token file belong to the current user and are not group/other accessible before sending the token.
- Operations: `create`, `get`, `list`, `children`, `wait`, `cancel`, `result`, `events` (stream), `reconcile`, `status`. A dropped connection cancels only that client's waiters and streams. The client reconnects lazily and retries every operation except `create`, which a caller must resolve by listing after a lost response.
- Errors crossing IPC carry a stable code and message; paths and stacks do not.

## CLI

`tsukai owner serve --state-dir D --jinushi-state-dir D --pi-executable P` runs the resident owner over the Jinushi-backed Pi runtime. `owner status` and `run create|get|wait|result|cancel|list` are thin clients (`create` reads the prompt from stdin). Stopping the owner (`SIGTERM`/`SIGINT`) detaches; it never retires Jinushi-owned executions.

## Verification

- Deterministic crash and restart tests use a durable in-memory Jinushi that outlives owner instances: `test/durable/recovery.test.ts` (intent-before-start, binding interrupted, acknowledgement interrupted, dispatch phases, running/terminal restart, output/event/journal gaps, missing/ambiguous backend, repeated reconciliation), `test/durable/file-store.test.ts`, and `test/owner/owner.test.ts` (reconnect, restart, access control).
- `pnpm run certify:owner` is the live certification. It needs a running Jinushi supervisor (`TSUKAI_JINUSHI_STATE_DIR`, `TSUKAI_JINUSHI_WORKSPACE`, `TSUKAI_JINUSHI_BIN`) and the certified Pi 0.99.1. It runs two owners as separate OS processes: a certification owner whose Jinushi retirement is held by a gate file is killed with SIGKILL after the run's semantic decision is durable, then the real `tsukai owner serve` restarts over the same state. Lane 1 restarts while the Pi process is physically alive; lane 2 lets the Pi process exit through Jinushi while no owner exists. Both assert the same AgentRun and Jinushi Run, the durable decision, the terminal receipt, one Jinushi Run and exactly one prompt/`get_state` response, idempotent reconcile, and no persisted prompt content. Without the environment it reports ENVIRONMENT_BLOCKED (exit code 3). The Pi run is credential-free, so it settles with Pi's explicit provider error (`failed`/`pi_assistant_error`); provider-backed semantic certification remains blocked as in M1b.
