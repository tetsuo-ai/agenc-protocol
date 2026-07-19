# Auditor Handoff Pack — `agenc-coordination`

> **Status: historical handoff record (assembled 2026-06; partially updated
> through the 2026-07-09 full-surface deploy).** Superseded where it conflicts
> with current state: test counts, upgrade-authority custody (Squads v4 2-of-3
> multisig since 2026-07-03), and verified-build status (OtterSec badge now live)
> have moved on, and the "0 open findings" summary in §4 is historical — the
> 2026-07-16/17 adversarial audit found additional issues the earlier audits
> missed. Its F-1..F-19 remediation queue is now implemented in the pending
> revision-5 candidate; see `TODO.MD` for the remediation record,
> `docs/MAINNET_MAINLINE.md` for the live/candidate split, and `CHANGELOG.md`
> for current validation evidence.

Single entry point for the external security auditor of the AgenC coordination
program. The program **custodies escrow, completion bonds, and reputation stakes**, so
this is a money-safety audit first. Read this file top-to-bottom; every section links
to the ground-truth code/doc.

> **Status of this pack:** AI-assembled (P8.2). Treat it as the handoff material for
> an external audit, not the final external audit report. When a professional report
> lands, it goes under `docs/audit/` with a per-finding remediation log — see
> ["When the report arrives"](#when-the-report-arrives).

---

## 0. The one-paragraph summary

`agenc-coordination` (Anchor 0.32.1, Solana 3.0.13, program id
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, upgradeable) is a Solana escrow +
coordination program for an agent task marketplace. It has **two `#[program]` modules**:
the deployed revision-4 **full** surface (**99 IDL instructions** as of batch-4) and a restricted
**mainnet-canary** surface (**25 instructions**). This handoff was originally written
while the canary was live on mainnet; **as of 2026-07-09 the full 99-instruction
surface is live on mainnet** (`surface_revision = 4`, last slot **431918664**, store +
contest + goods live, `ZkConfig` deferred). The Phase 9 layout migration (2026-06-11)
has long since been executed. See `docs/MAINNET_MAINLINE.md`. The
design goal the auditor should hold the code against is **"money never locks"**: every
escrow has at least one always-available exit (cancel / refund / reclaim / settle), and
those exits keep working even while the protocol is paused. Settlement splits up to four
ways (worker / protocol / operator / referrer) under a **hard 4000-bps combined fee cap
in bytecode** that leaves the worker ≥ 60%. The highest-stakes thing to audit is the
**deploy-gated, irreversible layout migration** of the live `Task` accounts (and the
single live `ProtocolConfig`) — at the time this was written there were 149 live tasks;
the migration was executed 2026-06-11 against the then-169 live tasks (0 failures).

---

## 1. Scope

### In scope (primary)

- **The deployed revision-4 99-instruction surface** — the historical scope of
  this handoff. The current `programs/agenc-coordination/src/`
  `#[cfg(not(feature = "mainnet-canary"))]` module is instead the pending
  98-instruction revision-5 candidate; its authoritative generated inventory is
  `docs/reference/INSTRUCTIONS.md`.
- **The two migrations** — `programs/agenc-coordination/src/instructions/migrate.rs`:
  - `migrate_protocol`: reallocs the single live `ProtocolConfig` 349 → 351B
    (appends `surface_revision`).
  - `migrate_task`: reallocs each live `Task` 382 → 466B (or 432 → 466B), appending the
    operator (Batch 2) + referrer (P6.2) fields.
  These run **once, irreversibly, on mainnet**, multisig-gated. Treat them as the
  highest-severity surface.
- **Money paths**: `completion_helpers.rs` (the 2/3/4-way split + escrow close),
  `bond_helpers.rs` / `post_completion_bond.rs` / `reclaim_completion_bond.rs`
  (25% completion bonds), `dispute_helpers.rs` / `resolve_dispute.rs` /
  `expire_dispute.rs` / `apply_dispute_slash.rs` / `apply_initiator_slash.rs`
  (dispute settlement + slashing), `slash_helpers.rs`, `lamport_transfer.rs`,
  `token_helpers.rs`.
- **Authority / gating**: `utils/multisig.rs` (multisig threshold), `update_*.rs`
  (admin config), `update_launch_controls.rs` (pause + `disabled_task_type_mask` +
  `surface_revision`), the dispute-resolver roster
  (`assign_dispute_resolver.rs` / `revoke_dispute_resolver.rs`) and moderation-attestor
  roster (`assign_moderation_attestor.rs` / `revoke_moderation_attestor.rs`).
- **Moderation gate** (fail-closed): `record_task_moderation.rs`,
  `record_listing_moderation.rs`, and the entry-only gates in `hire_from_listing.rs`,
  `accept_bid` (`bid_marketplace.rs`), `set_task_job_spec.rs`.
- **Version / migration gating**: `utils/version.rs`
  (`check_version_compatible` vs `check_version_compatible_for_exit`).

### In scope (secondary)

- The committed artifacts in `artifacts/anchor/` and `packages/protocol/src/generated/`
  must match the built program (supply-chain: a stale/hand-edited IDL is a risk — see
  `THREAT_MODEL.md`). Regeneration: `anchor build && npm run artifacts:refresh`.
- The TypeScript SDK (`packages/sdk-ts`, `@tetsuo-ai/marketplace-sdk`) account-meta
  derivation for the money instructions (does the client pass the correct required
  accounts so on-chain guards aren't bypassed by a malformed tx?).

### Out of scope / context only

- The **zkVM guest** (`zkvm/guest/`) and `complete_task_private` proof verification are a
  separate proving service (`agenc-prover`); the on-chain side shares
  `execute_completion_rewards`, but the proof system itself is a distinct audit.
- Hosted off-chain rails (indexer, webhooks, moderation attestation service) are not in
  this program; they are operator-side and the "credible exit" property
  (`docs/CREDIBLE_EXIT.md`, when authored) exists precisely so they are *not* trust
  dependencies for settlement.

### Surface counting note (be precise)

The surface this historical handoff audited, and the surface still deployed as
revision 4, has **99 instructions**. The current
`artifacts/anchor/idl/agenc_coordination.json` and
`docs/reference/INSTRUCTIONS.md` describe the pending revision-5 candidate and
contain **98 instructions**; they are not evidence that revision 5 is live. Older
historical docs may say "77", "80", "82", "84", or "90"; those counts are
intermediate milestones (Phase 9 = 84, P1.2 = 90, batch-2 = 94, batch-3 = 96,
batch-4 = 99). `vote_dispute` was **retired** (P6.3) and is absent from both the
live and candidate inventories. The **canary surface is exactly 25** instructions,
enforced by `scripts/check-canary-idl.mjs` (`npm run canary:check-idl`).

---

## 2. Invariant list (what must always hold)

These are the properties the program is built to guarantee. Each cites the enforcing
code; the Batch 1–4 prep doc (`docs/BATCH_1_3_AUDIT_PREP.md`) has the per-invariant test
mapping.

### Money safety

1. **Money never locks.** Every escrow has an always-available exit; the exit paths use
   `check_version_compatible_for_exit` (drops only the `protocol_paused` arm, keeps all
   version-range checks), so in-flight escrow settles even while paused. A pause stops
   only NEW entry. Applied to every unwind + settle/finalize path
   (`cancel_task`, `expire_claim`, `resolve_dispute`, `expire_dispute`, `complete_task`,
   `complete_task_private`, `submit/accept/reject/auto_accept/validate_task_result`,
   `apply_dispute_slash`, `reclaim_completion_bond`, the `RejectFrozen` exits).
2. **Settlement conserves exactly.** 2-way (`worker + protocol == reward`), 3-way
   (`+ operator`), and 4-way (`+ referrer`) all sum to the settlement base to the
   **lamport**; every fee leg is floored independently so the **worker keeps rounding
   dust** (`completion_helpers.rs::execute_completion_rewards` +
   `calculate_combined_fees`). Operator/referrer legs are SOL-only and are added to the
   escrow-balance check and `escrow.distributed`.
3. **The 4000-bps combined fee cap is the binding worker floor.**
   `protocol + operator + referrer ≤ MAX_COMBINED_FEE_BPS (4000)` ⇒ worker ≥
   `WORKER_FLOOR_BPS (6000)`, checked in **bps before any lamport math**
   (`CombinedFeeAboveCap`), enforced at BOTH snapshot time (`resolve_referrer_snapshot`,
   at hire/create) and settlement (`calculate_combined_fees`). Per-leg ceilings
   (protocol/operator/referrer ≤ 2000 bps each) are defense-in-depth.
4. **Fee legs can't be bypassed or redirected.** Operator leg: `complete_task` + all
   dispute payout paths require the seeds-fixed `["hire", task]` `HireRecord` and carve
   the operator from the worker's gross (`MissingOperatorAccount`/`InvalidOperatorAccount`).
   Referrer leg: snapshotted from program-owned `Task`/`HireRecord`, the supplied payee
   re-bound to the snapshot (`build_referrer_leg`: `InvalidReferrerAccount`); no
   self-deal (`ReferrerIsCreator`). A hired task can't be re-routed to the
   (non-hire-aware) manual path (`HiredTaskValidationUnsupported`).
5. **Completion bonds settle deterministically.** 25% Exclusive-SOL bonds; refunded to
   the poster on honest completion, forfeited to the creator/treasury on no-show/loss;
   bond accounts are **required + canonical-PDA-pinned** in `resolve_dispute`/
   `expire_dispute` (a resolver can't omit a forfeit-due bond, and a permissionless
   `expire_dispute` can't strand one). Bonds reject ZK-private tasks (would strand on
   `complete_task_private`).
6. **Checked arithmetic + overflow-checks.** All money paths use
   `checked_add/sub/mul` → `ArithmeticOverflow`; `[profile.release] overflow-checks =
   true` (`Cargo.toml`) is the second layer on the deployed SBF program.

### Migration safety

7. **Append-only layouts; live prefix stays valid.** `Task` 382→466B and
   `ProtocolConfig` 349→351B only **append** fields; the live prefix is unchanged so
   migrated accounts deserialize the new fields as zeroed defaults. `const_assert` pins
   each struct size.
8. **Strict size preconditions; corrupt accounts never grow.**
   `classify_task_migration` accepts only 382 or 432 (else 466=idempotent no-op;
   everything else incl. the 433–465 gap rejected); `classify_config_migration` accepts
   only 349 (else ≥351=idempotent; **350 rejected**). Appended tail is **explicitly
   zero-filled** regardless of `resize` semantics.
9. **Migrations are multisig-gated, version-ungated, idempotent, order-independent.**
   They must run while `protocol_version == 1` (binary-first → migrate → version-bump
   last; reverse order bricks via the version gate). `migrate_task` no longer requires
   `migrate_protocol` to have run first (the `d1b4b82` fix — see §4).

### Authority, trust, anti-abuse

10. **Disputes are accountable, single-resolver (no voting).** The protocol authority OR
    an assigned `DisputeResolver` resolves directly; a reasoned ruling
    (`rationale_hash: [u8;32]` mandatory + bounded `rationale_uri`) is **required** and
    persisted/emitted. `vote_dispute` is retired (advisory-only legacy field unused).
11. **Moderation is fail-closed, entry-only.** `hire`/`accept_bid`/`set_task_job_spec`
    require a publishable attestation (CLEAN | HUMAN_APPROVED, risk ≤ 100, not expired,
    correct authority); `enabled == false` fails closed. Freshness is checked at entry,
    never on settle/exit (so a stale attestation can't lock funds). The attestor registry
    (P6.8) lets the moderation authority deputize additional attestors.
12. **Sybil deterrent.** Fresh-agent reputation 3000 < a single-slash veteran's 4700
    (compile-time `const_assert`), so wipe-and-re-register doesn't out-rank the slashed
    identity; `min_agent_stake` makes a fresh identity cost slashable stake. **Caveat:**
    these apply on fresh `initialize_protocol` (new deploys); raising live-mainnet
    `min_agent_stake` needs a governance follow-up (no setter exists yet — flagged in
    `PLAN.md` P6.7).
13. **Anti-griefing.** No self-hire / no self-bid / no self-referral; price+version
    compare-and-swap on hire; `close_task` capacity decrement can't be skipped; child-PDA
    close binds each account by `owner == program` + discriminator + `.task == task_key`.
14. **State-transition integrity.** Only valid status transitions mutate
    program-owned accounts; terminal states are sticky (no revival/tombstone reuse).

---

## 3. Threat model

The human-readable invariant statement the fuzz harness
(`programs/agenc-coordination/fuzz/`) protects is
**[`docs/audit/THREAT_MODEL.md`](THREAT_MODEL.md)**. Its core invariants (valid state
transitions only; forward-migratable versioned state under explicit migration control;
private-completion payload consistency with the journal model; committed artifacts match
the built surface) are the same ones expanded in §2 above. Read the threat model first;
treat §2 here as its money-path elaboration.

---

## 4. Prior internal adversarial-audit results

All findings below are from internal multi-lens adversarial reviews (each ran a
multi-dimension lens, then an independent verifier). **Every confirmed finding from
those reviews was fixed; 0 were open at that time** — a historical statement: the
2026-07 audit later found new issues the earlier audits missed (see the banner and
`TODO.MD`). This is provided so the external auditor can see what was already probed —
it is NOT a substitute for independent confirmation.

| Review | Surface | Result |
|--------|---------|--------|
| pre-audit + dispute-fix | Batch 1 (operator economics, moderation, exit-safety) + operator-fee dispute bypass | 3 findings (operator-fee dodge on complete / via manual re-route / via dispute) — **all fixed**; re-audit 0 |
| `wy4dkre1z` | Batch 2 (`Task` layout + readers + `migrate_task`) | **0 confirmed** |
| `w51bg7quf` | full completion-bond lifecycle | 3 confirmed (HIGH/MED/LOW) — **all fixed** |
| `w494fwy0p` | `RejectFrozen` lifecycle | 3 confirmed — **all fixed** |
| dispute-bond follow-up | `resolve_dispute`/`expire_dispute` bond disposition | 1 LOW + 1 twin — **both fixed** (required + canonical-PDA-pinned bonds) |
| `wltxprh2y` | docs-grounded Solana/Anchor correctness (8 dims) | 6 clean; 2 LOW — **both fixed** (treasury rent-floor on `execute_proposal`; `overflow-checks = true`) |
| `wwbj8t0s0` → `wjci30gsx` | instruction coverage matrix | program 100% implemented; 40 untested ix → **+94 litesvm tests** added |
| **Phase-6 money-path / migration review** (`d1b4b82`) | P6.1–P6.8 money paths + the two migrations | **2 confirmed majors — both fixed** (0 fund-loss; 8 refuted) |
| Phase-6 decision pass (`1ed851a`) | sybil deterrent + neutrality/challenge posture | sybil deterrent BUILT (revert-sensitive tests); 1 finding reported (live min-stake setter — deferred governance) |

**The two Phase-6 majors (both fixed in `d1b4b82`):**

1. **`migrate_task` was hard-coupled to `migrate_protocol` ordering.** The typed
   `Account<ProtocolConfig>` couldn't deserialize the live 349B config (struct is now
   351B), so a tasks-first sweep failed opaquely (`AccountDidNotDeserialize`) on the
   irreversible mainnet migration. Fixed: `UncheckedAccount` + size-tolerant
   hand-validation; the two migrations are now order-independent (litesvm test
   revert-proven; `docs/VERSIONS.md` names `migrate_protocol` the mandatory first call).
2. **The referrer 4th leg leaked onto the live mainnet-canary surface.** `create_task`
   (a canary instruction) accepted referrer args and would pay the 4th leg on the
   restricted live surface. Fixed: `require_canary_referrer_disabled` fails it closed on
   the canary build (every canary task has `referrer == default`).

Full per-batch detail (commits, regression tests, revert-sensitivity proofs) is in
`docs/BATCH_1_3_AUDIT_PREP.md` (Batch 1–4).

---

## 5. Test inventory

| Suite | Count | How to run | Notes |
|-------|------:|------------|-------|
| Rust unit (full surface) | **300** | `cargo test --lib --manifest-path programs/agenc-coordination/Cargo.toml` | pure-fn invariants, revert-sensitive; verified green this pass |
| Rust unit (`mainnet-canary`) | **219** | `… --features mainnet-canary` | canary gate incl. the referrer fail-closed guard; verified green this pass |
| litesvm integration | **198** | `cd tests-integration && node --test` | runs the **real compiled `.so`** with signed txs; asserts decoded on-chain state |
| SDK (structural + e2e) | **~390** reported | `cd packages/sdk-ts && npm test` | `vitest`; static `it(` grep counts 358, the gate reports ~390 (parametrized cases expand). e2e uses litesvm 1.1.0 (kit-native) |

Additional gates (all clean at HEAD): clippy `--lib -D warnings` on both the default and
`mainnet-canary` profiles; `anchor build` + `npm run artifacts:check`;
`npm run canary:check-idl` (the `mainnet-canary` BUILD's IDL stays at exactly **25**
instructions — note the live mainnet surface is now the full 99-ix build, not the canary);
`cd packages/sdk-ts && npm run sdk:drift` (generated client in sync with the IDL).

**Phase-6-specific litesvm files** the auditor should map to the new invariants:
`referral-fee.test.mjs` (4-way conservation + combined cap + self-deal + SOL-only +
referrer-protection), `rate-hire.test.mjs`, `agent-track-record.test.mjs`,
`surface-versioning.test.mjs` (`migrate_protocol` realloc + `surface_revision`),
`moderation-attestor.test.mjs` / `security-attestor.test.mjs`,
`dispute-accountable-ruling.test.mjs`, `dispute-vote-retired.test.mjs`.

**Coverage caveats (documented, not testable here):** `complete_task_private` (needs a
remote ZK prover); the collaborative-token residual / token slash-reserve leg (minor
optional legs); `initialize_protocol`'s real initializer (needs the upgradeable
ProgramData account litesvm doesn't model — injected in tests). See
`docs/BATCH_1_3_AUDIT_PREP.md` §4.

---

## 6. The deploy-gated migration choreography (the auditor MUST understand this)

The live mainnet program has **149 `Task` accounts** and **1 `ProtocolConfig`**. Phase 6
changes both layouts, so the upgrade is an **irreversible, multisig-gated migration**,
not a hot-swap. The order is load-bearing:

```
1. Deploy the new program binary FIRST (full surface), protocol_version still == 1.
   - Both migrations are version-UNGATED so they can run at version 1.
2. migrate_protocol  — realloc the single config 349 -> 351B, zero-init surface_revision.
   - MANDATORY FIRST data call (docs/VERSIONS.md). Idempotent.
3. migrate_task (dry_run=true) across ALL 149 tasks — prove every post-image deserializes
   WITHOUT mutating. Then migrate_task (dry_run=false) sweeps all 149 (382/432 -> 466B,
   zero-filled tail, rent topped up). Idempotent + order-independent vs step 2 (the
   d1b4b82 fix decoupled them).
4. Version-bump LAST (migrate_protocol with target_version > current) — only after every
   account is migrated. Bumping earlier would brick in-flight paths via the version gate.
```

Why the order matters: the version gate (`check_version_compatible`) would reject
in-flight tasks at an old layout if the version were bumped before they're migrated;
exit paths use `_for_exit` and stay open regardless. Both migrations are **idempotent**
(re-runnable) and **multisig/upgrade-authority gated** (not permissionless). The strict
size preconditions (§2 #8) ensure a corrupt/unexpected account is never reallocated.

**Custody context the auditor should note:** the mainnet upgrade authority was moved
to a **2-of-3 multisig** during the 2026-06-11 rollout. Confirm on-chain via
`solana program show HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`; `docs/MAINNET_MAINLINE.md`
records the live program id + branch policy and `docs/UPGRADE_AUTHORITY.md` records the
custody runbook/status.

---

## 7. Build / reproduce

```bash
# Rust program + both unit-test profiles
cargo test  --lib --manifest-path programs/agenc-coordination/Cargo.toml
cargo test  --lib --manifest-path programs/agenc-coordination/Cargo.toml --features mainnet-canary
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml -- -D warnings
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml --features mainnet-canary -- -D warnings

# Anchor build + artifact integrity (committed IDL must match the build)
anchor build
npm run artifacts:refresh && npm run artifacts:check

# litesvm integration (runs the real .so)
cd tests-integration && node --test

# historical canary surface coherence (canary build == 25 instructions; no longer live on mainnet)
npm run canary:build && npm run canary:idl && npm run canary:check-idl

# SDK
cd packages/sdk-ts && npm run sdk:drift && npx tsc --noEmit && npm test
```

> **Verifiable build (P8.3) — repo-private caveat.** See
> [`docs/VERIFIABLE_BUILDS.md`](../VERIFIABLE_BUILDS.md) for the full matrix. In short:
> the build is **reproducible** today (same tag → same `.so`, pinned Docker) and every
> release records a program hash, so a maintainer with source access can confirm the
> deployed `HJsZ…` bytecode matches the local build. But third-party
> `solana-verify verify-from-repo`, the on-chain verification PDA / osec.io public
> registration, and npm publish-provenance are **blocked while the repo is private**
> (P0.6 — the Solana source is kept private to deter copying). The auditor can reproduce
> the build locally from this tree and compare the `.so` hash; do **not** represent the
> public third-party verification property as satisfied until the repo is public.

---

## When the report arrives

When the external audit report lands:

1. Place the report PDF/markdown under `docs/audit/` (e.g.
   `docs/audit/<firm>-<date>-report.md`).
2. For each finding, add a remediation entry: severity, the fix commit, and a
   **revert-sensitive** regression test (prove it fails against the broken code, then
   restore — per the repo's golden rule #4). Accepted-with-rationale findings get an
   explicit rationale, not silence.
3. Update `docs/BATCH_1_3_AUDIT_PREP.md` §3/§4 and this pack's §4 with the external
   results, and link the report from `README.md` and `docs/DOCS_INDEX.md`.
4. The phase is **done when** the report is published in-repo and every finding is closed
   or accepted with rationale (`PLAN.md` P8.2).

---

## Pointers

- `docs/BATCH_1_3_AUDIT_PREP.md` — Batch 1–4 change inventory, per-invariant test map,
  prior-audit detail (the companion to this pack).
- `docs/audit/THREAT_MODEL.md` — fuzz-harness invariant statement.
- `docs/PROGRAM_SURFACE.md` — grouped instruction + account model.
- `docs/VERSIONS.md` — surface-versioning + the migration release runbook.
- `docs/MAINNET_MAINLINE.md` — which code is live; upgrade-authority custody.
- `docs/MARKETPLACE_EMBED_UPGRADE_SPEC.md` — the embeddable-marketplace program plan
  (home of the §11.5 go/no-go gate).
- `SECURITY.md` (P8.1) — disclosure policy, contact, safe-harbor, emergency procedures.
- `docs/VERIFIABLE_BUILDS.md` (P8.3) — reproducible build + the repo-private verification
  caveat matrix.
- `docs/CREDIBLE_EXIT.md` (P8.6, when authored) — the no-hosted-dependency exit
  walkthrough.
