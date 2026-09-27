# M0 code contract

Node.js 24 LTS and pnpm 11.27.0 are the development baseline. `engines.node` is `>=24`.
`src/contracts` defines the C0 shared API. The application factory is named
`createRunService({ execution, harness, journal, limits? })`; it returns `{ runs, dispose }`.
`runs` has `create`, `get`, `list`, `children`, `wait`, `cancel`, `events`, and `result`.
`create` is async; `get`, `list`, `children`, and `result` are synchronous; `wait` and
`cancel` are async; `events` returns an async iterable. Lists use an optional cursor
and limit. The explicit `tsukai/testing` factory is `createMockRuntime()`.

The execution port starts exactly one fixture process per run. Its observer receives
ordered output bytes, physical exit receipts, and transport errors. The harness
decoder turns bytes into normalized observations and one authoritative settlement
signal. The journal assigns per-run sequence numbers and bounds history and live
subscriber queues. A `run.snapshot` observation carries the metadata public
projection after each state transition; reported result text stays outside the
journal. The default export is metadata-only. Unknown metrics remain absent.

Default finite limits are in `src/contracts/limits.ts`; tests may inject smaller
limits. Focused commands: `pnpm run test:domain`, `pnpm run test:observation`, and
`pnpm run test:mock`; `pnpm run typecheck` checks the integrated source. Workers
own their assigned source and test directories only. Integration and package
scripts are completed in C2.
