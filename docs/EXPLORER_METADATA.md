# Explorer metadata and the verified build

Issue #199 asked for two on-chain actions that only the upgrade-authority vault
can sign: create the canonical Program Metadata Program (PMP) `security` record
and update the vault's OtterSec verification PDA. Both are live for revision 8
since 2026-10-28. Neither action changes the program executable. This procedure
builds on wenakita's PR #200.

## Live state (2026-10-28)

| Property | Observed value |
| --- | --- |
| Program | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Deployment slot | `462468899` (revision 8) |
| Upgrade authority | `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` |
| Custody | Squads v4 `7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY`, autonomous 2-of-3, zero timelock; committed custody policy matches; transaction index 14 |
| Canonical security record | `HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw`, present: 841 bytes of UTF-8 JSON, uncompressed, direct data, SHA-256 `e729a01fe966ded0c7e632d80756a5de8f720f70c74f7e902e75b4f2e7f987e9` |
| Record source | Byte-identical to `programs/agenc-coordination/security.json` |
| Record creation | Squads proposal 14, approved by `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` and `3HvRz5tYADe92Va435ds2nxgUSWZhv8bHxm1wNfSNznx`, executed in tx `b4sj2V78ddEfN1V6EM9K3krs3LfgTkgSNZxiPT93hbZjZiXgmiKWKa14e9hJgbnZTZBum4rB1PeAkHymVdcrpEZ` at slot 462483846 (12:54:52 UTC) |
| Verification PDA | `CVV2Lu42qvCm8PrkzQYaKeHYSvAUjvRc6jBTawtuPfWQ`, updated by Squads proposals 12 and 13: verifier 0.5.2, commit `f39b383e416ec5bc511b0ffb781481a658d137d8`, slot 462468899, build arguments pin `--base-image solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab` |
| OtterSec registry | `is_verified: true` for commit `f39b383`, `on_chain_hash` and `executable_hash` both `ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`, last verified 2026-10-28T12:27:32Z |
| Read-only acceptance | `node scripts/explorer-metadata.mjs status`: `security.matches=true`, `acceptanceMet=true` |

The public observation evidence is in
`artifacts/explorer-metadata/2026-10-28-revision-8.json`. The superseded
revision-5 observation (2026-10-19, record absent, registry still on revision 4)
stays in `artifacts/explorer-metadata/2026-10-19-revision-5.json`.

## What explorers read

The hosted RFC 9116 files at `agenc.ag/.well-known/security.txt` and
`agenc.tech/.well-known/security.txt` are separate. Explorers do not read them.

- Solana Explorer reads the PMP canonical `security` record. Its Verified Build
  tab reads the OtterSec registry.
- Solscan's "Security.txt" flag also reads the PMP canonical `security` record.
  Mainnet programs that have only a PMP record and no `.security.txt` ELF
  section show true, for example
  `4X79YRjz9KNMhdjdxXg2ZNTS3YnMGYdwJkBHnezMJwr3` and
  `GpraCzoKRwVb3WfucGxCStTftB42qkoSJtpRLxshFoGF`. When a program has both,
  Solscan shows the PMP content. A program with only an ELF section still shows
  true from that section.
- The AgenC program has no `.security.txt` ELF section, so the PMP record alone
  set Solscan's flag. Solscan showed true and the record's content shortly
  after proposal 14 executed.
- Only the canonical record counts. A third-party (non-canonical) record is
  ignored. Write the record with JSON format (`--format json`, as below); a
  record stored with format `none` is shown as raw text and the flag stays
  false.

## Reproducibility

The deployed source is release commit
`f39b383e416ec5bc511b0ffb781481a658d137d8`. A default-feature build with the
checksum-pinned verifier **0.5.2** and the Agave **4.1.0** image
`solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab`
reproduces the deployed binary:

- Release ELF: 2,075,896 bytes, SHA-256
  `0b450dab8096b10c79bf5b8d8cf4a4a837cd8df69ea4cfaa09d68d9d2f16a44e`.
- Live ProgramData payload: 2,303,608 bytes, SHA-256
  `ed0e0f11239671b301813a06071c07791453d54f3c0969359a986a481cc505f9`. It is the
  release ELF followed only by zero padding (227,712 bytes of headroom).
- Verifier normalized hash, after removing trailing zero bytes:
  `ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`.

These hashes are different conventions for the same binary. Because the payload
is longer than the ELF, `scripts/explorer-metadata.mjs` checks that a rebuilt
artifact has the release ELF hash, equals the payload prefix, and that every
byte after it is zero.

The script, `security.json` and its tests are bound to revision 8: commit,
deployment slot, ELF, payload and normalized hashes. After the next program
upgrade they correctly fail closed. Reproduce the newly deployed source, capture
fresh custody and slot evidence, update `security.json` and the bindings, and
obtain a new review. Do not weaken the bindings to reuse an obsolete packet.

`programs/agenc-coordination/security.json` names **only GitHub Private
Vulnerability Reporting**, the confirmed contact in `SECURITY.md`. It pins the
revision-8 commit and expires on 2027-07-18. Renewing it before expiry needs a
new reviewed record write through the vault.

## Check the live state

Install this checkout's locked dependencies, including the independent web3
preflight graph:

```bash
npm ci
npm ci --prefix tests-integration
node --test scripts/explorer-metadata.test.mjs
node scripts/explorer-metadata.mjs check
node scripts/explorer-metadata.mjs status
```

`check` prints the SHA-256 of `security.json`; it must equal the on-chain
content hash above. `status` reads the loader, custody, PMP executable, the
canonical record and the OtterSec registry. It distinguishes an absent account
from an RPC or decoder error; a transport failure is not reported as missing
metadata. It is read-only.

To bind a rebuilt binary as well, build the release commit in a separate clean
checkout and run the preflight:

```bash
git worktree add --detach ../agenc-revision-8 f39b383e416ec5bc511b0ffb781481a658d137d8
cd ../agenc-revision-8/programs/agenc-coordination
solana-verify build --url https://api.mainnet-beta.solana.com \
  --library-name agenc_coordination \
  --base-image solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab
cd -
node scripts/explorer-metadata.mjs preflight --artifact /absolute/path/to/rebuilt/agenc_coordination.so
```

Pass `--url` so the verifier does not fall back to the default Solana CLI
config and its key file. The preflight binds the mainnet genesis, loader ownership and ProgramData PDA,
actual executable bytes, deployment slot, current upgrade vault, complete
reviewed Squads membership and threshold, and the deployed PMP binary. A changed
executable, authority, custody configuration, metadata representation or
expired contact document fails closed and needs a fresh review.

## How the revision-8 record was created (2026-10-28)

`explorer-metadata.mjs` only reads or exports unsigned proposal inputs. It has
no key-loading, signing, broadcast or external-job submission mode; the old
`--apply` form is rejected. Funding, buffer handoff, Squads approval and
execution are human gates (`MAINNET_ROLLOUT_RUNBOOK.md` §2.5). The revision-8
record followed these steps:

1. A fresh read-only `preflight` with the rebuilt release ELF.
2. An operator created a standalone staging buffer
   (`4dH8Pq7LPBFuqBW4WK6YnRKFBuz8gKJjwenLE1peosNQ`) from `security.json` with the
   **locked local** PMP CLI, `--compression none --format json`, and handed its
   authority to the vault. The commands printed by
   `node scripts/explorer-metadata.mjs` include these settings.
3. `export-security` checked the buffer owner, discriminator, authority and
   every content byte, and emitted one legacy transaction: exact rent top-up,
   canonical allocation, buffer copy, initialization and buffer close/refund. It
   refuses existing metadata and payloads over 8 KiB, and includes no
   ComputeBudget instruction inside the Squads CPI:

   ```bash
   node scripts/explorer-metadata.mjs export-security \
     --artifact /absolute/path/to/rebuilt/agenc_coordination.so \
     --buffer <BUFFER_PUBLIC_KEY> --rent-return <OPERATOR_PUBLIC_KEY>
   ```

4. The unsigned transaction became Squads proposal 14 (vault index 0). Two
   distinct members approved it and it was executed.
5. `status` then reported `security.matches=true` and `acceptanceMet=true`.

The verification PDA was updated earlier the same day, right after the program
upgrade, through Squads proposals 12 and 13 (see
[`VERIFIABLE_BUILDS.md`](./VERIFIABLE_BUILDS.md)). Proposal 13 added the
`--base-image` pin because OtterSec's build server had picked an older Solana
image for the proposal-12 record. `export-verify-pda` in this script still
exports the four-argument record without `--base-image`. Do not use it to
replace the live revision-8 record; a future re-attestation must carry a
reviewed base-image pin.

Do not commit transient proposal blobs or private keys. Acceptance requires
`security.matches=true` and OtterSec `is_verified=true` for the exact commit,
repository and **both** normalized hashes, then a separate check of the
explorer pages.

## Reproduce the actual RPC rehearsal

`Explorer Metadata RPC E2E` downloads only public executable/config data, checks
committed hashes, and boots a fresh default-feature Agave 4.1 validator. Every
key it uses is newly generated and valid only in that disposable genesis.

```bash
node scripts/fetch-explorer-drill-programs.mjs
AGENC_EXPLORER_RPC_E2E=1 SOLANA_VERIFY_BIN=/absolute/path/to/pinned/solana-verify \
  node --test scripts/explorer-metadata.rpc.test.mjs
```

The download pins the live revision-8 payload, and the drill first checks that
the release ELF is its exact prefix. The real PMP, Squads and Otter programs
then execute the complete path: real 2-of-3 multisig creation, funded buffer
upload/handoff, exact unsigned export through Squads CPI, one-approval and
outsider failures, byte-for-byte readback, exact buffer-rent refund, replay
rejection, stale verification-PDA creation and its approved update to the
revision-8 commit. The old commit is a deliberate prior-state fixture created by
transactions. Only Squads' **global fee/config** account is copied at genesis;
its rent epoch is set to local epoch zero because web3 cannot represent
`u64::MAX` exactly. No multisig, proposal, buffer or metadata lifecycle account
is injected. No production timing constants or validator features are disabled.

Evidence in `.localnet/evidence/issue-199-explorer-metadata.json` includes source
and binary hashes, genesis, signatures, confirmed transaction metadata and
assertions. CI uploads it. This proves the on-chain ceremony in the local SVM;
it does not execute the real vault, submit OtterSec jobs or prove an explorer
refresh. The live acceptance for revision 8 is recorded above.

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
