# P6.4 — Spam / Sybil Defense for the Open-Roster World

> **Historical design record (banner added 2026-07-17).** Dated design document, not current state — see `./MAINNET_MAINLINE.md` for what is live and `./audit/ENTERPRISE_REMEDIATION_2026-07.md` for the completed remediation record.

> **Status:** DESIGN ONLY. No code. Successor workstream to P1.2 (the
> Hardened Open Roster), which shipped on mainnet 2026-07-03 and explicitly
> handed this problem forward (`P1_2_OPEN_ROSTER_SPEC.md` §8: *"The bond is
> not a sybil defense… Real sybil/spam defense is P6.4"*). This document
> enumerates the attack surface with costs at live parameters, catalogues
> what the deployed program already defends, lays out design options, and
> recommends a layered minimal design. The deploy decisions here are
> human-owned Moments (`CLAUDE.md` golden rules).

## 0. One-paragraph framing

Until 2026-07-02 every unit of marketplace work intake transited a single
centralized moderation key, which was *also* — by accident — the network's only
spam and sybil defense. P1.2 deliberately turned the positive (allow) moderation
gate into a **provenance layer**: a hire now consumes whichever CLEAN attestation
the risk-bearing caller *chooses to present*, and anyone can self-register as an
attestor for a fully-refundable 0.25 SOL bond and attest their own supply CLEAN
(`register_moderation_attestor.rs`). That was the correct decentralization move,
but it means the spam/sybil defense that used to be implicit in "only tetsuo can
say CLEAN" no longer exists. This document designs its replacement. The central
finding: **the on-chain program cannot and should not be the spam filter** — the
allow-gate is provenance, the money paths already impose real friction on
*task* spam, and the correct place for spam/quality defense is **surface-side
provenance-weighted discovery** over an on-chain track record, with two small
program-side friction knobs held in reserve behind explicit tripwires.

---

## 1. Threat model (concrete attacks, costed at live parameters)

**Live parameters used throughout** (verified in source, cross-checked against
the WP-B2 mainnet decode in `MEMORY.md`):

| Parameter | Value | Source |
| --- | --- | --- |
| Protocol fee | **5% (500 bps)** live (not the 1% default) | WP-B2 decode; `ProtocolConfig.protocol_fee_bps` |
| Min agent stake | **0.01 SOL**, refundable on deregister | `min_agent_stake`; `register_agent.rs:123` |
| Attestor registration bond | **0.25 SOL** (`250_000_000` lamports), **100% refundable** after cooldown | `constants.rs:105`; `register_moderation_attestor.rs:58` |
| Attestor exit cooldown | **7 days** (`604_800` s) | `constants.rs:110`; `attestor_exit.rs:99` |
| Min listing / skill price | **1000 lamports** (`MIN_SKILL_PRICE`) | `constants.rs:89` |
| Min task reward | **> 0** (any positive lamport) | `create_task.rs:164` |
| Worker settlement floor | **≥ 60% (6000 bps)** to the worker at the fee caps | `constants.rs` `WORKER_FLOOR_BPS` |
| Task-creation rate limit | **50 / 24h**, 60 s cooldown, per-agent AND per-authority-wallet | `constants.rs:120-129`; `rate_limit_helpers.rs` |
| Reputation per completion | **0–100**, proportional to irreversible SOL protocol fee at **1 point / 100,000 lamports**; SPL-token completions earn 0. Start **3000**, max **10000** | `completion_helpers.rs`; `constants.rs`; `register_agent.rs` |
| Rent (rent-exempt min) | `(bytes + 128) * 6960` lamports (≈ 6960 lamports/byte incl. overhead) | Solana rent formula |

Two rent figures matter below:
- **`HireRating`** ≈ 439 bytes → **≈ 0.0040 SOL**, and it has **no close
  instruction** — its rent is **burned permanently** (keyed `["hire_rating",
  task]`, `state.rs:1810`; `rate_hire.rs:97-105`; no `close =` anywhere).
- **`ModerationAttestor`** ≈ 113 bytes → **≈ 0.0017 SOL** rent, refundable via
  `finalize_attestor_exit` (`attestor_exit.rs:65-72`, `close = attestor`).

### (a) Spam listings/tasks self-attested CLEAN by a sybil attestor

**Attack.** Register a `ServiceListing` (or create a task), self-register as a
moderation attestor (0.25 SOL, refundable), `record_listing_moderation` your own
`spec_hash` CLEAN, then `hire_from_listing` presenting yourself as the
`moderator` (`hire_from_listing.rs:406-434`). The hire passes the allow-gate —
because P1.2 makes the caller *choose the underwriter*, and nothing forces that
underwriter to be trusted by anyone.

**Cost.** The bond is refundable, so the *durable* cost of the attestor identity
is a 7-day float on 0.25 SOL (≈ zero at any interest rate) plus ≈ 0.0017 SOL
rent (also refundable). Per spam listing: `create_service_listing` rent (listing
account ≈ 500 B → ≈ 0.0044 SOL, reclaimable if the listing is closed) + one
`ListingModeration` record rent (≈ 0.0017 SOL, `init_if_needed`, reclaimable in
principle but no close path today) + tx fees. **Marginal cost per self-attested
spam listing ≈ 0.005–0.01 SOL (~$1 at $150/SOL), most of it reclaimable rent.**

**What actually stops this:** the edge trust lists (§2). agenc.ag does not trust
this sybil attestor, so the spam listing **does not appear in agenc.ag
discovery** — it is only visible on a surface that chooses to trust the sybil.
The on-chain allow-gate does *not* stop it and is not meant to. This attack is
only a *network* problem if it pollutes a **trusted** surface's discovery, which
reduces to attacks (c) and (d).

### (b) Reputation / rating wash-trading via self-hires

This is the attack the TODO flags: *"one self-hire ≈ one rating today."* Two
distinct on-chain quantities can be washed, with very different costs.

**(b1) Listing rating wash (`rate_hire`).** `rate_hire` folds a buyer's 1–5
score into `listing.total_rating` / `rating_count` (`rate_hire.rs:156-168`). Its
only guards (`rate_hire.rs:144-150`): signer == `task.creator` (the buyer),
task terminal `Completed`, and one rating per task (the `["hire_rating", task]`
init-once PDA). It does **not** check counterparty distinctness beyond the
`hire_from_listing` self-hire guard (`buyer_authority != provider_authority`,
`hire_from_listing.rs:77-80`), so the attacker needs **two** wallets: a provider
(listing owner) and a buyer. Both must be registered agents (0.01 SOL stake
each, refundable).

Cost **per fake 5-star rating**, at a floor-priced hire (`reward = MIN_SKILL_PRICE
= 1000 lamports`), where buyer and provider are the same attacker so the reward
circulates back minus fees:
- Protocol fee: 5% of 1000 = **50 lamports** (kept by protocol) — negligible.
- `HireRating` rent: **≈ 0.0040 SOL, permanently burned** (no close path). This
  is the real floor.
- Task / escrow / `HireRecord` rent: ≈ 0.0044 SOL + 0.0016 + 0.0018 —
  **reclaimable** via `close_task` (`close_task.rs:51`), so not a true cost.
- Tx fees: ~5 signed txns (hire, claim, submit, accept, rate) × 5000 lamports ≈
  **0.000025 SOL**.

**Net burn ≈ 0.004 SOL (~$0.60) per fake rating.** **100 fake 5-star ratings ≈
0.4 SOL (~$60).** This is cheap enough to matter: an attacker can manufacture a
five-star listing history for well under the price of one real job. The
`total_rating`/`rating_count` aggregate on a listing is therefore **not
trustworthy as displayed** without off-chain weighting.

**(b2) Agent reputation farming (`AgentRegistration.reputation`).** This section
was superseded by the 2026-07-18 hardening. A SOL completion now grants one
point per 100,000 lamports of irreversible protocol fee, capped at 100 points;
SPL-token completions grant zero. Dust self-hires therefore grant zero rather
than +100. Moving from the probationary 3000 to the 10000 cap requires at least
**0.7 SOL of protocol fees** (7000 × 100,000 lamports), regardless of how the
attacker splits the work. At the 5% live fee, a full +100 award requires a
0.2-SOL reward and burns 0.01 SOL; 70 such completions burn 0.7 SOL. Adding a
rating to every wash trade still burns the separate HireRating rent discussed
in b1. Raw reputation remains an economic signal rather than proof of distinct
counterparties, but it no longer rides for free on minimum-price work or mixes
unpriced SPL units into SOL economics.

> **Code discovery correcting the problem statement's "one self-hire ≈ one
> rating":** a self-hire produces *both* one listing rating (b1) *and* one
> worker reputation increment (b2) — they are separate on-chain writes with
> different persistence. The permanent-rent burn (b1's `HireRating`, ≈ 0.004
> SOL) is the binding cost for the rating. Reputation (b2) has its own
> irreversible SOL-fee floor and does not ride for free. `rate_hire` does **not** touch `AgentStats` or agent
> reputation (`rate_hire.rs:25-30` — provider-agent aggregate is explicitly
> DEFERRED to P6.3), so listing ratings and agent reputation are today
> **disjoint** signals.

### (c) Sybil attestor farms lending "attested" legitimacy

**Attack.** Stand up N attestor identities (0.25 SOL each, all refundable) that
cross-attest each other's supply CLEAN, and try to get *one* of them onto a
trusted surface's list, or build a plausible-looking "attested by many" veneer
for a naive surface that counts attestors rather than checking *which* attestors.

**Cost.** N × (7-day float on 0.25 SOL + ≈ 0.0017 SOL rent), all recoverable.
**Effectively free at scale.** The bond caps *concurrent* identities per unit
capital (25 identities per 6.25 SOL of working capital held for 7 days) but does
**not** price identity *creation* — P1.2 §4.2 states this honestly.

**What actually stops this:** discovery must weight by *whom a surface trusts*,
never by attestor count. A "10 attestors cleared this" signal is worthless if
all 10 are one entity. This is why the recommendation (§4) forbids any
count-of-attestors ranking primitive.

### (d) Trust-list poisoning / social-layer attack on the default list

**Attack.** Get a malicious attestor added to the on-chain `DefaultTrustList`
(`state.rs:2172`) that agenc.ag and forking surfaces consume by default, or
socially pressure the list maintainers, or exploit a stale list (the maintainer
keys go dark and the list ossifies with a now-compromised attestor still on it).

**Cost / feasibility.** The default list is **multisig-governed on-chain**
(`set_default_trust_list`, `require_multisig_threshold`, 2-of-3 live) — not an
npm key (P1.2 §5.1). So poisoning it requires **compromising 2 of 3 multisig
signers**, not a PR merge. Residual risks are (i) a *legitimate but
later-compromised* attestor already on the list, and (ii) **staleness** — the
list carries `updated_at` as a deadman precisely so surfaces can detect ossific-
ation and fall back to their own list (`state.rs` `DefaultTrustList.updated_at`).
This is the **strongest** structural position of the four attacks: it costs a
multisig compromise, not lamports. The residual is an *operational* trust-curation
discipline (Mozilla-root-store style inclusion/distrust log, P1.2 §5.1), not a
program change.

### (e) Griefing: BLOCK-floor requests and attestor exit/re-register cycling

**(e1) BLOCK-floor griefing.** The BLOCK floor
(`["moderation_block", hash]`, `moderation_gate_helpers.rs:166`) can only be
written by the **multisig** (`set_moderation_block`), and every block requires an
on-chain `rationale_hash` + `rationale_uri` (`state.rs:2126`, the
`resolve_dispute` precedent). **There is no permissionless "request takedown"
surface on-chain**, so there is no lamport-priced griefing vector here — a griefer
cannot spam block requests through the program. (A surface may build an off-chain
report queue; that queue's abuse is a surface problem, not a protocol one.) The
floor is fail-OPEN (`moderation_gate_helpers.rs:164-165`), so a dead multisig
cannot grief-by-omission either.

**(e2) Exit/re-register cycling.** An attestor can `request_attestor_exit` →
wait 7 days → `finalize_attestor_exit` (refund) → `register_moderation_attestor`
(fresh bond) and its **old v2 records unlock the gates again** (P1.2 §9.5:
*"Exit is not a durable retraction"*). This is a griefing/evasion vector against
any surface that treats "attestor exited" as "attestations retracted." Cost:
7-day float per cycle, refundable. **Mitigation is surface-side:** a surface that
trusts an attestor must treat a *re-registered* key as a **new** trust decision
(re-evaluate), and should key its trust on `(attestor, registered_at)` not
`attestor` alone — the `registered_at` field exists for exactly this
(`state.rs` `ModerationAttestor.registered_at`).

### Threat-model summary (cost to attacker)

| # | Attack | Marginal cost | Durable cost | Real defender |
| --- | --- | --- | --- | --- |
| a | Self-attested spam listing | ~0.005–0.01 SOL (mostly reclaimable) | ~0 | Edge trust list (surface doesn't show it) |
| b1 | Fake listing rating | **~0.004 SOL burned** | — | Provenance-weighted discovery |
| b2 | Max a worker's reputation (3000→10000) | **≥0.7 SOL burned as protocol fees** | — | Fee-backed gain + provenance-weighted discovery |
| c | Sybil attestor farm | ~0 (bonds refundable) | 7-day float × N | Trust *which*, never *how many* |
| d | Poison default trust list | **2-of-3 multisig compromise** | — | Multisig + inclusion/distrust log |
| e1 | BLOCK-floor griefing | **no on-chain vector** | — | (n/a — multisig-only write) |
| e2 | Exit/re-register to re-unlock records | 7-day float, refundable | — | Surface keys trust on `(attestor, registered_at)` |

**The economically-cheap attacks (b1, b2, a, c) all resolve at the discovery /
surface layer, not on-chain. The one on-chain-hard attack (d) is already
structurally strong.** That shape drives the recommendation.

---

## 2. What already defends (and exactly what it does NOT cover)

| Primitive | What it does | What it does NOT cover |
| --- | --- | --- |
| **Edge trust lists** (surface-chosen attestor sets; agenc.ag trusts global authority + attest.agenc.ag + env extras) | Protect a **surface's** discovery: a self-attested spam listing (a) is invisible on a surface that doesn't trust its attestor. This is the primary spam defense. | They protect *surfaces*, **not the network**. Every surface must curate its own list; a naive surface that trusts everyone inherits all of (a)/(c). No global spam floor. |
| **BLOCK floor** (`["moderation_block", hash]`, required on all 3 gates, multisig-written, content-hash-keyed) | Reactive, real-time **takedown** of a specific content hash, un-evadable by re-minting under a fresh PDA (`moderation_gate_helpers.rs:170-188`). | It is a **blacklist for known-bad content**, not a spam classifier. It is an **entry gate, not a settlement freeze** (P1.2 §9.5): already-live tasks still settle. It cannot proactively stop novel spam; someone must identify the hash first. |
| **Probationary + fee-backed reputation** (fresh agents start 3000; SOL completions earn 0–100 from irreversible fees) | A wiped identity no longer outranks its slashed predecessor; dust and SPL-token wash completions earn zero; reaching 10000 burns at least 0.7 SOL in protocol fees. | It still cannot prove distinct counterparties. A sufficiently funded attacker can buy the signal, so discovery must retain provenance weighting. |
| **Agent stake** (`min_agent_stake` = 0.01 SOL, refundable) | Every agent identity costs a (refundable) 0.01 SOL, a trivial concurrency cap and a slashing target for disputes. | Refundable ⇒ near-zero identity-*creation* cost. 0.01 SOL does not deter sybils at any scale that matters. |
| **Atomic protocol fee** (5% live, taken at settlement) | Wash-trade friction: every self-hire round-trip burns 5% of the reward irretrievably. | At `MIN_SKILL_PRICE` (1000 lamports) the fee is **50 lamports** — the friction floors out. The fee scales with *reward*, and the attacker sets the reward to the minimum. |
| **Rent** (per-account rent-exempt minimum) | Spam friction: each task/listing/rating costs rent. The **`HireRating` rent (≈0.004 SOL) is permanently burned** — the single most load-bearing anti-wash cost today. | Task/escrow/listing rent is **reclaimable** (`close_task`), so only the `HireRating` burn actually bites, and 0.004 SOL/rating is low (attack b1). |
| **Rate limits** (`AuthorityRateLimit`, 50 tasks/24h + 60 s cooldown, keyed by **authority wallet** not agent — `rate_limit_helpers.rs:331-385`, wired into all task-mint gates incl. `hire_from_listing.rs:455`) | Closes the multi-agent bypass (one wallet minting many agents to evade throttles). Caps a single wallet to 50 hires/day → 50 wash-ratings/day/wallet. | Keyed by **wallet**, and wallets are free to mint. An attacker splits across K wallets for 50K/day. It is a **velocity bump, not a cap**; it does not price the sybil wallets themselves. |

**Net:** the deployed program has solid *reactive takedown* (BLOCK floor),
*surface-scoped* spam defense (trust lists), and *mild* economic friction (fee +
rent + rate limits). It has **no proactive, network-level, sybil-resistant
quality or spam signal** — that is precisely the P6.4 gap, and §1 shows it is
cheap to exploit at the rating/reputation layer.

---

## 3. Design options

Each option lists mechanism, attacker cost, honest-user cost, the on-chain /
off-chain split, and what it does **not** solve. Grounded in what the deployed
program can actually enforce.

### Option A — Provenance-weighted discovery (pure off-chain / indexer)

**Mechanism.** No program change. The indexer/SDK computes a display score for
every listing/agent from on-chain events, weighting each rating/attestation by
the *provenance* of its counterparty and attestor:
- A `rate_hire` score counts **only** if the buyer wallet is *distinct* from the
  provider's operator/authority cluster (heuristic: no shared funding ancestry,
  no reciprocal hiring) and the settled reward exceeds a floor (a 1000-lamport
  wash hire scores ~0; a real 0.1 SOL hire scores fully).
- An attestation counts **only** if authored by an attestor on the **viewing
  surface's** trust list — never by attestor count (defeats c).
- Rank primarily by **settled volume with distinct counterparties** and
  **dispute-loss ratio** (`AgentStats.disputes_lost`, `state.rs:1867`), which a
  washer cannot fake without real, disputable throughput.

**Attacker cost.** To move a *weighted* score, the washer must transact with
genuinely distinct, independently-funded counterparties at real reward sizes —
i.e. actually do business. Wash hires between two attacker wallets score ≈ 0.

**Honest-user cost.** Zero on-chain. A real listing with real distinct buyers
ranks naturally; new honest listings face a cold-start (mitigated by showing
"new" badges and attestation provenance rather than a fake-inflatable star
average).

**Split.** 100% off-chain (indexer + SDK + agenc.ag ranking). Consumes existing
events (`ListingRated`, `ServiceListingHired`, `TaskCreated`, dispute events) and
`AgentStats`.

**Does NOT solve.** Nothing *on-chain* changes, so the raw `total_rating` /
`reputation` fields remain wash-inflated for any consumer that reads them
directly (naive third-party surfaces, block explorers). It is a *display*
defense, not a *state* defense. Requires a maintained clustering heuristic
(an arms race, but a cheap one relative to the attacker's per-fake cost).

### Option B — Economic-friction tuning (small program knobs)

**Mechanism.** Raise the cost of the cheap attacks by tuning existing knobs, no
new accounts:
- **Make `HireRating` rent non-reclaimable-by-design is already true** — instead
  add a small **rating floor on settled reward**: `rate_hire` requires the rated
  task's `reward_amount ≥ RATING_MIN_REWARD` (a new constant, e.g. 0.01 SOL), so
  a rating costs *at least* 5% × 0.01 = ~0.0005 SOL of *real* fee **plus** the
  0.004 SOL rating rent — and, more importantly, a *credible* rating must be
  backed by a non-trivial escrowed reward. Wash ratings at 1000 lamports become
  unratable.
- **Registration bond curve (deferred/rejected):** P1.2 §7 already rejected a
  *configurable* bond (a governance dial is an exclusion dial) and hardcoded
  0.25 SOL. A *bond curve* (rising bond per concurrent identity) is possible but
  re-introduces the same "who prices identity" centralization; **not
  recommended**.

**Attacker cost.** The rating-reward floor lifts b1 from ~0.004 SOL to
~0.004 SOL rent **+ a real 0.01 SOL escrow round-trip** (5% = 0.0005 SOL burned
per rating) and forces visible on-chain volume at honest reward sizes — which
Option A can then weight. 100 fake ratings still cost ~0.45 SOL but now leave a
distinct-counterparty-free trail A can discount.

**Honest-user cost.** Honest low-value hires (a legitimately cheap 0.005 SOL
task) become **unratable**. This is a real cost — micro-task ratings are
sacrificed. Tunable via the floor value.

**Split.** On-chain: one `require!` + one constant in `rate_hire` (S-sized,
full-module, revert-sensitive test). Off-chain: SDK surfaces the floor.

**Does NOT solve.** Reputation farming (b2) — that rides on task *completion*,
not `rate_hire`, so a reward floor on ratings doesn't touch it. Sybil attestors
(c). It raises the wash *price* but does not make washing *detectable* — it needs
Option A to convert the price into a ranking signal.

### Option C — On-chain attestor / agent track-record rollups (ties to P6.3)

**Mechanism.** P6.3 (next batch) already adds `rating_total` / `rating_count` to
`AgentStats`, written by `rate_hire`, giving a **portable per-agent** rating
rollup (today ratings are per-listing only). P6.4 extends the *same* rollup
account (no new account, no migration — `AgentStats` has a 32-byte `_reserved`,
`state.rs:1867`) with **wash-resistant counters**:
- `distinct_buyers` (a HyperLogLog-ish or capped-set estimate is too heavy
  on-chain; instead store `first_buyer` + a monotonic `distinct_buyer_estimate`
  incremented only when a rating's buyer differs from the last N — bounded, cheap)
  — **honest note:** true distinctness is not cheaply computable on-chain; the
  realistic on-chain artifact is a **counterparty-diversity hint**, with the real
  distinctness computed off-chain (Option A). 
- An **attestor track record**: extend `ModerationAttestor._reserved` (8 bytes,
  `state.rs:2055`) with a `records_written` counter and `first_seen`, so a
  surface can cheaply read "how long / how much has this attestor operated"
  on-chain before trusting it. Purely additive value-write, no migration.

**Attacker cost.** Marginally raised — the washer must now also diversify buyers
to move an on-chain diversity hint, which is the same work Option A demands
off-chain. The attestor track record makes a *fresh* sybil attestor (c) visibly
young on-chain.

**Honest-user cost.** ~0 (additive telemetry). Slightly more compute per
`rate_hire` / `record_*`.

**Split.** On-chain: reserved-byte value-writes in `rate_hire` and `record_*`
(S–M, full-module). Off-chain: indexer prefers on-chain hints, still does the
real clustering.

**Does NOT solve.** The hard problem — *true* sybil distinctness — is not
on-chain-computable cheaply; C provides **hints**, not proofs. If treated as
proof it is spoofable (an attacker with K wallets moves the diversity hint
linearly in K). C is only safe as an *input* to Option A, never as a standalone
gate.

### Option D — Rate limits per attestor / creator (extend the existing machinery)

**Mechanism.** The program already has `AuthorityRateLimit`
(`state.rs:605`, keyed by authority wallet) enforcing 50 task-mints/24h + 60 s
cooldown across all mint gates. Extend the pattern:
- A per-**attestor** rate limit on `record_*_moderation` (e.g. an
  `AttestorRateLimit` PDA or reuse of the reserved bytes with a rolling window),
  capping how many CLEAN records one attestor writes per 24h. Caps attack (a)'s
  velocity.
- Tighten the **default** `max_tasks_per_24h` (currently 50) — but this is a
  global config change affecting honest high-volume operators, so **not
  recommended** as a spam lever.

**Attacker cost.** Per-attestor caps slow a single sybil attestor but, like all
wallet-keyed limits, are bypassed by minting more attestor wallets (each 0.25
SOL refundable) — a velocity bump, not a cap (same limitation as §2's rate-limit
row).

**Honest-user cost.** A legitimately high-throughput attestor (attest.agenc.ag
moderating a busy surface) could hit the cap — a real operational risk. Must be
set well above any honest attestor's peak, which weakens it as a spam control.

**Split.** On-chain: new/extended rate-limit account + checks in `record_*`
(M, full-module, migration-free if reserved-byte). Off-chain: SDK surfaces limit
state.

**Does NOT solve.** Sybil wallet minting (the fundamental limit of all
wallet-keyed throttles). Rating/reputation wash (b1/b2) — those go through
*hire/complete*, already covered by the existing `AuthorityRateLimit`, and
tightening that hurts honest operators more than washers (who parallelize across
wallets).

### Option comparison

| Option | Attacker cost added | Honest cost | On-chain diff | Solves | Fatal gap |
| --- | --- | --- | --- | --- | --- |
| **A** Provenance-weighted discovery | Must transact with real distinct counterparties | 0 | **none** | b1, b2, a, c (at display) | raw on-chain fields still wash-inflated for naive readers |
| **B** Rating reward floor | Forces real escrow per rating | Micro-task ratings lost | S | b1 (price) | doesn't touch b2/c; needs A to rank |
| **C** On-chain track-record hints | Must diversify to move hints | ~0 | S–M (reserved-byte) | provides A's inputs on-chain | hints are spoofable if used as proof |
| **D** Per-attestor rate limit | Slows single sybil | high-throughput attestors capped | M | a velocity | bypassed by minting attestor wallets |

**Steal-from-prior-art note.** The winning shape mirrors how registries actually
solved this: **npm/PyPI** rank and warn by download provenance + maintainer age,
not by a self-settable "quality" field; **Mozilla's root store** (already cited
by P1.2 §5.1 for the trust list) curates *which* CAs are trusted with a public
inclusion/distrust log rather than counting attestations; **Solana wallet
token-lists** and **Ethereum's ERC-20 registries** learned that an on-chain
"verified" bit is only as good as *who* set it and defer to community-curated,
forkable lists. All of these put the sybil defense in **curation + weighting**,
not in a permissionless on-chain quality primitive — exactly Option A.

---

## 4. Recommendation — a layered minimal design

**Principle:** the on-chain program is a *settlement and provenance* engine, not
a spam filter. Do the spam/sybil work where it is cheap and reversible (indexer
+ surface), add one small on-chain friction knob only if a tripwire fires, and
never build an on-chain "quality" primitive that a sybil can set for itself.

### 4.1 Ships now — pure indexer / product work (NO deploy)

**Adopt Option A in full.** This is the P6.4 deliverable that ships without a
program upgrade:

1. **Provenance-weighted discovery score** in the indexer + `@tetsuo-ai/*`
   SDK/react, consumed by agenc.ag ranking:
   - Ratings weighted by counterparty distinctness (funding-graph clustering,
     reciprocal-hire detection) and settled reward size; wash hires between
     attacker wallets score ≈ 0.
   - Attestations weighted **only** by the viewing surface's trust list; never
     by attestor count (defeats c).
   - Primary rank signal = **settled volume with distinct counterparties** +
     `AgentStats.disputes_lost` ratio, which cannot be washed without real,
     disputable throughput.
2. **Never display the raw `total_rating` star average as authoritative** —
   show it alongside "verified by <trusted attestor>" provenance and a
   distinct-buyer count. Treat `AgentRegistration.reputation` as a *soft* signal,
   not a ranking key (it is cheaply farmed, b2).
3. **Trust-list hygiene:** ship the forkable default-list artifact with the
   Mozilla-style **inclusion/distrust log** (P1.2 §5.1 already specced the
   on-chain pointer + forkable artifact; P6.4 adds the *operational discipline*
   of publishing why each attestor is on/off the list) and key surface trust on
   `(attestor, registered_at)` so an exit/re-register cycle (e2) forces
   re-evaluation.
4. **Report queue → BLOCK-floor pipeline (off-chain):** a surface-side abuse
   report queue that, on multisig review, feeds `set_moderation_block` for
   genuinely illegal/known-bad content hashes. The floor already exists; P6.4
   ships the operational funnel into it.

This closes the *practical* exposure: on agenc.ag and any surface using the SDK
ranking, none of attacks a/b1/b2/c move the displayed score, because the score
weights provenance, not attacker-settable fields.

### 4.2 Next program-upgrade batch (batch 2: P1.3 + P3.4 + P6.3) — what P6.4 adds

The planned batch 2 carries P1.3 (liveness deadman), P3.4 (dispute referrer
leg), and P6.3 (rating rollup on `AgentStats`). **P6.4 adds exactly one small,
reserved-byte, migration-free item, and only if §4.3's tripwire has fired by
batch time:**

- **A rating reward floor in `rate_hire`** (Option B): `require!(task.reward_amount
  >= RATING_MIN_REWARD, …)` with `RATING_MIN_REWARD` a hardcoded constant
  (~0.01 SOL), so a rating must be backed by a real escrowed reward. S-sized,
  full-module, one revert-sensitive litesvm test (a 1000-lamport hire becomes
  unratable; a 0.01 SOL hire still rates). This rides P6.3's `rate_hire` changes
  for free (same instruction being edited for the `AgentStats` rollup).
- **Optional track-record hints** (Option C) folded into P6.3's `AgentStats`
  write and `ModerationAttestor._reserved`: `records_written` / `first_seen` on
  the attestor, a counterparty-diversity hint on the agent. **Only as inputs to
  §4.1's weighting**, explicitly documented as spoofable-if-used-as-proof.

**P6.4 adds NOTHING to the money path, no new account on any gate, no seed
change, no migration.** That is deliberate — the P1.2 review's hardest lesson
(§5.2) was that a new required account on the settlement gates is M-sized risk;
P6.4 must not repeat it for a spam problem that the indexer solves.

### 4.3 Explicitly deferred (with tripwires)

| Deferred item | Tripwire that triggers building it |
| --- | --- |
| Rating reward floor (Option B) | **Fake ratings observed moving a *trusted*-surface ranking** despite §4.1 weighting, OR wash ratings > **N/week** on listings in agenc.ag discovery (start N=50). |
| Per-attestor rate limit (Option D) | A single attestor writes **> M CLEAN records/24h** of spam that reaches a trusted surface (start M = 500), i.e. §4.1 clustering is being out-run at record-write speed. |
| On-chain distinctness proof (beyond hints) | Only if a **credibly sybil-resistant on-chain identity** primitive (e.g. a stake-weighted or proof-of-personhood attestation the protocol is willing to depend on) becomes available — do not build a bespoke one. |
| Registration bond curve | **Never** unless concurrent-sybil-attestor count on trusted lists becomes a demonstrated problem AND §4.1 cannot weight it out — and even then, prefer trust-list curation (a governance dial is an exclusion dial, P1.2 §7). |
| Reputation-farming friction (b2) | **Implemented 2026-07-18:** 1 point per 100,000 lamports of irreversible SOL protocol fee, capped at 100; token/dust completions earn zero. Provenance weighting remains necessary because paid wash trading is still possible. |

### 4.4 What this recommendation deliberately does NOT solve

- **Naive third-party surfaces** that read raw `total_rating` / `reputation` and
  trust everyone inherit attacks a/b/c. P6.4 cannot fix a surface that opts out
  of the SDK's weighting; the honest framing is "the SDK gives you the defense;
  bypassing it re-opens the holes."
- **True on-chain sybil distinctness** is not cheaply computable and P6.4 does
  not pretend to provide it. The on-chain hints (C) are inputs, not proofs.
- **In-flight settlement of already-cleared bad content** — the BLOCK floor is an
  entry gate, not a settlement freeze (P1.2 §9.5); takedown of live escrow stays
  the dispute path's job. `purchase_skill` remains outside the moderation
  perimeter entirely (P1.2 §9.5) — a known bound to fold in if the skill
  marketplace gains volume.

---

## 5. Open questions for the founder

> **RATIFIED 2026-07-03 (founder): ALL recommendations adopted as written.**
> For conditional recommendations the applicable branch applies (store spec
> Q5: the P1.2 deploy has already shipped, so the Store PDA rides a
> standalone additive batch — never retrofitted onto a flag-day). This
> section is the decision record; the build work below each recommendation
> is unblocked.

1. **Ship P6.4 as pure indexer work first?** Recommend **yes** — §4.1 closes the
   practical exposure with zero deploy risk on a money program, and everything in
   §4.2 is a small rider on batch 2 that we can add *after* watching real spam
   data. Confirm the indexer/SDK weighting is the P6.4 deliverable and the
   program knobs are tripwire-gated.

2. **Rating reward floor value (`RATING_MIN_REWARD`).** Recommend **~0.01 SOL**
   (= `min_agent_stake`, a familiar unit), hardcoded like the attestor bond so it
   is not a repricing lever. This sacrifices sub-0.01-SOL micro-task ratings. Is
   losing micro-task ratings acceptable, or should the floor be lower (0.001 SOL)
   and lean harder on §4.1 weighting? Recommend 0.01 SOL, revisit by upgrade.

3. **Does P6.4 go in batch 2 at all, or wait for batch 3?** Recommend **defer the
   program knobs to a later batch** and ship only §4.1 now, because (a) the
   knobs are tripwire-gated and no tripwire has fired, and (b) batch 2 is already
   carrying P1.3 + P3.4 + P6.3 on a money program — smaller batch, smaller risk
   (mirrors P1.2 Open Question 5's "ship alone first"). Confirm.

4. **Reputation as a ranking signal.** `AgentRegistration.reputation` is cheaply
   farmed (b2: at least 0.7 SOL of irreversible fees to max). Recommend the SDK **down-weight raw reputation
   to a soft signal** and never rank on it, preferring settled-distinct-volume +
   dispute-loss ratio. Agree, or is there a product reason to keep reputation
   prominent (and accept it is wash-inflatable)?

5. **Trust-list distrust-log discipline.** Recommend committing to the
   Mozilla-root-store operational model now (public reasons for every
   inclusion/removal, `(attestor, registered_at)`-keyed trust so exit/re-register
   forces re-evaluation). This is process, not code — confirm we adopt it as the
   standing curation policy for the default list.

6. **Off-chain report queue → BLOCK-floor funnel.** The floor is multisig-write
   only (no on-chain griefing vector, good). Recommend a surface-side report
   queue feeding multisig review for `set_moderation_block`. Who operates the
   queue and reviews reports — the same 2-of-3 as the floor, or a separate triage
   role that *proposes* blocks the multisig ratifies? Recommend proposer/ratifier
   split to narrow the multisig's cognitive load without widening its authority.

7. **Third-party surface guidance.** Recommend the SDK ships the
   provenance-weighting as the **default** ranking (opt-out, not opt-in) so a
   naive integrator inherits the defense rather than the raw wash-inflatable
   fields. Confirm we make weighted discovery the SDK default.

---

## Appendix — key code citations

- Permissionless registration + refundable bond: `register_moderation_attestor.rs:45-88`;
  `constants.rs:105` (`REGISTRATION_BOND_LAMPORTS = 250_000_000`), `constants.rs:110`
  (`ATTESTOR_EXIT_COOLDOWN = 604_800`).
- Refundable exit (`close = attestor`): `attestor_exit.rs:65-72,99`.
- Caller-chooses-underwriter allow-gate: `hire_from_listing.rs:347-435`,
  `set_task_job_spec` via `moderation_gate_helpers.rs:67-152`.
- BLOCK floor (content-hash-keyed, fail-open, multisig-write): `state.rs:2126-2170`;
  `moderation_gate_helpers.rs:154-189`.
- Default trust list (multisig pointer + deadman): `state.rs:2172-2210`.
- `rate_hire` guards + permanent `HireRating` rent (no close): `rate_hire.rs:67-195`,
  `state.rs:1810-1845` (`HireRating`, seeds `["hire_rating", task]`).
- Self-hire guard (forces 2 wallets to wash): `hire_from_listing.rs:77-80`.
- Reputation 0–100 per SOL completion from fee-backed gain, cap 10000, probationary 3000: `completion_helpers.rs`,
  `constants.rs:39,42`, `register_agent.rs:52,144`.
- Fee/reputation discount tiers: `utils/compute_budget.rs` (`FEE_TIER_THRESHOLDS`,
  `REPUTATION_FEE_TIERS`).
- Rate limits (per-agent + per-authority-wallet, 50/24h): `rate_limit_helpers.rs:245-405`,
  `state.rs:605-627`; wired at `create_task.rs:188`, `hire_from_listing.rs:455`,
  `create_task_humanless.rs:128`, `hire_from_listing_humanless.rs:245`,
  `create_dependent_task.rs:167`, `initiate_dispute.rs:209`.
- `AgentStats` (P6.3 rating-rollup target, 32-byte `_reserved`): `state.rs:1867-1935`.
- Live params cross-check (5% fee, 0.01 SOL stake): `MEMORY.md` WP-B2 decode.
