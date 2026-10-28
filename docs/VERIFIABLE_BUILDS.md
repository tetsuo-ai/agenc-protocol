# Verifiable Builds

How to prove that the on-chain `agenc-coordination` program deployed at
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` was built from this source.

> **Operator (Explorer security.txt):** merging docs is not enough. Explorers
> read two on-chain records the Squads vault must sign. Both exist for
> revision 8: the verification PDA is updated and attested (see below), and
> Squads proposal 14 created the canonical PMP security record
> `HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw` from the reviewed revision-8
> `security.json`. See [`EXPLORER_METADATA.md`](./EXPLORER_METADATA.md).

> This is PLAN.md **P8.3 (SHIPPED)**. The repo is **public**. Revision 8 is the
> currently deployed program (release commit
> `f39b383e416ec5bc511b0ffb781481a658d137d8`, normalized executable hash
> `ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`, deployed
> 2026-10-28). The OtterSec verified-build registration
> (<https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>)
> reports `is_verified: true` for that commit (last verified
> 2026-10-28T12:27:32Z). Revision 5 (live 2026-07-22 to 2026-10-28) was never
> re-attested; on 2026-10-19 the registry still named the revision-4 commit
> (`097ded1`) with `is_verified: false`. The program custodies escrow,
> completion bonds, and agent stakes; the reproducible, hash-pinned build is the
> supply-chain control on the money path. **Keeping the badge across upgrades is
> a deploy invariant** — see
> [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5 for the
> as-executed Squads-era re-verification procedure.

---

## TL;DR — what is provable

| Property | Status today (repo PUBLIC) | Notes |
|----------|-----------------------------|-------|
| The build is **reproducible** (same source tag → same `.so` bytes, in a pinned Docker image) | ✅ Works | — |
| Every release **records a hash** of the built program (`verifiable-build-hashes.txt`) | ✅ Works (`.github/workflows/verify.yml`) | — |
| Anyone can confirm the **deployed** program hash matches the **locally built** hash (`get-program-hash` vs `get-executable-hash`) | ✅ Works | — |
| A **third party** can independently verify the deployed program against the source (`solana-verify verify-from-repo`) | ✅ **Works — repo public** | executed 2026-07-03 |
| An **on-chain verification PDA** + OtterSec (osec.io) public registration | ✅ **Works, revision 8 attested** | PDA `CVV2Lu42…` written by the Squads upgrade-authority vault (proposals 12 and 13, runbook §2.5); OtterSec job `237eab0c` verified commit `f39b383` on 2026-10-28; revision 5 was never re-attested |
| npm **publish provenance** (`--provenance`) | ✅ Enabled | tag-triggered publishes use GitHub OIDC |

The honest one-line summary: the deployed program is revision 8 (commit
`f39b383`, normalized hash `ffb8f3cb…`, deployed 2026-10-28), and the OtterSec
registry reports `is_verified: true` for that commit after reproducing it
independently.

---

## Why this matters

`HJsZ…` is an **upgradeable** program. The on-chain bytecode is the only thing
that actually moves money; the source in this repo is a *claim* about that
bytecode until someone reproduces it. A verifiable build closes that gap:

1. **Reproducibility** — `solana-verify build` compiles the program inside a
   pinned Docker image, eliminating "works on my machine" toolchain drift, so
   the same source tag deterministically yields the same `.so`.
2. **Hash pinning** — the SHA-256 of the built `.so` is recorded on every
   release. The deployed program's executable hash can be compared against it.
3. **Public verification** (once public) — `verify-from-repo` lets *anyone* run
   the reproducible build from the git URL and assert it matches `HJsZ…`,
   recording the result in an on-chain PDA and the OtterSec public registry.

This is also a prerequisite for the **credible-exit test** (PLAN.md P8.6): an
embedder verifying "the program is the program" without trusting tetsuo-ai.

---

## Build surfaces and deployed revisions (read this before comparing hashes)

`lib.rs` defines **two** `#[program]` modules, and the full module also has an
explicit `private-zk` feature variant. These configurations produce **different
bytecode and different hashes**:

| Surface | Cargo build args | What it is |
|---------|------------------|------------|
| **production / default** (**104** instructions) | *(default features)* | The live revision-8 production surface (deployed 2026-10-28 from commit `f39b383`, normalized hash `ffb8f3cb…`). |
| **private-ZK development** (**107** instructions) | `--features private-zk` | Adds three quarantined proof instructions. Development/testing only; production preflight rejects this surface. |
| **deployed revision 5** (**101** instructions at `08a3c87`) | *(default features at the deployed commit)* | The **superseded** build that was live at `HJsZ…` from 2026-07-22 to 2026-10-28 (`surface_revision = 5`, slot **434489452**, executable SHA-256 `049a66…`). It reproduces with its historical Agave 3.0.13 image; see [`EXPLORER_METADATA.md`](./EXPLORER_METADATA.md). |
| **deployed revision 4** (**99** instructions at `097ded1`) | *(default features at the deployed commit)* | The **superseded** prior build that was live at `HJsZ…` (`surface_revision = 4`, slot **431918664**, 2026-07-09 → 2026-07-22). |
| **mainnet-canary** (25 instructions) | `--no-default-features --features mainnet-canary` | The conservative restricted BUILD. Still in source, but **no longer live on mainnet** (it was the surface live before 2026-06-11). |

> **Critical:** the mainnet program runs a **full / default** surface, but
> feature names do not identify a source revision. To match the *currently
> deployed* program (revision 8, normalized hash `ffb8f3cb…`) you MUST build
> default features at release commit `f39b383` with the pinned verifier and
> image below; the revision-5 commit `08a3c87` and the revision-4 commit
> `097ded1` reproduce superseded bytecode. Building `private-zk`
> or `mainnet-canary` also produces different bytecode and a non-matching hash;
> `private-zk` must never be substituted for a production artifact.

`release.yml` runs on `protocol-v*` tags and calls reusable `verify.yml`
(`workflow_call`; also available as `workflow_dispatch`). `verify.yml` itself
does not trigger on tags. It builds and hashes both release surfaces
(production and frozen canary, not the private development variant).
`release.yml` attaches those hashes to the GitHub Release. A build hash
becomes a live-program claim only after an on-chain comparison against the
deployed bytecode.

---

## Toolchain pinning

Anchor migrations must pass `node scripts/check-rust-supply-chain-policy.mjs`
and its process-level regression suite. The resolved `anchor-lang` and
`anchor-spl` packages in **every** Cargo lock must remain on stable 0.32.x or
move directly to >=1.0.2. Versions 1.0.0 and 1.0.1, and prereleases below
1.0.2, are forbidden by repository policy. This guards
[RUSTSEC-2026-0144](https://rustsec.org/advisories/RUSTSEC-2026-0144.html)
(`Program<System>` substitution) and
[RUSTSEC-2026-0146](https://rustsec.org/advisories/RUSTSEC-2026-0146.html)
(`InterfaceAccount` discriminator bypass in 1.0.0-rc.1). The currently pinned
0.32.1 is unaffected by both. The version floor is a necessary migration gate;
an Anchor major migration still needs ABI, SDK, SBF, and account-validation
regressions. It is not approved merely by passing the floor.

Advisory exception expiry is checked with the UTC wall clock before audit tools
run. The daily Rust Supply Chain workflow also enforces the exact exception
scope and reruns the pinned scanners on all independent Cargo locks.

solana-verify selects its deterministic Docker build image's Solana CLI version
from `[workspace.metadata.cli].solana` in the build-root `Cargo.toml`. This repo
pins it explicitly:

- **`programs/agenc-coordination/Cargo.toml`** → `[workspace.metadata.cli] solana = "4.1.0"`

That value is kept in sync with `Anchor.toml` `[toolchain] solana_version`
(4.1.0) and `anchor_version` (0.32.1). Without the explicit pin, solana-verify
would fall back to the `solana-program` entry in `Cargo.lock` (a transitive
`2.3.0`), which is **not** the toolchain the program is deployed with — so the
pin is load-bearing for reproducibility. **If you bump the Solana toolchain,
update all three (`Cargo.toml`, `Anchor.toml`, and `SOLANA_VERIFY_VERSION` /
this doc) together.**

The patched 4.1.0 build rail uses verifier 0.5.2; 0.5.0 has no 4.1.0 image
mapping. CI verifies the upstream Linux executable SHA-256
`b9d5ccce9634dc14269cab3e7a58649bc141b3306e7735a94478c936341f211f`
before execution. Verifier 0.5.2 selects the official build image by digest
`sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab`.
See the [tagged verifier release](https://github.com/solana-foundation/solana-verifiable-build/releases/tag/v0.5.2)
and its [image map](https://github.com/solana-foundation/solana-verifiable-build/blob/v0.5.2/src/image_config.rs).
These pins built the deployed revision-8 binary. Historical deployed hashes
still require their original toolchain, and each new deployment needs a new
independent attestation.

The build root is `programs/agenc-coordination/` (this crate is a single-member
Cargo workspace; there is no parent Cargo workspace). That path is the
`--mount-path` for `verify-from-repo`.

---

## Reproduce the build locally (works now, with the source)

Requires Docker and Rust. Targets **solana-verify v0.5.x**
(`solana-foundation/solana-verifiable-build`).

```bash
# 1. Install the pinned verifier (the version verify.yml uses).
cargo install solana-verify --version 0.5.2 --locked

# 2. Build the production/default surface deterministically from the program
#    crate directory. At release commit f39b383 this is the live revision-8
#    surface.
cd programs/agenc-coordination
solana-verify build --library-name agenc_coordination

# 3. Hash the built program.
solana-verify get-executable-hash target/deploy/agenc_coordination.so
```

To reproduce the **mainnet-canary** surface instead (no longer live; the build
that was on mainnet before 2026-06-11), add the feature args:

```bash
solana-verify build \
  --library-name agenc_coordination \
  -- --no-default-features --features mainnet-canary
solana-verify get-executable-hash target/deploy/agenc_coordination.so
```

The hash from step 3 must equal the corresponding entry in the release's
`verifiable-build-hashes.txt`. To reproduce the binary live today, build release
commit `f39b383e416ec5bc511b0ffb781481a658d137d8`; step 3 must print
`ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`. The
revision-5 commit `08a3c87` and the revision-4 commit `097ded1` reproduce
superseded bytecode.

---

## Compare against the deployed program (works now)

`get-program-hash` reads the deployed bytecode over RPC and hashes it the same
way — **no signing, read-only, no wallet**:

```bash
# Mainnet. Compare this to a default-feature build of the DEPLOYED commit.
solana-verify get-program-hash \
  -u https://api.mainnet-beta.solana.com \
  HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
```

If the deployed-program hash equals your locally reproduced **default-feature**
hash, you have proven the live program matches that source. The live program is
revision 8 as of 2026-10-28; OtterSec recorded its `on_chain_hash` as
`ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`.

---

## Full third-party verification: EXECUTED for revision 8 (2026-10-28)

The repo is public, so all of the below works for anyone. It was last executed on
2026-10-28 for revision 8: the verification PDA is written by the
Squads upgrade-authority vault and the OtterSec registry reports
`is_verified: true`. The previous execution was 2026-07-10 for revision 4.
Revision 5 (live 2026-07-22 to 2026-10-28) was never re-attested. One
wrinkle vs. the vanilla flow: since the upgrade
authority is a Squads vault, the PDA transaction is routed through a vault
transaction rather than `--keypair` — the as-executed procedure is in
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5 and MUST be
repeated after every future deploy or the badge silently flips back.

Revision-8 record (2026-10-28): the vault's verification PDA
`CVV2Lu42qvCm8PrkzQYaKeHYSvAUjvRc6jBTawtuPfWQ` (uploader: the vault) was updated
through Squads proposals 12 and 13. The 404-byte record names verifier 0.5.2,
repository `https://github.com/tetsuo-ai/agenc-protocol`, commit
`f39b383e416ec5bc511b0ffb781481a658d137d8`, deployed slot 462468899 and build
arguments `--mount-path programs/agenc-coordination --library-name
agenc_coordination --base-image
solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab`.
Proposal 13 added the `--base-image` pin because OtterSec's build server had
selected the Solana 2.2.2 image for the proposal-12 record, and job `f002de3e`
failed. Job `237eab0c` then verified the record:
<https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>
reports `is_verified: true`, commit `f39b383…`, and `on_chain_hash` and
`executable_hash` both
`ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38`
(`last_verified_at` 2026-10-28T12:27:32Z). Pin the release build image digest
with `--base-image` in every future PDA record.

### 1. `verify-from-repo` (clones the public repo, reproduces, compares)

```bash
solana-verify verify-from-repo \
  -u https://api.mainnet-beta.solana.com \
  --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --library-name agenc_coordination \
  --mount-path programs/agenc-coordination \
  --commit-hash <TAG_COMMIT_SHA> \
  https://github.com/tetsuo-ai/agenc-protocol
```

(Since the 2026-06-11 upgrade the deployed surface is a full / default build,
verify default features at the deployed commit — drop the `--no-default-features
--features mainnet-canary` args that were required when mainnet ran the canary.
Use the deployed commit for `--commit-hash`; the OtterSec registry entry for the
program currently names `f39b383`. Add the `--base-image` digest from the
revision-8 record above.)

PLAN.md P8.3 done-criterion: **this command passes against the deployed
program**: satisfied for revision 8 since 2026-10-28 (revision 4 on 2026-07-10;
revision 5 was never re-attested).

### 2. On-chain verification PDA

`verify-from-repo` prompts to upload the verification record on-chain (a PDA
keyed to the program + uploader). Answer **yes** to create it. For the
multisig-controlled upgrade authority (PLAN.md P8.5), export the unsigned
transaction instead and route it through the multisig:

```bash
solana-verify export-pda-tx \
  https://github.com/tetsuo-ai/agenc-protocol \
  --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --uploader <UPGRADE_AUTHORITY_PUBKEY> \
  --encoding base58 \
  --compute-unit-price 0
```

### 3. OtterSec (osec.io) remote verification

In solana-verify v0.5.x the legacy `--remote` flag on `verify-from-repo` is
**deprecated**. The flow is: upload the PDA (step 2), then submit a remote job
to the OtterSec API, which independently reproduces the build and publishes the
result to [verify.osec.io](https://verify.osec.io), Solana Explorer, and other
indexers:

```bash
solana-verify remote submit-job \
  --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --uploader <UPGRADE_AUTHORITY_PUBKEY>

# Poll status:
solana-verify remote get-job --job-id <JOB_ID>
```

After this, `HJsZ…` shows a green "verified" badge in explorers that read the
OtterSec registry — the third-party verification property in P8.3 is live.
Last executed 2026-10-28 for revision 8 (job `237eab0c`); the previous run was
2026-07-10 for revision 4. Note that because the upgrade
authority is the Squads vault, the export-pda-tx transaction needs the
ComputeBudget instruction dropped and must be wrapped as a Squads vault
transaction — the exact as-executed steps are in
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5.

---

## What the CI workflow does (`.github/workflows/verify.yml`)

`verify.yml` is `workflow_call` plus `workflow_dispatch`. A `protocol-v*` tag
starts `release.yml`, which calls `verify.yml`. Manual dispatch is the other
entry. When it runs:

1. Installs the pinned `solana-verify` (`SOLANA_VERIFY_VERSION`, currently
   `0.5.2`, whose digest map includes Agave 4.1.0).
2. Reproducibly builds **both** current source surfaces (mainnet-canary and
   production) in the pinned Docker image.
3. Emits `get-executable-hash` for each into `verifiable-build-hashes.txt`,
   stamped with the program ID, tag, commit, verifier version, and timestamp.
4. Uploads that file as a workflow artifact. `release.yml` attaches it to the
   GitHub Release.

For a `protocol-v*` tag, `release.yml` cannot enter publication unless that
job succeeds. The release
rail verifies that the tag commit is on `main`, validates the semantic version
and both executable hashes, and passes tag-derived package/hash values to shell
through environment variables rather than direct workflow-expression
interpolation. External Actions are pinned to immutable full commit SHAs. Before
each GitHub/npm mutation, the workflow re-resolves the remote tag and requires
both its peeled source commit and exact fetched tag object to remain unchanged.
That second identity rejects replacement of an annotated tag/signature even when
the replacement still points at the same commit. A pre-existing npm version
fails closed rather than being treated as a successful rerun without an integrity
and provenance match.

Publication is ordered fail-closed: prepare a draft GitHub release, attach the
required hash manifest, publish the npm package with provenance, then make the
GitHub release public. A verifier, attachment, or npm failure therefore cannot
leave a public protocol release that lacks its build evidence.

The `verify-from-repo` / OtterSec submission step is still present in
`verify.yml` **commented out**; the 2026-07-10 verification was executed
manually (the Squads vault path in the runbook §2.5), and so was the 2026-10-28
revision-8 verification. Activating the CI step is an open item below.

---

## Activation checklist (P0.6 shipped, status as of 2026-10-28)

- [ ] Uncomment the `verify-from-repo` step in `.github/workflows/verify.yml`
      (and wire `MAINNET_RPC_URL`). *(Still commented out; the manual runbook
      §2.5 path is what keeps the badge alive today.)*
- [x] Require `--provenance` on the tag-triggered npm publish command in
      `.github/workflows/release.yml` (GitHub OIDC, public repository).
- [x] Re-resolve the remote release tag before each external mutation and fail
      closed on a pre-existing npm version that the current run cannot verify.
- [x] Protect release tags from update/deletion in repository settings and enable
      GitHub immutable releases. The authenticated live-readiness check on
      2026-07-19 verified bypass-free tag rules for every release-train family and
      immutable releases enabled; the readiness gate continuously detects drift.
- [x] Run `verify-from-repo` against mainnet for the live tag; create the PDA
      (export-and-multisig-sign via the Squads vault). The revision-8 record
      `CVV2Lu42…` was updated through Squads proposals 12 and 13 on
      2026-10-28. The revision-4 record was verified 2026-07-10; revision 5 was
      never re-attested.
- [x] Submit the OtterSec remote job; confirm the verified badge
      (`is_verified: true` for revision 8, job `237eab0c`, 2026-10-28).
- [x] Update this doc's TL;DR table to mark the third-party rows ✅.
- [x] Reference the verified badge from the README security section.

---

## References

- Solana Foundation verifiable-build tool: <https://github.com/solana-foundation/solana-verifiable-build>
- Solana docs — Verifying Programs: <https://solana.com/docs/programs/verified-builds>
- OtterSec verified-programs registry: <https://verify.osec.io>
- Related: [MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md) (deployed source-of-truth),
  [VERSIONS.md](./VERSIONS.md) (surface versioning), PLAN.md P8.3 / P0.6 / P8.5 / P8.6.
