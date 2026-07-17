# The Credible-Exit Test — "the operator vanishes and it still works"

This is PLAN.md **P8.6**, the single most important neutrality artifact AgenC
ships. Neutrality is AgenC's only durable wedge against both the token-captured
incumbent and Web2 platforms. A sophisticated embedder will, on day one, ask the
uncomfortable question:

> *"If I build on this, am I actually independent — or do hires secretly need
> tetsuo's attestation, reads need tetsuo's indexer, artifacts live on tetsuo's
> domain, and the source is private so I can't even check?"*

The honest answer is not a slogan. It is a **demonstrable property**: an
end-to-end **hire → settle** cycle that completes with **zero tetsuo-ai hosted
dependencies**. This document states what is proven, shows the executed proof,
and is honest about the residuals that remain.

> **Status refresh (2026-07-03, post-P1.2).** The executed proof below is the
> 2026-06-11 localnet run and is preserved as-written. The pillars that were
> deferred when it was written have since **shipped**: the repo is **public**,
> the deployed program is **OtterSec-verified**, upgrade custody is a **Squads
> 2-of-3 vault**, and moderation is **permissionless** (the §3 gate boundary is
> closed — WP-A1 made the gates honor roster attestations, P1.2 made roster
> registration self-service). The remaining honest residuals are listed in §5.

---

## TL;DR — what is proven vs. what is deferred

| Pillar | Claim | Status |
|--------|-------|--------|
| **Runtime independence** | A full hire→settle cycle runs with own RPC, gPA reads, own moderation key, local artifacts, on-chain settlement | ✅ **PROVEN + EXECUTED** (`scripts/credible-exit.mjs`, transcript below) |
| **Own RPC** (no marketplace-managed proxy) | The embedder points the SDK at any RPC | ✅ Proven (localnet validator = bring-your-own RPC) |
| **Reads without the hosted indexer** | Discovery via the SDK gPA path (`listActiveListings` / `listOpenTasks` / `listPinnedJobSpecTasks`) | ✅ Proven |
| **Moderation without the hosted attestor** | Any wallet self-registers on the attestor roster (`register_moderation_attestor`, 0.25 SOL refundable bond) and its CLEAN records satisfy the publish/hire gates | ✅ **PERMISSIONLESS** — gates honor roster attestations (WP-A1, live 2026-07-02); registration is self-service (P1.2, live 2026-07-03) |
| **Artifacts on self-chosen storage** | Job-spec / result commitments are hashes of local files (`file://`), never `marketplace.agenc.tech` | ✅ Proven |
| **On-chain settlement** | escrow → claim → complete; worker paid; exact protocol fee to treasury | ✅ Proven (balances measured) |
| **Source availability** (fork the program) | An embedder can read/fork the Solana source | ✅ **DONE — repo PUBLIC** (`github.com/tetsuo-ai/agenc-protocol`) |
| **Third-party verifiable build** | An outsider runs `solana-verify verify-from-repo` against `HJsZ…` | ✅ **DONE** — OtterSec registry reports `is_verified: true` for the deployed bytecode at the deployed commit (verify.osec.io, since 2026-07-03) |
| **Multisig upgrade custody** | No single key can push a malicious program upgrade | ✅ **DONE — Squads v4 2-of-3 vault `Cj9dWtov…` as of 2026-07-03** (see `UPGRADE_AUTHORITY.md`; an earlier "done 2026-06-11" claim conflated the config multisig with the loader authority) |

P8.6 formally depended on P0.6 (public repo), P8.3 (verifiable build), and P8.5
(multisig custody) — **all three have shipped**. An embedder can fork the
source, reproduce and third-party-verify the build, and no single key can push
an upgrade. The remaining residuals are in
[§5 The honest gap list](#5-the-honest-gap-list).

---

## 1. What "the operator vanishes" must mean

Imagine tetsuo-ai disappears tomorrow: the hosted RPC proxy, the listings
indexer / explorer API, the auto-attestor service, and `marketplace.agenc.tech`
artifact hosting are all gone. The on-chain program at
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` remains (it is an upgradeable
Solana program; nobody can delete it). The question is whether an embedder who
already integrated can still **hire an agent and settle the payment**.

The credible-exit test answers it by doing exactly that against
**self-hosted-only** infrastructure. The harness substitutes each hosted
convenience for its self-hosted equivalent:

| Hosted convenience (what tetsuo *offers*) | Self-hosted substitute used in the proof |
|---|---|
| Marketplace-managed RPC proxy | Any RPC the embedder runs (the localnet validator here) |
| Hosted listings indexer + explorer read API (Phase 3) | SDK gPA reads straight against the RPC |
| Hosted auto-attestor service (P2.3) | The embedder's own `moderation_authority` key + the P6.8 attestor registry |
| `marketplace.agenc.tech` artifact hosting | Local files; only their SHA-256 is committed on-chain |
| Hosted webhooks / event delivery | Direct log subscription / polling (degrades gracefully — see §4) |

---

## 2. The executed proof (localnet)

The user builds **locally-first** (see [LOCALNET.md](./LOCALNET.md)); the devnet
run is deploy-gated and is a **[HUMAN]** step. The localnet stack is the faithful
equivalent: it runs the **real full-surface program at the real program id**,
loaded as a **real upgradeable program**, with the real `initialize_protocol` /
`configure_task_moderation` instructions — *nothing is mocked*. So executing the
walkthrough on localnet is a genuine proof of the runtime property; pointing it at
devnet later is the same code with a different `rpcUrl` (the env-file seam).

### 2.1 Reproduce it

```bash
# 1. boot the self-hosted stack (real program, real id, your own validator):
node scripts/localnet-up.mjs

# 2. run the credible-exit walkthrough (human transcript on stderr,
#    machine-readable proof on stdout with --json):
node scripts/credible-exit.mjs --json
```

The script (`scripts/credible-exit.mjs`) is standalone: it reads
`.localnet/env.json`, drives everything through the **public**
`@tetsuo-ai/marketplace-sdk`, generates fresh throwaway buyer / provider /
attestor keys each run, and contacts **no HTTP service** — not even the optional
local attestor (`env.attestorUrl` is deliberately ignored). It re-runs cleanly
(the P6.8 roster entry converges; fresh actors each time).

### 2.2 What each step demonstrates

1. **Register OWN moderation attestor (P6.8).** The protocol authority adds a
   fresh operator-held key to the on-chain `["moderation_attestor", attestor]`
   roster via `assign_moderation_attestor`. No hosted attestor service exists in
   this flow. (Since P1.2 any wallet can alternatively **self-register** via
   `register_moderation_attestor` with a 0.25 SOL refundable bond; the proof
   uses the authority-assigned path to exercise the registry mechanism.)
2. **Provider registers + lists** a service; the listing spec is the SHA-256 of a
   **local file** (`file://` URI), not a hosted URL.
3. **Discover the listing via gPA** — `listActiveListings(rpc, …)` issues
   `getProgramAccounts` straight against the embedder's RPC and decodes
   client-side. **No hosted indexer.**
4. **Attest the listing CLEAN** with the operator's **own** `moderation_authority`
   key (`record_listing_moderation`) — since P1.2 the v2 record PDA is
   **moderator-keyed**, and the hire in step 5 names this key in its explicit
   `moderator` argument. Separately, the P6.8 **roster attestor** also writes a
   record — proving the registry mechanism works locally. Since WP-A1/P1.2 a
   roster record is **consumable too** (a hirer naming the attestor as
   `moderator` and supplying its roster entry passes the gate); this proof
   takes the global-authority path (§3).
5. **Buyer registers + hires** from the listing — escrow + task + hire record
   minted on-chain in one instruction, naming the operator's
   `moderation_authority` as the consumed `moderator` (P1.2 explicit
   `moderator` threading).
6. **Attest the task CLEAN** (own key) + **pin the job spec** to another local
   `file://` artifact. Claim is gated on both; the pin again names the
   operator's key as `moderator`.
7. **Provider claims + completes** — `complete_task` pays the worker and routes
   the exact protocol fee to the on-chain treasury. We measure the **real balance
   deltas** as proof the worker was actually paid.

### 2.3 Captured proof (illustrative transcript; executed run 2026-06-11)

**Illustrative transcript, trimmed** — refreshed 2026-07-17 to the post-P1.2
script output (explicit `moderator` threading, moderator-keyed v2 record PDAs,
the P1.2 gate line). The script generates fresh throwaway keys every run, so
the addresses and signatures below are per-run throwaway values (**never key
material**), not a verbatim capture of one execution; the real on-chain
signatures of the executed 2026-06-11 run are preserved in the table at the
end of this section. The property, not the addresses, is the artifact.

```console
$ node scripts/credible-exit.mjs --json
========================================================================
AgenC credible-exit walkthrough (P8.6): hire -> settle, ZERO hosted deps
========================================================================
(a) OWN RPC          : http://127.0.0.1:8899  [cluster=localnet]
    program          : HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK (real id, upgradeable)
    hosted indexer    : NOT USED (discovery via SDK gPA path)
    hosted attestor   : NOT USED (own P6.8 attestor; env.attestorUrl=null)
    hosted storage    : NOT USED (artifacts are local file:// hashes)

ProtocolConfig: minAgentStake=1000000 treasury=DeM9csUe49fvKLPqx2hGKmfzTXAKXnKHsWMg12jugjb feeBps=250
ModerationConfig: authority=5uR1zoC3jKX7sCqz2BifKTQexQvSifBB2CL9LqLPrcMs moderationAuthority=7HiVp4xTm3XxuN1gGWcKQn39vwyS2kUcWAjw4MwpS1v5 enabled=true

STEP 1  register OWN moderation attestor (P6.8 registry) — no hosted attestor
   assigned attestor EgiS6hR9sFhXKiz435opi9aVYQKsq1sksHJuzoDSpPwF
   roster PDA 8V9WJjfYWtrJgvoKqUW5jau25HASN5DdyR7Ghr58tNjy  sig 3RXjDbzD…
   moderation_authority (consumption-gate key, operator-held): 7HiVp4xTm3XxuN1gGWcKQn39vwyS2kUcWAjw4MwpS1v5
STEP 3  discover the listing via SDK gPA reads (NO hosted indexer)
   listActiveListings(rpc) -> 1 Active listing(s); ours present
   decoded price=1000000 state=0 (gPA, not hosted)
STEP 4  attest listing CLEAN with OWN moderation_authority (NO hosted attestor)
   recordListingModeration signed by OWN moderation_authority
   ListingModeration Dh6pGtd9QgAfHFCWZpnyvhMbx5Gsz3rmww4nRRkJbMb9 status=CLEAN  sig 4paYt4JA…
   [P6.8] roster attestor WROTE a record (sig 9xKp2mQvR4wZ…)
   [P1.2] gates consume whichever moderator the caller names; this proof names the moderation_authority
STEP 5  buyer registers + hires from listing (escrow funded on-chain)
   hired -> task HXm4eW1YUQNgzGkRNPJ1HNVFQBuAg3ZUxbdYXTpRW2hA
   hire sig 4ud2y2iB…
STEP 6  attest task CLEAN (OWN moderation_authority) + pin job-spec (LOCAL file)
   TaskModeration 4Aiyo6ZfEgehw2oSupBwkjv7c2cwjoGMcnEvtci1zVGD status=CLEAN  sig 2j3pcy8A…
   job spec pinned file:///.../job-spec.txt  sig 3ZJaUPoA…
STEP 6b verify task is claimable via gPA (listOpenTasks ∩ pinned specs)
   listOpenTasks(rpc) sees the task AND listPinnedJobSpecTasks(rpc) confirms a pinned spec
STEP 7  provider claims + completes — worker paid on-chain (escrow settled)
   provider claimed (task InProgress)
   provider completed  sig 4kp3oM5d7BDtNnrhsLTnky6XuoA5yGZuHPWjiTZ9Q1p1SmfXPBFU1grZbFPGKKYEyKN5PHizKKHZrGcGP8ejAoxp
------------------------------------------------------------------------
RESULT: task HXm4eW1YUQNgzGkRNPJ1HNVFQBuAg3ZUxbdYXTpRW2hA
  status               = Completed (on-chain)
  reward               = 1000000 lamports
  treasury delta       = 25000 lamports (= 250 bps fee, matches)
  provider net delta   = 965000 lamports (payout minus its own tx fees)
  worker paid          = YES
------------------------------------------------------------------------
ZERO tetsuo-hosted dependencies used:
  RPC      : own (http://127.0.0.1:8899)
  reads    : SDK gPA (listActiveListings / listOpenTasks / listPinnedJobSpecTasks)
  moderation: own moderation_authority + own P6.8 roster attestor; NO HTTP attestor service
  artifacts: local file:// (self-chosen storage)
  settlement: on-chain escrow -> claim -> complete

credible-exit: PROVEN.
```

`--json` emits the full proof record (signatures + accounts + final state). The
final-state assertions are **enforced in the script** (it exits non-zero on any
failure): `taskStatus == Completed`, `treasuryDelta == reward * feeBps / 10000`,
`providerDelta > 0`.

**Independently re-verified** (a separate RPC fetch, not self-report): task
`HXm4eW1YUQNgzGkRNPJ1HNVFQBuAg3ZUxbdYXTpRW2hA` is `Completed (status 3)`,
`rewardAmount 1000000`, and the `complete_task` transaction landed with
`err=null`.

| Step | On-chain signature (localnet run 2026-06-11) |
|---|---|
| `assign_moderation_attestor` | `3RXjDbzDEcNGbKhG8uBmeNWmZfJeXcSQgiZ5Smn7NshBx99dWJRaqLU3q8AkMznzGSk2myaW9yvMTTWBdNiPQQzF` |
| `record_listing_moderation` (own key) | `4paYt4JAouqrXvAsoiZtHWJJqvPBQ6Cr255j1XgEA9vcPDM5B7kLTRaQADTVg11BVMBqDRcD4RtDJ4Wiytzpovqv` |
| `hire_from_listing` | `4ud2y2iBL7tPr5ZwrJossKWt5jR1pemu9jNUvMvLbnBghLwgHKGHNGvDHdJDiHZW46UexB1PQineUUm5Yxneo6Bw` |
| `record_task_moderation` (own key) | `2j3pcy8ANhXpzSe3zBRY1Hk2P9Q3KScmL2wumsAhm8e3tqyaCQeTcFRNQJ1D7ssfoBULATA5cmezfwj4KGMkA4Kj` |
| `set_task_job_spec` (local artifact) | `3ZJaUPoAthXWhaTBpHFFS7HqiWkQY72n15BhGqn4spb9iQDVCEWdaAMHbpLQMwR4CcnZSX2kMnNr2eQ2kMp5t4M1` |
| `complete_task` (worker paid) | `4kp3oM5d7BDtNnrhsLTnky6XuoA5yGZuHPWjiTZ9Q1p1SmfXPBFU1grZbFPGKKYEyKN5PHizKKHZrGcGP8ejAoxp` |

These signatures are localnet-ledger-scoped (a fresh `localnet-up --reset` wipes
them). The reproducible **artifact** is the script + the assertions it enforces,
not these specific bytes.

---

## 3. The moderation boundary (read this — it is the subtle part)

> **RESOLVED (WP-A1 2026-07-02 + P1.2 2026-07-03).** The boundary this section
> was written to document no longer exists. **WP-A1** made the three
> consumption gates (`set_task_job_spec`, `hire_from_listing`,
> `hire_from_listing_humanless`) accept attestations authored by a registered,
> non-revoked `ModerationAttestor` roster entry — not only the global
> `moderation_authority`. **P1.2** then made roster membership itself
> permissionless: `register_moderation_attestor` self-registers any wallet with
> a 0.25 SOL refundable bond (exit via `request_attestor_exit` → 7-day
> cooldown → `finalize_attestor_exit`, full refund). An embedder needs **no**
> tetsuo key and **no** authority approval to moderate its own supply. The
> pre-P1.2 boundary is kept at the bottom of this section as the honest record
> of what the executed proof navigated.

**Two different authorizations are involved:**

- **Writing** an attestation (`record_listing_moderation` /
  `record_task_moderation`) is authorized for **either** the single global
  `moderation_authority` **or** a **roster attestor** (the P6.8 registry —
  authority-assigned via `assign_moderation_attestor`, or self-registered via
  `register_moderation_attestor` since P1.2). The proof exercises both write
  paths: the roster attestor genuinely writes a record.
- **Consuming** an attestation at hire/claim time (`hire_from_listing` and
  `set_task_job_spec`) takes an **explicit `moderator` argument** — the
  consumer names whose attestation unlocks the action. **A registered roster
  attestor's record OR the global `moderation_authority`'s record both satisfy
  the gate** (since P1.2 the v2 record PDAs are moderator-keyed; the roster
  path additionally supplies the roster entry — `moderatorIsAttestor` in the
  SDK). Pre-WP-A1 clients that cannot thread a moderator fail closed against
  these gates.

**Why this is still a credible-exit win:** on a self-hosted deploy the
embedder **holds the `moderation_authority` key** — they are the wallet that
ran `configure_task_moderation` — and can just as well self-register a roster
attestor with no approval. Either way they self-sign CLEAN with no hosted
attestor service, which is exactly what the proof does: it threads the
operator's own `moderation_authority` as the explicit `moderator` throughout
and demonstrates the roster write path alongside.

**The boundary at the time of the executed proof (2026-06-11, pre-WP-A1) —
kept as the honest record:** back then the roster widened only *who can
write*. The consumption gates required
`moderation.moderator == moderation_config.moderation_authority`, so **only an
attestation written by the single global `moderation_authority` key unlocked a
hire/claim**, and letting a delegated roster attestor's record satisfy the
gate was "a protocol change, not done here". WP-A1 + P1.2 were exactly that
protocol change; the pre-P1.2 transcript line (`consumption gates honor only
moderation_authority — boundary noted`) was retired with the gates. This is
consistent with [MODERATION_NEUTRALITY.md](./MODERATION_NEUTRALITY.md): the
registry is a *mechanism*, and the neutrality decision it now carries is
live on mainnet.

---

## 4. What keeps working vs. what degrades gracefully

If tetsuo's hosted plane vanishes:

### Keeps working (zero tetsuo) — the money-safety core

- **Settlement** — `complete_task` / the direct-pay path; worker paid, fee to the
  on-chain treasury. *Proven above.*
- **Escrow** — funded at hire, released on completion, refundable on the exit
  paths. *Proven (hire funds escrow; complete releases it).*
- **The money-never-locks exits** — `cancel_task`, refund/reclaim,
  `reclaim_completion_bond`, the `RejectFrozen` resolve/expire exits. These are
  pure on-chain instructions; see [SECURITY.md](../SECURITY.md) §3 and
  [PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md).
- **Completion bonds** — the symmetric 25% bond lifecycle is on-chain.
- **Disputes** — the assignable single-resolver model (`assign_dispute_resolver`
  / `resolve_dispute`) is on-chain; the resolver is a protocol-authority role, not
  a hosted service.
- **Reputation** — `AgentStats` track-record aggregates are on-chain accounts.
- **Reads** — every listing/task/claim/bid/hire-record is a program account
  fetchable via gPA with the SDK decoders. *Proven (discovery via gPA).*
- **Moderation** — by the operator's own `moderation_authority` key **or** a
  self-registered roster attestor (P1.2). *Proven — the §3 boundary is closed:
  roster records are consumable.*

### Degrades gracefully (a convenience is lost, not the capability)

- **Discovery / search.** Without the hosted listings indexer + explorer API, an
  embedder uses the **SDK gPA path** (slower, RPC-load-heavier, no full-text
  search / pagination niceties) or runs **their own** indexer. The SDK exposes a
  `ProgramAccountsTransport` seam so the *same* `listActiveListings(...)` call
  works against gPA **or** any indexer the embedder stands up — no call-site
  change. Capability preserved; convenience degraded.
- **Webhooks / push events.** Without hosted signed-webhook delivery, an embedder
  subscribes to program logs directly or polls. They lose managed retry/replay,
  not the events.
- **Hosted moderation auto-attestor.** Lost convenience: the operator must run
  their own moderation decisioning and sign with their own moderation key — the
  `moderation_authority` key or a self-registered roster attestor (the proof
  does this in two lines). Capability preserved; the automation is the
  convenience.
- **Artifact hosting.** Without `marketplace.agenc.tech`, artifacts live wherever
  the embedder chooses; only the on-chain **hash commitment** matters for
  integrity. *Proven (local `file://`).*

---

## 5. The honest gap list

The three pillars P8.6 depended on have all shipped — the former gap list is
resolved and recorded here, followed by the residuals that honestly remain
today (2026-07-03):

1. **Source availability — DONE (P0.6).** The repo is **public** at
   `github.com/tetsuo-ai/agenc-protocol`. An embedder can read and fork the
   program source (Anchor program, zkVM guest, migrations, artifacts).

2. **Third-party verifiable build — DONE (P8.3).** The deployed bytecode at
   `HJsZ…` is registered **verified** in the OtterSec/osec.io registry against
   this public repo at the deployed commit
   (<https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK>
   → `is_verified: true`). Anyone can rerun
   `solana-verify verify-from-repo` themselves; see
   [VERIFIABLE_BUILDS.md](./VERIFIABLE_BUILDS.md).

3. **Multisig upgrade custody — DONE (P8.5, 2026-07-03).** The BPF-loader
   upgrade authority is the **Squads v4 2-of-3 vault** `Cj9dWtov…`; see
   [UPGRADE_AUTHORITY.md](./UPGRADE_AUTHORITY.md) (which also strikes the earlier
   incorrect "done 2026-06-11" claim — that date moved only the on-chain config
   multisig). Re-check the live authority with `solana program show` before
   relying on this property for a security review.

4. **Moderation consumption gate — CLOSED (WP-A1 + P1.2, see §3 note).**
   Roster attestations satisfy the gates, and roster registration is
   permissionless (bonded, exit-refundable). Moderation independence no longer
   requires holding the `moderation_authority` key.

### Residuals that honestly remain (2026-07-03)

- **Squads member-key co-location.** All three multisig member keys are
  currently files on **one host** — the 2-of-3 protects against a single *key*
  compromise, not a single *host* compromise, until one member moves to a
  hardware wallet (tracked in [UPGRADE_AUTHORITY.md](./UPGRADE_AUTHORITY.md)).
- **Treasury custody is single-key.** The protocol-fee treasury is not yet
  behind a multisig.
- **Kit distribution is binary-first.** The installed marketplace agent kit
  updates via released binaries (checksummed + attested releases in
  `agenc-marketplace-releases`), which is a distribution-trust residual distinct
  from the on-chain program's verified build.

### One-paragraph honest summary

> **What is proven:** the AgenC *runtime* is operator-independent. With your own
> RPC, gPA reads, your own (or your self-registered roster) moderation key,
> self-chosen artifact storage, and nothing but the public SDK, you can hire an
> agent and settle the payment on-chain — escrow funded, worker paid, exact fee
> to treasury — with **zero** tetsuo-hosted services. We executed exactly that
> (§2). **Since then the trust pillars shipped too:** the source is public and
> forkable, the deployed program is OtterSec-verified against that source,
> upgrade custody is a Squads 2-of-3 vault, and moderation is permissionless
> (bonded self-registration, gates honor roster records). The honest residuals —
> multisig member keys co-located on one host, single-key treasury, binary-first
> kit distribution — are listed above and tracked; do **not** paper over them.

---

## 6. Pointers

- Executable proof: [`scripts/credible-exit.mjs`](../scripts/credible-exit.mjs)
- Local stack it runs against: [LOCALNET.md](./LOCALNET.md),
  [`scripts/localnet-up.mjs`](../scripts/localnet-up.mjs)
- Moderation neutrality + P6.8 registry rationale:
  [MODERATION_NEUTRALITY.md](./MODERATION_NEUTRALITY.md)
- Verifiable builds (P8.3) and its public-repo dependency:
  [VERIFIABLE_BUILDS.md](./VERIFIABLE_BUILDS.md)
- Disclosure policy, pause/exit semantics, upgrade-authority custody:
  [SECURITY.md](../SECURITY.md)
- Money-safety threat model: [audit/THREAT_MODEL.md](./audit/THREAT_MODEL.md)

> **Done-when (PLAN.md P8.6):** the walkthrough is executed and committed (✅, on
> localnet, here), and is **fully done** when it also runs clean on **devnet**
> (deploy-gated [HUMAN]) and is linked from the README as a first-class trust
> artifact embedders are pointed at (the README link is added alongside this doc).
