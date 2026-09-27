# Tsukai

Agent Run lifecycle and observation, separate from orchestration and process ownership.

Tsukai owns agent-run identity, parent/child relationships, semantic lifecycle, results, and observation. Mottainai decides what work to do. Jinushi owns physical execution. Nawabari owns workspace authority.

The target is a TypeScript SDK with a local runtime owner and separately managed harness processes. Pi RPC is the first production integration target; Pi is not embedded into the Tsukai owner process.

## Canonical documents

- [Architecture](docs/ARCHITECTURE.md): product boundaries, runtime semantics, integration and observation contracts.
- [Initial implementation](docs/IMPLEMENTATION.md): bounded mock-preview milestone and acceptance criteria.
- [Agent instructions](AGENTS.md): repository execution rules.

## Current status

Architecture baseline only. No implementation, npm publication, or package-name reservation is claimed by this commit.

The first implementation milestone is a working mock-preview SDK, isolated fixture workers, and event recording/replay. It does not certify production Pi/Jinushi integration, durable recovery, or filesystem isolation. The intended npm package and CLI name are `tsukai`; registry availability must be checked at publication time.
