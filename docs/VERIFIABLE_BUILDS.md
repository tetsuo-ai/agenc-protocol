# Verifiable Builds

How to prove that the on-chain `agenc-coordination` program deployed at
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` was built from this source — and,
honestly, **what that proof does and does not cover today** while the repository
is private.

> This is PLAN.md **P8.3**. The program custodies escrow, completion bonds, and
> agent stakes; a reproducible, hash-pinned build is the supply-chain control on
> the money path. P8.3 **depends on P0.6** (the repo going public) for full
> third-party verification — that dependency is called out explicitly below and
> is **not** hidden.

---

## TL;DR — what is provable, and what is blocked

| Property | Status today (repo PRIVATE) | Needs |
|----------|------------------------------|-------|
| The build is **reproducible** (same source tag → same `.so` bytes, in a pinned Docker image) | ✅ Works now | — |
| Every release **records a hash** of the built program (`verifiable-build-hashes.txt`) | ✅ Works now (`.github/workflows/verify.yml`) | — |
| A maintainer with repo access can confirm the **deployed** program hash matches the **locally built** hash (`get-program-hash` vs `get-executable-hash`) | ✅ Works now (anyone with the source can reproduce; only the maintainer has the source) | — |
| A **third party** can independently verify the deployed program against the source (`solana-verify verify-from-repo`) | ❌ **Blocked** | **P0.6 — repo PUBLIC** |
| An **on-chain verification PDA** + OtterSec (osec.io) public registration | ❌ **Blocked** | **P0.6 — repo PUBLIC** |
| npm **publish provenance** (`--provenance`) | ❌ **Blocked** | **P0.6 — repo PUBLIC** |

The honest one-line summary: **the build is reproducible and hash-pinned now;
independent, trustless source-verification by a third party requires the public
repo (the [HUMAN] P0.6 decision).** Until then, "verifiable" means *reproducible
by anyone who has the source*, not *verifiable by an outside party who does not*.

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
| **mainnet-canary** (25 instructions) | `--no-default-features --features mainnet-canary` | The conservative surface **actually live** at `HJsZ…` on mainnet today. |
| **full / default** (80 instructions) | *(default features)* | The complete surface, **deploy-gated** (PLAN.md Phase 9). Not live. |

> **Critical:** to match the *deployed* mainnet program you MUST build the
> **mainnet-canary** surface. Building the default (full) surface produces a
> different, larger program and a **non-matching** hash. This mirrors the
> repo's own `canary:build` npm script
> (`anchor build --no-idl -- --no-default-features --features mainnet-canary`).

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

# 2. Build the LIVE (mainnet-canary) surface deterministically, from the
#    program crate directory. Extra cargo args go after the `--` separator.
cd programs/agenc-coordination
solana-verify build \
  --library-name agenc_coordination \
  -- --no-default-features --features mainnet-canary

# 3. Hash the built program.
solana-verify get-executable-hash target/deploy/agenc_coordination.so
```

To reproduce the **full** (deploy-gated) surface instead, drop the feature args:

```bash
solana-verify build --library-name agenc_coordination
solana-verify get-executable-hash target/deploy/agenc_coordination.so
```

The hash from step 3 must equal the corresponding entry in the release's
`verifiable-build-hashes.txt`.

---

## Compare against the deployed program (works now)

`get-program-hash` reads the deployed bytecode over RPC and hashes it the same
way — **no signing, read-only, no wallet**:

```bash
# Mainnet. Compare this to the mainnet-canary hash from step 3 above.
solana-verify get-program-hash \
  -u https://api.mainnet-beta.solana.com \
  HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
```

If the deployed-program hash equals your locally reproduced **mainnet-canary**
hash, you have proven the live program matches this source tree at this commit —
*for anyone who has the source*. That is the strongest property available while
the repo is private.

---

## Full third-party verification — BLOCKED on P0.6 (repo public)

The steps below require a **public** git URL the OtterSec remote builder can
clone. They will **not** work while the repo is private; they are documented so
they are ready to activate the moment P0.6 ships. **Do not claim these as done
or as a current property of the program while the repo is private.**

### 1. `verify-from-repo` (clones the public repo, reproduces, compares)

```bash
solana-verify verify-from-repo \
  -u https://api.mainnet-beta.solana.com \
  --program-id HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK \
  --library-name agenc_coordination \
  --mount-path programs/agenc-coordination \
  --commit-hash <TAG_COMMIT_SHA> \
  https://github.com/tetsuo-ai/agenc-protocol \
  -- --no-default-features --features mainnet-canary
```

PLAN.md P8.3 done-criterion: **this command passes against the deployed
program.** It cannot pass until the repo URL is publicly cloneable (P0.6).

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
OtterSec registry — the trustless, third-party property P8.3 is ultimately
after. **Gated on P0.6.**

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

The `verify-from-repo` / OtterSec submission step is present in `verify.yml`
**commented out**, with the P0.6 gate documented inline, so it is a one-edit
activation once the repo is public.

So: **every release records a reproducible, verifiable hash even while the repo
is private.** The only thing the private repo blocks is *independent third-party*
verification of that hash against the source — which is exactly the public-repo
(P0.6) dependency.

---

## Activation checklist for when the repo goes public (P0.6)

- [ ] Uncomment the `verify-from-repo` step in `.github/workflows/verify.yml`
      (and wire `MAINNET_RPC_URL`).
- [ ] Add `--provenance` to both `npm publish` commands in
      `.github/workflows/release.yml` (per the note already there).
- [ ] Run `verify-from-repo` against mainnet for the live tag; create the PDA
      (or export-and-multisig-sign it under P8.5).
- [ ] Submit the OtterSec remote job; confirm the verified badge.
- [ ] Update this doc's TL;DR table to mark the third-party rows ✅.
- [ ] Reference the verified badge from the README security section.

---

## References

- Solana Foundation verifiable-build tool: <https://github.com/solana-foundation/solana-verifiable-build>
- Solana docs — Verifying Programs: <https://solana.com/docs/programs/verified-builds>
- OtterSec verified-programs registry: <https://verify.osec.io>
- Related: [MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md) (deployed source-of-truth),
  [VERSIONS.md](./VERSIONS.md) (surface versioning), PLAN.md P8.3 / P0.6 / P8.5 / P8.6.
