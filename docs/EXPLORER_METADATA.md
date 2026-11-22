# Explorer metadata and the verified build

Issue #199 asked for two on-chain actions that only the upgrade-authority vault
can sign: create the canonical Program Metadata Program (PMP) `security` record
and update the vault's OtterSec verification PDA. Both went live for revision 8
on 2026-10-28. For revision 9 (2026-11-21) only the verification PDA was
updated; the security record update is deferred (see below). Neither action
changes the program executable. This procedure builds on wenakita's PR #200.

## Live state (revision 9, read 2026-11-22)

| Property | Observed value |
| --- | --- |
| Program | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Deployment slot | `472177819` (revision 9) |
| Upgrade authority | `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` |
| Custody | Squads v4 `7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY`, autonomous 2-of-3, zero timelock; committed custody policy matches; transaction index 16 |
| Canonical security record | `HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw`, present and unchanged since revision 8: 841 bytes of UTF-8 JSON, uncompressed, direct data, SHA-256 `e729a01fe966ded0c7e632d80756a5de8f720f70c74f7e902e75b4f2e7f987e9`. It names `source_release` `revision-8` and commit `f39b383…` |
| Record source | Byte-identical to `programs/agenc-coordination/security.json`, which is also unchanged |
| Record creation | Squads proposal 14 (2026-10-28), approved by `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` and `3HvRz5tYADe92Va435ds2nxgUSWZhv8bHxm1wNfSNznx`, executed in tx `b4sj2V78ddEfN1V6EM9K3krs3LfgTkgSNZxiPT93hbZjZiXgmiKWKa14e9hJgbnZTZBum4rB1PeAkHymVdcrpEZ` at slot 462483846 (12:54:52 UTC) |
| Verification PDA | `CVV2Lu42qvCm8PrkzQYaKeHYSvAUjvRc6jBTawtuPfWQ`, 404 bytes, updated by Squads proposal 16 (tx `4wAuJX7YPodyo1vGDX9TXgthcmgKFTitWDorHRo8FAv3BhHydqn5z6JQ5ob5rLokjCNA3yp3ogPYx1vme5Rd1ecd`, slot 472196661): verifier 0.5.2, commit `154d286659592c799bd111bf416fdba7ccc704b4`, slot 472177819, build arguments pin `--base-image solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab` |
| OtterSec registry | `is_verified: true` for commit `154d286`, `on_chain_hash` and `executable_hash` both `baf5be55c86f0a5c79eb52229a3412121a1a3c5f2a5699f4b24d75c7e8dc3608`, last verified 2026-11-21T15:56:30Z (job `e6e4c02a-d2f6-44f8-8cb1-6be55cb61c00`) |
| Read-only acceptance | Not available yet: `node scripts/explorer-metadata.mjs status` still checks the revision-8 bindings, so it stops on the revision-9 program (`deployment slot changed; re-review the ceremony`) |

The revision-8 observation evidence (record present, registry on revision 8)
stays in `artifacts/explorer-metadata/2026-10-28-revision-8.json`. No
revision-9 observation file is committed yet; it comes with the record update.
The superseded revision-5 observation (2026-10-19, record absent, registry
still on revision 4) stays in
`artifacts/explorer-metadata/2026-10-19-revision-5.json`.

## Revision 9: security record update deferred

The revision-9 ceremony did not update the canonical security record, and no
Squads proposal touched it. Explorers that read it (Solana Explorer's Security
tab, Solscan's Security.txt flag) therefore get the revision-8 content: the same
GitHub Private Vulnerability Reporting contact, `source_release` `revision-8`
and commit `f39b383…`. The verified-build badge reads the OtterSec registry,
which names the revision-9 commit.

Two things block the update today:

- `export-security` only creates a record. It refuses an existing canonical
  record, so it cannot write a new `security.json` over the live one. A
  revision-9 record needs a new, reviewed PMP update path through the vault.
- `scripts/explorer-metadata.mjs`, `security.json` and their tests are bound to
  revision 8 (commit, slot 462468899, payload `ed0e0f11…`, normalized hash
  `ffb8f3cb…`). Every command that reads the program (`status`, `preflight`,
  `export-security`, `export-verify-pda`) fails closed on the revision-9
  program until they are rebound to revision 9 and reviewed.

The deferral does not affect the program, and it did not block the unpause.

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
`154d286659592c799bd111bf416fdba7ccc704b4` (program tree
`df10b3fc66c2707b58305311da6b060c928b594f`, the same as the frozen release
commit `e62c82bf1a12b04ef37ef1f1bb6b5ce1058c03a3`). A default-feature build with
the checksum-pinned verifier **0.5.2** and the Agave **4.1.0** image
`solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab`
reproduces the deployed binary:

- Release ELF: 2,183,448 bytes, SHA-256
  `fa56b36b9175f7c1424c8119385e88ee116320d9ab08dc3f590ef662580b5e35`.
- Live ProgramData payload: 2,303,608 bytes, SHA-256
  `5d1ff9c667f9825194974c3f98f5766cc39628f98b290198df634eb78321db68`. It is the
  release ELF followed only by zero padding (120,160 bytes of headroom).
- Verifier normalized hash, after removing trailing zero bytes:
  `baf5be55c86f0a5c79eb52229a3412121a1a3c5f2a5699f4b24d75c7e8dc3608`.

These hashes are different conventions for the same binary. Because the payload
is longer than the ELF, `scripts/explorer-metadata.mjs` checks that a rebuilt
artifact has the release ELF hash, equals the payload prefix, and that every
byte after it is zero.

The script, `security.json` and its tests are still bound to revision 8:
commit `f39b383e416ec5bc511b0ffb781481a658d137d8`, deployment slot 462468899,
ELF `0b450dab…`, payload `ed0e0f11…` and normalized hash `ffb8f3cb…`. Since the
2026-11-21 upgrade they correctly fail closed. To rebind them, reproduce the
revision-9 source, capture fresh custody and slot evidence, update
`security.json` and the bindings, and obtain a new review. Do not weaken the
bindings to reuse an obsolete packet.

`programs/agenc-coordination/security.json` names **only GitHub Private
Vulnerability Reporting**, the confirmed contact in `SECURITY.md`. It still
pins the revision-8 commit and expires on 2027-07-18. Renewing it, or moving it
to revision 9, needs a new reviewed record write through the vault.

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

Until the script is rebound to revision 9, `check` still works, but `status`
and `preflight` stop at the revision-8 deployment binding. The commands below
describe the revision-8 procedure.

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
exports the four-argument record without `--base-image`. It was not used for
revision 9: Squads proposal 16 came from a reviewed `solana-verify
export-pda-tx` export that passed `--base-image` from the start, so one proposal
was enough. Do not use `export-verify-pda` to replace the live record; every
future re-attestation must carry a reviewed base-image pin.

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

The download pins the revision-8 payload, and the drill first checks that the
release ELF is its exact prefix. Since the 2026-11-21 upgrade the live payload is
revision 9's (`5d1ff9c6…`), so the download fails closed and the workflow fails
on every branch until the drill is rebound with the record update. It is not a
required check. The real PMP, Squads and Otter programs
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
refresh. The live acceptance for revision 8 was recorded on 2026-10-28; the
revision-9 state is recorded above.

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
