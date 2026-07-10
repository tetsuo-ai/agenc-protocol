# Verifiable Builds

How to prove that the on-chain `agenc-coordination` program deployed at
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` was built from this source.

> This is PLAN.md **P8.3 — SHIPPED**. The repo is **public**, and as of
> 2026-07-03 the deployed program carries a **live OtterSec verified-build
> registration**: <https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>
> reports `is_verified: true` against this repo at the deployed commit
> (`aad4c0d`, the P1.2 90-instruction surface). The program custodies escrow,
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
| An **on-chain verification PDA** + OtterSec (osec.io) public registration | ✅ **LIVE** (`is_verified: true`) | PDA written by the Squads upgrade-authority vault; runbook §2.5 |
| npm **publish provenance** (`--provenance`) | ❌ Not yet enabled | one-edit activation in `release.yml` (see checklist below) |

The honest one-line summary: **the deployed program is third-party verifiable
today** — reproduce it yourself with `verify-from-repo`, or read the OtterSec
registry entry that already attests it. The remaining open item is npm
`--provenance` on the TypeScript package publishes.

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

## The two surfaces (read this before you compare hashes)

`lib.rs` defines **two** `#[program]` modules, selected by a Cargo feature. They
produce **different bytecode and different hashes**:

| Surface | Cargo build args | What it is |
|---------|------------------|------------|
| **full / default** (**99** instructions as of batch-4) | *(default features)* | The complete surface — **live** at `HJsZ…` on mainnet (`surface_revision = 4`, last slot **431918664** as of 2026-07-09). Growth: 84 (Phase 9) → 90 (P1.2) → 94/96/99 (batches 2–4). Verify the OtterSec registry entry names the commit you build. |
| **mainnet-canary** (25 instructions) | `--no-default-features --features mainnet-canary` | The conservative restricted BUILD. Still in source, but **no longer live on mainnet** (it was the surface live before 2026-06-11). |

> **Critical:** since 2026-06-11 the mainnet program runs the **full / default**
> surface — to match the *deployed* mainnet program you MUST build the default
> (full) surface **at the deployed commit** (the OtterSec registry entry names
> it). Building the `mainnet-canary` surface produces a different, smaller
> program and a **non-matching** hash. (Before the 2026-06-11 upgrade the
> opposite was true — mainnet ran the canary build.) Current HEAD source is the
> 99-ix batch-4 surface; older deploy commits had intermediate counts.

The `verify.yml` workflow builds and hashes **both** surfaces on every
`protocol-v*` tag so the live surface can be checked and the full surface has a
reproducible hash on record before it is ever deployed.

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

# 2. Build the LIVE (full / default) surface deterministically, from the
#    program crate directory. As of 2026-06-11 the full surface is what is
#    deployed on mainnet, so this is the build to match the live program.
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
`verifiable-build-hashes.txt`.

---

## Compare against the deployed program (works now)

`get-program-hash` reads the deployed bytecode over RPC and hashes it the same
way — **no signing, read-only, no wallet**:

```bash
# Mainnet. Compare this to the full/default-surface hash from step 3 above.
solana-verify get-program-hash \
  -u https://api.mainnet-beta.solana.com \
  HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
```

If the deployed-program hash equals your locally reproduced **full/default**
surface hash, you have proven the live program matches this source tree at this
commit. (Before 2026-06-11 the live program was the `mainnet-canary` build; the
full surface went live with the Phase 9 upgrade.)

---

## Full third-party verification — EXECUTED (2026-07-03, badge live)

The repo is public, so all of the below works for anyone. It was executed on
2026-07-03 (after the P1.2 deploy): the verification PDA is written by the
Squads upgrade-authority vault and the OtterSec registry reports
`is_verified: true`. One wrinkle vs. the vanilla flow: since the upgrade
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

(Since the 2026-06-11 upgrade the deployed surface is the full / default build,
so verify against the default features — drop the `--no-default-features
--features mainnet-canary` args that were required when mainnet ran the canary.
Use the deployed commit for `--commit-hash`; the OtterSec registry entry for the
program names the currently-verified one.)

PLAN.md P8.3 done-criterion: **this command passes against the deployed
program** — satisfied since 2026-07-03.

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
OtterSec registry — the trustless, third-party property P8.3 is after.
**Executed 2026-07-03; the badge is live.** Note that because the upgrade
authority is the Squads vault, the export-pda-tx transaction needs the
ComputeBudget instruction dropped and must be wrapped as a Squads vault
transaction — the exact as-executed steps are in
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.5.

---

## What the CI workflow does (`.github/workflows/verify.yml`)

On every `protocol-v*` tag (and on manual dispatch):

1. Installs the pinned `solana-verify` (`SOLANA_VERIFY_VERSION`, currently
   `0.5.0`).
2. Reproducibly builds **both** surfaces (mainnet-canary and full) in the
   pinned Docker image.
3. Emits `get-executable-hash` for each into `verifiable-build-hashes.txt`,
   stamped with the program ID, tag, commit, verifier version, and timestamp.
4. Uploads that file as a workflow artifact **and** attaches it to the GitHub
   Release created by `release.yml`.

The `verify-from-repo` / OtterSec submission step is still present in
`verify.yml` **commented out**; the 2026-07-03 verification was executed
manually (the Squads vault path in the runbook §2.5). Activating the CI step is
an open item below.

---

## Activation checklist (P0.6 shipped — status as of 2026-07-03)

- [ ] Uncomment the `verify-from-repo` step in `.github/workflows/verify.yml`
      (and wire `MAINNET_RPC_URL`). *(Still commented out; the manual runbook
      §2.5 path is what keeps the badge alive today.)*
- [ ] Add `--provenance` to both `npm publish` commands in
      `.github/workflows/release.yml` (per the note already there — the repo is
      public now, so this is unblocked).
- [x] Run `verify-from-repo` against mainnet for the live tag; create the PDA
      (export-and-multisig-sign via the Squads vault — done 2026-07-03).
- [x] Submit the OtterSec remote job; confirm the verified badge
      (`is_verified: true` live).
- [x] Update this doc's TL;DR table to mark the third-party rows ✅.
- [x] Reference the verified badge from the README security section.

---

## References

- Solana Foundation verifiable-build tool: <https://github.com/solana-foundation/solana-verifiable-build>
- Solana docs — Verifying Programs: <https://solana.com/docs/programs/verified-builds>
- OtterSec verified-programs registry: <https://verify.osec.io>
- Related: [MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md) (deployed source-of-truth),
  [VERSIONS.md](./VERSIONS.md) (surface versioning), PLAN.md P8.3 / P0.6 / P8.5 / P8.6.
