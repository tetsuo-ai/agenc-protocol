# Upgrade Authority — Custody & Multisig Migration Runbook

This document records the **current** upgrade authority of the live mainnet
program and the precise runbook to migrate it from a single key to a **Squads
(or equivalent) multisig**. The actual authority transfer is **[HUMAN:
executes]** — this file is the plan and the safety checklist, not a record that
it has been done.

> See also: `SECURITY.md` §5.3 (custody summary integrators inherit),
> `docs/MAINNET_MAINLINE.md` (what `main` means for the live program), and
> `CLAUDE.md` Golden Rule #1 (a layout change is an irreversible deploy-gated
> migration — the same upgrade authority gates it).

---

## 1. Current state (verified on-chain)

The program is deployed with the **BPF Upgradeable Loader**, so it has a
mutable upgrade authority that can push new bytecode.

```
Program ID:        HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
ProgramData:       E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw
Owner (loader):    BPFLoaderUpgradeab1e11111111111111111111111
Upgrade Authority: HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh   ← SINGLE KEY
```

Verify at any time:

```bash
solana program show HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --url https://api.mainnet-beta.solana.com
# read the "Authority:" line — it must equal HcecpKX…GLqh today,
# and the target multisig vault PDA after the migration in §4.
```

> The **upgrade authority** (this document) is distinct from the **protocol /
> config authority** stored inside `ProtocolConfig` (the on-chain multisig that
> pauses via `update_launch_controls`, updates fees, and manages the
> dispute-resolver roster). This runbook only moves the **program upgrade
> authority**. Migrating the protocol/config multisig is a separate, on-chain
> `update_multisig` operation and is out of scope here.

---

## 2. The risk

`HcecpKX…GLqh` is a **single keypair** with unilateral power to deploy arbitrary
new bytecode to a program that **custodies escrow, completion bonds, and
reputation stakes**, and to run the irreversible 149-task-class migration.

Concretely, a single compromised or coerced key can:

- replace the program with bytecode that drains every escrow/bond/stake;
- defeat the money-never-locks exits by shipping a build that strands funds;
- raise/bypass the bytecode fee caps (`MAX_COMBINED_FEE_BPS = 4000`);
- silently change settlement, dispute, or moderation logic.

There is **no on-chain recovery** from a malicious upgrade after the fact. This
is the single largest residual trust assumption in the system and is exactly the
kind of single-point-of-compromise an embedder's security review will flag.

**Mitigation: move the upgrade authority to an M-of-N multisig** so no single
key (and no single compromised signer) can push an upgrade. Target: **Squads**
(the standard Solana program-upgrade multisig) or an equivalent threshold
signer, with the threshold and signer set chosen by the human (recommended:
geographically/organizationally separated signers, M ≥ 2, ideally with at least
one hardware-wallet signer).

---

## 3. Pre-migration safety checks (do ALL before transferring)

1. **Confirm the current authority key is in hand.** The transfer must be signed
   by `HcecpKX…GLqh`; losing access to it *before* the transfer completes
   permanently bricks upgradability.
2. **Choose M-of-N and the signers.** Decide threshold and members. Each member
   must hold their key independently. **[HUMAN: decides]**
3. **Fund the new authority.** The multisig vault that will own the authority
   needs SOL for future upgrade transactions; a Squads transfer + future
   upgrades cost fees.
4. **Test on devnet first.** Stand up a throwaway upgradeable program on devnet,
   create the multisig, and run the *exact* transfer + a test upgrade through it
   so the operational flow is rehearsed before touching mainnet.
5. **Quiet window.** Do the mainnet transfer when no migration/upgrade is
   in-flight, and announce it (auditors/SDK consumers track the authority).
6. **Record the target address** (the multisig's program-authority address) in
   this file and in `SECURITY.md` §5.3 the moment it is created, before the
   transfer, so the verification in §5 has an expected value.

---

## 4. Migration runbook (human-executed)

There are two supported routes. **Route A (Squads UI)** is the recommended,
lower-risk path; **Route B (raw CLI)** is the equivalent using
`solana program set-upgrade-authority` for any threshold-signer tool. In both,
the new authority must be **the multisig's authority address**, never a fresh
single key.

### Route A — Squads (recommended)

1. **Create the multisig.** In the Squads app (mainnet), create a new multisig
   with the chosen members and threshold (M-of-N). Record its address.
2. **Locate the program-authority address Squads expects.** Squads manages
   program upgrade authority via its vault; follow Squads' "Add a program /
   take over upgrade authority" flow, which tells you the **destination
   authority address** to transfer to. **Record it** (call it `<SQUADS_AUTH>`).
3. **Transfer the upgrade authority to the Squads address**, signed by the
   current single key:

   ```bash
   solana program set-upgrade-authority \
     HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
     --upgrade-authority <PATH_TO_CURRENT_KEY_OR_LEDGER> \
     --new-upgrade-authority <SQUADS_AUTH> \
     --url https://api.mainnet-beta.solana.com
   ```

   (If the current authority is a Ledger, use
   `--upgrade-authority usb://ledger?key=…` and approve on-device.)
4. **Confirm Squads now controls it** (its UI shows the program), then run a
   **no-op / trivial test upgrade proposal** through the multisig to prove M-of-N
   signing actually upgrades the program before you rely on it. Cancel or apply
   per your test plan.

### Route B — raw `set-upgrade-authority` (any threshold tool)

1. Create the multisig with your tool and obtain its **authority address**
   `<MS_AUTH>`.
2. Transfer:

   ```bash
   solana program set-upgrade-authority \
     HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
     --upgrade-authority <PATH_TO_CURRENT_KEY_OR_LEDGER> \
     --new-upgrade-authority <MS_AUTH> \
     --url https://api.mainnet-beta.solana.com
   ```
3. From here on, **every upgrade** must be assembled and signed as an M-of-N
   transaction through the tool — a `solana program deploy` from a single key
   will fail because that key is no longer the authority.

> ⚠️ **Do NOT use `--final`.** Setting the authority to `--final` (none) makes the
> program **permanently immutable** and is irreversible — it would prevent any
> future security fix or the 149-task migration. The goal is *multisig*, not
> *immutable*.

> ⚠️ **Do NOT transfer to an address you do not control / cannot sign with.** A
> typo'd or wrong `--new-upgrade-authority` permanently loses upgradability with
> no recovery.

---

## 5. Post-migration verification

```bash
solana program show HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --url https://api.mainnet-beta.solana.com
```

Confirm **`Authority:`** now equals the multisig authority address (`<SQUADS_AUTH>`
/ `<MS_AUTH>`) and **no longer** `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh`.

Then:

1. Update `SECURITY.md` §5.3 to state the multisig as the upgrade authority and
   record its address + threshold.
2. Update this file's §1 with the new authority and the date of transfer.
3. Update `README.md` and `docs/MAINNET_MAINLINE.md` if they cite the authority.
4. Announce the new custody to auditors / SDK consumers / embedders.
5. Run one real M-of-N test upgrade (if not already done in §4.4) so the team has
   exercised the signing path *before* an emergency requires it.

---

## 6. Status

- [x] Current single-key authority documented & verified on-chain (`HcecpKX…GLqh`).
- [x] Risk articulated; target custody (Squads/equivalent multisig) stated here and in `SECURITY.md` §5.3.
- [x] Runbook + safety checks written.
- [ ] **[HUMAN]** Multisig created (M-of-N + signers chosen).
- [ ] **[HUMAN]** Devnet rehearsal of transfer + test upgrade.
- [ ] **[HUMAN]** Mainnet `set-upgrade-authority` executed.
- [ ] **[HUMAN]** Post-migration verification + docs/announcement updated.

This is **done** only when `solana program show` reports the multisig as the
upgrade authority on mainnet and the docs above are updated to match.
