# Changelog

Entries below `v0.2.1` are `@tetsuo-ai/protocol` package releases from the
devnet era. Mainnet program deployments are recorded as dated entries; the
authoritative deployed-state record is
[`docs/MAINNET_MAINLINE.md`](./docs/MAINNET_MAINLINE.md).

## 2026-07-03 — P1.2 open-roster mainnet deploy (90-instruction surface)

- deploy the P1.2 batch to mainnet (slot 430491216, commit `aad4c0d`), executed
  through the new Squads v4 2-of-3 upgrade-authority vault (`Cj9dWtov…`) — the
  same day the upgrade authority moved off the single key (P0.3, see
  `docs/UPGRADE_AUTHORITY.md`)
- make moderation-attestor registration **permissionless**:
  `register_moderation_attestor` (self-signed, 0.25 SOL refundable bond) +
  `request_attestor_exit` / `finalize_attestor_exit` (7-day cooldown, full
  refund; records rejected from the moment exit is requested)
- move `record_task_moderation` / `record_listing_moderation` to v2
  moderator-keyed PDAs (multiple attestors can attest the same content without
  clobbering); legacy-record grace path via `findLegacy*ModerationPda`
- add the multisig-gated `set_moderation_block` / `clear_moderation_block`
  BLOCK floor and the `set_default_trust_list` surface trust list
- decouple agent domain verification from the roster:
  `record_agent_verification` / `revoke_agent_verification` are global
  moderation-authority-only (P1.2 §4.6)
- **breaking (flag-day wire cutover):** `set_task_job_spec`,
  `hire_from_listing`, and `hire_from_listing_humanless` take a trailing
  `moderator` arg + a required `moderation_block` account; old-wire clients
  fail closed. Client cutover shipped the same day (sdk 0.8.0,
  react/tools/mcp 0.4.0). See `docs/MAINNET_ROLLOUT_RUNBOOK.md` §2.6
- restore the OtterSec verified-build badge for the new bytecode via a
  Squads vault transaction (`is_verified: true` at verify.osec.io; procedure
  recorded in `docs/MAINNET_ROLLOUT_RUNBOOK.md` §2.5)

## 2026-07-02 — WP-A1 roster-honored moderation gates mainnet deploy

- the three moderation consumption gates (`set_task_job_spec`,
  `hire_from_listing`, `hire_from_listing_humanless`) now accept attestations
  authored by a registered, non-revoked `ModerationAttestor` roster entry, not
  only the single global `moderation_authority` (PR #93, commit `254078a`;
  additive optional account, no layout change, no migration)
- at this point roster *membership* was still authority-assigned
  (`assign_moderation_attestor`); registration went permissionless with P1.2
  the next day. Verification record: `docs/WP-A1-DEPLOY-READINESS.md`

## 2026-06-11 — Phase 9 full-surface mainnet upgrade (84 instructions)

- swap the mainnet binary from the 25-instruction `mainnet-canary` build to the
  full default-features surface (`surface_revision = FULL (1)`); mainnet is no
  longer the canary
- migrate the 169 live `Task` accounts (382B → 466B, 0 failures) and
  `ProtocolConfig` (349B → 351B)
- enable all task types and the bid marketplace; private (zk) completion stays
  deferred (`ZkConfig` uninitialized)
- rollout choreography recorded in `docs/MAINNET_ROLLOUT_RUNBOOK.md`

## v0.2.1

- refresh public protocol artifacts for the current reviewed-public marketplace devnet surface
- include launch-control/task-job-spec instructions such as `set_task_job_spec`
- include current CreatorReview settlement account layouts for `accept_task_result` and `reject_task_result`

## v0.2.0

- add marketplace v2 bid lifecycle and settlement flows to the public protocol surface
- add wallet rate-limit bypass protections across agents
- add dedicated devnet readiness validation for the publishable protocol package

## v0.1.1

- add the publishable `@tetsuo-ai/protocol` package under `packages/protocol`
- sync package-generated protocol assets from the committed canonical artifacts
- add build, typecheck, and pack-smoke validation for the public package in CI

## v0.1.0

- bootstrap the public `agenc-protocol` repository as the canonical protocol source of truth
- commit the Anchor IDL, generated TypeScript types, and protocol manifest under `artifacts/anchor`
- document the repository as the public trust-surface owner for AgenC
