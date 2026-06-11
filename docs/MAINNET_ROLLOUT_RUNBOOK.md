# MAINNET ROLLOUT RUNBOOK — full-surface upgrade

Operational runbook for upgrading the live mainnet `agenc-coordination` program
from the restricted **25-instruction canary** surface to the full **~80-instruction**
surface. This is the Phase 9 on-chain upgrade. It is **irreversible** and
**human-run**; this document is the choreography, not an authorization.

> Source of truth for layout/version semantics: [`VERSIONS.md`](./VERSIONS.md).
> Branch-of-record policy: [`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md).

---

## 0. Current live state (verified 2026-06-11)

| | Value |
|---|---|
| Program ID | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Upgrade authority | `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` (single key) |
| Live binary | 921,016 B (canary build, `--features mainnet-canary`) |
| ProgramData balance | 6.41147544 SOL — **allocated tight** (rent(921016+45) == balance exactly; no headroom) |
| Live ProtocolConfig | OLD 349-byte layout (pre-P6.5, no `surface_revision`) |
| Live Task accounts | 149, at 382-byte (pre-Batch-2) layout |

The full-surface binary (default features) is **2,975,920 B** (~2.84 MB) as of
the current build — ~3× the canary. Re-measure the exact byte count of the
binary you actually deploy before funding (a verifiable/Docker build can differ
by a few KB).

---

## 1. Cost (verified against live mainnet rent)

Solana rent = `(128 + bytes) × 6960` lamports; verified with `solana rent`.

| Item | SOL | Nature |
|---|---|---|
| New ProgramData rent (2,975,920 + 45) | ~20.71 | permanent floor |
| Current ProgramData rent (already funded) | 6.41147544 | already locked |
| **Permanent extension top-up** | **~14.30** | **locked forever** (recoverable only by closing the program) |
| Upgrade buffer rent (2,975,920 + 37) | ~20.71 | **temporary — refunded** to the payer after the upgrade |
| Write/upgrade tx fees (~2,900 txns) | ~0.015 | permanent |

- **Peak balance the authority must hold:** ~**35 SOL** (buffer + extension + fees).
- **Net permanent spend:** ~**14.3 SOL** (the ProgramData rent increase) + fees.
- The authority currently holds **6.94 SOL** → fund at least **~30 SOL** before
  starting (round up from the ~28 SOL peak shortfall for fee/retry headroom).
  ~21 SOL returns when the buffer refunds.

`solana program deploy --program-id <ID>` auto-extends ProgramData (a single
+2,054,904-byte extend is permitted; result < the 10 MiB `MAX_PERMITTED_DATA_LENGTH`
ceiling). Pass `--no-auto-extend` only if extending manually first.

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
      multisig before the deploy if at all possible.
- [ ] **Rehearsed on devnet/localnet** against a ≥149-task clone — see §4.
- [ ] **Authority funded** with ~30 SOL (§1).
- [ ] **§11.5 go/no-go** decision recorded (business gate; owner's call).

---

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
   At this instant the live 349-byte ProtocolConfig and the 149 382-byte Tasks
   **fail typed reads** — this is expected and is why steps 2–3 follow immediately.

2. **`migrate_protocol` FIRST** (realloc ProtocolConfig 349 → 351, zero-init
   `surface_revision = 0`, top up rent). Call with `target_version == 1` for the
   realloc-only path. Multisig-gated, idempotent. Until this runs, `migrate_task`
   itself cannot resolve the config.

3. **`migrate_task` for ALL 149 tasks** (realloc Task 382 → 466, idempotent,
   order-independent). Pass each Task PDA as a **raw** account (the handler
   deserializes manually so it accepts the 382B legacy layout). Sweep every live
   task; verify count migrated == 149. A task left un-migrated stays unreadable
   by typed clients.

4. **Stamp `surface_revision` LAST** via `update_launch_controls` with
   `SURFACE_REVISION_FULL`. This flips `getDeployedSurface(rpc)` to advertise the
   full capability set. Doing this before steps 2–3 complete would advertise
   features over not-yet-migrated state.

5. **Publish the on-chain IDL** for the mainnet cluster to match the now-live
   full surface (`anchor idl upgrade` against the full IDL — NOT the 25-instruction
   canary IDL). See `MAINNET_MAINLINE.md` step 5.

---

## 4. Devnet/localnet rehearsal (required before §3 on mainnet)

Prove the freeze-then-recover cycle at scale before touching mainnet:

1. Boot the localnet stack (`scripts/localnet-up`) with the program loaded at the
   real ID, run the real initializers, and seed **≥149** Task accounts at the
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
program. The rehearsal extends that to the full 149-task sweep choreography.

---

## 5. Abort / rollback

- **Before step 1 (deploy):** fully reversible — nothing on-chain changed.
- **After step 1, before steps 2–3:** the program is live but typed reads are
  frozen. The forward fix is to complete the migration sweep, not to roll back —
  re-deploying the canary binary would itself require its own migration and is
  not a clean revert. **Do not pause between step 1 and step 3.** Have the
  migrate sweep scripted and ready to fire immediately after the deploy lands.
- **Rent is not recoverable** short of closing the program. Treat the ~14.3 SOL
  as spent.

---

## 6. Post-rollout

- [ ] All 149 tasks readable via typed `Account<Task>`.
- [ ] `getDeployedSurface(rpc)` reports the full capability set.
- [ ] Mainnet IDL published and fetchable matches the full surface.
- [ ] `MAINNET_MAINLINE.md` "Current Mainnet Deployment" updated (scope = full surface).
- [ ] Buffer account refund received by the payer (~21 SOL back).
- [ ] Published SDK semver compatible with the now-live surface (see `VERSIONS.md`).

_Generated 2026-06-11. Re-verify byte sizes and rent against live mainnet before each run._
