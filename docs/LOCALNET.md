# LOCALNET — the one-command local AgenC stack

Run the marketplace locally on a real `solana-test-validator`, with the **real
program id** loaded as a **real upgradeable program**, real SDK instructions, and
a single environment file as the seam between localnet, devnet, and hosted.

There are two explicit modes. `--dev-ready` is the normal product-development
mode: it creates a fresh disposable ledger with a genesis-injected, current,
unpaused ProtocolConfig so registrations, listings, and hires work immediately.
Plain `localnet-up` is a production-frozen initialization rehearsal: it sends the
real `initialize_protocol` instruction, which correctly starts the full production
build paused and unstamped. It deliberately cannot accept new marketplace work.
The development fixture never represents a deployment or release-stamp ceremony.

## Quick start

The lifecycle safety rail is intentionally Linux-specific. Managed process
observation requires **Linux with procfs mounted at `/proc`**. Exact signalling
also requires a kernel with `pidfd_send_signal(2)` (Linux 5.1+) and the system
Python 3 interpreter at `/usr/bin/python3` with `signal.pidfd_send_signal`
(Python 3.9+). Lifecycle locking and guarded validator startup additionally use
that interpreter's standard-library `fcntl`, `ctypes`, and `subprocess` modules.
`localnet-up` probes the complete signalling rail before starting work, and
`localnet-down` fails closed if signalling is needed but unavailable; there is
no numeric-PID fallback. `localnet-status` only observes process identity, while
`localnet-record-attestor` observes identity and takes the lifecycle lock, but
both still require Linux/procfs.

Shutdown opens `/proc/<pid>` as a stable process reference, verifies executable,
argv, cwd, user, and process-start identity through that descriptor, and signals
through the same descriptor. `localnet-up`, `localnet-down`, and
`localnet-record-attestor` are serialized by one private, nonblocking exclusive
`flock(2)` for their complete mutation windows; concurrent commands fail closed.
Node retains the locked open-file description while an isolated Python broker
acquires the lock through a duplicated descriptor. The implementation never
calls `LOCK_UN`: duplicated descriptors share one Linux `flock`, so release
occurs only after every duplicate closes. Broker failure cannot silently unlock
Node's retained descriptor, and a launcher crash needs no stale-lock recovery.

```bash
# prerequisites (once): anchor build  +  cd packages/sdk-ts && npm install && npm run build
node scripts/localnet-up.mjs --dev-ready # disposable operational marketplace (~18s fresh)
node scripts/localnet-status.mjs    # fail-closed process/program/config health
node scripts/localnet-down.mjs      # stop; add --purge to wipe the ledger

# Production-frozen initialization rehearsal (intentionally not marketplace-ready):
node scripts/localnet-up.mjs
```

`localnet-up` is idempotent within the selected mode: re-running converges and
verifies live state. The modes cannot be silently relabeled. Switching modes
requires `localnet-down --purge` because `--dev-ready` is genesis-only and never
keeps a ledger. If a config PDA has different values, startup fails loudly.

`localnet-status` applies the same standard before printing `HEALTHY`. It binds the
strict environment file to the version-2 validator identity, canonical loopback RPC
port, current captured `.so`, `private-unlinked-fd-v1` provenance, and exact fd 5
argv; holds one stable process reference across the RPC reads; verifies the
loader-v3 owner/layout/link, local upgrade authority, executable prefix, and
zero-only ProgramData capacity; and requires the exact protocol, bid marketplace,
and moderation values that `localnet-up` converges to. The optional attestor URL
is informational:
its POST-only business route has no authenticated read-only health contract, so a
GET/404 is never mislabeled healthy.

## What `localnet-up` actually does

1. **Preflight** — `solana-test-validator` + `solana-keygen` on PATH; the full-surface
   `.so` at `programs/agenc-coordination/target/deploy/agenc_coordination.so` (warns
   below ~2 MB: that's the canary build — rerun `anchor build`); the built SDK at
   `packages/sdk-ts/dist`. The source `.so` must be a current-user-owned, single-link
   regular file. It is read once through one descriptor, with inode/size/nanosecond
   timestamp stability checks, and detached into an owned byte snapshot. The IDL,
   SDK, and script-pinned canonical program IDs must agree before any lifecycle
   marker or process is created. The rail refuses any occupied member of the
   requested port set if the process is not its exact recorded validator.
2. **State dir** — private `.localnet/` (gitignored, mode `0700`): keys
   (`authority.json`, `moderator.json`, `seeder.json`, generated on first run,
   mode `0600`), logs, environment data, and the lifecycle files described
   below. `localnet-up` deliberately does **not** pre-create `ledger/`; the
   validator creates it only after the durable pre-spawn intent exists.
3. **Boot** — `solana-test-validator --reset` (skip the reset with `--keep-ledger`)
   with the program **genesis-loaded at the real program id** via
   `--upgradeable-program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK /proc/self/fd/5 <authority>`.
   Before spawn, the captured bytes are written and synced into a private `0400`
   inode, reopened once for validation, unlinked, and passed through the guardian
   to the validator as fd 5. The validator therefore loads the exact bytes whose
   SHA-256 and size enter lifecycle evidence; replacing or modifying the build path
   after capture cannot change the loaded program. This creates a real
   BPFLoaderUpgradeable ProgramData account with the local authority as upgrade
   authority, so no instruction or SDK behavior is mocked.
4. **Verify the live loader state** — before any airdrop or initialization write,
   reads the Program and canonical ProgramData accounts from RPC; requires loader-v3
   ownership/layout, the canonical Program → ProgramData link, the expected local
   upgrade authority, the exact captured ELF prefix, and only zero bytes in unused
   ProgramData capacity. This also detects an out-of-band upgrade on a kept ledger.
5. **Fund** — airdrops 500 SOL to each of the three keys (tops up below 100 SOL).
6. **Initialize or verify the explicit mode** — through the published SDK
   (`createMarketplaceClient` against `http://127.0.0.1:8899`):
   - In plain production-frozen mode, `initialize_protocol` is sent for real:
     authority signs (it is the upgrade authority), moderator co-signs as the
     required distinct `second_signer`, multisig owners are
     `[authority, moderator, seeder]` with threshold 2, and treasury is authority.
     The resulting config
     must be `protocolPaused=true`, `surfaceRevision=0`.
   - In disposable `--dev-ready` mode, the same complete ProtocolConfig shape is
     genesis-injected with `protocolPaused=false` and
     `surfaceRevision=SURFACE_REVISION_CURRENT`. The script then decodes and
     verifies every expected value. This is a local fixture, not release evidence.
   - Both modes use `disputeThreshold=60`, `protocolFeeBps=500` (the live fee),
     `minStake=0.001 SOL`, and `minStakeForDispute=0.001 SOL`.
   - `initialize_bid_marketplace` — authority and moderator supply the required
     distinct 2-of-3 approvals in both modes. The singleton is initialized once
     with the reviewed local bid bond, cooldown, rate, lifetime, and no-show slash
     policy, then its owner, discriminator, PDA bump, authority, and every policy
     field are decoded and verified on every convergence run.
   - `configure_task_moderation` — `moderation_authority` = the **moderator** key,
     `enabled=true` (fail-closed moderation, same shape as devnet/mainnet).
7. **Write `env.json`** — see the convention below — and print the next commands.

## Lifecycle state, guardian, and crash recovery

All lifecycle leaves are anchored through the already-open private `.localnet/`
directory and validated as current-user-owned, single-link, non-symlink state.
Identity and intent records are atomically published and directory-synced.

| Path                                   | Present when                                                                                 | Purpose                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.localnet/lifecycle.lock`             | Persistent private lock inode                                                                | Serializes `localnet-up`, `localnet-down`, and `localnet-record-attestor`; the inode's presence does not mean the lock is held.                                                                               |
| `.localnet/validator.starting`         | Before every managed validator spawn until live identity is durable and the guardian commits | Version-2 pre-spawn intent binding this user, repository, ledger, program ID, exact SHA-256/size, and `private-unlinked-fd-v1` load method; retained as recovery evidence if the launcher dies before commit. |
| `.localnet/validator.pid`              | After exact live identity is captured and durably published                                  | Version-2 identity binding the live validator to its PID, process-start time, executable, argv, cwd, RPC port, exact program SHA-256/size, fd-bound load method, and this state tree.                         |
| `.localnet/validator.stopped`          | After a verified stop, a dead live record, or a failed managed replacement                   | Atomic archive of the validator identity and durable proof that its ledger may be purged.                                                                                                                     |
| `.localnet/ledger/`                    | Only after `solana-test-validator` creates it                                                | Validator-owned ledger. The lifecycle scripts never create it in advance.                                                                                                                                     |
| `.localnet/attestor.pid`               | After `localnet-record-attestor` verifies and records an optional attestor                   | Lets `localnet-down` verify and stop that exact Node process; recording is serialized with validator lifecycle changes.                                                                                       |
| `.localnet/keys/`, `logs/`, `env.json` | After their respective setup steps                                                           | Persistent local keys, validator output, and the environment seam; `--purge` does not remove them.                                                                                                            |

Validator launch uses an isolated system-Python guardian, not a detached
numeric PID:

1. `localnet-up` captures the source artifact, validates the existing-ledger
   evidence, durably publishes `validator.starting`, materializes the private
   unlinked program snapshot, then starts the guardian with that snapshot and a
   duplicate of the lifecycle lock. The guardian starts in a new session, so
   normal invoking-terminal teardown cannot send it a hangup after a successful
   commit. It launches and retains the validator as an exact `subprocess.Popen`
   child.
2. The guardian opens the resolved executable, validates that exact inode, and
   executes it through the retained descriptor, so a path replacement cannot
   substitute different bytes between validation and exec. The validator arms
   `PR_SET_PDEATHSIG` with `SIGKILL` immediately before exec and checks its parent
   again to close the documented setup race. The guardian rejects set-user-ID,
   set-group-ID, and file-capability binaries because Linux can clear the
   parent-death signal when executing them. It separately validates the inherited
   program fd as a current-user-owned, unlinked, `0400` regular file and forwards
   that same descriptor to the validator as fd 5.
3. Node opens a stable process reference, captures the validator's canonical
   identity through it, durably publishes `validator.pid`, and only then sends
   `COMMIT`.
4. Before commit, launcher EOF makes the guardian terminate, escalate if needed,
   and reap that exact child before closing its inherited lock descriptor. If the
   guardian itself dies, the parent-death signal kills the validator. After
   commit, the guardian closes its lock descriptor, acknowledges Node, and stays
   as a minimal lifetime supervisor waiting for the validator; supervisor death
   still kills the validator. Node retains its own lifecycle-lock descriptor for
   the rest of the complete `localnet-up` operation.

`localnet-down --purge` runs under that same lock. It first stops any verified
live validator through its stable process reference and atomically archives
`validator.pid` as `validator.stopped`. After a precommit launcher crash, lock
acquisition proves the guardian has finished reaping, and the validated
`validator.starting` file supplies equivalent purge evidence. An existing
ledger is purged only when at least one of those two recovery markers is valid.
The ledger is removed first and the `.localnet` directory is immediately synced
before either proof marker is deleted. The markers are then removed and the
directory is synced again. A crash can therefore restore stale proof after the
ledger is gone, but cannot durably restore the ledger while durably losing the
proof that authorized its removal. A removal or first-sync failure retains
recovery evidence for a safe retry.

Primary implementation references:

- [Linux `proc_pid(5)`](https://man7.org/linux/man-pages/man5/proc_pid.5.html)
  and [`pidfd_send_signal(2)`](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)
- [Linux `flock(2)` open-file-description semantics](https://man7.org/linux/man-pages/man2/flock.2.html)
  [`fsync(2)` directory-entry durability](https://man7.org/linux/man-pages/man2/fsync.2.html),
  and [`PR_SET_PDEATHSIG(2const)`](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
- [Python `fcntl.flock`](https://docs.python.org/3/library/fcntl.html#fcntl.flock),
  [`signal.pidfd_send_signal`](https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal),
  and [`subprocess.Popen`](https://docs.python.org/3/library/subprocess.html#popen-constructor)
- [Node.js `child_process` descriptor and stdio semantics](https://nodejs.org/api/child_process.html)
- [Anza loader-v3 `UpgradeableLoaderState` sizes and layouts](https://github.com/anza-xyz/solana-sdk/blob/master/loader-v3-interface/src/state.rs)
  and [Agave test-validator upgradeable-program genesis loading](https://github.com/anza-xyz/agave/blob/master/test-validator/src/lib.rs)

## The environment convention (the single seam)

Canonical local instance: `/home/tetsuo/git/AgenC/agenc-protocol/.localnet/env.json`
(gitignored). Keypair **paths** only — never key material.

| Field                 | Type                                       | Localnet value written by `localnet-up`                                                    |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `cluster`             | `"localnet" \| "devnet" \| "mainnet"`      | `"localnet"`                                                                               |
| `rpcUrl`              | string                                     | `http://127.0.0.1:8899`                                                                    |
| `rpcSubscriptionsUrl` | string                                     | `ws://127.0.0.1:8900`                                                                      |
| `programId`           | string                                     | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (same id on every cluster)                  |
| `programSha256`       | string                                     | SHA-256 of the exact fd-bound program bytes loaded and verified on-chain                   |
| `programSize`         | number                                     | Byte length of that exact program artifact                                                 |
| `attestorUrl`         | string \| null                             | `null` until an attestor is started (a previously recorded value is preserved on converge) |
| `fixturesPath`        | string \| null                             | `<repo>/.localnet/fixtures.json` (written by the seeder)                                   |
| `keypairs`            | `{ authority, moderator, seeder }` \| null | paths under `.localnet/keys/`                                                              |

SDK-side resolution order (browser-safe; `process` is only touched behind a
`typeof process` guard):

1. explicit function options
2. environment variables `AGENC_SANDBOX_CLUSTER` / `AGENC_SANDBOX_RPC_URL` /
   `AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL` / `AGENC_SANDBOX_ATTESTOR_URL` /
   `AGENC_SANDBOX_FIXTURES`
3. shipped defaults: **this localnet stack** (cluster `localnet`, RPC
   `127.0.0.1:8899/8900`) + shipped fixtures. There is NO shipped attestor
   endpoint (WP-D4 removed the dead `sandbox.agenc.tech` default — the
   attestor resolves to `null` unless configured; the moderator keypair is
   the localnet no-attestor path). `AGENC_SANDBOX_CLUSTER=devnet` selects the
   public devnet endpoints.

For commands that can attest either through HTTP or directly with a moderator,
the two mechanisms are exclusive. Passing `--moderator-keypair` suppresses an
inherited `attestorUrl`; passing `--attestor-url` suppresses an inherited
moderator path. The committed React sandbox always selects the deterministic
moderator-key route explicitly, so a URL preserved from a stopped optional
attestor cannot hijack a later seed run.

Node scripts/services additionally accept `--env-file <path>` (defaulting to
`.localnet/env.json` when it exists) and export the `AGENC_SANDBOX_*` variables for
child processes.

## The switchover: localnet → devnet → hosted

**Only the environment file changes.** Same program id, same SDK calls, same seeder,
same attestor code, same fixtures shape. `scripts/devnet-deploy.md` is this exact
choreography pointed at devnet (deploy at step 2 ↔ our genesis `--upgradeable-program`;
its step 4 initializers ↔ our step 5; its seeding hook ↔ the same seeder script).

| `env.json` field      | today (localnet)                   | after devnet deploy                | after hosting                       |
| --------------------- | ---------------------------------- | ---------------------------------- | ----------------------------------- |
| `cluster`             | `localnet`                         | `devnet`                           | `devnet` (or `mainnet` post-launch) |
| `rpcUrl`              | `http://127.0.0.1:8899`            | `https://api.devnet.solana.com`    | your hosted/paid RPC                |
| `rpcSubscriptionsUrl` | `ws://127.0.0.1:8900`              | `wss://api.devnet.solana.com`      | your hosted WS                      |
| `programId`           | `HJsZ…w1xK`                        | `HJsZ…w1xK` (unchanged)            | `HJsZ…w1xK` (unchanged)             |
| `attestorUrl`         | `null` / local storefront attestor | devnet attestor endpoint           | hosted attestor (P2.3)              |
| `fixturesPath`        | `.localnet/fixtures.json`          | `null` (SDK ships devnet fixtures) | `null`                              |
| `keypairs`            | `.localnet/keys/*`                 | human-held devnet keypairs         | `null` (services hold their own)    |
| **everything else**   | —                                  | **nothing else changes**           | **nothing else changes**            |

## The full local stack, component by component

| Component                     | Command                                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validator + program + configs | `node scripts/localnet-up.mjs --dev-ready`                                                                                                                                | Operational disposable mode. Omit `--dev-ready` only for the intentionally paused production-init rehearsal. Other flags: `--port <n>` (reserves rpc through rpc+103), `--keep-ledger` (frozen mode only), `--env-file <p>`.                                                                                                                                                                                                        |
| Status                        | `node scripts/localnet-status.mjs [--env-file <p>]`                                                                                                                       | Exit 0 means exact stack integrity **and** operational marketplace readiness; a valid but paused/unstamped stack is `UNHEALTHY` for product workflows.                                                                                                                                                                                                                                                                              |
| Seeder                        | `node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs --rpc http://127.0.0.1:8899 --keypair .localnet/keys/seeder.json --moderator-keypair .localnet/keys/moderator.json` | registers ~10 providers + listings, records CLEAN moderation with the moderator key (no attestor needed locally)                                                                                                                                                                                                                                                                                                                    |
| Attestor (optional)           | storefront `server/sandboxAttestor.ts` (see its `SANDBOX_ATTESTOR.md`)                                                                                                    | env-driven: `SANDBOX_ATTESTOR_ENABLED=true`, `SANDBOX_ATTESTOR_KEYPAIR_PATH=.localnet/keys/moderator.json`, `SANDBOX_ATTESTOR_RPC_URL=http://127.0.0.1:8899`, **`SANDBOX_ATTESTOR_ALLOW_CUSTOM_RPC=true`** (the attestor is devnet-or-allowlisted fail-closed). Record its URL in `env.json.attestorUrl`; run `node scripts/localnet-record-attestor.mjs <pid>` so `localnet-down` can verify the exact process before stopping it. |
| Stop / wipe                   | `node scripts/localnet-down.mjs [--purge]`                                                                                                                                | every verified validator stop atomically archives its private live record; `--purge` requires a valid stopped or pre-spawn recovery marker for an existing ledger, removes the ledger first, and deletes recovery markers last (keys + `env.json` survive)                                                                                                                                                                          |

## Gotchas (read before debugging)

- **Restart vs reset.** While the validator runs, re-running `up` never reboots it
  (converge only) and refuses a config from the other mode. After `down`, a plain
  `up` does `--reset` — a **fresh production-frozen genesis that wipes seeded
  state**. `up --dev-ready` also requires a fresh disposable genesis. Only the
  production-frozen mode accepts `--keep-ledger`.
- **New `.so` requires a reset.** `--upgradeable-program` is genesis-only. After
  `anchor build` produces different bytes, run a plain `up` (reset).
  `--keep-ledger` fails closed when any prior lifecycle artifact binding differs
  from the captured `.so`; it also verifies the actual ProgramData bytes before
  convergence, so it never silently labels old or manually upgraded bytes current.
- **Seeding stake.** This localnet's `ProtocolConfig.min_agent_stake` is 0.001 SOL (the
  program-enforced floor in `initialize_protocol`). `register_agent` requires
  `stake_amount >= min_agent_stake` — a `stakeAmount: 0` registration fails with
  `InsufficientStake` (6136). The seeder script and `examples/localnet-first-hire.ts`
  read `min_agent_stake` from the on-chain ProtocolConfig and stake exactly that,
  so they work unmodified on any properly initialized cluster.
- **One managed stack per state tree.** `--port <n>` reserves a disjoint 104-port
  range: RPC `n`, WebSocket `n+1`, faucet `n+2`, gossip `n+3`, and dynamic ports
  `n+4..n+103`. Separate checkouts can run simultaneously only with non-overlapping
  ranges. One checkout still has one `.localnet` state tree: concurrent `up`,
  `down`, and `record-attestor` mutations are explicitly refused by its lifecycle
  lock; status is read-only and does not take that lock.
- **Treasury = authority on localnet.** `initialize_protocol` requires a system-account
  treasury to co-sign at init; localnet reuses the authority key for it. Devnet/mainnet
  use a distinct human-held treasury (see `scripts/devnet-deploy.md`).
- **Logs.** Validator output lands in `.localnet/logs/validator.log`; `up` prints the
  tail automatically when startup fails.
- **Missing lifecycle evidence fails closed.** An existing ledger is never
  recursively removed when neither a valid `validator.stopped` marker nor a
  valid `validator.starting` pre-spawn intent exists. Missing state is not proof
  that a live validator released the ledger. A normal `localnet-down` preserves
  the stopped marker; a fresh precommit crash preserves the starting marker; and
  purge preserves both until recursive ledger removal and its parent-directory
  sync succeed. Lock release is
  automatic only after every duplicated open-file descriptor closes; before
  commit, the guardian deliberately delays that release until the exact child is
  reaped. This guarantee covers validators managed by these scripts; a same-user
  process launched manually outside the rail must not reuse this private ledger.

## Verified run (2026-06-09, this machine)

Real transcript of the full stack — boot, seed, local attestor, the first-hire
example over the seam, a seeded-listing hire driven to settlement, status, down.
Output trimmed; throwaway local addresses only, never key material.

> Historical evidence: this run predates the production-frozen initializer and
> the exact status rail. To reproduce the operational workflow now, add
> `--dev-ready`; the current status output shape is shown near the end of the
> transcript. Plain `localnet-up` is intentionally paused and cannot be seeded.

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
  PORT=4174 node --import tsx server/index.ts &
  node <protocol-repo>/scripts/localnet-record-attestor.mjs $! # exact process identity
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
treasury delta: 50000 lamports (exactly the 500 bps protocol fee)
provider authority delta: +940000 lamports (950000 payout - 2 tx fees)
# 4.6s wall clock, end to end

$ node scripts/localnet-status.mjs
[OK  ] environment: <repo>/.localnet/env.json
[OK  ] stack binding: rpc=http://127.0.0.1:8899 sha256=<exact .so SHA-256> size=<exact bytes> method=private-unlinked-fd-v1
[OK  ] validator process: pid 2995404 (recorded <canonical timestamp>)
[OK  ] sdk dist: <repo>/packages/sdk-ts/dist/index.js
[OK  ] local identities: authority=<address> moderator=<address> seeder=<address>
[OK  ] rpc health: http://127.0.0.1:8899 health=ok slot=936 solana=3.0.13
[OK  ] program account: HJsZ...w1xK owner=BPFLoaderUpgradeab1e11111111111111111111111 links=<ProgramData PDA>
[OK  ] ProgramData: <ProgramData PDA> exact executable and authority verified
[OK  ] ProtocolConfig: ... protocolFeeBps=500 minAgentStake=1000000 ... multisig=2/3 ...
[OK  ] ModerationConfig: ... moderationAuthority=<moderator> enabled=true
[OK  ] BidMarketplaceConfig: ... minBidBondLamports=1000000 ... noShowSlashBps=1000
[OK  ] marketplace readiness: unpaused at reviewed surface revision 5
[ -- ] attestor: configured at http://127.0.0.1:4174/api/sandbox/attest; no read-only authenticated health contract
[ -- ] fixtures: .localnet/fixtures.json (seeded=true, listings=10)
[OK  ] validator stability: exact process remained live through all RPC checks
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
This is also historical evidence; use `localnet-up --dev-ready` for its current
operational equivalent.

```console
# 1. boot + seed (18.3s + 28.3s)
$ node scripts/localnet-down.mjs --purge && node scripts/localnet-up.mjs --dev-ready
localnet is up (18.3s total).
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
$ node <repo>/scripts/localnet-record-attestor.mjs "$!"
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
$ node scripts/localnet-down.mjs
storefront stopped / validator stopped (SIGTERM)
```
