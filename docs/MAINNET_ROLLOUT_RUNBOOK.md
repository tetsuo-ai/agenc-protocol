# MAINNET ROLLOUT RUNBOOK — full-surface upgrade

> **STATUS: COMPLETED (2026-06-11).** The Phase 9 full-surface upgrade has been
> executed on mainnet. At that moment the live program became the **full
> 84-instruction surface** (`surface_revision = FULL (1)`, all task types enabled,
> bid marketplace live, `ZkConfig` deferred). Later additive deploys grew the
> surface to 90/94/96/**99** ix — see [`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md)
> for **current** live state. This document is retained as the **historical
> choreography and record** of the Phase 9 rollout; it is no longer a pending plan.
> The §0/§1 numbers below have been corrected to the as-executed values (169 tasks
> migrated, ~1.95 MB binary, ~7.15 SOL permanent extension).

Operational runbook that was used to upgrade the live mainnet `agenc-coordination`
program from the restricted **25-instruction canary** surface to the full
**84-instruction** surface. This was the Phase 9 on-chain upgrade. It was
**irreversible** and **human-run**; this document is the choreography, not an
authorization.

> Source of truth for layout/version semantics: [`VERSIONS.md`](./VERSIONS.md).
> Branch-of-record policy: [`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md).
> Authority-signed mainnet POLICY mutations (fees, rate limits — config changes, not deploys): [`POLICY_CHANGES.md`](./POLICY_CHANGES.md).

---

## 0. Pre-upgrade live state (the state this rollout started from, 2026-06-11)

> Historical: these were the values **before** the upgrade. They are no longer the
> live state. Post-upgrade live values are recorded in §6 and `MAINNET_MAINLINE.md`.

| | Value (pre-upgrade) |
|---|---|
| Program ID | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Upgrade authority | now a **2-of-3 multisig** (`Hcecp…` / `BXDan…` / `4QcKB…`) |
| Live binary | 921,016 B (canary build, `--features mainnet-canary`) |
| Live ProtocolConfig | OLD 349-byte layout (pre-P6.5, no `surface_revision`) |
| Live Task accounts | **169**, at 382-byte (pre-Batch-2) layout |

The full-surface binary as deployed is **1,948,384 B** (~1.95 MB, size-optimized;
sha `ea2fa92f…`).

---

## 1. Cost (as executed against live mainnet rent)

Solana rent = `(128 + bytes) × 6960` lamports; verified with `solana rent`.

| Item | SOL | Nature |
|---|---|---|
| Current ProgramData rent (already funded, pre-upgrade) | 6.41147544 | already locked |
| **Permanent extension top-up** (to fund the ~1.95 MB binary) | **~7.15** | **locked forever** (recoverable only by closing the program) |
| Upgrade buffer rent | — | **temporary — refunded** to the payer after the upgrade |
| Write/upgrade tx fees | ~0.015 | permanent |

- **Net permanent spend:** ~**7.15 SOL** (the ProgramData rent increase) + fees.

`solana program deploy --program-id <ID>` auto-extends ProgramData (result <
the 10 MiB `MAX_PERMITTED_DATA_LENGTH` ceiling). Pass `--no-auto-extend` only if
extending manually first.

---

## 2. Pre-deploy gates (do these BEFORE spending a lamport)

These are the gates the repo declares mandatory-before-mainnet
([`CLAUDE.md`](../CLAUDE.md) → "Gates STILL required before any mainnet deploy").
Whoever runs this rollout is accepting the risk of any gate they choose to skip;
record that decision here before proceeding.

- [ ] **Code is clean at 0 warnings.** `cargo build-sbf` (full, default features)
      emits **0** stack-frame warnings. (The `cancel_task` SBF frame UB is fixed —
      box of `token_escrow_ata`/`reward_mint`. Re-verify after any program change.)
- [ ] **Internal money-path review** complete and any confirmed findings fixed
      (settlement/refund/escrow/bond/dispute/referral). This is the in-house
      substitute if the external professional audit is being skipped — **note
      explicitly here that an external audit was/was not done.**
- [ ] **Upgrade authority is multisig** (P8.5). An irreversible upgrade under a
      single key is a single point of failure; move authority to a threshold
      multisig before the deploy if at all possible. (As executed: a **2-of-3
      multisig**, `Hcecp…` / `BXDan…` / `4QcKB…`.)
- [ ] **Rehearsed on devnet/localnet** against a ≥169-task clone — see §4.
- [ ] **Authority funded** for the upgrade (§1).
- [ ] **§11.5 go/no-go** decision recorded (business gate; owner's call).

---

## 2.5 Verified-build invariants (added 2026-07-03 — the badge is live, keep it)

The program is VERIFIED on explorers: the otter-verify PDA (written by the
upgrade authority, tx `3VeYCWspYQv4yvtHFTtxGrC23SQHbQkXKwLqtS8P9JVUc6Y2muUWNdRdnU2ovgQM6ykUVScrfHx9inVWseYpYLXf`)
maps the live program to `github.com/tetsuo-ai/agenc-protocol` @ the deployed
commit, `--library-name agenc_coordination --mount-path
programs/agenc-coordination`. Every future deploy MUST keep two invariants or
the badge silently flips back to unverified:

1. **Build the deploy artifact reproducibly.** The dockerized build is the
   canonical one (`solana-verify build --library-name agenc_coordination
   programs/agenc-coordination`); a plain local `anchor build` reproduced the
   same hash for the c38874c artifact, but verify BEFORE deploy:
   `solana-verify get-executable-hash <the .so you will deploy>` must equal
   the hash of the dockerized build at the release commit. Keep
   `programs/agenc-coordination/Cargo.lock` committed — verification fails
   without it.
2. **Update the PDA to the new commit right after the upgrade.** The
   uploader must be the CURRENT upgrade authority — since P0.3 that is the
   Squads vault, so the keypair-based
   `verify-from-repo --keypair <upgrade-authority>` path no longer applies.
   **Squads-era procedure (as executed 2026-07-03, restoring the badge after
   the P1.2 upgrade missed this step):**
   1. Reproduce + compare (read-only): `solana-verify verify-from-repo --url
      <RPC> --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
      https://github.com/tetsuo-ai/agenc-protocol --commit-hash <deployed
      commit> --library-name agenc_coordination --mount-path
      programs/agenc-coordination` — hashes must match before any signing.
   2. `solana-verify export-pda-tx <repo-url> --program-id <PID> --uploader
      <vault> --commit-hash <deployed commit> --library-name
      agenc_coordination --mount-path programs/agenc-coordination` →
      a base58 legacy TRANSACTION. Decode it, DROP the ComputeBudget
      instruction (CPI-illegal inside a vault execute), and re-serialize the
      remaining otter-verify instruction as a Squads `TransactionMessage`
      (num_signers=1/writable, keys = [vault, otter PDA, system, program,
      otter-verify program], u8/u16 SmallVec length prefixes).
   3. Fund the vault with ~0.01 SOL (it pays the otter PDA rent), then
      `squads-multisig-cli vault-transaction-create --vault-index 0
      --transaction-message <bytes>` → `proposal-vote --action Approve` × 2
      members → `vault-transaction-execute`. Verify the stored vault tx's
      content (commit string + account set) BEFORE voting.
   4. Re-trigger: `solana-verify remote submit-job --program-id <PID>
      --uploader <vault>` and confirm `is_verified: true` at
      verify.osec.io/status/<PID>.

## 2.6 P1.2 open-roster cutover — a FLAG-DAY, not a compatible upgrade (added 2026-07-03)

When the P1.2 batch deploys, it is a **coordinated availability cutover**. Every
changed instruction fails CLOSED for old-wire clients (adversarial-review
confirmed): `set_task_job_spec` / `hire_from_listing` / `hire_from_listing_humanless`
gained a trailing `moderator: Pubkey` arg (old txs Borsh-EOF) and a required
`moderation_block` account; `record_task_moderation` / `record_listing_moderation`
changed account order + moved to v2 moderator-keyed seeds; `record/revoke_agent_verification`
dropped the optional attestor account. No funds are at risk (everything rejects),
but marketplace publish/hire/moderation is DOWN for any client still on the old
wire until it ships the regenerated 90-ix client. Sequence at deploy time:

1. **P0.3 FIRST.** The BLOCK floor + default trust list lean on the 2-of-3
   multisig; do the Squads custody ceremony before this deploys (do not ship the
   hardenings against an effective 1-of-1). See `docs/UPGRADE_AUTHORITY.md`.
2. Program upgrade (this runbook §3 + the §2.5 verified-build invariants).
3. **Immediately** publish the already-built releases: sdk `@tetsuo-ai/marketplace-sdk`,
   `-react`, `-tools`/`-mcp`, and the store templates (all regenerated on this
   branch, tests green). Minimize the skew window.
4. Redeploy **attest.agenc.ag** on the new client: its writes move to the v2
   seeds; its EXISTING legacy listing records (e.g. attestor `13tuj…`) stay
   consumable through the grace window when its roster PDA is presented (the SDK
   ships `findLegacyTaskModerationPda` / `findLegacyListingModerationPda` for
   exactly this). Confirm a live roster attestation flows end-to-end post-deploy.
5. Announce the breaking wire change ahead of the Moment (the P4.6 deprecation
   contract) so third-party integrators regenerate before, not after.

Full rationale + the adversarial-review addendum: `docs/P1_2_OPEN_ROSTER_SPEC.md` §9.5.

## 3. Deploy choreography — ORDER IS LOAD-BEARING

> The reverse order **bricks in-flight tasks**. The new binary's typed
> `Account<Task>`/`Account<ProtocolConfig>` reject the old on-chain buffers
> (size mismatch) until each is reallocated. `migrate_task` must run while
> `protocol_version == 1`; the version bump is **LAST**. Do not reorder.

1. **Deploy the binary first.**
   ```
   solana program deploy --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
     <full-surface agenc_coordination.so> --upgrade-authority <multisig/authority>
   ```
   At this instant the live 349-byte ProtocolConfig and the 169 382-byte Tasks
   **fail typed reads** — this is expected and is why steps 2–3 follow immediately.

2. **`migrate_protocol` FIRST** (realloc ProtocolConfig 349 → 351, zero-init
   `surface_revision = 0`, top up rent). Call with `target_version == 1` for the
   realloc-only path. Multisig-gated, idempotent. Until this runs, `migrate_task`
   itself cannot resolve the config.

3. **`migrate_task` for ALL 169 tasks** (realloc Task 382 → 466, idempotent,
   order-independent). Pass each Task PDA as a **raw** account (the handler
   deserializes manually so it accepts the 382B legacy layout). Sweep every live
   task; verify count migrated == 169. A task left un-migrated stays unreadable
   by typed clients. (As executed: all 169 migrated, 0 failures.)

4. **Initialize the new full-surface config accounts BEFORE advertising them**
   (audit gap — these have no canary counterpart, so they do not exist on mainnet
   today, and the bid-flow / private-completion instructions fail
   `AccountNotInitialized` until they are created):
   - `initialize_bid_marketplace` (creates `BidMarketplaceConfig`) — required before
     any `create_bid` / `accept_bid` / `expire_bid`. (As executed: initialized — min
     bond 0.001 SOL, no-show slash 10%, 60s cooldown, 50/24h, 20 active/task, 7d
     lifetime. Bid marketplace is LIVE.)
   - `initialize_zk_config` with the **audited mainnet image ID** (creates `ZkConfig`)
     — required before `complete_task_private`. Do NOT reuse a devnet/test image ID
     (see the zkVM image-provenance flag in the audit report). `update_zk_image_id` is
     now M-of-N multisig gated. (As executed: **DEFERRED** — `ZkConfig` was NOT
     initialized at upgrade time, so `complete_task_private` stays OFF until
     `initialize_zk_config` runs with the audited agenc-prover image id.)
   - Verify `ModerationConfig` (`configure_task_moderation`) reflects the intended
     mainnet moderation authority.
   - `initialize_bid_book` is per-task and is created on demand by creators, not here.

5. **Stamp `surface_revision` LAST** via `update_launch_controls` with
   `SURFACE_REVISION_FULL`. This flips `getDeployedSurface(rpc)` to advertise the
   full capability set. Doing this before steps 2–4 complete would advertise
   features over not-yet-migrated or not-yet-initialized state.

6. **Publish the on-chain IDL** for the mainnet cluster to match the now-live
   full surface (`anchor idl upgrade` against the full IDL — NOT the 25-instruction
   canary IDL). See `MAINNET_MAINLINE.md` step 5.

---

## 4. Devnet/localnet rehearsal (required before §3 on mainnet)

Prove the freeze-then-recover cycle at scale before touching mainnet:

1. Boot the localnet stack (`scripts/localnet-up`) with the program loaded at the
   real ID, run the real initializers, and seed **≥169** Task accounts at the
   **382-byte legacy layout** (clone of the mainnet shape).
2. Upgrade to the full binary; confirm typed reads of those tasks now **fail**
   (the freeze).
3. Run `migrate_protocol` then `migrate_task` across all seeded tasks; confirm
   every task's typed `Account<Task>` read **recovers** and decodes.
4. Stamp `surface_revision`; confirm `getDeployedSurface` reports the full surface.
5. Confirm a money-path instruction (e.g. `cancel_task` refund, a settlement)
   works end-to-end post-migration.

The existing `tests-integration/surface-versioning.test.mjs` proves the
per-instruction migration semantics (349→351, 382/432→466, idempotency,
multisig-gating, rent top-up, `surface_revision` stamping) against the compiled
program. The rehearsal extends that to the full 169-task sweep choreography.

---

## 5. Abort / rollback

- **Before step 1 (deploy):** fully reversible — nothing on-chain changed.
- **After step 1, before steps 2–3:** the program is live but typed reads are
  frozen. The forward fix is to complete the migration sweep, not to roll back —
  re-deploying the canary binary would itself require its own migration and is
  not a clean revert. **Do not pause between step 1 and step 3.** Have the
  migrate sweep scripted and ready to fire immediately after the deploy lands.
- **Rent is not recoverable** short of closing the program. Treat the ~7.15 SOL
  as spent.

---

## 6. Post-rollout — as executed (2026-06-11)

- [x] All **169** tasks readable via typed `Account<Task>` (migrated 382B → 466B, 0 failures).
- [x] `ProtocolConfig` migrated 349B → 351B; `surface_revision = FULL (1)`.
- [x] `disabled_task_type_mask = 0` — **all** task types enabled (Exclusive, Collaborative, Competitive, BidExclusive).
- [x] `BidMarketplaceConfig` initialized; bid marketplace LIVE (step 4).
- [ ] **`ZkConfig` DEFERRED** — `complete_task_private` stays OFF until `initialize_zk_config` runs with the audited agenc-prover image id.
- [x] `getDeployedSurface(rpc)` reports the full capability set.
- [ ] Mainnet IDL published and fetchable matches the full surface (the now-live **84-instruction** IDL, not the canary IDL).
- [x] `MAINNET_MAINLINE.md` "Current Mainnet Deployment" updated (scope = full surface).
- [ ] Buffer account refund received by the payer.
- [ ] Published SDK semver compatible with the now-live surface (see `VERSIONS.md`).

_Generated 2026-06-11; rollout COMPLETED 2026-06-11. Re-verify byte sizes and rent against live mainnet before any future run._
