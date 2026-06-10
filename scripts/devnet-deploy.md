# Devnet Full-Surface Deploy Runbook (P2.2)

The human runs every command tagged **[HUMAN, writes on-chain]**. Everything else is
local/read-only and was verified runnable on 2026-06-09 with the exact pinned toolchain.

| Fact | Value (verified 2026-06-09, read-only) |
|---|---|
| Program ID (all clusters) | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` |
| ProgramData address | `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Upgrade authority | `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` |
| Anchor IDL account (derived) | `GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1` — **does not exist yet** (`anchor idl fetch` → `AccountNotFound`) |
| On-chain devnet binary | 403,440 bytes, last deployed slot 463431336 (~3 weeks stale; pre-Batch-2/3: no resolver roster, no humanless hire, no `RejectFrozen`, no completion-bond lifecycle) |
| New full-surface `.so` | `programs/agenc-coordination/target/deploy/agenc_coordination.so` — **2,811,288 bytes** (note: the program crate is its own build root, so the `.so` lands under `programs/agenc-coordination/target/deploy/`, NOT root `target/deploy/`) |
| Devnet ProtocolConfig | `DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs` — **EXISTS** (authority = upgrade authority, treasury `4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n`, protocolVersion 1, totalTasks 4) |
| Devnet ModerationConfig | `EAJ6hNQNXvZb7kpECTakRSdYQ91PwW2GvysTX8f5NTmE` — **MISSING** |
| Devnet ZkConfig | `GjyVSczkMkhX2pNmAaousiVPumFvyfZSr48wgAWXQJnD` — **MISSING** |
| Devnet BidMarketplace | `C8M8F53ZEfPq77gfmtghEzuP9bYaxVHu7KXZimf37TRn` — **MISSING** |

> **SAFETY — same program ID on mainnet.** `Anchor.toml` maps localnet/devnet/mainnet to
> the same program ID and `[provider] cluster = "localnet"`. NEVER rely on the default
> CLI config: pass `--url devnet` (solana) / `--provider.cluster devnet` (anchor) on
> every command, and run `solana config get` first to confirm the default isn't mainnet.

Shell variables used below (set them in the human's shell):

```bash
cd /home/tetsuo/git/AgenC/agenc-protocol            # repo root — run everything from here
export PROGRAM_ID=HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK
export UPGRADE_AUTHORITY_KEYPAIR=~/path/to/devnet-upgrade-authority.json   # human-held; pubkey HcecpK...
export DEVNET_URL=https://api.devnet.solana.com
```

---

## 0. Prerequisites

1. **Toolchain** — must match `Anchor.toml` pins (`anchor_version = "0.32.1"`,
   `solana_version = "3.0.13"`). Verified locally:

   ```bash
   anchor --version    # anchor-cli 0.32.1
   solana --version    # solana-cli 3.0.13 (Agave)
   ```

2. **Upgrade-authority keypair** — the JSON keypair for
   `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh`. It is the program upgrade authority
   AND the devnet `ProtocolConfig.authority`, so it signs the upgrade, the IDL init, and
   the moderation-config init. Confirm:

   ```bash
   solana-keygen pubkey "$UPGRADE_AUTHORITY_KEYPAIR"   # must print HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh
   ```

3. **Devnet SOL.** Exact rent math for this upgrade (all numbers cross-checked with
   `solana rent` against devnet on 2026-06-09):

   | Item | Bytes | Cost |
   |---|---|---|
   | `program extend` (permanent, into ProgramData) | +2,407,848 | **16.75862208 SOL** |
   | write-buffer rent (temporary, refunded when the deploy consumes the buffer) | 2,811,325 | **19.56771288 SOL** |
   | IDL account (~49 KB deflated of the 506 KB IDL) | ~49,000 | ~0.35 SOL |
   | Transaction fees (large multi-tx upload) | — | < 0.1 SOL |

   **Peak balance needed ≈ 36.8 SOL; net consumed ≈ 17.2 SOL** (the buffer rent comes
   back). Authority balance was **7.62 SOL** on 2026-06-09 — top it up first:

   ```bash
   solana balance HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh --url devnet
   solana airdrop 5 HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh --url devnet   # [HUMAN] repeat; rate-limited per request/day
   ```

   If the CLI faucet throttles, use the web faucet <https://faucet.solana.com>
   (GitHub-gated, up to 5 SOL per request). A separate funded payer also works — pass it
   as `-k <PAYER_KEYPAIR>` and add `--upgrade-authority "$UPGRADE_AUTHORITY_KEYPAIR"`
   (both sign; flags verified in `solana program deploy --help`).

---

## 1. Build the full surface + verify

```bash
anchor build                                   # full surface (default features) → 2.8 MB .so + 506 KB target/idl/agenc_coordination.json
npm run artifacts:check                        # committed artifacts/anchor + package copies match the build   [verified green 2026-06-09]
```

Unit + litesvm gates (one line; verified green 2026-06-09 — **232** Rust unit tests,
**158** litesvm integration tests):

```bash
cargo test --lib --manifest-path programs/agenc-coordination/Cargo.toml && (cd tests-integration && node --test)
```

Sanity-check the artifact you are about to ship:

```bash
stat -c %s programs/agenc-coordination/target/deploy/agenc_coordination.so   # 2,811,288 bytes as of 2026-06-09
node -p "JSON.parse(require('fs').readFileSync('target/idl/agenc_coordination.json','utf8')).instructions.length"  # 80
```

Do **NOT** run `npm run canary:build` between building and deploying — it overwrites the
`.so` with the restricted 25-instruction mainnet-canary binary. If you ran it, run
`anchor build` again and re-check the byte size.

---

## 2. Upgrade the existing devnet program

The program already exists and is upgradeable, so this is an **upgrade**, not an initial
deploy. Two paths; the buffer flow is recommended for a 2.8 MB binary on flaky devnet
because a failed upload resumes instead of restarting.

### 2a. Extend the program account — [HUMAN, writes on-chain]

The on-chain ProgramData holds 403,440 bytes; the new binary is 2,811,288 bytes.
Required additional bytes = `2,811,288 − 403,440 = 2,407,848` (recompute as
`new .so bytes − "Data Length" from solana program show` if either side changed):

```bash
solana program show "$PROGRAM_ID" --url devnet        # read-only; note "Data Length"
solana program extend "$PROGRAM_ID" 2407848 --url devnet -k "$UPGRADE_AUTHORITY_KEYPAIR"   # [HUMAN, writes on-chain] ~16.76 SOL rent
```

Note: `solana program deploy` on solana-cli 3.0.13 auto-extends by default (there is a
`--no-auto-extend` flag), so this step is technically redundant — but running it
explicitly makes the rent cost land in its own auditable transaction and removes one
failure mode from the big upload.

### 2b. Write the buffer — [HUMAN, writes on-chain]

Pre-generate a buffer keypair so a failed/partial upload can be **resumed** by re-running
the exact same command:

```bash
solana-keygen new -o /tmp/devnet-buffer.json --no-bip39-passphrase        # local only
solana program write-buffer programs/agenc-coordination/target/deploy/agenc_coordination.so \
  --url devnet -k "$UPGRADE_AUTHORITY_KEYPAIR" \
  --buffer /tmp/devnet-buffer.json \
  --use-rpc --with-compute-unit-price 1000 --max-sign-attempts 100        # [HUMAN, writes on-chain] ~19.57 SOL rent (refunded)
```

- `--use-rpc` + `--with-compute-unit-price` + a high `--max-sign-attempts` are the
  devnet-flakiness mitigations (all flags verified in `solana program write-buffer --help`).
- If it dies partway: re-run the identical command — it resumes into the same buffer.
- The buffer authority defaults to `-k`, which here IS the upgrade authority. Only if you
  used a separate payer, hand the buffer over:

  ```bash
  solana program set-buffer-authority "$(solana-keygen pubkey /tmp/devnet-buffer.json)" \
    --new-buffer-authority HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh \
    --url devnet -k <PAYER_KEYPAIR>                                       # [HUMAN, writes on-chain]
  ```

### 2c. Deploy from the buffer — [HUMAN, writes on-chain]

```bash
solana program deploy \
  --program-id "$PROGRAM_ID" \
  --buffer "$(solana-keygen pubkey /tmp/devnet-buffer.json)" \
  --upgrade-authority "$UPGRADE_AUTHORITY_KEYPAIR" \
  --url devnet -k "$UPGRADE_AUTHORITY_KEYPAIR"                            # [HUMAN, writes on-chain]
```

The buffer is consumed and its rent refunded to the payer. Stale buffers from abandoned
attempts can be found and reclaimed:

```bash
solana program show --buffers --buffer-authority HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh --url devnet   # read-only
solana program close --buffers --url devnet -k "$UPGRADE_AUTHORITY_KEYPAIR"                                  # [HUMAN, writes on-chain] rent recovery
```

### Alternative: one-shot `anchor upgrade`

Simpler, but restarts the whole 2.8 MB upload on failure (extra solana args go after `--`):

```bash
anchor upgrade programs/agenc-coordination/target/deploy/agenc_coordination.so \
  --program-id "$PROGRAM_ID" \
  --provider.cluster devnet --provider.wallet "$UPGRADE_AUTHORITY_KEYPAIR" \
  -- --use-rpc --with-compute-unit-price 1000 --max-sign-attempts 100     # [HUMAN, writes on-chain]
```

---

## 3. Publish the IDL

No IDL account exists on devnet yet (`AccountNotFound` for
`GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1`, verified 2026-06-09), so the **first**
publish is `idl init` — it can only ever run once per program:

```bash
anchor idl init "$PROGRAM_ID" \
  --filepath target/idl/agenc_coordination.json \
  --provider.cluster devnet --provider.wallet "$UPGRADE_AUTHORITY_KEYPAIR"   # [HUMAN, writes on-chain] FIRST TIME ONLY (~0.35 SOL)
```

Every later redeploy that changes the IDL uses `idl upgrade` instead:

```bash
anchor idl upgrade "$PROGRAM_ID" \
  --filepath target/idl/agenc_coordination.json \
  --provider.cluster devnet --provider.wallet "$UPGRADE_AUTHORITY_KEYPAIR"   # [HUMAN, writes on-chain] every subsequent deploy
```

Notes (flags verified against `anchor idl init/upgrade/fetch --help`):
- The wallet pays for + becomes the IDL authority on `init`, and must BE the IDL
  authority on `upgrade` — keep both on the upgrade-authority keypair.
- Publish the full-surface `target/idl/agenc_coordination.json` produced by step 1's
  `anchor build` (identical to the committed `artifacts/anchor/idl/agenc_coordination.json`
  while `npm run artifacts:check` is green). Never publish
  `target/idl/agenc_coordination.canary.json` to devnet.
- Optional on congested devnet: add `--priority-fee <microlamports>`.

---

## 4. Initialize / verify ProtocolConfig + ModerationConfig

### 4a. Read-only state check FIRST (no wallet, no signing — verified runnable 2026-06-09)

From `packages/sdk-ts` (after `npm install && npm run build` there, so `dist/` exists):

```bash
cd packages/sdk-ts && node --input-type=module -e "
import { createSolanaRpc } from '@solana/kit';
import { findProtocolConfigPda, findModerationConfigPda, fetchMaybeProtocolConfig, fetchMaybeModerationConfig } from './dist/index.js';
const rpc = createSolanaRpc('https://api.devnet.solana.com');
const [protocolPda] = await findProtocolConfigPda();
const [moderationPda] = await findModerationConfigPda();
const [p, m] = await Promise.all([fetchMaybeProtocolConfig(rpc, protocolPda), fetchMaybeModerationConfig(rpc, moderationPda)]);
console.log('ProtocolConfig  ', protocolPda, p.exists ? JSON.stringify({ authority: p.data.authority, protocolVersion: p.data.protocolVersion }) : 'MISSING');
console.log('ModerationConfig', moderationPda, m.exists ? JSON.stringify({ moderationAuthority: m.data.moderationAuthority, enabled: m.data.enabled }) : 'MISSING');
"
```

**Expected outcome:** `ProtocolConfig` is **already initialized** from the May deployment
(authority `HcecpK…`, version 1) — do NOT try to re-initialize it; `initialize_protocol`
is guarded by `ProtocolAlreadyInitialized`. `ModerationConfig` printed `MISSING` as of
2026-06-09 and needs step 4c.

### 4b. ProtocolConfig — only if MISSING (fresh program ID / wiped cluster)

`initialize_protocol` requires (see
`programs/agenc-coordination/src/instructions/initialize_protocol.rs`):
- `remaining_accounts[0]` = the program's **ProgramData** account
  (`E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw`) — real on devnet, which is exactly why
  litesvm tests inject the config instead of calling this;
- the signer must be the **program upgrade authority**;
- a **distinct second signer**, both signers in `multisig_owners`, `multisig_threshold >= 2`
  and `< owners.len()` (so at least 3 owners);
- the treasury must co-sign if it is a plain system account.

The maintained invocation path is the idempotent init script (it fetches each config
account first and only initializes what is missing — ProtocolConfig, rate limits,
BidMarketplace, ZkConfig; it does **not** touch ModerationConfig):

```bash
node scripts/validation-initialize.mjs --config <your-devnet-init-config.json>   # [HUMAN, writes on-chain]
```

The config JSON supplies `programId`, `rpcUrl`, `idlPath`, `authorityKeypairPath`,
`secondSignerKeypairPath`, `treasuryKeypairPath`, and the `protocol` / `rateLimits` /
`bidMarketplace` / `zkConfig.activeImageId` blocks (see the `main()` of
`scripts/validation-initialize.mjs` for every key). Caution: for accounts that already
exist it *verifies* them against the config and throws on mismatch — on the live devnet
program, set the expected `protocol` values to the May-deployment values from step 4a.

ZkConfig and BidMarketplace are also `MISSING` on devnet (2026-06-09); the same script
initializes both — needed before the private-completion (DV-03E) and bid-flow readiness
scenarios. The 32-byte `zkConfig.activeImageId` comes from the prover guest build (see
`docs/ZK_PRIVATE_FLOW.md`).

### 4c. ModerationConfig — required, currently MISSING — [HUMAN, writes on-chain]

`configure_task_moderation` is `init_if_needed` + authority-gated (signer must equal
`ProtocolConfig.authority` = the upgrade authority), so it is safe to re-run — re-running
just updates the values. Set the moderation authority to the devnet sandbox attestor key
(P2.3). From `packages/sdk-ts`:

```bash
export DEVNET_MODERATION_AUTHORITY=<attestor-pubkey>     # the P2.3 service's devnet key
cd packages/sdk-ts && node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { createMarketplaceClient, facade } from './dist/index.js';
const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.UPGRADE_AUTHORITY_KEYPAIR, 'utf8'))));
const client = createMarketplaceClient({ rpcUrl: 'https://api.devnet.solana.com', signer: authority });
const ix = await facade.configureTaskModeration({ authority, moderationAuthority: process.env.DEVNET_MODERATION_AUTHORITY, enabled: true });
const { signature } = await client.send([ix]);
console.log('configure_task_moderation:', signature);
"   # [HUMAN, writes on-chain]
```

Re-run the 4a read-only check afterwards — `ModerationConfig` must show your attestor
pubkey and `enabled: true`. The gate is fail-closed: with `enabled: true` and no CLEAN
attestation, `hire_from_listing`/task flows stay blocked until the P2.3 attestor records
moderation — that is the intended sandbox shape.

---

## 5. Post-deploy verification (all read-only)

```bash
# 1. Program: fresh slot, Data Length >= 2,811,288
solana program show "$PROGRAM_ID" --url devnet

# 2. IDL: fetchable, 80 instructions
anchor idl fetch "$PROGRAM_ID" --provider.cluster devnet -o /tmp/devnet-idl.json
node -p "JSON.parse(require('fs').readFileSync('/tmp/devnet-idl.json','utf8')).instructions.length"   # expect 80

# 3. SDK one-liner against devnet — the step-4a snippet; expect ProtocolConfig + ModerationConfig both present
```

Then the devnet readiness harness (from the repo root; `matrix` verified runnable
2026-06-09 — lists scenarios DV-01 … DV-09):

```bash
npm run devnet:marketplace:matrix      # read-only: lists the Marketplace V2 scenario matrix
npm run devnet:marketplace:prepare -- --scenario DV-03A --config scripts/marketplace-devnet.config.example.json
                                       # creates an artifact bundle + pre-state snapshots (RPC reads only)
# ... a human/agent executes the scenario's transactions on devnet, then:
npm run devnet:marketplace:capture -- --bundle artifacts/devnet-readiness/DV-03A/<timestamp> --signature <tx_sig>
                                       # captures post-state + transaction evidence into the bundle
npm run devnet:marketplace:report      # aggregates bundle verdicts into the readiness report
```

(`prepare`/`capture`/`report` only read RPC state and write local artifact files; the
scenario transactions themselves are **[HUMAN, writes on-chain]**.)

---

## 6. Refresh cadence + follow-on hooks

**Policy: redeploy devnet on every `main` merge that touches `programs/`.** Devnet must
never lag the full surface again (the May binary sat 3 weeks stale and predated
Batch 2/3).

Detection — after each merge to `main` (or in a scheduled job), diff against the last
deployed commit recorded in the log table below:

```bash
git fetch origin
git log --oneline <LAST_DEPLOYED_COMMIT>..origin/main -- programs/
```

Non-empty output ⇒ rerun steps 1 → 2 (extend only if the new `.so` outgrew the on-chain
Data Length) → 3 (`idl upgrade`) → 5. Config accounts (step 4) persist across upgrades —
re-run only the 4a read-only check. Record every deploy in the table and optionally tag:
`git tag devnet-deploy-$(date +%Y%m%d) <commit>`.

Follow-on hooks after each refresh:

1. **Seed sandbox fixtures** — `packages/sdk-ts/scripts/seed-devnet-sandbox.mjs`
   (ships alongside this runbook as part of P2.4) reseeds the ~10 provider agents +
   Active listings published as `@tetsuo-ai/marketplace-sdk/sandbox` constants, then
   rewrites `packages/sdk-ts/src/sandbox/fixtures.json` (`seeded: true`) — commit that
   file and ship an SDK release. Requires `npm run build` in `packages/sdk-ts` first
   (it imports the built `dist/`). Run after each redeploy:

   ```bash
   node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs \
     --keypair <funding+provider-authority.json> \
     --attestor-url <P2.3-attestor-endpoint>            # [HUMAN, writes on-chain]
   ```

   (Idempotent: re-runs verify existing devnet accounts against the blueprints and
   fail loudly on drift. If the P2.3 attestor is not deployed yet, substitute
   `--moderator-keypair <devnet-moderation-authority.json>`.)
2. **Sandbox attestor (P2.3)** — confirm the hosted auto-attestor is running and its key
   matches `ModerationConfig.moderation_authority` (step 4a check); rotate via step 4c if
   not.
3. **SDK drift** — if the IDL changed, the normal repo gate already covers it
   (`cd packages/sdk-ts && npm run sdk:drift && npx tsc --noEmit && npm test`).

---

## Deploy log

| Date | Commit | Slot | `.so` bytes | Notes |
|---|---|---|---|---|
| ~2026-05-19 | (unrecorded) | 463431336 | 403,440 | Pre-Batch-2/3 surface; ProtocolConfig initialized; no IDL, no ModerationConfig/ZkConfig/BidMarketplace |
| _(next)_ | | | | First full-surface deploy + `idl init` + ModerationConfig |
