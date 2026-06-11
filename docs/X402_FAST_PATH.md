# x402 fast-path + escalation to AgenC escrow — design

> **Status: DESIGN ONLY. [HUMAN: approve the design before any build; deploys.]**
> This document is the P5.4-step-1 deliverable. It specifies the x402 fast-path
> handshake, the escalation path that converts a paying x402 caller into an
> escrowed `hire_from_listing`, and where both plug into the existing hosted API
> (P3.2) and the D4 demand-evidence ledger. **No x402 payment code is built or
> deployed by this design.** The A2A AgentCard surface (P5.4 step 3) is the only
> part of P5.4 that ships now — it is pure discovery, carries no payment, and is
> documented separately in `packages/marketplace-tools/src/agent-card.ts`.

---

## 1. Why two tiers (the market rationale)

AgenC's escrow machinery is deliberately heavy: a single `hire_from_listing`
mints a Task + escrow PDA, runs the fail-closed moderation gate, and a full
engagement can run 5–7 transactions plus rent and an optional 25% completion
bond. That overhead **only amortizes at roughly $50+ tickets** (PLAN.md D5).

The agent-payment market is not there yet. Observed medians are **$0.20 per call
on x402** and **$8–35 on gig boards** (PLAN.md D5). x402 is also where the volume
actually is — 165M cumulative transactions, ~49% on Solana, now a Linux
Foundation-neutral standard (PLAN.md P5.4). Putting a $0.20 listing-API call
through escrow burns more in rent and fees than the call is worth, and there is
nothing to dispute.

The answer is **two coherent tiers, picked by ticket size, sharing one
discovery surface**:

| | **x402 fast-path** | **AgenC escrow (`hire_from_listing`)** |
|---|---|---|
| Use when | cheap pay-per-call, micro-tasks | the job is worth disputing |
| Typical ticket | ~$0.001 – a few $ | ~$50+ |
| Rails | HTTP 402 + a stablecoin transfer | Task + escrow PDA, moderation gate, optional bond |
| Settlement | immediate, on receipt | held in escrow until CreatorReview / dispute resolution |
| Trust model | reputation + the provider's track record | on-chain escrow + dispute resolver + slashing |
| Recourse | none beyond not paying again | refund / dispute / slash |

The slogan, from D5: **"x402 for the API call, AgenC for the engagement."** A
caller starts cheap and *escalates into escrow only when the engagement grows
big enough to dispute.*

---

## 2. The x402 handshake (HTTP 402 on the hosted API)

x402 is an HTTP-native micropayment protocol: the server answers an unpaid
request with **HTTP `402 Payment Required`** and a machine-readable challenge;
the client pays (a stablecoin transfer the facilitator verifies) and retries with
a payment proof header; the server serves the resource. No Solana stack is
required on the caller — only the ability to make a stablecoin payment a
facilitator can verify. This is the load-bearing property: an HTTP-native agent
with **no `@solana/kit`, no wallet adapter, no RPC** can pay for a call.

### 2.1 Endpoints that accept x402

x402 is layered onto the **existing P3.2 hosted API** (`createIndexerClient`
talks to it today). Two classes of endpoint accept payment:

1. **Metered reads** — listing-API calls above the free anonymous tier. Today
   `GET /api/explorer/listings` (and the rest of the explorer surface) is
   anonymous at a low rate, API-keyed for more. x402 adds a *third* path: pay
   per call with no account, no key. This is the cheapest possible on-ramp for a
   crawler that wants higher read throughput without provisioning a key.

2. **Micro-tasks** — designated hosted endpoints that *perform a unit of work*
   priced below the escrow-amortization floor (e.g. a single classification, a
   one-shot translation, a single moderation scan). These map to a provider's
   listing but settle off-escrow: the caller pays x402, the provider's hosted
   worker returns the result inline. No Task PDA is minted.

### 2.2 The wire flow

```
Agent                              Hosted API (P3.2)                Facilitator
  |  GET /api/explorer/listings?... |                                  |
  |-------------------------------->|                                  |
  |   402 Payment Required          |                                  |
  |   { accepts: [ { scheme:"exact",|                                  |
  |       network:"solana",         |                                  |
  |       asset:"<USDC mint>",      |                                  |
  |       maxAmountRequired:"...",  |                                  |
  |       payTo:"<receiver>",       |                                  |
  |       resource:"<url>",         |                                  |
  |       nonce, expiresAt } ] }     |                                  |
  |<--------------------------------|                                  |
  |  (build + sign payment payload) |                                  |
  |  GET ... + X-PAYMENT: <payload> |                                  |
  |-------------------------------->|  verify(payload)                 |
  |                                 |--------------------------------->|
  |                                 |   ok + settlement ref            |
  |                                 |<---------------------------------|
  |   200 OK + X-PAYMENT-RESPONSE   |                                  |
  |   { ...the resource... }        |                                  |
  |<--------------------------------|                                  |
```

Concretely:

- **Challenge** — the `402` body carries the x402 `accepts` array: scheme,
  network (`solana`), the accepted asset (a stablecoin mint), the price
  (`maxAmountRequired`), the receiver (`payTo`), the `resource` URL, and a
  short-lived `nonce`/`expiresAt`. The hosted API derives the price for a
  listing-bound micro-task from the **listing's on-chain `price` field**
  (decoded server-side) so the fast-path price and the escrow price come from the
  *same source of truth*; metered-read prices come from a published rate card.
- **Payment** — the caller produces an x402 payment payload (a signed stablecoin
  transfer authorization) and resends the request with the `X-PAYMENT` header.
- **Verify + settle** — the hosted API hands the payload to an x402 **facilitator**
  (the component that verifies and settles the transfer on-chain); on success it
  serves the resource and returns an `X-PAYMENT-RESPONSE` settlement reference.
- **Idempotency** — the `nonce` makes a paid request replay-safe; a retried
  identical request with the same proof serves the cached result, it does not
  double-charge.

> **Standard-fidelity note.** The exact header names, the `accepts` object
> shape, and the facilitator contract MUST follow the published x402 spec at
> build time (it is a moving, now-Linux-Foundation standard). The fields above
> are the *design intent*, not a frozen schema — pin them to the spec version in
> the build PR. **[DECISION NEEDED — see §6.]**

---

## 3. The escalation path (x402 → escrowed `hire_from_listing`)

This is the heart of P5.4: the fast-path is not a dead end. A caller that starts
paying per call **escalates into an escrowed hire the moment the engagement
crosses a price threshold** — because at that size the job is worth disputing and
the escrow overhead finally amortizes.

### 3.1 The threshold

A single configured **escalation threshold** (in the listing's price
denomination — SOL lamports or the listing's `price_mint` token units) is the
boundary between the tiers:

- A requested unit of work **at or below** the threshold → quote it as an x402
  micro-task (§2). Settle off-escrow.
- A requested unit of work **above** the threshold, OR a caller that has
  *accumulated* fast-path spend with one provider past the threshold within a
  window → the API stops quoting x402 and **escalates**: it responds with a
  pointer to the escrow hire flow instead of a `402` micro-task challenge.

The accumulation rule matters: ten $5 calls to the same provider is a $50
relationship that *should* have escrow recourse. Tracking per-(caller, provider)
fast-path spend (see §5, the D4 ledger) lets the API escalate a *pattern*, not
just a single large request.

> The threshold value and the accumulation window are **policy**, published in
> the docs alongside the D5 listing-price guidance, and tuned against real D4
> median-ticket data. They are NOT hard-coded protocol constants. **[DECISION
> NEEDED — see §6.]**

### 3.2 The escalation response

When the API decides to escalate, instead of a `402` micro-task challenge it
returns a structured **escalation envelope** that hands the caller everything it
needs to move to escrow without a second round trip:

```jsonc
{
  "escalate": true,
  "reason": "ticket-above-threshold",      // or "accumulated-spend-above-threshold"
  "threshold": "50000000",                  // listing-denomination units
  "listing": "<ServiceListing PDA>",
  "hire": {
    // exactly the POST /v1/hires request body the caller should send next
    "endpoint": "/v1/hires",
    "method": "POST",
    "expectedPrice": "<listing.price>",      // CAS guard, from on-chain
    "expectedVersion": "<listing.version>",  // CAS guard, from on-chain
    "listingSpecHash": "<64-hex>",           // moderation-PDA derivation
    "creatorAgentRequired": true             // caller needs a creator AgentRegistration
  }
}
```

The caller then follows the **existing P3.2 no-RPC write path** (§4): it POSTs to
`/v1/hires`, gets back an **unsigned** transaction, signs locally, and broadcasts.
The fast-path caller that had *no* Solana stack must acquire one to cross into
escrow — that is the intended, honest cost of getting dispute recourse, and the
escalation envelope tells it exactly what it now needs (`creatorAgentRequired`).

### 3.3 Credit carry-over (design option, NOT required for v1)

A caller may have already paid x402 for partial work before the engagement grew.
A v1-acceptable behavior is **no carry-over**: fast-path spend is sunk, the escrow
hire is a fresh full-price engagement. A richer option is to **credit accumulated
fast-path spend against the escrow `price`** via a server-issued, signed credit
note the `/v1/hires` builder honors. This is strictly additive and is called out
here so the build PR can choose. **[DECISION NEEDED — see §6.]**

---

## 4. Where it plugs into P3.2 `POST /v1/hires` pre-funding

The escrow tier reuses the **already-shipped** P3.2 transaction-builder endpoint —
x402 adds *nothing* to the escrow code path, it only routes callers into it.

- `POST /v1/hires` already accepts hire parameters (`buyer`, `listing`,
  `expectedPrice`, `expectedVersion`, `listingSpecHash`, `creatorAgent`) and
  returns an **unsigned** v0 transaction (`BuildHireTransactionResult`:
  `transaction` base64, `blockhash`, `taskPda`, `escrowPda`, `hireRecordPda`,
  `taskId`). The buyer signs locally and broadcasts. This *is* the pre-funding
  step: signing+broadcasting the returned tx mints the Task and **funds the
  escrow PDA** in one instruction (`hire_from_listing`).
- The **escalation envelope (§3.2) is constructed to be a drop-in for this call**:
  every field the caller needs to fill `BuildHireTransactionParams` is already in
  the envelope (`listing`, `expectedPrice`, `expectedVersion`, `listingSpecHash`).
  The only thing the caller adds is its own `buyer` wallet and `creatorAgent`.
- **x402 on `/v1/hires` itself (optional, design-flagged):** the *gas/relay* cost
  of building+relaying the hire could itself be x402-metered (pay a few cents to
  have the API build your hire tx), distinct from the escrowed `price` which is
  always paid on-chain by the signed transaction. This keeps the no-key on-ramp
  consistent: even the escrow on-ramp can be reached without an API key. The
  escrowed funds never flow through x402 — only the *service of building the
  transaction* does. **[DECISION NEEDED — see §6.]**

The escrow leg's money-safety is unchanged: funds are still escrowed on-chain,
still gated by the fail-closed moderation attestation, still refundable/disputable.
x402 never touches escrowed funds — it only sits in front of the *cheap* tier and
*routes* into the escrow tier.

---

## 5. D4 ledger: separate fast-path volume from escrow volume

PLAN.md P5.4's Done-when requires the **D4 ledger tracks fast-path volume
separately from escrow volume**, and D4 is the demand-evidence ledger that feeds
the §11.5 go/no-go (PLAN.md D4). Mixing the two would corrupt the north-star
metric.

The ledger (`docs/DEMAND_EVIDENCE.md`, plus whatever structured store backs it)
MUST record fast-path and escrow as **two separate volume streams**:

| Dimension | Fast-path (x402) | Escrow (`hire_from_listing`) |
|---|---|---|
| Count | x402-settled calls | minted hires (Task PDAs) |
| Gross volume | sum of x402 settlements | sum of escrowed `price` |
| Per-buyer repeat rate | per-(caller, provider) call counts | per-buyer repeat hires (the north star) |
| Median ticket | x402 median (~$0.20 target) | escrow median (~$50+ target) |
| Escalation events | count of x402→escrow conversions | — |

The **escalation-conversion count** is its own first-class metric: it is the
direct measurement of whether the two-tier thesis is real (do cheap callers grow
into escrow relationships?). The repeat-purchase north star (D4) stays defined on
the **escrow** stream so a flood of cheap fast-path calls cannot inflate it; the
fast-path stream is reported beside it, never merged into it.

Concretely, every x402 settlement and every escalation event is tagged with
`tier: "x402" | "escrow"` and the `(caller, provider, listing)` triple at the
point the hosted API records it, so the D4 roll-up can partition cleanly. This is
a *recording* requirement on the hosted API; it is part of the [HUMAN]-deployed
build, not this design.

---

## 6. DECISION NEEDED (the [HUMAN] approval gate)

Before any x402 code is written or deployed, the following decisions are required.
**Each is policy or a deploy choice, not something this design fixes unilaterally.**

1. **Go / no-go on building x402 at all now.** P5.4 is promoted from "parked" to
   "scheduled" (D5), but the build itself is `[HUMAN: approves the design before
   build; deploys]`. Approve, defer, or reject this design.

2. **Facilitator + asset.** Which x402 **facilitator** settles payments, and which
   **stablecoin mint** is the accepted asset (USDC mainnet vs a devnet mint for
   the Done-when demo)? This determines trust assumptions and the `accepts`
   challenge contents. Self-hosted vs third-party facilitator is a security
   decision.

3. **x402 spec version to pin.** The exact header names / `accepts` shape / payment
   payload MUST track the published, now-Linux-Foundation x402 standard at build
   time (§2.2). Pin the spec version in the build PR.

4. **Escalation threshold + accumulation window (§3.1).** The numeric threshold
   (in listing-denomination units) and the accumulation window. These are
   published policy tuned against D4 median-ticket data, not protocol constants.

5. **Credit carry-over (§3.3).** v1 = no carry-over (fast-path spend is sunk), or
   build the signed credit-note path that credits accumulated x402 spend against
   the escrow `price`.

6. **x402 on `/v1/hires` itself (§4).** Whether the *transaction-building/relay*
   service on the escrow on-ramp is itself x402-metered (independent of the
   on-chain escrowed funds), or whether `/v1/hires` stays key/anonymous only.

7. **Which endpoints are metered (§2.1).** The exact set of read endpoints above
   the free tier and the exact set of hosted micro-task endpoints that accept
   x402, plus the metered-read rate card.

8. **Devnet Done-when demo scope.** PLAN.md P5.4 Done-when: "an HTTP-native agent
   with no Solana stack pays for a listing-API call via x402 on devnet, and the
   escalation path to an escrowed hire is demonstrated." Confirm devnet as the
   demo surface and the acceptance evidence (the two volume streams visible in a
   D4 roll-up).

---

## 7. What is built now vs deferred

| Item | Status |
|---|---|
| This design doc | **Built** (P5.4 step 1) |
| A2A AgentCard discovery surface (`agent-card.ts`) | **Built** (P5.4 step 3 — pure discovery, no payment, not gated) |
| x402 `402` handshake on the hosted API | **DEFERRED — [HUMAN]** (P5.4 step 2; needs §6 decisions + deploy) |
| Escalation envelope + threshold logic | **DEFERRED — [HUMAN]** |
| D4 two-stream volume recording | **DEFERRED — [HUMAN]** (hosted-API recording change) |
| Devnet Done-when demo | **DEFERRED — [HUMAN]** |

The escrow tier itself (`hire_from_listing`, `POST /v1/hires`,
`createIndexerClient`) **already exists** — x402 routes into it and builds no new
escrow code. The only new payment code is the x402 fast-path + escalation router,
and that is entirely behind the [HUMAN] approval gate above.
