# P5.3 — Verifiable Referral Attribution

> **Status:** DESIGN — draft for founder review. Nothing here is implemented or
> deployed. Companion to the ratified `P5_2_STORE_IDENTITY_SPEC.md` (whose §7.6
> pre-designed the attachment point this doc uses) and to the ratified
> `P6_4_SPAM_SYBIL_DESIGN.md` (whose costed threat model this doc extends to
> the referral leg). Any program change here is a human-owned deploy Moment.

## 1. The current model, precisely

The P6.2 referrer leg is **live on mainnet and already paying real money** —
the explorer revenue endpoint (live-read 2026-07-04) shows two referred hires
settled for 375,000 lamports of referrer fees across two payee wallets. So this
is not a design for a dormant feature; migration constraints in §7 are real.

How attribution works today, end to end:

- **On-chain: the referrer is a client-supplied pubkey.** Every mint gate takes
  a bare `referrer: Option<Pubkey>` + `referrer_fee_bps: u16` argument from
  whoever builds the transaction: `create_task`
  (`create_task.rs:129-130`), `hire_from_listing`
  (`hire_from_listing.rs:352-353`), and their humanless variants
  (`hire_from_listing_humanless.rs:155-156`). The args are normalized by
  `resolve_referrer_snapshot` (`completion_helpers.rs:582-619`) and stamped
  onto the `Task` (`state.rs:1017-1020`) and, for hires, mirrored onto the
  `HireRecord` (`state.rs:1785-1787`; `hire_from_listing.rs:562-563`).
- **The only on-chain validation is arithmetic + one self-deal check:**
  per-leg cap `MAX_REFERRER_FEE_BPS = 2000` (`constants.rs:16`;
  `completion_helpers.rs:599-601`), combined-cap pre-check at snapshot
  (`completion_helpers.rs:603-612`) and the binding combined cap at settlement
  (`protocol + operator + referrer ≤ 4000` bps so the worker keeps ≥60%,
  `constants.rs:22,30`; `calculate_combined_fees`,
  `completion_helpers.rs:513-568`), and `referrer_key != creator`
  (`completion_helpers.rs:614-617`). Nothing checks *who* the referrer is or
  whether they referred anything.
- **Settlement pays the snapshot.** The CreatorReview paths
  (`accept_task_result.rs:324-395`, `auto_accept_task_result.rs:302-373`) and
  the Auto path (`complete_task.rs:322-388`) resolve the leg Task-first with a
  HireRecord fallback, validate the passed payee account equals the snapshot
  (`errors.rs:933-935`), pay it from escrow
  (`completion_helpers.rs:219-225`), and emit `ReferrerFeePaid`
  (`events.rs:596-603`). Which paths do NOT pay the leg is the subject of the
  companion doc `P3_6_REFERRER_BEYOND_CREATORREVIEW.md`.
- **Off-chain: attribution is a URL parameter.** agenc.ag's create wizard
  reads `?ref=<handle>` from the URL, resolves the handle to a store row via
  `/api/stores?handle=`, and drops the store's wallet + fee bps into the
  `create_task` args (`agenc-ag/apps/web/components/creator/CreateWizard.tsx:92-93`,
  `:254-262`, `:659-660` — the comment there is honest: "REAL on-chain money").
  Independent `create-agenc-store` nodes bake their `referrer.wallet/feeBps`
  into build-time config (`store-core` `storeConfigSchema`) and stamp it on
  every hire their UI builds.

**The problem statement, sharpened.** "Any tx-builder names any wallet as
referrer" is true but under-describes the exposure. Three distinct properties
are missing, and they are not the same problem:

1. **Attribution integrity** — the `?ref=` param (and the store-config
   equivalent) can be stripped or replaced by anything between the referring
   surface and the signed transaction: the buyer, a wallet, a competing UI, a
   malicious kit. The referring store has no way to prove it was robbed,
   because there was never a verifiable link to rob.
2. **Referrer identity** — the payee is a bare wallet. Nothing makes it
   enumerable, brandable, or joinable to the P5.2 Store identity; the explorer
   `referrers` rollup is a list of anonymous pubkeys.
3. **Leg pricing consent** — unlike the operator leg, which the **provider**
   sets on their own listing at `create_service_listing` and which is
   snapshotted from the listing at hire (`hire_from_listing.rs:371-372`,
   `:491-501`), the referrer leg's **bps is chosen by the buyer's tx builder**
   at hire/create time. The provider never agreed to it. See §4.

## 2. Threat model (costed, extending P6.4)

Live parameters as in `P6_4_SPAM_SYBIL_DESIGN.md` §1 (5% protocol fee, rent
formula `(bytes+128) × 6960` lamports, all bonds refundable).

### (a) Attribution theft / stripping

**Attack.** Replace (or drop) the referrer the referring surface intended:
a buyer edits the URL, a forked UI substitutes its own wallet, an agent kit
rebuilds the tx with its operator's wallet as referrer.

**Cost: zero.** There is no on-chain notion of the "correct" referrer to
deviate from.

**Bound on the damage — important nuance:** the referring surface usually
*builds the transaction itself* (agenc.ag wizard, a store node's checkout).
Within its own surface its attribution is safe-by-construction. The theft
vector is everything downstream of discovery: the buyer who found the listing
on store A but checks out via surface B, deep-link unfurls, copied PDAs, agent
frameworks hiring through the SDK directly. Exactly the traffic a referral
program exists to reward is the traffic it cannot see.

### (b) Self-referral rebate (the buyer taxes the worker)

**Attack.** The buyer supplies their own second wallet as `referrer` with
`referrer_fee_bps` up to 2000. At settlement, 20% of the reward routes back to
the buyer's other pocket; the **worker** absorbs it (the leg is carved from the
settlement base ahead of the worker's share, `completion_helpers.rs:513-568`).
The only guard is `referrer != creator` (`completion_helpers.rs:614-617`) —
one wallet away from useless, same as the two-wallet wash in P6.4 §1(b1).

**Cost: one free wallet + ~5,000 lamports of tx fees.** Not even a wash trade
— the buyer was hiring anyway; this is a 20% coupon minted at the worker's
expense.

**What limits it today:** the worker can read `task.referrer_fee_bps` before
claiming (it is stamped at mint, before any claim exists), and a hired
provider can decline to claim a hire whose fees they dislike. But no shipped
surface actually shows the worker "this task pays you 75%, not 95%" at claim
time. This is a **tooling gap first** (§6.1) and a protocol-pricing question
second (§4).

### (c) Wash-referral volume (faking a store's referred GMV)

**Attack.** A store self-hires (two wallets, P6.4 §1(b1) mechanics) naming its
own store wallet as referrer, to inflate "referred GMV / hires" on
leaderboards or any provenance score that consumes the explorer `referrers`
rollup. Marginal cost per fake referred hire is the P6.4 b1 cost (~0.004 SOL
burned `HireRating` rent if they also rate; otherwise ~5% of a floor-priced
reward + reclaimable rent) — call it **< 0.005 SOL per fake referral**.

**Defense is the P6.4 answer, verbatim:** referred volume is a
provenance-weighted *display* signal, never rankable raw. No on-chain design
in this document changes that; a registered referrer PDA is registered, not
honest.

### (d) Referrer griefing / unwanted attribution

**Attack.** Attach a victim's wallet as `referrer` on abusive or illegal task
content so their address shows up as the "referrer of record" in explorers,
or dust-attribute a rival store on embarrassing volume.

**Cost: zero.** The named referrer never consented; today nothing lets them
prove non-involvement (or refuse the leg). Low severity — the payee receives
money, not liability — but it is the one attack that only referrer-signed
attribution (§5 Option C) actually eliminates.

### Summary

| # | Attack | Marginal cost | What actually stops it |
| --- | --- | --- | --- |
| a | Strip/replace attribution | 0 | Nothing on-chain; only surface-owned checkout |
| b | Self-referral rebate | ~0 (2nd wallet) | Worker floor (60%) caps it at 20%; claim-time fee display (unshipped) |
| c | Wash referred-GMV | <0.005 SOL/hire | P6.4 §4.1 provenance weighting; never rank raw referrer totals |
| d | Unwanted attribution | 0 | Only referrer-signed attribution |

## 3. What on-chain attribution can and cannot prove

Be honest about the ceiling before choosing a design. A program can enforce
exactly two new properties:

- **P1 — the payee is a registered identity** (a Store PDA instead of a bare
  wallet): buys enumerability, joinability, a brand to display, a bond behind
  the name, and a natural place for referral bookkeeping. It does **not**
  prevent (a), (b), or (c) — registering a sybil store costs ~0.056 SOL, all
  refundable (P5.2 §7.1-§8 Q1).
- **P2 — the referrer consented** (a referrer signature over the attribution):
  eliminates (d) and gives the referrer control of their own terms. It does
  **not** prevent (a) — a thief consents to crediting themselves — nor (b)/(c)
  — the attacker signs with their own sybil identity.

**No design proves causation** ("this store actually brought this buyer").
Causation is an off-chain fact about a browser session. Any on-chain scheme
that claims otherwise is selling P6.4's attack (c) a costume. The correct
frame: on-chain attribution makes referral identity *legible and consenting*;
it makes referral *honesty* nobody's problem but the ranking layer's.

## 4. The pricing asymmetry (who sets the bps)

Every other leg has a clear price-setter: the protocol fee is config
(`ProtocolConfig.protocol_fee_bps`, locked onto the task at mint), the
operator fee is set by the provider on their own listing. The referrer fee is
set by **the buyer's transaction builder** against the **worker's** revenue.
That is backwards from every affiliate system on earth, where the *seller*
publishes the commission.

Two possible corrections, both deliberately out of scope for the first P5.3
batch but recorded here because the Store PDA makes them cheap later:

- **Provider-side cap:** a `max_referrer_fee_bps` on `ServiceListing`
  (32 reserved bytes available, `state.rs:1750`), enforced at
  `hire_from_listing` snapshot. Additive, no migration, S-sized. The default
  (0 = accept protocol max) preserves today's behavior.
- **Store-advertised default:** the P5.2 `Store.referrer_fee_bps` field is the
  natural published rate; a hire gate that resolves the leg *from the
  registered store* instead of a caller-supplied bps removes the buyer from
  price-setting entirely.

Until one of these ships, surfaces MUST display the full split to the worker
at claim time (§6.1.3) — the floor guarantees ≥60%, but consent should be
informed, not inferred.

## 5. Design options

### Option A — Status quo + documented limits + provenance weighting

No program change. Document (this §2) that attribution is a cooperative
convention; explorer/SDK treat referred GMV as unverified (P6.4 §4.1: weight
by the viewing surface's trust, never rank raw); agenc.ag continues `?ref=`.

- **Attacker cost added:** none.
- **Honest cost:** none.
- **What it buys:** honesty. The referrer leg keeps working for the 100%-of-
  today's-volume case where the referring surface builds the tx.
- **Fatal gap:** referral as a *growth primitive* stays surface-local — a
  store can only trust attribution on checkouts it renders itself.

### Option B — Registered referrer: the leg pays a Store PDA (P5.2 §7.6)

The ratified Store spec already reserved this attachment: *"the hire gates can
accept an optional `referrer_store` account constrained to `["store",
referrer]` and resolve the snapshot payee from `store.owner`"* (P5.2 §7.6).
Concretely:

- `hire_from_listing` / `create_task` / humanless variants gain one optional
  account: `referrer_store: Option<Account<Store>>`, seeds
  `["store", referrer_arg]`. When `referrer_fee_bps > 0`, the account is
  **required** and the stamped payee is `referrer_store.owner` (== the
  `referrer` arg, by seeds). When the leg is absent, nothing changes.
- Account-count impact is trivial: `HireFromListing` today carries 14 accounts
  (`hire_from_listing.rs:180-338`); this makes 15, far from any limit.
- `Task`/`HireRecord` layouts are untouched — they keep storing the resolved
  payee wallet exactly as today (`state.rs:1017-1020`), so **settlement paths
  need zero changes** and pre-P5.3 tasks settle identically. This is the whole
  reason P5.2 resolved the payee from `store.owner` rather than storing a
  store reference: no migration, no new settlement account.
- Enforcement posture: **fail-closed on new mints only.** A non-registered
  wallet can no longer be named as a paid referrer; a store exit
  (`close_store`) after mint does not strand settlement because the payee
  wallet is already snapshotted.

- **Attacker cost added:** ~0.056 SOL refundable per sybil referrer identity
  (P5.2 rent + bond). Prices nothing durable — P6.4 §1(c) framing applies.
- **Honest cost:** every referrer must register a Store (one tx, refundable).
  For the two live referrer payees, a one-time re-registration; for agenc.ag
  stores, the P5.2 migration flow already covers it.
- **What it buys:** P1 of §3 — enumerable, branded, bonded referrer identity;
  the explorer `referrers` rollup becomes joinable to store identities; P6.4's
  weighting gets a real key (`(store, registered_at)`); the "stores earn"
  product story becomes verifiable end-to-end.
- **What it does NOT buy:** any resistance to §2(a)-(c). State this in the
  product copy.

### Option C — Referrer-signed attribution (vouchers)

The referrer co-signs the attribution: either as a second tx signer (dead on
arrival — the referring store is not online when the buyer signs) or as a
**durable voucher**: an ed25519 signature by the store wallet over a canonical
message (`store pda, buyer or "any", listing/store scope, max bps, expiry,
nonce`), verified on-chain via ed25519-program instruction introspection, the
`ReferralVoucher` pattern.

- **Attacker cost added:** none for theft/self-referral (attackers self-sign).
  Eliminates §2(d) (unwanted attribution) and gives referrers term control
  (their signed `max bps` fixes their side of §4).
- **Honest cost:** high. A new verification path on four mint gates,
  instruction-introspection code (a historically bug-prone Solana pattern),
  voucher distribution plumbing in every surface, nonce/replay bookkeeping
  (a per-voucher PDA or a store-side counter — new rent), SDK/kit surface on
  every framework. This is M/L on money-adjacent gates.
- **Verdict:** the cost/benefit is upside-down while §2(d) is a theoretical
  grief with zero observed incidents and referral volume is 2 hires.
  Design-ahead note: if built later, the voucher should bind to the **Store
  PDA** (Option B first), and the P5.2 `Store._reserved` 64 bytes can host the
  replay counter without a layout change.

### Option D — Reprice the leg out of the protocol fee

Restructure so the referrer leg is carved from the protocol's 5% instead of
the worker's share, removing §4's asymmetry entirely. Rejected for now:
repricing live settlement math is the highest-risk class of change
(P1.2 §5.2 lesson), 5% cannot fund a 20% leg, and the worker floor already
bounds the harm. Reconsider only alongside a deliberate fee-model revision.

## 6. Recommendation

**Attribution is not worth new program surface today; identity is worth a
small, already-designed rider once the Store PDA ships. Ship in this order:**

### 6.1 Now (no program change)

1. **Document the trust model** (this doc §2-§3) in the SDK and store-core:
   the referrer leg is *cooperative attribution* — verifiable payment to a
   named wallet, not verified causation. Copy discipline: never write
   "verified referral" anywhere a raw `referrers` rollup is displayed.
2. **Weighting discipline (P6.4 §4.1 applied to referrals):** the indexer/SDK
   must treat referred GMV as attacker-settable; never rank stores by raw
   referred totals; weight by counterparty distinctness and by the viewing
   surface's trust list.
3. **Claim-time split display:** kit/react/agenc.ag show the worker the full
   4-way split (incl. `task.referrer_fee_bps`) before claim/accept of a hire.
   Closes the informed-consent half of §2(b) with zero deploy.

### 6.2 After the P5.2 Store batch deploys (small additive rider)

4. **Option B, exactly as pre-ratified in P5.2 §7.6:** optional
   `referrer_store` account on the four mint gates; payee resolved from
   `store.owner`; paid referrer ⇒ registered store. S/M-sized, additive, no
   migration, no settlement change. It should ride a batch **after** the Store
   account has real registrations, so the fail-closed gate doesn't strand
   honest referrers on day one (see migration, §7).

### 6.3 Deferred, with tripwires (P6.4 discipline)

| Deferred | Tripwire |
| --- | --- |
| Referrer-signed vouchers (Option C) | A real unwanted-attribution incident, or referrers demonstrably robbed at cross-surface checkout volume that matters (> 5% of referred GMV disputed) |
| Provider-side `max_referrer_fee_bps` (§4) | Observed self-referral rebates (§2b) materially cutting worker take on real listings, or worker complaints post-§6.1.3 display |
| Store-resolved default bps (§4) | Rides free with any future listing-terms batch once Option B is live |

**Go/no-go: GO** — but as scoped above: §6.1 is the P5.3 deliverable now;
§6.2 is a pre-designed rider on the first additive batch after the Store PDA
ships (batch 3+, never the P1.3/P3.4/P6.3 batch-2 money-path batch, which is
already carrying settlement-adjacent change); §6.3 stays tripwire-gated.
**NO-GO on referrer-signed attribution now** and **NO-GO on any claim that
on-chain registration verifies referral honesty.**

## 7. Migration for the live referrer leg

- **Live state (2026-07-04):** two settled referred hires, 375,000 lamports of
  paid referrer fees, two distinct payee wallets; `Task` (466 B, pinned at
  `state.rs:1087`) and `HireRecord` already carry the P6.2 fields on every
  live account — the realloc sweep is done and is not reopened by anything in
  this doc.
- **Option B migration = none on-chain.** Layouts unchanged; settled tasks are
  history; open referred tasks settle from their snapshot regardless of store
  registration. The only migration is *social*: the fail-closed gate must not
  ship before the two live payee wallets (and agenc.ag's store roster) have a
  registration path — hence §6.2's "after the Store batch has real
  registrations" sequencing, and a kit/SDK preflight error ("referrer must be
  a registered store") that links the registration flow.
- **Rollback:** because settlement never reads the `Store`, disabling the gate
  (a later upgrade) reverts cleanly to today's semantics with zero stranded
  state.

## 8. Open questions for the founder

1. **Accept the honest ceiling?** Confirm the product story is "registered,
   consenting, enumerable referrers" — never "verified referrals." All copy
   and ranking follows §6.1.1-2.
2. **Fail-closed vs fail-open gate (Option B):** recommend **fail-closed**
   (paid referrer must be a registered store) for legibility, accepting that
   it adds one registration tx of friction per referrer. Fail-open (unregistered
   wallets still allowed, store account optional garnish) preserves zero
   friction but makes the identity layer decorative. Confirm fail-closed.
3. **Batch placement:** recommend the Option B rider ships in the first
   additive batch **after** the standalone Store batch, not with it — so
   registration exists before the gate demands it. Confirm.
4. **Worker-facing split display (§6.1.3):** confirm this is required
   acceptance criteria for kit + agenc.ag before the rider deploys.
5. **Provider referrer cap (§4):** park as tripwire-gated, or pull into the
   same rider as Option B (one more `require!` at hire, S-sized)? Recommend
   tripwire-gated — don't grow the rider.
