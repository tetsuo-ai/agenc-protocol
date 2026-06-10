# LOCALNET — the one-command local AgenC stack

Run every phase of the marketplace locally first: a real `solana-test-validator`
with the **real program id** loaded as a **real upgradeable program**, the real
`initialize_protocol` / `configure_task_moderation` instructions sent through the
published SDK, and a single environment file as the only seam between localnet,
devnet, and hosted. Pointing at devnet later is a one-file change, never a refactor.

## Quick start

```bash
# prerequisites (once): anchor build  +  cd packages/sdk-ts && npm install && npm run build
node scripts/localnet-up.mjs        # boot + deploy + initialize (~18s fresh, ~0.2s converge)
node scripts/localnet-status.mjs    # health + decoded ProtocolConfig/ModerationConfig
node scripts/localnet-down.mjs      # stop; add --purge to wipe the ledger
```

`localnet-up` is idempotent: re-running converges (verifies live state) instead of
duplicating. If a config PDA exists with **different** values (e.g. you swapped key
files under a kept ledger), it fails loudly rather than silently adopting them.

## What `localnet-up` actually does

1. **Preflight** — `solana-test-validator` + `solana-keygen` on PATH; the full-surface
   `.so` at `programs/agenc-coordination/target/deploy/agenc_coordination.so` (warns
   below ~2 MB: that's the canary build — rerun `anchor build`); the built SDK at
   `packages/sdk-ts/dist`. Refuses the port if a process that is **not** our pid-filed
   validator binds it; if our validator is alive and healthy it just converges.
2. **State dir** — `.localnet/` (gitignored): `ledger/`, `keys/` (`authority.json`,
   `moderator.json`, `seeder.json`, generated on first run, `chmod 600`), `logs/`,
   `validator.pid`, `env.json`.
3. **Boot** — `solana-test-validator --reset` (skip the reset with `--keep-ledger`)
   with the program **genesis-loaded at the real program id** via
   `--upgradeable-program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK <so> <authority>`.
   That creates a real BPFLoaderUpgradeable ProgramData account with our authority as
   upgrade authority — exactly what `initialize_protocol`'s ProgramData check requires,
   so no instruction or SDK behavior is mocked.
4. **Fund** — airdrops 500 SOL to each of the three keys (tops up below 100 SOL).
5. **Initialize** — sends the **real instructions** through the published SDK
   (`createMarketplaceClient` against `http://127.0.0.1:8899`):
   - `initialize_protocol` — authority signs (it IS the upgrade authority), moderator
     co-signs as the required distinct `second_signer`, multisig owners =
     `[authority, moderator, seeder]` with threshold 2, treasury = authority (a system
     account must co-sign at init; using the authority keeps localnet to three keys),
     `disputeThreshold=60`, `protocolFeeBps=250`, `minStake=0.001 SOL` (the program
     floor), `minStakeForDispute=0.001 SOL`.
   - `configure_task_moderation` — `moderation_authority` = the **moderator** key,
     `enabled=true` (fail-closed moderation, same shape as devnet/mainnet).
6. **Write `env.json`** — see the convention below — and print the next commands.

## The environment convention (the single seam)

Canonical local instance: `/home/tetsuo/git/AgenC/agenc-protocol/.localnet/env.json`
(gitignored). Keypair **paths** only — never key material.

| Field | Type | Localnet value written by `localnet-up` |
|---|---|---|
| `cluster` | `"localnet" \| "devnet" \| "mainnet"` | `"localnet"` |
| `rpcUrl` | string | `http://127.0.0.1:8899` |
| `rpcSubscriptionsUrl` | string | `ws://127.0.0.1:8900` |
| `programId` | string | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (same id on every cluster) |
| `attestorUrl` | string \| null | `null` until an attestor is started (a previously recorded value is preserved on converge) |
| `fixturesPath` | string \| null | `<repo>/.localnet/fixtures.json` (written by the seeder) |
| `keypairs` | `{ authority, moderator, seeder }` \| null | paths under `.localnet/keys/` |

SDK-side resolution order (browser-safe; `process` is only touched behind a
`typeof process` guard):

1. explicit function options
2. environment variables `AGENC_SANDBOX_CLUSTER` / `AGENC_SANDBOX_RPC_URL` /
   `AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL` / `AGENC_SANDBOX_ATTESTOR_URL` /
   `AGENC_SANDBOX_FIXTURES`
3. shipped defaults (public devnet + `DEFAULT_SANDBOX_ATTESTOR_URL` + shipped fixtures)

Node scripts/services additionally accept `--env-file <path>` (defaulting to
`.localnet/env.json` when it exists) and export the `AGENC_SANDBOX_*` variables for
child processes.

## The switchover: localnet → devnet → hosted

**Only the environment file changes.** Same program id, same SDK calls, same seeder,
same attestor code, same fixtures shape. `scripts/devnet-deploy.md` is this exact
choreography pointed at devnet (deploy at step 2 ↔ our genesis `--upgradeable-program`;
its step 4 initializers ↔ our step 5; its seeding hook ↔ the same seeder script).

| `env.json` field | today (localnet) | after devnet deploy | after hosting |
|---|---|---|---|
| `cluster` | `localnet` | `devnet` | `devnet` (or `mainnet` post-launch) |
| `rpcUrl` | `http://127.0.0.1:8899` | `https://api.devnet.solana.com` | your hosted/paid RPC |
| `rpcSubscriptionsUrl` | `ws://127.0.0.1:8900` | `wss://api.devnet.solana.com` | your hosted WS |
| `programId` | `HJsZ…w1xK` | `HJsZ…w1xK` (unchanged) | `HJsZ…w1xK` (unchanged) |
| `attestorUrl` | `null` / local storefront attestor | devnet attestor endpoint | hosted attestor (P2.3) |
| `fixturesPath` | `.localnet/fixtures.json` | `null` (SDK ships devnet fixtures) | `null` |
| `keypairs` | `.localnet/keys/*` | human-held devnet keypairs | `null` (services hold their own) |
| **everything else** | — | **nothing else changes** | **nothing else changes** |

## The full local stack, component by component

| Component | Command | Notes |
|---|---|---|
| Validator + program + configs | `node scripts/localnet-up.mjs` | flags: `--port <n>` (ws is always rpc+1), `--keep-ledger`, `--env-file <p>` |
| Status | `node scripts/localnet-status.mjs [--env-file <p>]` | exit 0 = healthy; decodes both config PDAs via SDK decoders |
| Seeder | `node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs --rpc http://127.0.0.1:8899 --keypair .localnet/keys/seeder.json --moderator-keypair .localnet/keys/moderator.json` | registers ~10 providers + listings, records CLEAN moderation with the moderator key (no attestor needed locally) |
| Attestor (optional) | storefront `server/sandboxAttestor.ts` (see its `SANDBOX_ATTESTOR.md`) | env-driven: `SANDBOX_ATTESTOR_ENABLED=true`, `SANDBOX_ATTESTOR_KEYPAIR_PATH=.localnet/keys/moderator.json`, `SANDBOX_ATTESTOR_RPC_URL=http://127.0.0.1:8899`, **`SANDBOX_ATTESTOR_ALLOW_CUSTOM_RPC=true`** (the attestor is devnet-or-allowlisted fail-closed). Record its URL in `env.json.attestorUrl`; write `.localnet/attestor.pid` so `localnet-down` stops it. |
| Stop / wipe | `node scripts/localnet-down.mjs [--purge]` | `--purge` removes only the ledger; keys + `env.json` survive |

## Gotchas (read before debugging)

- **Restart vs reset.** While the validator runs, re-running `up` never reboots it
  (converge only). After `down`, a plain `up` does `--reset` — a **fresh genesis that
  wipes seeded state**. Use `up --keep-ledger` to restart with all accounts intact.
- **New `.so` requires a reset.** `--upgradeable-program` is genesis-only and silently
  ignored on an existing ledger, so after `anchor build` produces a new binary, run a
  plain `up` (reset) — `--keep-ledger` would keep running the old program bytes.
- **Seeding stake.** This localnet's `ProtocolConfig.min_agent_stake` is 0.001 SOL (the
  program-enforced floor in `initialize_protocol`). `register_agent` requires
  `stake_amount >= min_agent_stake` — a `stakeAmount: 0` registration fails with
  `InsufficientStake` (6136). The seeder script and `examples/devnet-first-hire.ts`
  read `min_agent_stake` from the on-chain ProtocolConfig and stake exactly that,
  so they work unmodified on any properly initialized cluster.
- **One stack per machine by default.** `--port` moves the RPC/WS ports, but
  solana-test-validator's faucet still defaults to port 9900, so two concurrent stacks
  collide on the faucet. Run one at a time unless you know what you're doing.
- **Treasury = authority on localnet.** `initialize_protocol` requires a system-account
  treasury to co-sign at init; localnet reuses the authority key for it. Devnet/mainnet
  use a distinct human-held treasury (see `scripts/devnet-deploy.md`).
- **Logs.** Validator output lands in `.localnet/logs/validator.log`; `up` prints the
  tail automatically when startup fails.

## Verified run (2026-06-09, this machine)

Real transcript of the full stack — boot, seed, local attestor, the first-hire
example over the seam, a seeded-listing hire driven to settlement, status, down.
Output trimmed; throwaway local addresses only, never key material.

```console
$ node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs
-> validator on port 8899 ... booted pid 2995404 (reset) (0.5s)
-> airdrops (500 SOL targets) ... authority=500SOL moderator=500SOL seeder=500SOL (1.2s)
-> protocol config (initialize_protocol) ... initialized (2Xhm95cMigjBUcFFCR3uaZrNRJKmp766dLQvaMeJ8i2sp7VQxRMogRdEw37C8UwQn6ornjQJPU4bdgMVHjjQwp4W) (15.1s)
-> moderation config (configure_task_moderation) ... initialized (24YZYZvCFc4yR3mW7fgWvEYF8rT2TCfQdmQXRsi2bfQQU4L5mGRpC1rZZnAT29yYhDv36Yuexkukmuk451jzWoKi) (1.0s)
localnet is up (18.0s total).

$ node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs \
    --env-file .localnet/env.json \
    --keypair .localnet/keys/seeder.json --moderator-keypair .localnet/keys/moderator.json
env file: /home/tetsuo/git/AgenC/agenc-protocol/.localnet/env.json (cluster localnet)
provider stake: 1000000 lamports (ProtocolConfig.min_agent_stake)
registered agent: Sandbox Codegen Co (7M2tYoUMwtumX8RVnXDtnV5ddqgnu8b8swS5HFytLxJE)
created listing: Sandbox Codegen Co (BEQUg8oCBbv61DuBAGM6kVJBWUSeqWzavtxjqNZTZmoT)
attested via moderator keypair: Sandbox Codegen Co
... (x10 providers)
wrote /home/tetsuo/git/AgenC/agenc-protocol/.localnet/fixtures.json (seeded: true, cluster localnet, slot 197)
# 30.3s wall clock

# local attestor (from the agenc-services-storefront checkout):
$ SANDBOX_ATTESTOR_ENABLED=true SANDBOX_ATTESTOR_ALLOW_CUSTOM_RPC=true \
  SANDBOX_ATTESTOR_RPC_URL=http://127.0.0.1:8899 \
  SANDBOX_ATTESTOR_KEYPAIR_PATH=<repo>/.localnet/keys/moderator.json \
  PORT=4174 node --import tsx server/index.ts &        # then write .localnet/attestor.pid
AgenC Services storefront listening on http://localhost:4174
# and set env.json attestorUrl = "http://127.0.0.1:4174/api/sandbox/attest"

# the SAME first-hire example, retargeted purely by the environment seam:
$ export AGENC_SANDBOX_CLUSTER=localnet AGENC_SANDBOX_RPC_URL=http://127.0.0.1:8899 \
    AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL=ws://127.0.0.1:8900 \
    AGENC_SANDBOX_ATTESTOR_URL=http://127.0.0.1:4174/api/sandbox/attest \
    AGENC_SANDBOX_FIXTURES=<repo>/.localnet/fixtures.json
$ cd packages/sdk-ts && SANDBOX_NIGHTLY=1 npx vitest run tests-e2e/devnet-nightly.test.ts
environment: cluster localnet, rpc http://127.0.0.1:8899
fixtures: "Sandbox Analyst" is Active at 7RkbpXC7sPVNYSLVkaxChHgXNa4J8B4kgBhzRZzjTkHc (1000000 lamports)
protocol: minAgentStake 1000000 lamports, treasury DeM9csUe49fvKLPqx2hGKmfzTXAKXnKHsWMg12jugjb
provider: listed 3hNB3KfF8Rb59aXzpMQzpmKjxKML8Rs21YzPEjpxqbSi
attestor: listing moderation recorded CLEAN
buyer: hired -> task HF31YUZTe6gFwwFTYypsmgK9dKdm2AsHKA4qBT8ZRbCq (sig 37ftbKQ2cQXMpz7AYRmHUYtEm8KzrajqcKupHTdXDpqRU53U9yJ2sxR85N2DFfKuFNj2K2dTJxV2iYG7yq3YQbeU)
provider: claimed (task InProgress)
provider: settled (sig 2L4uzsvLCGHEVQVhaase6cC9ywo634gNEpeZDbTTdq3AJ83cPuDfYeZYv4nU2LzY4ZP3NYeMXEFHseEds1S7M4Bx)
done — faucet to settled result on localnet. Task: HF31YUZTe6gFwwFTYypsmgK9dKdm2AsHKA4qBT8ZRbCq
 Test Files  1 passed (1)   # 6.0s

# a SEEDED fixture listing hired to settlement (fresh airdropped buyer; the
# seeder key plays the listing's provider; task attested over HTTP):
hired seeded listing -> task 8k37LPZhoNa8RiNWt8RETygUNpeWTWKaG97Rg5k5ZewS
  hire signature: 3yaBrFjAxLH3VRU72rEcw5awQ3e7Meaw1oQz1n8ASeAnACeqrTYufWhHf44nPVg32GzzrJaFuBmzoZiifM7PMRwf
attestor (http://127.0.0.1:4174/api/sandbox/attest):
  task attestation signature: 2dRTmXkeSwVRWXsmTiPByTNX2GaAxiiQEhGcnTsB5GuGEeQFSNFEnUdoGaHELaQNLfpwDTgbs6dsdZ9hHAXUSBJo
provider: completed — settlement signature 2HCeDXhJtMbhUws6A2QuQy21htGgKmry4mQfjrGH6aNmQkbx2EigGGq8hQB45zrPnfBXGJLs7rtVU6ZYYzZfw7f3
Task.status === Completed; Task.rewardAmount === 1000000
treasury delta: 25000 lamports (exactly the 250 bps protocol fee)
provider authority delta: +965000 lamports (975000 payout - 2 tx fees)
# 4.6s wall clock, end to end

$ node scripts/localnet-status.mjs
[OK  ] validator process: pid 2995404
[OK  ] rpc health: http://127.0.0.1:8899 health=ok slot=936 solana=3.0.13
[OK  ] program account: HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK executable=true
[OK  ] ProtocolConfig: ... minAgentStake=1000000 ... totalAgents=16 totalTasks=4
[OK  ] ModerationConfig: ... enabled=true
[OK  ] attestor: http://127.0.0.1:4174/api/sandbox/attest -> HTTP 404   # GET probe; POST-only route, <500 = alive
[ -- ] fixtures: .localnet/fixtures.json (seeded=true, listings=10)
status: HEALTHY

$ node scripts/localnet-down.mjs
validator: pid 2995404 stopped (SIGTERM)
attestor: pid 2997290 stopped (SIGTERM)      # .localnet/attestor.pid honored
```

## Phase 3 verified run (2026-06-10, this machine)

The full hosted-data-plane surface (PLAN.md Phase 3: listings indexer + explorer
read API, API keys, `POST /v1/hires` tx builder, signed webhooks, public
moderation API, SDK indexer/webhook/moderation clients) exercised end to end
against this localnet stack — localhost only, throwaway keys, output trimmed.

```console
# 1. boot + seed (18.3s + 28.3s)
$ node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs
localnet is up (18.3s total).
# gotcha: a stale env.json attestorUrl from a previous run makes the seeder try
# HTTP attestation — null it (or run the attestor) before seeding:
$ node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs --env-file .localnet/env.json \
    --keypair .localnet/keys/seeder.json --moderator-keypair .localnet/keys/moderator.json
... (x10 providers, listings moderated CLEAN via the moderator key)   # 28.3s

# 2. storefront (from the agenc-services-storefront checkout) — indexer +
#    moderation API on, attestor off, throwaway data dir, pid under .localnet/:
$ PORT=4185 STOREFRONT_DATA_DIR=$(mktemp -d) SOLANA_RPC_URL=http://127.0.0.1:8899 \
  LISTINGS_INDEXER_ENABLED=true LISTINGS_INDEXER_RPC_URL=http://127.0.0.1:8899 \
  LISTINGS_INDEXER_POLL_INTERVAL_MS=3000 MODERATION_API_ENABLED=true \
  MODERATION_AUTHORITY_KEYPAIR_PATH=<repo>/.localnet/keys/moderator.json \
  MODERATION_ALLOW_CUSTOM_RPC=true \
  nohup node --import tsx server/index.ts > <repo>/.localnet/logs/storefront.log &
AgenC Services storefront listening on http://localhost:4185

# 3. ingest — all 10 seeded listings indexed within ~14s of boot:
$ curl -s 'http://127.0.0.1:4185/api/explorer/listings?pageSize=50'
success: true total: 10  (all metadataValid=true, accountData base64 present)
GET /listings/:pda, /listings/:pda/hires, /agents/:pda/track-record,
and the LISTING_NOT_FOUND 404 envelope all verified.

# 4. parity (0.13s) — SDK queries.listActiveListings over gPA vs
#    createIndexerClient({baseUrl}).listActiveListings:
gPA listings: 10 / indexer listings: 10
PARITY OK: same listing set, deep-equal decoded accounts

# 5. tx builder (1.9s) — fresh airdropped buyer (createSandboxClient over the
#    AGENC_SANDBOX_* seam), registered as agent, POST /v1/hires via the SDK
#    client, signed locally with @solana/kit, broadcast, confirmed:
listing 5NCHsZ…t3Xq: price=700000 version=1
broadcast signature: tJV6m5ZkBpoepSyyuwjQYL5hiBzLJTgdcSg1Ux2jSSdrAgDWnAXNMa6EskwBTUSrSK3McxUV1HmRxKP6iUBejcp
on-chain: Task exists (reward=700000), HireRecord exists (task ok, listing ok)

# 6. webhooks (4.2s) — POST /v1/api-keys, registerWebhook -> local receiver,
#    another hire, signed deliveries verified with the SDK helper:
delivery listing.hired: sig VERIFIED via verifyAgencWebhookSignature (tamper fails)
delivery task.created:  sig VERIFIED via verifyAgencWebhookSignature (tamper fails)
replay: GET /v1/events shows both delivered event ids

# 7. moderation (5.1s) — fresh UNMODERATED listing created via the SDK, then
#    sdk requestListingModeration (endpoint from AGENC_SANDBOX_MODERATION_URL=
#    http://127.0.0.1:4185/api/moderation/listings), then a public-path hire:
spec canonical hash: 716e75d0…aa106  ->  verdict clean, riskScore 0
policyHash == sha256(GET /api/moderation/policy bytes)  (8235 bytes)
ListingModeration on-chain at ARX8a9…7GJb (riskScore=0, policyHash matches)
hire on that listing: built -> signed -> broadcast -> Task + HireRecord on-chain

# 7b. negative path — raw-category listing NOT in the v1 taxonomy:
metadataValid: false, issues: ["category … is not one of the 20 canonical …"]
default query excludes it; ?metadataValid=false includes it. After this exists,
gPA returns 12 listings vs indexer 11 — the indexer's documented default
exclusion of metadataValid:false listings (contract behavior, not drift).

# 8. teardown
$ kill $(cat .localnet/storefront.pid) && node scripts/localnet-down.mjs
storefront stopped / validator stopped (SIGTERM)
```
