# Explorer metadata and revision-5 re-attestation

Issue #199 requires two approved on-chain actions: create the canonical `security`
metadata and update the vault's verification PDA. The program executable is not
changed by these actions. This procedure builds on wenakita's PR #200.

## Observed state and reproducibility

On 2026-10-19, read-only mainnet inspection confirmed:

| Property | Observed value |
| --- | --- |
| Program | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Last deployment slot | `434489452` |
| Upgrade authority | `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` |
| Custody | Squads v4, autonomous 2-of-3, zero timelock; committed custody policy matches |
| Canonical security PDA | `HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw`, absent |
| OtterSec registry | `is_verified: false`, still refers to revision-4 commit `097ded1` |

The exact revision-5 source is
`08a3c87d4729e4a47c3db58cc61f2a8cee8a518d`. A fresh default-feature build with
checksum-pinned verifier **0.5.2** and its historical Agave **3.0.13** image
`sha256:2ee1f4c3f0db0e1c1107ffb978b1d16b792194148852f31891adf3ee85970259`
reproduced the live payload **byte-for-byte**:

- Raw ELF/payload SHA-256: `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`.
- Verifier normalized hash, after removing trailing zero bytes:
  `a389e6f5e0dda3cb1b893e2c82ba04272059f33d17df7c00ab8fca73915ef203`.

These different hashes represent different hashing conventions for the same
binary. The current Agave 4.1/revision-7 candidate must not be used to attest the
historical deployed revision. Historical reproduction does not relax the
current release toolchain floors. Public observation evidence is recorded in
`artifacts/explorer-metadata/2026-10-19-revision-5.json`.

## Prepare a reviewable packet

Install this checkout's locked dependencies, including the independent web3
preflight graph:

```bash
npm ci
npm ci --prefix tests-integration
node --test scripts/explorer-metadata.test.mjs
node scripts/explorer-metadata.mjs check
```

Build the exact deployed commit in a separate clean checkout:

```bash
git worktree add --detach ../agenc-revision-5 08a3c87d4729e4a47c3db58cc61f2a8cee8a518d
cd ../agenc-revision-5/programs/agenc-coordination
solana-verify build --library-name agenc_coordination
```

Use the checksum-pinned verifier from `.github/workflows/verify.yml`. Before
preparing either proposal, run in the current remediation checkout:

```bash
node scripts/explorer-metadata.mjs preflight --artifact /absolute/path/to/rebuilt/agenc_coordination.so
node scripts/explorer-metadata.mjs status
```

The preflight binds the mainnet genesis, loader ownership and ProgramData PDA,
actual executable bytes, deployment slot, current upgrade vault, complete
reviewed Squads membership/threshold and deployed PMP binary. A changed
executable, authority, custody configuration, metadata representation or expired
contact document fails closed and needs a fresh review. `status` distinguishes
an absent account from an RPC/decoder error; a transport failure is not reported
as missing metadata.

`programs/agenc-coordination/security.json` names **only GitHub Private
Vulnerability Reporting**, the confirmed contact in `SECURITY.md`. It pins the
revision-5 commit and expires on 2027-07-18. Renew it deliberately before expiry.

## Operator ceremony, after explicit authorization

`explorer-metadata.mjs` only reads or exports unsigned proposal inputs. It has no
key-loading, signing, broadcast or external-job submission mode; the old
`--apply` form is rejected. Mainnet funding, buffer handoff, Squads approval and
execution remain the human gates in `MAINNET_ROLLOUT_RUNBOOK.md` §2.5.

1. Review the document bytes and hash, fresh preflight, rent-return public key,
   and both proposals. Use independently controlled members per
   `UPGRADE_AUTHORITY.md`; this PR does not attest actual key custody.
2. An authorized operator funds and uploads a standalone staging buffer using
   the **locked local** PMP CLI. Use `--compression none --format json`, then
   hand that exact buffer to the reviewed upgrade vault. The commands printed
   by `node scripts/explorer-metadata.mjs` include these settings. Check the
   buffer's address from the named CLI field; never extract an arbitrary first
   base58 token from console output. Do not re-create a buffer to retry an export.
3. Export the canonical write, with the operator's reviewed rent-return address:

   ```bash
   node scripts/explorer-metadata.mjs export-security \
     --artifact /absolute/path/to/rebuilt/agenc_coordination.so \
     --buffer <BUFFER_PUBLIC_KEY> --rent-return <OPERATOR_PUBLIC_KEY>
   ```

   The exporter checks the buffer owner, discriminator, authority and every
   content byte. It emits one legacy transaction: exact rent top-up, canonical
   allocation, buffer copy, initialization and buffer close/refund. It refuses
   existing metadata and payloads over 8 KiB; there is no hidden multi-extend or
   overwrite behavior. It includes no ComputeBudget instruction inside the
   Squads CPI. Review the returned instruction/account list and `rentTopUp`.
4. Export the verification-PDA update:

   ```bash
   node scripts/explorer-metadata.mjs export-verify-pda \
     --artifact /absolute/path/to/rebuilt/agenc_coordination.so \
     --verifier /absolute/path/to/pinned/solana-verify
   ```

   The exporter checks the verifier executable SHA-256 and decodes its complete
   unsigned transaction: exact PDA, accounts/permissions, instruction, repository,
   commit, verifier version, build arguments and deployment slot. Extra data or
   instructions are rejected. A fresh loader/custody read must still match the
   preflight when either export finishes.
5. Import each `unsignedTransaction` into Squads as base58, vault index 0.
   Review and approve with two distinct members, then execute. Repeat the
   read-only preflight immediately before each approval and execution. Stored
   Squads proposals **do not expire merely because the import's outer blockhash
   expires**; reject stale proposals after any source/custody/state change.
6. Confirm the PDA update, then submit the separately approved external job:

   ```bash
   solana-verify remote submit-job \
     --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
     --uploader Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf
   node scripts/explorer-metadata.mjs status
   ```

Do not commit transient proposal blobs or private keys. Acceptance requires
`security.matches=true` and OtterSec `is_verified=true` for the exact commit,
repository and **both** normalized hashes. Confirm the Explorer Security and
Verified Build tabs separately. The primary metadata program documentation
notes evolving Explorer support; on-chain success alone does not prove an
external UI refreshed. If the registry or UI remains stale, leave #199 open.

## Reproduce the actual RPC rehearsal

`Explorer Metadata RPC E2E` downloads only public executable/config data, checks
committed hashes, and boots a fresh default-feature Agave 4.1 validator. Every
key it uses is newly generated and valid only in that disposable genesis.

```bash
node scripts/fetch-explorer-drill-programs.mjs
AGENC_EXPLORER_RPC_E2E=1 SOLANA_VERIFY_BIN=/absolute/path/to/pinned/solana-verify \
  node --test scripts/explorer-metadata.rpc.test.mjs
```

The real PMP, Squads and Otter programs execute the complete path: real 2-of-3
multisig creation, funded buffer upload/handoff, exact unsigned export through
Squads CPI, one-approval and outsider failures, byte-for-byte readback, exact
buffer-rent refund, replay rejection, stale verification-PDA creation and its
approved revision-5 update. The old commit is a deliberate prior-state fixture
created by transactions. Only Squads' **global fee/config** account is copied at
genesis; its rent epoch is set to local epoch zero because web3 cannot represent
`u64::MAX` exactly. No multisig, proposal, buffer or metadata lifecycle account
is injected. No production timing constants or validator features are disabled.

Evidence in `.localnet/evidence/issue-199-explorer-metadata.json` includes source
and binary hashes, genesis, signatures, confirmed transaction metadata and
assertions. CI uploads it. This proves the on-chain ceremony in the local SVM;
it does not execute the real vault, submit OtterSec jobs or prove Explorer UI
refresh. Those live acceptance steps remain pending.

PMP JavaScript **0.7.0** is pinned in `package-lock.json` because it supports the
repo's Kit 6.9 line; current 0.11 uses Kit 8. The deployed PMP executable is
independently hash-pinned and tested. The limited test-only Squads wire adapter
is checked against SDK 2.1.4 wire output and the real deployed SBF. It avoids
installing that SDK's unused legacy SPL/native `bigint-buffer` graph. The
upstream SDK archive used for comparison has SRI
`sha512-5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==`.

Primary references: [PMP](https://github.com/solana-program/program-metadata),
[Squads v4](https://github.com/Squads-Protocol/v4), and
[verifier 0.5.2](https://github.com/solana-foundation/solana-verifiable-build/tree/v0.5.2).
