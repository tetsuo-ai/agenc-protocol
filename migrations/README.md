# Protocol Migrations

This directory is the repo-local home for migration notes and helpers.

## Current State

- The live protocol version constants still target version `1`.
- Live instructions: `migrate_protocol` (349B → 351B `ProtocolConfig`,
  zero-init `surface_revision`, multisig, `target_version` still 1) and
  `migrate_task` (382B or 432B → 466B Task, operator/referrer tail
  zero-init). Logic is in
  `programs/agenc-coordination/src/instructions/migrate.rs`.
- One real account migration has executed: the 2026-06-11 `migrate_task`
  sweep of 169 live mainnet Tasks, alongside the full-surface upgrade.
  Contest schema bits live in Task reserved bytes; they are not what
  `migrate_task` writes. `migrations/v1_to_v2.rs` is a template for a
  future `ProtocolConfig` version bump, not a record of that sweep.
- Migration authority lives in this public protocol repo, not in a sibling
  `agenc-core` tree.

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
