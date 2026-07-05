# @tetsuo-ai/agenc-cli

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
