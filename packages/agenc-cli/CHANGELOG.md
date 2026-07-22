# @tetsuo-ai/agenc-cli

## 0.3.0 (unreleased candidate)

### Release coordination

- Align generated projects and runtime dependencies on the coordinated
  revision-5 candidates: `@tetsuo-ai/marketplace-sdk@^0.12.0` and
  `@tetsuo-ai/agenc-worker@^0.2.0`. `agenc promote` now selects compatibility
  from the finalized on-chain surface revision: revision 4 accepts only the
  published client set, while revision 5 accepts only the coordinated candidate
  train. Both directions of client/program skew fail, and install hints follow
  the detected revision instead of always pointing at SDK 0.12.0. Store-core
  0.6.0 and 0.6.1 are distinguished exactly because they sit on opposite sides
  of this pre-1.0 wire cutover. Directly installed protocol artifacts are also
  gated (`0.3.x` on revision 4, `0.4.x` on revision 5), because their IDL and
  generated types describe different write wires. The new programmatic
  `SUPPORT_MATRIX_BY_SURFACE_REVISION` export exposes both reviewed sets;
  `SUPPORT_MATRIX` remains as a deprecated revision-4 alias so existing CLI 0.2
  embedders do not break silently. Promotion now also validates every installed
  first-party manifest and its actual dependency/peer ranges, so independently
  admitted version buckets cannot hide an incoherent package pair. Present but
  unreadable/malformed/unversioned manifests fail closed; genuinely absent
  optional packages remain allowed. Revision-5 promotion stays blocked until
  operators capture the real post-upgrade deployment identity, patch it into
  the reviewed table, rebuild/repack, and independently re-audit the CLI.
- Raise the scoped CLI and unscoped alias runtime floor to Node 22.23.1; Node 20
  is EOL and unsupported by the revision-5 package train.
- Generated worker projects and both `agenc dev` backends now retain account
  owner/executable metadata for the worker runtime, so an empty System-owned
  hire PDA is classified as the valid direct-task placeholder without erasing
  the provenance checks used for real `HireRecord` accounts. Generated worker
  account and balance reads explicitly pin `confirmed`, matching marketplace
  discovery and transaction defaults.
- `agenc dev --purge` now delegates the complete stop-and-wipe operation to
  the repository's hardened `localnet-down.mjs --purge` rail and requires that
  child to finish successfully before starting `localnet-up.mjs`. It no longer
  sends a numeric-PID signal or assumes a validator stopped after a fixed
  two-second sleep, so a slow shutdown cannot silently preserve the old ledger.
- Programmatic localnet identity parsing now accepts only the repository's
  version-2 `private-unlinked-fd-v1` evidence and the exact validator argument
  `/proc/self/fd/5`. The former mutable build-path binding is intentionally
  rejected, matching the validator that the hardened localnet rail can emit.
- The unscoped `agenc-cli` alias advances to 0.3.0 with the scoped package. The
  published 0.2.0 pair remains current until the coordinated cutover.
- Make `@tetsuo-ai/agenc-cli/cli` a side-effect-free command API. The `agenc`
  executable now uses a dedicated non-exported bin wrapper, and the unscoped
  alias calls `runCliProcess()` explicitly, so importing an advertised module
  can never print usage or set an exit code.
- Project names now pass through one bounded structural npm-name normalizer
  with npm's 214-character output cap. Hostile or million-character directory
  names no longer trigger chained regular-expression work during scaffolding.
- Generated buyer flows compute the canonical buyer job-spec hash before the
  funded hire, pass it as the required revision-5 `taskJobSpecHash`, and reuse
  the same hash during activation. CLI 0.3.0 therefore must not drive revision-4
  hire/activation writes; the explicit v2 discriminators reject that skew.
- Generated checkout recovery now accepts the SDK's reconciliation-only
  `hiring` token, validates its stable intent digest and canonical 64-byte
  Solana signature shape without rejecting valid shorter leading-zero
  encodings, reuses the exact stored job-spec commitment, and
  delegates retry to `resumeHireAndActivate`. Bare account-state adoption and
  fabricated empty-signature `hireReconciled` progress were removed. Only a
  genuine SDK post-send token is persisted; generic preflight errors abort and
  release the idempotency key for a clean retry. A canonical SDK finalized-
  failure proof explicitly discards the obsolete recovery and debit reservation
  because Solana's atomic execution guarantees that no hire was funded. An
  invalid terminal proof instead enters a permanent non-recovery block and
  retains the conservative debit reservation for manual review.

## 0.2.0

Onboarding-funnel release — a cold machine now gets from `npx` to a settled
4-way split in seconds, with zero toolchain:

### Minor Changes

- **`agenc dev` in-process sandbox fallback (litesvm).** `dev` no longer
  hard-requires a cloned agenc-protocol repo + `anchor build` + a running
  localnet (a 45–60 minute cold wall). When no localnet stack is discoverable
  (or a discovered stack is dead with no tooling to boot it), `dev` falls
  back to the REAL compiled agenc-coordination program run in-process via
  `@tetsuo-ai/marketplace-sdk/testing` — the `.so` ships inside the sdk — and
  runs the SAME bot lifecycle, printing the SAME 4-way-split settlement
  table. The output labels the mode (`mode: in-process sandbox (litesvm)` vs
  `mode: localnet`). New flags: `--sandbox` (force in-process), `--localnet`
  (require the stack; old fail-with-instructions behavior). The sandbox
  stamps the LIVE mainnet protocol fee (500 bps) into its ProtocolConfig so
  the treasury leg is production-truthful. `litesvm` moved from
  devDependencies to dependencies to make the cold path self-contained.
  New root exports: `runDevSandbox`, `SANDBOX_PROTOCOL_FEE_BPS`,
  `GpaSimulator`, `DevMode`; `DevRunSummary` gains `mode` and its `rpcUrl`
  is `null` in sandbox mode.
- **`agenc init` scaffolds a `package.json`** when the project has none
  (name from the directory, `private: true`, `@tetsuo-ai/marketplace-sdk` /
  `@solana/kit` — plus `@tetsuo-ai/agenc-worker` for worker projects — pinned
  inside the VERSIONING.md matrix), so `npm install` cannot hoist
  node_modules into an ancestor project and `agenc promote` finds the sdk.
  An existing `package.json` is never touched.
- **`agenc promote` un-poisoned:** the support matrix now accepts MULTIPLE
  compatible minor lines per package, sourced from docs/VERSIONING.md §1.1 —
  sdk `0.8.x` AND `0.9.x` (0.9.0 was previously flagged "OUTSIDE the
  supported 0.8.x line — fails closed", which was false: 0.9.x speaks the
  live wire; batch-2 was additive), store-core `0.5.x`/`0.6.x`. FAIL lines
  now carry actionable hints: `solana-keygen new` for missing wallets and
  concrete RPC guidance. `SUPPORT_MATRIX` is now
  `Record<string, readonly string[]>` and `versionInMatrix` takes the lines
  array (programmatic-surface breaking, pre-1.0 minor).
- Localnet demo parity: the repo's `scripts/localnet-up.mjs` now seeds
  `protocolFeeBps=500` (was 250) to match the live mainnet fee.
- New `./cli` export (`@tetsuo-ai/agenc-cli/cli`) so wrappers — e.g. the
  unscoped `agenc-cli` alias package — can execute the CLI entry directly.

## 0.1.0

Initial release (WP-H6) — `agenc init` / `agenc dev` / `agenc promote`:

- `init`: framework-detected wiring of the current repo (Next.js checkout
  surface over plain-SDK `hireAndActivate`, or an `@tetsuo-ai/agenc-worker`
  worker loop), idempotent with `--force` protection.
- `dev`: localnet-sandbox counterparty bots (buyer `hireAndActivate` with a
  referrer, listing operator, reused agenc-worker runtime as the worker bot,
  buyer accept) ending in the live 4-way settlement split printed from real
  on-chain lamport deltas. Localnet-only; reuses a healthy running stack or
  boots one via the sdk repo's `scripts/localnet-up.mjs` (`--purge` re-boots).
- `promote`: readonly go-live checklist (RPC, wallet, VERSIONING.md pin
  matrix, rent-exemption advisory, receipts), with `--json`.
