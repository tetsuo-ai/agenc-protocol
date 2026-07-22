# Upgrade Authority — Custody & Multisig Migration Runbook

This document records the upgrade authority of the live mainnet
program and the precise runbook to migrate it from a single key to a **Squads
(or equivalent) multisig**.

> **✅ DONE 2026-07-03 (P0.3 executed + verified on-chain).** The program upgrade
> authority is now a **2-of-3 Squads v4 multisig vault**:
> `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (multisig account
> `7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY`, program
> `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, members `HcecpKX…GLqh` /
> `3HvRz5t…` / `6CpyZBm…`, autonomous). Verify: `solana program show
HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` → `Authority:` = the vault above,
> **not** the old single key. The 2-of-3 was proven able to propose/vote/execute
> (a no-op config transaction) BEFORE the transfer, so the handover is reversible.
> Full record + tx signatures:
> `~/agenc-mainnet-restore/mainnet/upgrade-authority-squads-members/README.md`.
> **Residual (tracked):** all three member keys are files on one host — replace
> one with a Ledger (Squads config tx, no re-transfer) for true distributed custody.
>
> **⚠️ Earlier "2026-06-11 done" note was WRONG and is struck** — it conflated the
> `ProtocolConfig` on-chain config multisig (`Hcecp…/BXDan…/4QcKB…`, 2-of-3, which
> governs fees / the P1.2 BLOCK floor via `require_multisig_threshold`) with the
> BPF-loader upgrade authority this runbook migrates. Until 2026-07-03 the loader
> authority was genuinely still the single key.
>
> ~~Status update (2026-06-11): … the upgrade authority is now a 2-of-3 multisig…~~
> **(struck — see above).**

> See also: `SECURITY.md` §5.3 (custody summary integrators inherit),
> `docs/MAINNET_MAINLINE.md` (what `main` means for the live program), and
> `CLAUDE.md` Golden Rule #1 (a layout change is an irreversible deploy-gated
> migration — the same upgrade authority gates it).

---

## 1. State (the table below is the PRE-MIGRATION state — superseded by the 2026-07-03 Squads migration in the banner above)

The program is deployed with the **BPF Upgradeable Loader**, so it has a
mutable upgrade authority that can push new bytecode.

```
Program ID:        HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
ProgramData:       E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw
Owner (loader):    BPFLoaderUpgradeab1e11111111111111111111111
Upgrade Authority: HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh   ← was SINGLE KEY until 2026-07-03; now the Squads v4 2-of-3 vault `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (see banner)
```

Verify at any time:

```bash
solana program show HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --url https://api.mainnet-beta.solana.com
# read the "Authority:" line — as of 2026-07-03 it is the Squads v4 2-of-3 vault,
# not the single HcecpKX…GLqh key it was before the migration in §4.
```

> The **upgrade authority** (this document) is distinct from the **protocol /
> config authority** stored inside `ProtocolConfig` (the on-chain multisig that
> pauses via `update_launch_controls`, updates fees, and threshold-approves
> authority-proposed dispute-resolver roster changes and direct authority
> rulings). This runbook only moves the **program upgrade
> authority**. Migrating the protocol/config multisig is a separate, on-chain
> `update_multisig` operation and is out of scope here.

---

## 2. The risk

Before the 2026-06-11 migration, `HcecpKX…GLqh` was a **single keypair** with unilateral
power to deploy arbitrary new bytecode to a program that **custodies escrow, completion
bonds, and reputation stakes**, and to run the irreversible task-layout migration (executed
2026-06-11 over the 169 live tasks). The authority is now a 2-of-3 multisig.

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
   by `HcecpKX…GLqh`; losing access to it _before_ the transfer completes
   permanently bricks upgradability.
2. **Choose M-of-N and the signers.** Decide threshold and members. Each member
   must hold their key independently. **[HUMAN: decides]**
3. **Fund the new authority.** The multisig vault that will own the authority
   needs SOL for future upgrade transactions; a Squads transfer + future
   upgrades cost fees.
4. **Test on devnet first.** Stand up a throwaway upgradeable program on devnet,
   create the multisig, and run the _exact_ transfer + a test upgrade through it
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
> future security fix or any future task-layout migration. The goal is _multisig_, not
> _immutable_.

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
   exercised the signing path _before_ an emergency requires it.

---

## 6. Pending revision-5 capacity ceremony (artifact bound; not executed)

This is a future upgrade operation, separate from the completed authority
migration above. The live ProgramData allocation and final extension target are
now independently bound:

- live ProgramData: 2,183,269 account-data bytes = 45 bytes of loader metadata
  - 2,183,224 bytes of executable capacity;
- reviewed final production SBF: 2,303,608 bytes, SHA-256
  `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`,
  requiring exactly 120,384 additional bytes. This supersedes the
  pre-close-task-fix 2,284,496-byte `79f55a68…` identity; the 2026-07-20
  close-task fix build and two isolated 2026-07-21 rebuilds are
  byte-identical;
- loader ceiling: 10,485,760 account-data bytes = 10,485,715 executable bytes.

Mainnet has the SIMD-0431 minimum-extension rule active. An ordinary legacy
`ExtendProgram` must add at least 10,240 bytes; only an extension within 10,240
bytes of the loader ceiling may be smaller, and then it must consume all
remaining headroom. The exact 120,384-byte extension satisfies that rule.

Former 2,284,384-byte candidate rent and Buffer figures are superseded and must
not fund a transaction. The bound dimensions are:

- target ProgramData account: 2,303,653 bytes (standard-formula rent floor
  16,034,315,760 lamports);
- upgrade Buffer account: 2,303,645 bytes;
- the 2026-07-20 dual-provider rent/balance evidence (15,901,296,240 /
  15,901,240,560 floors, 15,196,443,120 live balance at context slots
  434137752/434137753, 704,853,120-lamport top-up) was read for the superseded
  2,284,541-byte target and must be re-read from two independent providers for
  the new length immediately before any ceremony, plus the rail's
  1,000,000-lamport payer fee reserve.

The safe rent treatment remains:

- derive target ProgramData and Buffer lengths only from the thrice-reproduced
  final SBF;
- call the official
  [`getMinimumBalanceForRentExemption` RPC](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)
  with `{ commitment: "finalized" }` only. The method has no response context
  and does not support `minContextSlot`;
- require the two providers to return the same pre-send estimate, while treating
  the loader/runtime—not that contextless estimate—as authoritative at execution;
- after finalization, re-query both providers and require exact rent-floor and
  immutable-postimage agreement. Each provider's ProgramData balance must be at
  least the fresh floor. Record its own `excessLamports = balance - floor`;
  permissionless dust and normal finalized-provider lag remain visible but cannot
  make a correct irreversible extension unrecoverable.

The Squads vault held only 27,216,000 lamports at finalized provider context
slots 434137753 and 434137755. That balance is no longer an extension
prerequisite: current Agave does not authorize legacy `ExtendProgram` through
CPI, so the vault cannot execute the extension.
The former authority/payer wallet held 19.555838965 SOL on both providers at
finalized slot 434137785, enough for the presently calculated extension plus
Buffer requirements. It remains dated evidence: re-query both rent surfaces and
the selected payer immediately before use. No transfer to the Squads vault is
required for extension.

Required choreography:

Primary behavior sources re-verified on 2026-07-20 are the official
[Agave checked-extension removal](https://github.com/anza-xyz/agave/pull/11685),
[v4.1.0 CPI allow-list](https://github.com/anza-xyz/agave/blob/v4.1.0/program-runtime/src/cpi.rs#L174-L196),
[v4.1.0 top-level CLI implementation](https://github.com/anza-xyz/agave/blob/v4.1.0/cli/src/program.rs#L2398-L2518),
and [SIMD-0431 feature declaration](https://github.com/anza-xyz/agave/blob/v4.1.0/feature-set/src/lib.rs#L1528-L1530).

1. Re-run the read-only mainnet preflight and re-resolve genesis, loader feature
   activation, Program/ProgramData binding, authority, capacity, balance, rent,
   and the independently approved SBF/IDL hashes. Deploy remains pinned to Solana
   CLI 3.0.13; the separate extension rail accepts only official Agave CLI 4.1.0
   from the pinned source commit because that release removed the obsolete
   upgrade-authority signer requirement from its legacy-extension client. On
   x86_64 Linux it also requires extracted `solana` binary SHA-256
   `6cec29c203643342c4fd6cf9404f413a77e7452ef9205665c98cbf91e083f4c4`
   from official release archive SHA-256
   `9713fcfe4e90107595babd2001c8337fc9647195390c01dc5976039c11ca2da4`.
2. Run `node scripts/program-extend-mainnet.mjs` to preview the exact policy.
   Current mainnet never activated `ExtendProgramChecked`; current Agave also
   rejects legacy `ExtendProgram` through CPI, so **do not** construct or approve
   a Squads extension proposal. The checked-in policy is
   `reviewed-final-twice-reproduced` and binds the exact final SBF hash,
   2,303,608-byte payload, and 120,384-byte extension. Any unbound, malformed, or
   arithmetically inconsistent policy fails before file or RPC work. Execute the
   permissionless legacy instruction as a top-level transaction with:

   ```bash
   node scripts/program-extend-mainnet.mjs --execute \
     --payer-keypair <funded-payer.json> \
     --solana-cli <agave-4.1.0-solana> \
     --solana-cli-archive <agave-4.1.0-release-archive> \
     --evidence-file <durable-untracked.json>
   ```

   The wrapper pins cluster genesis, Program/ProgramData linkage, Squads upgrade
   authority, inactive checked-feature state, active SIMD-0431 state, exact
   bound capacity arithmetic, rent estimate, System-owned payer and reserve,
   original payload hash, and official CLI source/binary across two independent
   finalized RPCs.
   It hashes the supplied archive instead of recording an expected value, copies
   the verified binary into a private mode-0700 directory, rehashes it, and
   executes the still-open copied inode through `/proc/self/fd` so replacing the
   original path cannot substitute executed bytes. It separately copies the
   private single-link payer keypair into an unlinked mode-0400 inode and passes
   the same descriptor as child fd 4 for both address derivation and execution;
   it never logs, hashes, or serializes key material. Credential-bearing RPC URLs
   are rejected.

   The durable evidence is written before broadcast because the CLI response
   omits the transaction signature. It is a strict version-3, policy-bound 0600
   record published from an exclusively created, fsynced temp file; initial
   creation cannot replace another record. Later phase transitions hold an
   exclusive sidecar lock across exact-record comparison and atomic rename, and
   fsync the parent directory. If a crash leaves the lock, confirm no writer is
   active before manually removing it. Resume rejects missing, malformed, stale,
   future-dated, temporally inconsistent, or internally contradictory RPC/genesis,
   CLI, payer, preflight, status, and signature-history evidence before any
   postflight query. Solana RPC may canonically return a null transaction
   `blockTime`; wall-clock chronology is enforced when present, while exact
   anchored signature and slot/ProgramData ordering are always required. Its
   `recordSha256` is only an unkeyed corruption/torn-write
   checksum—not cryptographic authentication. Evidence integrity relies on the
   local OS account boundary, mode 0600, and a protected parent directory.

3. Paginate finalized ProgramData signature history until the durable pre-send
   anchor is reached (at most 100 pages of 1,000; missing anchor fails closed).
   Independently retrieve and decode the exact finalized top-level loader
   instruction/signature through both RPCs. The transaction signature/slot and
   stable postimages must agree, and the transaction/new ProgramData slot must
   be strictly greater than both saved preflight context slots. Provider-local
   nullable `blockTime` metadata may differ. Confirm the unchanged
   old payload prefix, identical full-payload hashes, zero-filled appended region,
   exact capacity, authority, and agreed rent floor on both providers. Validate
   and retain each provider's independently observed balance and deterministic
   `excessLamports`; those dust-sensitive values need not be identical. If
   execution succeeded but normal postflight was
   interrupted, run `--postflight-only --evidence-file <same.json>`; bounded
   polling and anchored pagination make recovery fail closed. A permissionless
   third party can race another extension between preflight and inclusion. Exact
   postflight detects the resulting over-extension but cannot undo it, so minimize
   that interval and abort the cutover on any size mismatch. Extension writes
   `ProgramData.slot`; a same-slot `Upgrade` is rejected.
4. Re-run the complete preflight against the extended account. Do not bypass
   `--no-auto-extend`, and abort on any authority, capacity, balance, slot, hash,
   or inventory drift.
5. Execute the independently approved Squads upgrade in the later slot, then
   require the post-deploy snapshot to preserve capacity and match the approved
   SBF bytes before any migration or revision stamp proceeds.

Nothing in this document records an already-completed extension or upgrade. The
extension is permissionless account allocation; the later executable-byte change
still requires the independently reviewed 2-of-3 Squads upgrade.

---

## 7. Upgrade-authority migration status (completed)

- [x] Former single-key authority documented and verified before transfer (`HcecpKX…GLqh`; historical evidence).
- [x] Risk articulated; target custody (Squads/equivalent multisig) stated here and in `SECURITY.md` §5.3.
- [x] Runbook + safety checks written.
- [x] **Multisig created** 2026-07-03 — Squads v4 2-of-3, vault `Cj9dWtov…` (members `HcecpKX…`/`3HvRz5t…`/`6CpyZBm…`).
- [~] Devnet rehearsal — public devnet faucet was down; substituted an equivalent on **mainnet** pre-transfer proof: the 2-of-3 executed a no-op config transaction (propose→2 votes→execute), proving M-of-N signing works before the transfer.
- [x] **Mainnet `set-upgrade-authority` executed** 2026-07-03 (destination triple-verified; no `--final`).
- [x] **Post-migration verification** — `solana program show` reports the vault as `Authority:`. Docs and `SECURITY.md` §5.3 are updated. Remaining custody hardening: swap at least one member to a Ledger or independently controlled signer.

The authority migration is complete: `solana program show` reports the Squads
vault as the mainnet upgrade authority and the custody docs match. The separate
revision-5 capacity ceremony in §6 remains pending until executed and verified.
