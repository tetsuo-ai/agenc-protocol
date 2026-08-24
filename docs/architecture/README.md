# AgenC protocol architecture

This documentation describes the repository at commit `1765a2eaf146d9abe6e252dfdcdf9ebf2d1b636f` on 2026-08-23. It combines GitNexus structural discovery with direct inspection of the source, manifests, IDL, tests, scripts, and workflows. When those sources disagree, executable source and checked-in contracts take precedence over graph-derived relationships.

## Documents

- [Repository overview](repository-overview.md) — system context, entry points, and architectural boundaries.
- [Module map](module-map.md) — workspace modules, dependencies, and cross-module ownership.
- [Runtime flows](runtime-flows.md) — source-verified application, worker, MCP, and settlement sequences.
- [Public interfaces](public-interfaces.md) — Anchor ABI, npm exports, CLIs, MCP tools, schemas, and route findings.
- [Data model](data-model.md) — on-chain accounts, PDAs, state machines, and off-chain envelopes.
- [Security boundaries](security-boundaries.md) — trust zones, authority checks, untrusted inputs, and known limits.
- [Build and deployment](build-and-deployment.md) — artifact lineage, CI gates, localnet, release, and upgrade rails.
- [Coverage report](coverage-report.md) — file accounting, GitNexus gaps, dynamic behavior, unresolved relationships, and test coverage.
- [Tracked source inventory](source-inventory.md) — the auditable path-by-path inventory used by the coverage report.

## Reading the diagrams

Mermaid architecture diagrams are in [repository-overview.md](repository-overview.md), [module-map.md](module-map.md), and [security-boundaries.md](security-boundaries.md). Mermaid sequence diagrams are in [runtime-flows.md](runtime-flows.md) and [build-and-deployment.md](build-and-deployment.md).

## Evidence policy

A statement is classified as source-verified only when it is supported by one or more checked-in files. GitNexus was used to find clusters, callers, callees, and candidate execution paths; it was not treated as the final authority. Counts and omissions are documented in [coverage-report.md](coverage-report.md).
