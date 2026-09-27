# M1b Jinushi contract freeze

Source: Jinushi `origin/main@630592a09e4333d6cb5e89d6e389aad25dc5143d`, protocol v1 (`internal/model`, `internal/protocol`, `internal/ipc`, `internal/supervisor`). Tsukai base: `origin/main@66c5e8314914dccffa2e3ba5c0a45624298f76a4` (M1a PR #3 merged).

The production port sends one noninteractive `run` with Pi RPC argv, an admitted absolute cwd, explicit environment, detached lifetime, and an opaque `agentRunId` correlation. It then uses `input`, `close-input`, `output` offsets, per-Run `events` follow, `inspect`/`await`, and `cancel`. Jinushi Run ID remains physical identity; Pi session ID remains harness identity. A response carries a 1 MiB maximum big-endian length-prefixed JSON payload. Output responses encode at most 65536 bytes as base64 and expose `retainedFrom`/`gap`. Follow frames use event `seq`/`retainedFrom` and stop after terminal or uncertain state. The receipt on a terminal Run is physical evidence; an uncertain Run is not a terminal receipt.

Jinushi [#5](https://github.com/yohn-jp/jinushi/issues/5) is open: protocol v1 has no submission identity or input request identity. Therefore Run creation and input delivery are **single attempt only**. After a sent request loses its response, Tsukai cannot infer whether the effect occurred, retry, or claim a second Run is safe. Such loss is an explicit uncertain transport failure. No correlation label is a substitute for idempotency. `close-input` and `cancel` also receive no invented retry guarantee.

Jinushi [#8](https://github.com/yohn-jp/jinushi/issues/8) is open: current `events` follow is per Run and internally polls every 100 ms. M1b may consume that accepted surface without implementing a competing poller, multiplex watch, or input-writer lease. The port must report history gaps and cannot turn missing output into success.

The local execution port is ephemeral. It does not implement M2 owner durability or recover an ambiguous submission across Tsukai restarts. A live certification against a real Jinushi supervisor and Pi process is distinct from mocked protocol tests.
