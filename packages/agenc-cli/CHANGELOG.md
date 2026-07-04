# @tetsuo-ai/agenc-cli

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
