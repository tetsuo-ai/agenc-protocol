# Protocol Migrations

This directory is the repo-local home for migration notes and helpers.

## Current State

- The live protocol version constants still target version `1`.
- One real account migration has executed: the 2026-06-11 task-layout migration
  (schema-0 legacy → schema-1) swept all 169 live mainnet tasks with 0 failures,
  alongside the full-surface upgrade. `migrations/v1_to_v2.rs` remains a template
  for a future `ProtocolConfig` version bump, not a record of that sweep.
- Migration authority lives in the public protocol repo, not in `agenc-core` or other workspace repos.
- `programs/agenc-coordination/src/instructions/migrate.rs` is the source of truth for migration logic when versioned state changes are introduced.

## What Belongs Here

- notes for a real version change
- migration helper scripts
- rollout and rollback guidance tied to a specific protocol upgrade

## What Does Not Belong Here

- speculative future-version templates presented as current guidance
- private-core rollout authority
- generic operational docs that are not tied to protocol migration work

## When A Real Migration Is Added

1. add the migration logic in `programs/agenc-coordination/src/instructions/migrate.rs`
2. update the version constants in `src/state.rs`
3. document the exact upgrade path, verification steps, and rollback plan here
4. update the repo docs that describe version compatibility

Until then, treat this directory as reserved migration authority rather than a template-driven roadmap.
