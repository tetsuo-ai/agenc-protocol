# Explorer metadata — two Squads approvals

Make [explorer.solana.com](https://explorer.solana.com/address/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK) show **Verified Build** and **security.txt** for `HJsZ…`.

This is **not** a program upgrade. The Squads upgrade-authority vault signs two metadata writes. After they land, anyone can submit the OtterSec job.

Related: [#199](https://github.com/tetsuo-ai/agenc-protocol/issues/199), [VERIFIABLE_BUILDS.md](./VERIFIABLE_BUILDS.md), [MAINNET_ROLLOUT_RUNBOOK.md](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5, [SECURITY.md](../SECURITY.md) §1 / §6.

---

## Operator card (do this)

```bash
node scripts/explorer-metadata.mjs
```

That prints the filled-in commands. The short version:

| Step | Who | What |
|------|-----|------|
| 0 | GitHub | Merge this PR (`programs/agenc-coordination/security.json`) |
| 1 | Operator | Fund vault `Cj9dWtov…` with ~0.01 SOL if needed (otter-PDA rent) |
| 2 | Operator | Any funded keypair (~0.02 SOL) that is **not** the vault — pays the PMP buffer |
| 3 | Operator | `node scripts/explorer-metadata.mjs export-security --apply --keypair ~/.config/solana/id.json` → **blob A** |
| 4 | Operator | `node scripts/explorer-metadata.mjs export-verify-pda --apply` → **blob B** |
| 5 | Squads 2-of-3 | Import A and B as base58 vault txs (index 0). Drop ComputeBudget if CPI rejects it. Approve + execute both. |
| 6 | Anyone | `node scripts/explorer-metadata.mjs submit-osec --apply` |
| 7 | Anyone | `node scripts/explorer-metadata.mjs status` then hard-refresh Explorer |

Done when status shows `securityPresent=true` and `osec.is_verified=true` for commit `08a3c87d4729e4a47c3db58cc61f2a8cee8a518d` (revision-5 candidate). The current OtterSec row still names `097ded1` (revision 4) and is why Explorer says unverified.

Do **not** check the base58 blobs into git. They carry a recent blockhash and die in minutes.

---

## What each approval writes

1. **security.txt** — Program Metadata Program, seed `security`, **canonical** (upgrade authority only). Explorer's Security tab does not read [agenc.ag/.well-known/security.txt](https://agenc.ag/.well-known/security.txt). `--non-canonical` will not populate the tab.

   The checked-in JSON uses only the confirmed GitHub Private Vulnerability Reporting channel. It does **not** advertise `security@agenc.tech` (`SECURITY.md` §1).

2. **Verified Build** — otter-verify PDA update from revision-4 commit `097ded1` → revision-5 commit `08a3c87…` (`--library-name agenc_coordination --mount-path programs/agenc-coordination`). Then `solana-verify remote submit-job` asks OtterSec to rebuild. Explorer reads [verify.osec.io/status/HJsZ…](https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK).

If `export-verify-pda` hashes would not match live `HJsZ…`, stop. Confirm `solana-verify get-program-hash` against a default-feature build of `08a3c87…` before anyone votes. Do not pass `private-zk` or `mainnet-canary`.

---

## Pins

| Item | Value |
|------|-------|
| Program | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Upgrade-authority vault | `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` |
| Squads multisig | `7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY` |
| Revision-5 source | `08a3c87d4729e4a47c3db58cc61f2a8cee8a518d` |
| Payload | `programs/agenc-coordination/security.json` |

`08a3c87` is the revision-5 final-candidate commit that bound executable SHA-256 `049a66e3…`. Later `main` commits through `7f57b2b` are docs/ceremony only.

---

## Checks

```bash
node --test scripts/explorer-metadata.test.mjs
node scripts/explorer-metadata.mjs check
```
