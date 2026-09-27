# M1b Jinushi contract freeze

Source: Jinushi `origin/main@44c5003b85442680b28a60cfa0f2e54890b04cc4`, protocol v1. Tsukai originally integrated against `90e52caf5d91c0ece8aeaf343aad2a7ff23bb935`; this freeze supersedes that pre-Wave-2 contract.

The production port sends one noninteractive `run` with Pi RPC argv, an admitted absolute cwd, explicit environment, detached lifetime, and an opaque `agentRunId` correlation. Jinushi Run ID remains physical identity; Pi session ID remains harness identity. Tsukai consumes Jinushi input/output, per-Run event follow, inspect/await, cancel, and terminal receipts without introducing a direct-spawn fallback.

## Retry-safe submission

Jinushi #5 is complete on current main.

Run creation carries a stable caller-generated `submissionId` derived from the Tsukai AgentRun identity. Jinushi durably binds that identity to the accepted specification. A lost response may therefore be retried with the same submission identity without starting a second physical execution. A changed specification conflicts instead of reusing the identity.

Tsukai retries an ambiguous Run submission only with the same `submissionId` and unchanged specification. A second ambiguous failure remains explicit uncertainty.

## Retry-safe physical controls

Jinushi physical mutations require a bounded `requestId` and the current positive `expectedGeneration`. Tsukai serializes Pi stdin writes and uses a stable request identity for an ambiguous retry of the same mutation. Successful mutation responses return the current Run and advance Tsukai's observed generation.

The same rule applies to `close-input` and `cancel`: an ambiguous transport response may be replayed with the same request identity and generation, so Jinushi can return the durable disposition without repeating the physical effect. Stale/conflicting generations remain explicit failures; Tsukai never converts them into success.

## Observation

Jinushi #8 is complete on current main.

Per-Run event/output follow is notifier-driven rather than the former primary 100 ms polling fallback. Jinushi also provides bounded all-Run watch, telemetry follow, explicit history gaps/watermarks, and interactive writer ownership. M1b uses the per-Run event/output surfaces needed for noninteractive Pi RPC and does not add a competing poller.

Jinushi writer ownership also gates physical stdin mutations for the noninteractive Pi path. Tsukai acquires a bounded writer lease around each serialized stdin/close-input mutation and releases it afterward; a lost release remains bounded by Jinushi lease expiry. This does not turn the Pi process into an interactive PTY Run.

## Completion evidence

M1b code closure requires:

- current Jinushi protocol DTOs, including Run generation;
- stable idempotent Run submission;
- generation-checked retry-safe input, close-input, and cancel;
- notifier-driven event follow with explicit history-gap handling;
- ordered stdout delivery and bounded stderr diagnostics;
- semantic Pi settlement remaining distinct from Jinushi physical retirement;
- terminal Jinushi receipt as the physical completion authority;
- focused tests plus `pnpm run verify` and `pnpm run test:package`;
- live Jinushi + Pi certification when the required local binaries/environment are available.

The repository must not claim the final verification/certification items until they have actually run. The former Jinushi #5/#8 implementation blockers no longer gate M1b.
