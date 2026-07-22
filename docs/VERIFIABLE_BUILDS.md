# Verifiable Builds

How to prove that the on-chain `agenc-coordination` program deployed at
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` was built from this source.

> This is PLAN.md **P8.3 — SHIPPED**. The repo is **public**. Revision 5 is the
> currently deployed program (executable SHA-256
> `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`, deployed
> 2026-07-22). The prior OtterSec verified-build registration
> (<https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>)
> reported `is_verified: true` at the revision-4 deployed commit (`097ded1`, the
> 99-instruction surface); re-running the reusable verifiable build re-registers
> the revision-5 bytecode. The program custodies escrow,
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
| An **on-chain verification PDA** + OtterSec (osec.io) public registration | ⏳ **re-register for revision 5** | prior registration attested revision 4; re-run the reusable build to re-attest `049a66…`; PDA written by the Squads upgrade-authority vault (runbook §2.5) |
| npm **publish provenance** (`--provenance`) | ✅ Enabled | tag-triggered publishes use GitHub OIDC |

The honest one-line summary: **the deployed program is revision 5** (executable
`049a66…`, deployed 2026-07-22) and is third-party verifiable by reproducing the
reviewed revision-5 source with `verify-from-repo`; the OtterSec registry still
carries the prior revision-4 attestation (`097ded1`) until the reusable build is
re-run against revision 5.

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
| **production / default** (**101** instructions) | *(default features)* | The live revision-5 production surface (deployed 2026-07-22, executable SHA-256 `049a66…`). |
| **private-ZK development** (**104** instructions) | `--features private-zk` | Adds three quarantined proof instructions. Development/testing only; production preflight rejects this surface. |
| **deployed revision 4** (**99** instructions at `097ded1`) | *(default features at the deployed commit)* | The **superseded** prior build that was live at `HJsZ…` (`surface_revision = 4`, slot **431918664**, 2026-07-09 → 2026-07-22). |
| **mainnet-canary** (25 instructions) | `--no-default-features --features mainnet-canary` | The conservative restricted BUILD. Still in source, but **no longer live on mainnet** (it was the surface live before 2026-06-11). |

> **Critical:** the mainnet program runs a **full / default** surface, but
> feature names do not identify a source revision. To match the *currently
> deployed* program (revision 5, executable SHA-256 `049a66…`) you MUST build
> default features at the reviewed revision-5 source; the prior deployed commit
> `097ded1` reproduces the superseded revision-4 bytecode. Building `private-zk`
> or `mainnet-canary` also produces different bytecode and a non-matching hash;
> `private-zk` must never be substituted for a production artifact.

The `verify.yml` workflow builds and hashes **both release surfaces** (production
and frozen canary, not the private development variant) on every `protocol-v*`
tag so the production surface and frozen canary each have a
reproducible hash. A build hash becomes a live-program claim only after an
on-chain hash comparison against the deployed bytecode.

---

## Toolchain pinning

solana-verify selects its deterministic Docker build image's Solana CLI version
from `[workspace.metadata.cli].solana` in the build-root `Cargo.toml`. This repo
pins it explicitly:

- **`programs/agenc-coordination/Cargo.toml`** → `[workspace.metadata.cli] solana = "3.0.13"`

That value is kept in sync with `Anchor.toml` `[toolchain] solana_version`
(3.0.13) and `anchor_version` (0.32.1). Without the explicit pin, solana-verify
would fall back to the `solana-program` entry in `Cargo.lock` (a transitive
`2.3.0`), which is **not** the toolchain the program is deployed with — so the
pin is load-bearing for reproducibility. **If you bump the Solana toolchain,
update all three (`Cargo.toml`, `Anchor.toml`, and `SOLANA_VERIFY_VERSION` /
this doc) together.**

The build root is `programs/agenc-coordination/` (this crate is a single-member
Cargo workspace; there is no parent Cargo workspace). That path is the
`--mount-path` for `verify-from-repo`.

---

## Reproduce the build locally (works now, with the source)

Requires Docker and Rust. Targets **solana-verify v0.5.x**
(`solana-foundation/solana-verifiable-build`).

```bash
# 1. Install the pinned verifier (the version verify.yml uses).
cargo install solana-verify --version 0.5.0 --locked

# 2. Build the production/default surface deterministically from the program
#    crate directory. At current HEAD this is the live revision-5 surface.
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
`verifiable-build-hashes.txt`. To reproduce the binary live today, build the
reviewed revision-5 source (deployed executable SHA-256 `049a66…`); the prior
deployed commit `097ded1` reproduces the superseded revision-4 bytecode.

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
revision 5 (executable SHA-256 `049a66…`) as of 2026-07-22.

---

## Full third-party verification — EXECUTED for revision 4 (2026-07-10); RE-RUN PENDING for revision 5

The repo is public, so all of the below works for anyone. It was last executed on
2026-07-10 for revision 4: the verification PDA is written by the
Squads upgrade-authority vault and the OtterSec registry reports
`is_verified: true`. Revision 5 (deployed 2026-07-22, executable SHA-256
`049a66…`) requires re-running this flow to re-attest the new bytecode. One
wrinkle vs. the vanilla flow: since the upgrade
authority is a Squads vault, the PDA transaction is routed through a vault
transaction rather than `--keypair` — the as-executed procedure is in
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5 and MUST be
repeated after every future deploy or the badge silently flips back.

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
program currently names `097ded1`.)

PLAN.md P8.3 done-criterion: **this command passes against the deployed
program** — satisfied for revision 4 since 2026-07-10; re-run against revision 5
(deployed 2026-07-22).

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
**Last executed 2026-07-10 for revision 4; re-run pending to re-attest revision 5
(deployed 2026-07-22).** Note that because the upgrade
authority is the Squads vault, the export-pda-tx transaction needs the
ComputeBudget instruction dropped and must be wrapped as a Squads vault
transaction — the exact as-executed steps are in
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5.

---

## What the CI workflow does (`.github/workflows/verify.yml`)

On every `protocol-v*` tag (and on manual dispatch):

1. Installs the pinned `solana-verify` (`SOLANA_VERIFY_VERSION`, currently
   `0.5.0`).
2. Reproducibly builds **both** current source surfaces (mainnet-canary and
   production) in the pinned Docker image.
3. Emits `get-executable-hash` for each into `verifiable-build-hashes.txt`,
   stamped with the program ID, tag, commit, verifier version, and timestamp.
4. Uploads that file as a workflow artifact **and** attaches it to the GitHub
   Release created by `release.yml`.

`verify.yml` is also a reusable `workflow_call` job. For a `protocol-v*` tag,
`release.yml` cannot enter publication unless that job succeeds. The release
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
manually (the Squads vault path in the runbook §2.5). Activating the CI step is
an open item below.

---

## Activation checklist (P0.6 shipped — status as of 2026-07-19)

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
      (export-and-multisig-sign via the Squads vault — revision-4
      record verified 2026-07-10; **re-run pending to re-attest revision 5**,
      deployed 2026-07-22).
- [x] Submit the OtterSec remote job; confirm the verified badge
      (`is_verified: true` for revision 4; **re-run pending for revision 5**).
- [x] Update this doc's TL;DR table to mark the third-party rows ✅.
- [x] Reference the verified badge from the README security section.

---

## References

- Solana Foundation verifiable-build tool: <https://github.com/solana-foundation/solana-verifiable-build>
- Solana docs — Verifying Programs: <https://solana.com/docs/programs/verified-builds>
- OtterSec verified-programs registry: <https://verify.osec.io>
- Related: [MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md) (deployed source-of-truth),
  [VERSIONS.md](./VERSIONS.md) (surface versioning), PLAN.md P8.3 / P0.6 / P8.5 / P8.6.
