# M5: capability-aware multi-harness adapter contract

Scope: Issue #16. M5 generalizes the canonical `RunService` from Pi-only execution to several harness adapters, advertises each adapter's capabilities in machine-readable form, and adds one additional real harness (Claude Code). Ownership is unchanged: Tsukai owns AgentRun identity, lifecycle, resident ownership, durability, scoped controls, and projections; Jinushi owns the process; the harness owns its native session and protocol; Nawabari and Mottainai responsibilities are untouched. The harness layer is not a scheduler, supervisor, workspace authority, or orchestration engine.

## Harness contract

`HarnessAdapter` (`src/contracts/harness.ts`) is the smallest contract the existing service needed:

| Member          | Purpose                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `identity`      | Harness name and pinned version recorded on every run it creates       |
| `capabilities`  | Machine-readable `HarnessCapabilities`                                 |
| `execution`     | The existing `ExecutionPort` (start/resume/retire/detach/dispose)      |
| `harness`       | The existing `HarnessPort` (native bytes to observations + settlement) |
| `validateInput` | Validates the harness's request at the service boundary                |

`createRunService({ adapters })` (and `createHarnessRuntime`) selects the adapter from `input.harness` at create, and from the persisted `snapshot.harness` for every later operation. A run never moves to another adapter: after a restart whose owner lacks the run's adapter (or has a different version), reconciliation marks it `uncertain` with `harness-adapter-unavailable` / `harness-version-mismatch` and never attaches, retires, or relaunches through a different adapter. The single-harness options (`execution`, `harness`, `harnessIdentity`, `validateInput`) remain, so `createPiRuntime` and the M0 mock keep their exact behavior. There is still one RunService implementation.

The byte-duplex execution seam introduced for Pi is now also named harness-neutrally (`DuplexExecution`, `DuplexExecutionPort`); the Pi names remain. The Jinushi port was parameterized by its fixed argv: `createJinushiPiExecutionPort` is unchanged and `createJinushiClaudeCodeExecutionPort` reuses the same Jinushi Run/input/output/receipt implementation.

## Capability model

Every field describes current Tsukai behavior backed by verified harness authority; there are no flags for hypothetical integrations.

| Capability                | Pi 0.99.1                     | Claude Code 2.1.285                      |
| ------------------------- | ----------------------------- | ---------------------------------------- |
| `protocol`                | `pi-rpc-jsonl`                | `claude-code-stream-json`                |
| `evidenceNamespace`       | `pi`                          | `claudeCode`                             |
| `session.identity`        | `before-prompt` (`get_state`) | `after-prompt` (`system/init`)           |
| `prompt.acceptance`       | `acknowledged` (disposition)  | `implicit` (no acceptance response)      |
| `settlement.evidence`     | `pi:agent_settled`            | `claude-code:result`                     |
| `cancellation.abort`      | `native` (`abort` RPC)        | `native` (`control_request` interrupt)   |
| `steer` (tsukai / native) | unsupported / available       | unsupported / unverified                 |
| `followUp`                | unsupported / available       | unsupported / available                  |
| `interaction`             | unsupported / available       | unsupported / available (`can_use_tool`) |
| tools / durations         | reported / reported           | reported / unavailable                   |
| usage / cost              | reported / reported           | reported / estimated                     |
| retry / compaction        | reported / reported           | reported / reported                      |
| `recovery.reattach`       | `output-replay`               | `output-replay`                          |

`tsukai` is what Tsukai does; `native` is what the harness offers, as verified (`unverified` is never treated as available). Cancellation retirement is always `execution-owner` (Jinushi).

## Unsupported features

`runs.steer(id, message)` and `runs.followUp(id, message)` exist only as capability checks: they validate the message bound, look up the run's capability, and reject with `HarnessCapabilityError` (`code: "HARNESS_CAPABILITY_UNSUPPORTED"`, with `harness`, `capability`, and `native`) before any byte reaches the harness. No adapter routes them: one AgentRun is one submitted prompt, and a follow-up would change what the run is. The service refuses an adapter that advertises `tsukai: "native"` for them. `runs.capabilities(id)` throws the same error for a run whose harness advertises none (the M0 mock). The owner IPC exposes `capabilities`, `steer`, and `follow-up` to operators, and maps the error to `HARNESS_CAPABILITY_UNSUPPORTED`; the M3 agent surface is unchanged.

Required interaction is never answered for the agent: Pi `extension_ui_request` and Claude Code `control_request` (`can_use_tool`) settle as explicit errors (`pi-required-interaction-unsupported`, `claude_code_required_interaction_unsupported`) and the execution is retired. Missing usage/cost evidence stays unavailable.

## Pi preservation

Pi remains the reference harness and its adapter code path is unchanged apart from being exposed as `createPiHarnessAdapter`. Pi session identity (`get_state` before the prompt), prompt disposition (`started` only), `agent_end`/`agent_settled` settlement, retry/compaction/tool/usage mapping under `payload.pi`, M2 restart/replay (foreign response recovery), and M3 cancel semantics are unchanged. `test/harness/preservation.test.ts` runs the same Pi transcript through `createPiRuntime` and through the multi-harness runtime and asserts identical harness journal payloads and identical M4 metric values (only the added `provenance.harness` attribution differs). Existing consumers need no migration.

## Additional harness: Claude Code

Authority verified before implementation:

- the installed executable `/opt/claude-code/bin/claude`, `claude --version` = `2.1.285 (Claude Code)`, and its `--help` for every flag the adapter passes;
- `@anthropic-ai/claude-agent-sdk@0.3.285` (the SDK that drives this CLI version; registry integrity `sha512-e98yZH3cWjQ2nSXGxOcx5BrEqG9Y0+CoSoVIN1BaypxT7yGVShdhhH8ROYcJZWqjgiTFyTaN56JQSPJAjarOSg==`), whose `sdk.d.ts` types define `SDKUserMessage`, `SDKSystemMessage` (`init`), `SDKAssistantMessage`, `SDKResultMessage` (`subtype`, `is_error`, `terminal_reason`, `usage`, `total_cost_usd`, `queued_turn_count`), `SDKAPIRetryMessage`, `SDKCompactBoundaryMessage`, `SDKStatusMessage`, and `SDKControlRequest`/`SDKControlResponse` (`interrupt`), and whose `sdk.mjs` spawns the CLI with `--output-format stream-json --verbose --input-format stream-json`;
- live probes of the real CLI: `system/init` (with `session_id`) is written only after the first user message; an `interrupt` `control_request` is acknowledged with a `control_response`; the process stays alive after `result` while stdin is open and exits when stdin closes; without credentials the turn ends with `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`.

Launch (fixed argv, Jinushi-owned, no direct spawn): `claude -p --bare --input-format stream-json --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --permission-mode dontAsk --tools ""`. The prompt is one stream-json user message on stdin, never argv. `--bare` limits authentication to `ANTHROPIC_API_KEY`/`apiKeyHelper` and skips hooks, plugins sync, and `CLAUDE.md` discovery.

Semantics:

- Identity: `system/init` `session_id` becomes `execution.sessionId`; its `claude_code_version` becomes `execution.harnessVersion` and must equal the pinned version, otherwise the run fails with `claude_code_version_mismatch` (no compatibility guessing).
- Prompt receipt is implicit: dispatch is `requested` before the write and becomes `accepted` only when harness output arrives. A restart before any output leaves the run `uncertain` (`prompt-delivery-unconfirmed`) until evidence arrives; the prompt is never resent.
- Settlement: the first `result` record. Success requires `subtype: "success"`, `is_error: false`, and `terminal_reason` absent or `completed`; `aborted_*` is an abort; `queued_turn_count > 0` is an explicit error (automatic continuation); everything else is an error named from `terminal_reason`/`subtype`. `result` text is the reported result, never persisted.
- Cancellation: before settlement, an `interrupt` control request is sent (its acknowledgement proves nothing), then stdin is closed and Jinushi retires the Run. A late cancel after settlement does not interrupt and does not rewrite the outcome.
- Observations (under `payload.claudeCode`): `harness.session`, `harness.message` (block types, model, stop reason, error kind), `harness.tool` (`tool_use` id/name, `tool_result` id/`isError`), `harness.result`, `harness.retry` (`system/api_retry`), `harness.compaction` (`compact_boundary`, `status` with a compact outcome), `harness.state`, `harness.native`. No text, thinking, tool input, or tool output is recorded. Result usage/cost are recorded only for non-error results (error results may carry zeroed values, which are not evidence).

## Observation and provenance

The journal envelope is unchanged. Harness-native detail remains under the adapter's `evidenceNamespace`. M4 projections compute Pi/mock metrics exactly as before and Claude Code metrics from `claudeCode` evidence: tool calls/errors, result token usage, the latest cumulative cost estimate (never summed), retry attempts, and compaction starts/failures. Claude Code reports no tool duration, no total token count, and no retry outcome; those metrics stay `unavailable`. Every harness-sourced metric and timeline event carries `provenance.harness`. Replay accepts `claude-code` snapshots and the `harnessVersion` binding field. No Pi events are synthesized for other harnesses.

## Durability

The persisted snapshot already records `harness.name`/`version`; the binding adds the optional `harnessVersion` and keeps the native `sessionId`. Nothing else was added to durable state and the metadata-only defaults are unchanged. Restart does not switch harness, duplicate execution, replay a prompt, fabricate a session identity, or fabricate observations.

## Verification

- `test/harness/contract.ts` is the reusable cross-harness contract; `test/harness/contract.test.ts` runs it unchanged for Pi and Claude Code over one multi-harness RunService, a real file store, and a Jinushi-shaped fake that speaks each protocol: machine-readable capabilities, independent AgentRun/Jinushi Run/session identities, fixed argv without prompt, settlement-before-exit finalization, explicit error mapping (Claude Code uses the captured credential-free transcript), native abort plus retirement, waiter-vs-run cancellation, explicit unsupported controls with no harness contact, restart recovery without prompt replay, refusal to switch adapters on restart, projection provenance and live/replay agreement, unavailable-not-zero metrics, and metadata-only journals.
- `test/claude-code/adapter.test.ts` covers the captured real transcripts (`test/claude-code/fixtures/claude-code-2.1.285/`, credential-free, cwd/model replaced by placeholders), result mapping, retry/compaction mapping, framing/malformed/oversized/control-record rejection, the interrupt control round trip, the one-user-message rule, version pinning, required interaction, implicit-receipt uncertainty across restart, and late cancel.
- `test/harness/preservation.test.ts` covers Pi-native preservation and the capability/unsupported operations across the owner IPC.
- `pnpm run certify:harness` (needs `TSUKAI_JINUSHI_STATE_DIR`, `TSUKAI_JINUSHI_WORKSPACE`, `TSUKAI_CLAUDE_CODE_EXECUTABLE`; the certified Pi is resolved as in M1b) runs agent-run, cancel, and owner-restart lanes against a real Jinushi supervisor with real Pi and Claude Code processes. Without the environment, lanes report `ENVIRONMENT_BLOCKED`. Provider-backed success-path certification of either harness remains `ENVIRONMENT_BLOCKED` without credentials; Claude Code success-path semantics are covered only by fixtures shaped from the SDK types.

Limitations: steer, follow-up, and interactive input are not routed for any harness; Claude Code tool durations are not observable through stream-json; the Claude Code version is pinned exactly; certification ran on the Linux Jinushi backend.
