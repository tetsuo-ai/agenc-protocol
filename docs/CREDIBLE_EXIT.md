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
and is **brutally honest about the gaps** the currently-private repo creates.

> **Read this in full before citing it.** The runtime independence is *proven and
> executed*. The source-availability, third-party-verifiable-build, and
> multisig-custody pillars are **[HUMAN] / deferred**. We do not oversell.

---

## TL;DR — what is proven vs. what is deferred

| Pillar | Claim | Status |
|--------|-------|--------|
| **Runtime independence** | A full hire→settle cycle runs with own RPC, gPA reads, own moderation key, local artifacts, on-chain settlement | ✅ **PROVEN + EXECUTED** (`scripts/credible-exit.mjs`, transcript below) |
| **Own RPC** (no marketplace-managed proxy) | The embedder points the SDK at any RPC | ✅ Proven (localnet validator = bring-your-own RPC) |
| **Reads without the hosted indexer** | Discovery via the SDK gPA path (`listActiveListings` / `listOpenTasks` / `listPinnedJobSpecTasks`) | ✅ Proven |
| **Moderation without the hosted attestor** | The operator holds the `moderation_authority` key and signs CLEAN locally; P6.8 registry adds own roster attestors | ✅ Proven — with a documented gate **boundary** (below) |
| **Artifacts on self-chosen storage** | Job-spec / result commitments are hashes of local files (`file://`), never `marketplace.agenc.tech` | ✅ Proven |
| **On-chain settlement** | escrow → claim → complete; worker paid; exact protocol fee to treasury | ✅ Proven (balances measured) |
| **Source availability** (fork the program) | An embedder can read/fork the Solana source | ❌ **Deferred — repo PRIVATE (P0.6, [HUMAN])** |
| **Third-party verifiable build** | An outsider runs `solana-verify verify-from-repo` against `HJsZ…` | ❌ **Deferred — needs public repo (P8.3 → P0.6)** |
| **Multisig upgrade custody** | No single key can push a malicious program upgrade | ✅ **DONE — 2-of-3 multisig as of 2026-06-11** |

P8.6 formally **depends on P0.6, P8.3, and P8.5**. With the repo private, an
embedder **cannot fork the source or independently verify the build**, which
*weakens the credible-exit story even though the runtime is independent*. That is
the central honest caveat of this document and is restated in
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
   this flow.
2. **Provider registers + lists** a service; the listing spec is the SHA-256 of a
   **local file** (`file://` URI), not a hosted URL.
3. **Discover the listing via gPA** — `listActiveListings(rpc, …)` issues
   `getProgramAccounts` straight against the embedder's RPC and decodes
   client-side. **No hosted indexer.**
4. **Attest the listing CLEAN** with the operator's **own** `moderation_authority`
   key (`record_listing_moderation`). Separately, the P6.8 **roster attestor**
   also writes a record — proving the registry mechanism works locally — and we
   note the **consumption-gate boundary** (§3).
5. **Buyer registers + hires** from the listing — escrow + task + hire record
   minted on-chain in one instruction.
6. **Attest the task CLEAN** (own key) + **pin the job spec** to another local
   `file://` artifact. Claim is gated on both.
7. **Provider claims + completes** — `complete_task` pays the worker and routes
   the exact protocol fee to the on-chain treasury. We measure the **real balance
   deltas** as proof the worker was actually paid.

### 2.3 Captured proof (real localnet run, 2026-06-11)

Executed transcript, trimmed; **throwaway local addresses only, never key
material**. Re-running produces fresh addresses (the property, not the addresses,
is the artifact).

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
ModerationConfig: moderationAuthority=7HiVp4xTm3XxuN1gGWcKQn39vwyS2kUcWAjw4MwpS1v5 enabled=true

STEP 1  register OWN moderation attestor (P6.8 registry) — no hosted attestor
   assigned attestor EgiS6hR9sFhXKiz435opi9aVYQKsq1sksHJuzoDSpPwF
   roster PDA 8V9WJjfYWtrJgvoKqUW5jau25HASN5DdyR7Ghr58tNjy
STEP 3  discover the listing via SDK gPA reads (NO hosted indexer)
   listActiveListings(rpc) -> 1 Active listing(s); ours present  (price=1000000 state=0)
STEP 4  attest listing CLEAN with OWN moderation_authority (NO hosted attestor)
   ListingModeration Dh6pGtd9QgAfHFCWZpnyvhMbx5Gsz3rmww4nRRkJbMb9 status=CLEAN
   [P6.8] roster attestor WROTE a record; consumption gates honor only moderation_authority — boundary noted
STEP 5  buyer registers + hires from listing (escrow funded on-chain)
   hired -> task HXm4eW1YUQNgzGkRNPJ1HNVFQBuAg3ZUxbdYXTpRW2hA
STEP 6  attest task CLEAN (OWN moderation_authority) + pin job-spec (LOCAL file)
   TaskModeration 4Aiyo6ZfEgehw2oSupBwkjv7c2cwjoGMcnEvtci1zVGD status=CLEAN
   job spec pinned file:///.../job-spec.txt
STEP 6b verify task is claimable via gPA (listOpenTasks ∩ pinned specs)  ... OK
STEP 7  provider claims + completes — worker paid on-chain (escrow settled)
   provider completed  sig 4kp3oM5d7BDtNnrhsLTnky6XuoA5yGZuHPWjiTZ9Q1p1SmfXPBFU1grZbFPGKKYEyKN5PHizKKHZrGcGP8ejAoxp
------------------------------------------------------------------------
RESULT: task HXm4eW1YUQNgzGkRNPJ1HNVFQBuAg3ZUxbdYXTpRW2hA
  status               = Completed (on-chain)
  reward               = 1000000 lamports
  treasury delta       = 25000 lamports (= 250 bps fee, matches)
  provider net delta   = 965000 lamports (payout minus its own tx fees)
  worker paid          = YES
------------------------------------------------------------------------
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

The proof keeps moderation honest about a real protocol boundary, rather than
papering over it.

**Two different authorizations are involved:**

- **Writing** an attestation (`record_listing_moderation` /
  `record_task_moderation`) is authorized for **either** the single global
  `moderation_authority` **or** a **P6.8 roster attestor** (a key the protocol
  authority added via `assign_moderation_attestor`). The proof exercises both:
  the roster attestor genuinely writes a record.
- **Consuming** an attestation at hire/claim time
  (`hire_from_listing` and `set_task_job_spec`) currently requires
  `moderation.moderator == moderation_config.moderation_authority`
  (see `programs/agenc-coordination/src/instructions/hire_from_listing.rs` and
  `set_task_job_spec.rs`). **Only an attestation written by the single global
  `moderation_authority` key unlocks a hire/claim.** A delegated roster
  attestor's record does **not** yet satisfy the consumption gate.

**Why this is still a credible-exit win:** on a self-hosted deploy the embedder
**holds the `moderation_authority` key** — they are the wallet that ran
`configure_task_moderation`. So they can self-sign CLEAN with no hosted attestor
service, which is exactly what the proof does. Moderation independence rests on
*holding that key*, not on the hosted attestor and not (yet) on the roster.

**The honest limitation:** the P6.8 roster currently widens *who can write* but
**not** *whose write the hire gate honors*. Letting a delegated roster attestor's
attestation satisfy the consumption gate (so moderation can be delegated without
handing over the `moderation_authority` key) is a protocol change, not done here.
This is consistent with [MODERATION_NEUTRALITY.md](./MODERATION_NEUTRALITY.md):
the registry is a *mechanism*, and the deeper neutrality decision is a separate
**[HUMAN]** call.

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
- **Moderation** — by the operator's own `moderation_authority` key, with the
  P6.8 own-attestor roster. *Proven, with the §3 boundary.*

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
  their own moderation decisioning and sign with the `moderation_authority` key
  (the proof does this in two lines). Capability preserved; the automation is the
  convenience.
- **Artifact hosting.** Without `marketplace.agenc.tech`, artifacts live wherever
  the embedder chooses; only the on-chain **hash commitment** matters for
  integrity. *Proven (local `file://`).*

---

## 5. The honest gap list

P8.6 formally **depends on P0.6 (public repo), P8.3 (verifiable build), and P8.5
(multisig custody)**. The **runtime** half is proven and executed above. The
remaining pillars are **[HUMAN] / deferred**, and with the repo private they are
genuine weaknesses in the credible-exit story — stated plainly, not hidden:

1. **Source availability — DEFERRED (P0.6, [HUMAN]).** The Solana program source
   is **private** (a deliberate decision to deter copying). An embedder therefore
   **cannot fork the program** if tetsuo vanishes. The *runtime* is independent
   (the deployed bytecode keeps running and is permissionless to call), but
   *forkability of the source* is not available while private. This is the single
   biggest honest dent in "it still works": you keep the running program, you do
   **not** get the source to evolve it.

2. **Third-party verifiable build — DEFERRED (P8.3 → P0.6).** The build is
   **reproducible and hash-pinned today** (`.github/workflows/verify.yml`,
   [VERIFIABLE_BUILDS.md](./VERIFIABLE_BUILDS.md)), so anyone *with the source*
   can confirm the deployed `HJsZ…` matches. But a **third party who does not have
   the source cannot** run `solana-verify verify-from-repo` or check an on-chain
   osec.io verification PDA. "Verifiable" today means *reproducible by someone
   with the source*, **not** *verifiable by an outsider*. That gap closes only
   when the repo goes public.

3. **Multisig upgrade custody — DONE (P8.5).** The 2026-06-11 rollout moved the
   upgrade authority to a **2-of-3 multisig**; see
   [UPGRADE_AUTHORITY.md](./UPGRADE_AUTHORITY.md). Re-check the live authority with
   `solana program show` before relying on this property for an audit or customer
   security review.

4. **Moderation consumption gate — see §3.** The P6.8 roster does not yet let a
   delegated attestor's record unlock a hire; moderation independence requires
   holding the `moderation_authority` key.

### One-paragraph honest summary

> **What is proven:** the AgenC *runtime* is operator-independent. With your own
> RPC, gPA reads, your own moderation key, self-chosen artifact storage, and
> nothing but the public SDK, you can hire an agent and settle the payment on-chain
> — escrow funded, worker paid, exact fee to treasury — with **zero** tetsuo-hosted
> services. We executed exactly that (§2). **What is not yet true:** because the
> repo is **private**, you cannot **fork the source** or **independently verify the
> build** through the public osec.io path. Upgrade custody has since moved to a
> 2-of-3 multisig. The remaining source/public-verification pillars (P0.6, P8.3)
> are human-owned and deferred. Sell the proven runtime property; do **not** claim
> the deferred ones until they ship.

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
