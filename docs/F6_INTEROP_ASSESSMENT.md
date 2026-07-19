# WP-F6 — Ecosystem interop assessment (x402 / A2A / ERC-8004 / ACP / adjacent)

> **Historical assessment record (banner added 2026-07-17).** Web-verified 2026-07-04; the in-repo baseline it cites (e.g. the 90-instruction P1.2 build) is that day's state — mainnet has run the 99-instruction surface since 2026-07-09. See `./MAINNET_MAINLINE.md` for current state and `../TODO.MD` for the completed remediation record.

> **Status: ASSESSMENT — decision-grade, web-verified 2026-07-04.**
> This document is the WP-F6 deliverable: an adversarially honest read of the
> agent-economy interop standards as they exist TODAY, mapped against what AgenC
> actually runs on mainnet, with a go/no-go/defer call per standard. Every
> adoption or status claim carries a source and an access date; anything not
> verifiable at a primary source is marked **UNVERIFIED**. It recommends; it
> does not build. Nothing here changes signing, wallet, or program policy.

## 0. Recommendation summary

| Standard | Recommendation | Revisit | One-line rationale |
|---|---|---|---|
| **x402** (LF x402 Foundation) | **GO — build the fast-path, scoped** | 2026-10-01 (D4 volume check) | Governance is neutral (LF, 2026-04-02), Solana is a first-class settled network (~half of tx), and our rails half-exist; organic volume is small (~$1.11M/30d) so build for the option value + WP-H8 billing, not for revenue today. |
| **A2A AgentCard** (LF, spec v1.0.1) | **GO — schema alignment only** (ship the v1.0 mapping; NO full endpoint) | 2027-01-15 (registry-spec landing) | WP-F4's `agenc.agentCard.v1` + A2A projection is the right artifact; re-pin it from `a2a/v0.2` to v1.0 and serve `/.well-known/agent-card.json`. Full A2A endpoint compliance (task lifecycle over JSON-RPC/gRPC) buys nothing until a client exists that would call it. |
| **ERC-8004** (EVM trustless-agents registry) | **NO-GO on a bridge; counter with WP-H8** | 2026-12-01 (spec-final + usage check) | Mainnet since 2026-01-29, ~285k registered agents, authored from MetaMask/EF/Google/Coinbase — the EVM trust slot IS being claimed (§4). But an attestation bridge is an oracle liability; WP-H8 verification-as-API sells our trust stack to EVM agents without inheriting EVM consensus. |
| **Virtuals ACP** | **NO-GO on a protocol bridge; DEFER a read-side adapter** | 2026-12-01 | Real cumulative agent-to-agent revenue is ~$4M against a $479M headline aGDP, top-3-agent concentrated, $VIRTUAL-staked, platform-operated — and Virtuals itself is pivoting to the open ERC-8183 standard (§4). A settlement bridge imports their token economics for a small verified market. |
| **AP2** (FIDO Alliance) | **DEFER — track, no build** | 2027-03-01 | Spec v0.2, standardization just moved to FIDO WGs (2026-04-28); mandates/VC design is card-rail-first. Too early to target; x402 is its crypto leg anyway. |
| **Stripe/OpenAI agentic commerce, MCP payments, others** | **NO BUILD — monitor** | opportunistic | Retail-checkout-shaped or pre-spec; none currently defines an agent-service settlement layer we could join. |

The strongest single finding: **the x402 wire format changed under our design.**
x402 v2 (launched 2025-12-11) renamed the headers our `docs/X402_FAST_PATH.md`
flow sketch uses (`X-PAYMENT` → `PAYMENT-SIGNATURE`, challenge moved into a
`PAYMENT-REQUIRED` header, CAIP-aligned network IDs) — while the WP-H8 rails
already sitting in `agenc-attestation-service` were written against the v2
header names. The design doc's §2.2 "pin the spec version at build time"
escape hatch did its job, but the pin must now be **v2**, and the fast-path
build should reuse the attestation-gateway implementation rather than write a
second one.

## 1. Our reality (what any interop claim maps onto)

Facts checked in-repo 2026-07-04; this is the baseline every "interop with
AgenC" statement below is measured against.

- **Program:** 90-instruction Anchor program live on Solana mainnet
  (`artifacts/anchor/idl/agenc_coordination.json`, 90 instructions; P1.2 open
  roster build, upgrade custody Squads 2-of-3, verified build badge —
  `docs/MAINNET_MAINLINE.md`, `docs/P1_2_OPEN_ROSTER_SPEC.md`).
- **Settlement:** 4-way atomic split at `complete_task`/accept — worker +
  protocol + operator + referrer — with on-chain caps: each fee leg ≤ 2000 bps,
  combined fees ≤ 4000 bps, worker floor ≥ 6000 bps
  (`programs/agenc-coordination/src/instructions/constants.rs`).
- **Moderation:** permissionless bonded attestor roster with fail-closed
  hire gating (P1.2), live attestor at attest.agenc.ag.
- **Receipts:** every settlement resolves to a public receipt page,
  `https://agenc.ag/receipt/<sig>` (`packages/sdk-ts/src/receipt.ts`,
  `settlementReceiptUrl`, sdk ≥ 0.8.1) itemizing the 4-way split with
  per-leg on-chain links.
- **Store identity:** `agenc.storeManifest.v1` — ed25519-signed,
  surface-neutral store manifest served at `/.well-known/agenc-store.json`
  (`docs/P5_2_STORE_IDENTITY_SPEC.md`, store-core ≥ 0.5.0).
- **Agent/listing discovery:** `agenc.agentCard.v1` — the unified listing
  AgentCard (store-core `src/seo/agent-card.ts`, served by every
  create-agenc-store template at `/api/agent-card/<pda>` and by agenc.ag),
  plus this repo's `@tetsuo-ai/marketplace-tools` emitter
  (`packages/marketplace-tools/src/agent-card.ts`) which carries an `a2a`
  projection currently pinned to `a2a/v0.2`. WP-F4 (in flight in parallel
  with this assessment) unifies these under `agenc.agentCard.v1` with an
  explicit A2A field-mapping table — that is the shipped discovery artifact
  this doc builds on.
- **Toolchain (MIT, published):** `@tetsuo-ai/marketplace-sdk` 0.8.4,
  `@tetsuo-ai/agenc-worker` 0.1.1, `@tetsuo-ai/agenc-cli` 0.2.0,
  `@tetsuo-ai/marketplace-tools` / `marketplace-mcp` 0.4.0,
  `@tetsuo-ai/marketplace-react` 0.4.1.
- **x402 prior art in-house:** `docs/X402_FAST_PATH.md` (design-only, zero
  payment code, 8 open `[HUMAN]` decisions) and a working local-scheme x402
  v2 implementation in `agenc-attestation-service`
  (`services/gateway/src/x402.ts`: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE` headers, `x402Version: 2`, `exact` scheme, HMAC local
  facilitator) — **disabled by default** behind `AGENC_X402_ENABLED=1`.
  This is WP-H8's per-anchor billing rail.

Why this matters for the thesis: "every agent marketplace is a node in the
same global economy" is only true if a non-AgenC agent can (a) *discover* an
AgenC listing, (b) *pay* for it, and (c) *trust* the outcome — without
adopting our whole stack. Discovery is A2A's lane, payment is x402/AP2's
lane, trust is ERC-8004's lane on EVM and ours on Solana. Without deliberate
interop the thesis silently narrows to "every AgenC-scaffolded marketplace,"
which is a distribution claim, not an economy claim.

## 2. x402 — HTTP 402 payments (LF x402 Foundation)

### What it is today (verified 2026-07-04)

- **Spec:** v1 and v2 coexist in the canonical spec tree; **v2 launched
  2025-12-11** ([x402.org/writing/x402-v2-launch](https://www.x402.org/writing/x402-v2-launch),
  accessed 2026-07-04). v2 moves the challenge into a `PAYMENT-REQUIRED`
  header, replaces `X-PAYMENT`/`X-PAYMENT-RESPONSE` with `PAYMENT-SIGNATURE`/
  `PAYMENT-RESPONSE`, adopts CAIP-aligned network/asset identifiers, and adds
  a Discovery extension; reference SDKs remain v1-backward-compatible
  (corroborated by thirdweb's v2 changelog, 2026-01-13, accessed 2026-07-04).
  `exact` remains the primary scheme; `defer` is named in the spec's
  concern-separation.
- **Governance:** the **Linux Foundation formally launched the x402
  Foundation on 2026-04-02**, Coinbase contributing the protocol, with 22
  launch members including AWS, AmEx, Circle, Cloudflare, Google, Mastercard,
  Microsoft, Shopify, **Solana Foundation**, Stripe, and Visa
  ([linuxfoundation.org press](https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol),
  accessed 2026-07-04). Repo custody moved to the foundation org 2026-04-06
  (`coinbase/x402` now carries a development-fork banner; exact foundation
  org slug UNVERIFIED beyond search snippets).
- **Adoption — the honest two-curve picture:**
  - Cumulative: >100M payments by the v2 launch (Coinbase, 2025-12-11);
    Chainalysis (2026-06-03, accessed 2026-07-04) confirms >100M cumulative
    through Q1 2026 but attributes much of the Q4-2025 surge to **memecoin
    farming** (PING pay-to-mint), followed by an early-2026 plateau. Brian
    Armstrong cited ~160M cumulative and "95% of transfer volume now ≥ $1"
    in June 2026 (TechTimes 2026-07-03 — secondary source; original venue
    UNVERIFIED).
  - **Raw usage cooled >92%** from the Dec-2025 peak (~731k tx/day) to
    ~57k/day by Feb–Mar 2026 (OKX Ventures via blockchain.news; CoinDesk
    2026-03-11 "demand is just not there yet" — accessed via search
    2026-07-04). Organic 30-day run-rate as of 2026-05-30: **3.69M tx,
    $1.11M volume, ~$0.30 avg ticket, 189.9k buyers / 43k sellers**
    (x402scan via note.com/x402inc, accessed 2026-07-04; live July dashboard
    UNVERIFIED). Top real usage: machine-readable data APIs and LLM-gateway
    services.
  - **Solana is first-class:** the Coinbase-hosted CDP facilitator settles on
    Base, Polygon, Arbitrum, World, **and Solana**
    ([docs.cdp.coinbase.com/x402/welcome](https://docs.cdp.coinbase.com/x402/welcome),
    accessed 2026-07-04); solana.com/x402 claims 35M+ tx / $10M+ volume on
    Solana since mid-2025 (accessed 2026-07-04); weekly tx share ~49.7% on
    Solana in early Feb 2026 (SolanaFloor, accessed 2026-07-04) and the LF
    press credits Solana with ~65% of 2026 volume. Solana-side settlement is
    concentrated in the **Dexter** (~69% of Solana x402 tx) and **PayAI**
    (~31%) facilitators (SolanaFloor, Feb 2026).

Against the fast-path doc's priors: `docs/X402_FAST_PATH.md` cited "165M
cumulative, ~49% on Solana" (PLAN.md P5.4). The cumulative figure now
verifies at ~160M (June 2026) and the Solana share at ~50–65% depending on
window — the priors hold. What did NOT hold is the wire sketch (§2.2 shows
v1 `X-PAYMENT` headers) and the "$0.20 median" (current avg ~$0.30, and the
volume behind it is far smaller than the headline tx counts implied).

### What interop concretely means for AgenC

The two-tier design in `docs/X402_FAST_PATH.md` still maps cleanly, with
three corrections:

1. **Pin v2.** The `accepts` challenge, header names, and CAIP network IDs
   must target x402 v2 (`network` becomes a CAIP-2 identifier for Solana
   mainnet, asset the USDC mint). The design doc anticipated exactly this
   with its §2.2 standard-fidelity note; the pin is now decidable: **v2**.
2. **Reuse the WP-H8 rails.** `agenc-attestation-service`'s gateway already
   implements the v2 challenge/verify/receipt cycle (local HMAC scheme, not
   yet a standard facilitator). The fast-path build should extract/extend
   that module and swap the local HMAC verifier for a real facilitator
   client, not write a parallel implementation.
3. **Facilitator choice is now concrete** (was §6 decision 2): the
   CDP-hosted facilitator settles Solana natively (free ≤1k tx/mo, then
   $0.001/tx), with PayAI/Dexter as Solana-native alternatives and the
   Faremeter/Corbits stack (UNVERIFIED at first-party source) as the
   self-host option. Trust trade-off: CDP is the lowest-effort, most
   Coinbase-dependent path; self-hosting preserves the credible-exit story
   (`docs/CREDIBLE_EXIT.md`).

Escalation into `hire_from_listing` is unchanged and remains the
differentiated part: nobody else in the x402 ecosystem offers "your $0.30
API call can graduate into an escrowed, moderated, disputable engagement on
the same listing."

### Effort / risk

- **Effort: moderate.** The hosted-API 402 handshake + escalation envelope is
  weeks-scale given the attestation-gateway prior art; the D4 two-stream
  ledger split is a recording change. No program change, no new escrow code
  (the design guarantees this).
- **Risk:** (a) organic x402 demand is currently small — the revenue case is
  weak *today*; (b) facilitator dependency (mitigated by self-host option);
  (c) spec is young at v2 — extensions still moving (Discovery, SIWX). All
  bounded; none touch escrowed funds by construction.

### Recommendation: **GO**, scoped

Build P5.4 step 2 (the 402 handshake on metered reads + micro-task
endpoints + the escalation envelope), pinned to v2, reusing the WP-H8
gateway rails — and simultaneously flip WP-H8 per-anchor billing on the
attestation service when Trust Anchors ship, so one x402 implementation
serves both. The justification is **option value and standards position**,
not current revenue: the LF governance event and the Solana Foundation's
membership mean the Solana seat at the x402 table is real and open, and the
escalation path is a story only we can tell. **What it earns the thesis:**
payment-lane interop — any HTTP-native agent with no Solana stack can pay an
AgenC listing, which is the literal "node in a global economy" claim for the
cheap tier. **Revisit 2026-10-01** against D4 fast-path volume; if the
two-stream ledger shows zero escalations by then, freeze further x402
investment at maintenance.

## 3. A2A AgentCard — discovery (Linux Foundation, spec v1.0.1)

### What it is today (verified 2026-07-04)

- **Spec:** **v1.0.0 stable 2026-03-12, v1.0.1 2026-05-28**
  ([github.com/a2aproject/A2A/releases](https://github.com/a2aproject/A2A/releases),
  accessed 2026-07-04; [a2a-protocol.org spec](https://a2a-protocol.org/latest/specification/)
  confirms 1.0 as latest released). Three normative transports: JSON-RPC,
  gRPC, HTTP+JSON. v1.0 modernized OAuth (PKCE/device-code, dropped
  implicit/password grants) and added **signed AgentCards**
  (`AgentCardSignature`, spec §4.4.7/§8.4). Discovery well-known URI is
  **`/.well-known/agent-card.json`** (the older `agent.json` naming is gone;
  [a2a-protocol.org/latest/topics/agent-discovery/](https://a2a-protocol.org/latest/topics/agent-discovery/),
  accessed 2026-07-04). The spec **explicitly does not standardize a registry
  API** — registries are on the roadmap.
- **Governance:** Linux Foundation since 2025-06-23; TSC includes AWS, Cisco,
  Google, IBM Research, Microsoft, Salesforce, SAP, ServiceNow. IBM's ACP
  merged into A2A 2025-08-29. A2A is **not** part of the Agentic AI
  Foundation (AAIF founding docs and the LF's own A2A one-year press never
  mention it; secondary claims to the contrary are contradicted by primary
  sources — accessed 2026-07-04).
- **Adoption:** 150+ supporting organizations and SDKs in five languages per
  the LF one-year release (2026-04-09, accessed 2026-07-04) — but the release
  names **zero individual production deployers** ("supporters" ≠ deployments).
  Hard number: Python `a2a-sdk` ≈ **11.0M downloads/month, trending up**
  ([pypistats.org/packages/a2a-sdk](https://pypistats.org/packages/a2a-sdk),
  accessed 2026-07-04) — roughly an order of magnitude below MCP (~97M/mo at
  AAIF launch, Dec 2025). Microsoft Foundry's A2A endpoint surface is still
  *public preview* at Build 2026. A widely-shared skeptical read (Credal,
  2026-03-06, accessed 2026-07-04) argues A2A stalled versus MCP.
- **Payments:** core A2A defines none. The `google-agentic-commerce/a2a-x402`
  extension is **frozen at v0.1.0 (2025-09-16, only release ever)**, Python
  only (accessed 2026-07-04). Payments energy lives in the x402 and AP2
  foundations, not inside A2A.

### What interop concretely means for AgenC

Discovery-lane schema alignment — and WP-F4 is already shipping it. The
concrete protocol-level mapping:

| A2A v1.0 AgentCard field | AgenC source of truth |
|---|---|
| `name` / `description` | LISTING_METADATA v1 name/category (`docs/LISTING_METADATA.md`) |
| `provider` | AGENT_METADATA v1 operator identity + `agenc.storeManifest.v1` origin |
| `url` (service endpoint) | store origin / agenc.ag listing URL |
| `skills[]` | one skill per listing: category + tags + spec_uri |
| `capabilities` | non-streaming single-shot hire (as today's `a2a` projection) |
| `securitySchemes` | n/a today — hires are transactions, not authed HTTP calls |
| `AgentCardSignature` | maps naturally onto the storeManifest ed25519 signing discipline |
| (no A2A field) | price terms, CAS guards (`expectedPrice`/`expectedVersion`), `spec_hash`, moderation state — carried in the `agenc.agentCard.v1` superset |

Three actionable deltas, all cheap:

1. **Re-pin the projection.** `packages/marketplace-tools/src/agent-card.ts`
   targets `a2a/v0.2`; the world is at v1.0.1. Update the projection fields
   and the `A2A_SCHEMA_VERSION` constant in the WP-F4 unification pass.
2. **Serve the well-known URI.** Store templates serve
   `/api/agent-card/<pda>`; A2A crawlers look at
   `/.well-known/agent-card.json`. A store is one agent-facade — emit the
   store-level card there (listings as `skills[]`), which composes with
   `/.well-known/agenc-store.json` already specced in P5.2.
3. **Sign the card.** v1.0's `AgentCardSignature` is the same shape as our
   storeManifest signing; signing the emitted card with the store wallet is
   a small, differentiating step (most A2A cards in the wild are unsigned).

**Full A2A endpoint compliance** — actually speaking the A2A task lifecycle
(`message/send`, `tasks/get`, streaming, push notifications) over JSON-RPC or
gRPC — is a different animal: it means running a hosted agent-protocol server
per store, mapping A2A `Task` states onto our on-chain Task lifecycle
(Claimable→Claimed→Submitted→Settled does not round-trip cleanly onto A2A's
working/input-required/completed), and inventing an authentication story for
callers who by definition don't hold Solana keys. That is server
infrastructure with no current caller: no verified A2A production deployment
today would discover and invoke a marketplace listing this way.

### Effort / risk

- Schema alignment: **days**, inside WP-F4's existing surface. Risk ≈ zero
  (pure emission; no payment, no keys).
- Full endpoint compliance: **months**, hosted-service liability, and an
  impedance mismatch with escrowed settlement. Risk: building a server
  nobody calls.

### Recommendation: **GO on schema alignment; NO-GO (defer) on full endpoint compliance**

Ship the v1.0-pinned mapping + well-known URI + signed card through WP-F4.
**What it earns the thesis:** discovery-lane citizenship — an A2A crawler
finds AgenC listings with zero AgenC-specific code, which is the cheapest
possible proof that AgenC marketplaces are nodes in a shared economy rather
than a walled scaffold. **Revisit 2027-01-15** or when the A2A registry spec
lands / a real A2A client that invokes third-party marketplace agents ships,
whichever is first.

## 4. ERC-8004 + Virtuals ACP — the EVM trust slot

### ERC-8004 today (verified 2026-07-04)

- **Spec:** formally still **Draft** (Standards Track ERC; authors Marco De
  Rossi/MetaMask, Davide Crapis/EF dAI, Jordan Ellis/Google, Erik
  Reppel/Coinbase — [eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004),
  accessed 2026-07-04). A "v1.0" overhaul landed ~Dec 2025/Jan 2026: the
  Identity Registry is now **ERC-721** (agents are NFTs), plus Reputation
  (feedback entries, off-chain aggregation) and Validation (stake-secured
  re-execution / zkML / TEE hooks) registries. The spec bakes in the
  adjacent standards: registration files use **A2A agent-card endpoints**
  (A2A v0.3.0 referenced) and reputation feedback supports **optional x402
  payment proofs**.
- **Deployment and numbers:** canonical registries deployed to Ethereum
  mainnet **2026-01-29** (Forbes 2026-02-05 via search; corroborated by
  news.bitcoin.com 2026-02-14, accessed 2026-07-04), now on ~12 EVM chains.
  [8004scan.io](https://www.8004scan.io/) (fetched 2026-07-04) shows
  **~285.6k registered agents and ~427.5k feedback submissions** — up from
  ~21.5k agents in mid-Feb 2026. Honest caveat: registration is a cheap
  permissionless mint (the Feb→Jul jump is dominated by BNB/Base mass
  registrations); feedback count is the better usage proxy and is still
  modest. "50+ contributing organizations" circulates in secondary
  explainers but is UNVERIFIED at a primary source.
- **The trust-slot verdict:** the "EVM trust slot is being actively claimed"
  premise **verifies**. Author-level backing from MetaMask, the Ethereum
  Foundation, Google, and Coinbase; Etherscan and dedicated scanners
  indexing it; RedStone/Credora/The Graph/ChaosChain building on it; a
  dedicated Devconnect day — and, decisively, **Virtuals now designs against
  it** (ERC-8183, below).

### Virtuals ACP today (verified 2026-07-04)

- **State:** ACP v2 is current (unified Jobs interface, Butler chat
  front-end, custom offerings; whitepaper.virtuals.io via search
  2026-07-04), runs on **Base and Solana**, described as permissionless —
  but the registry, Butler, escrow contracts, and payouts are
  Virtuals-operated, and **$VIRTUAL staking gates publishing** (whitepaper
  staking docs, search-surfaced 2026-07-04). Open spec, platform-centric
  operation.
- **Numbers — the 1.77M-jobs prior does not cleanly update.** A current
  cumulative job count is **UNVERIFIED** (the Dune dashboard
  `dune.com/hashed_official/acp-virtuals` returned HTTP 500 on 2026-07-04;
  app.virtuals.io stats are JS-rendered; the whitepaper status page 404s).
  What does verify: headline **aGDP ~$479M** (blockeden.xyz 2026-04-21 via
  search) versus **~$4M actual cumulative agent-to-agent revenue** at the
  point Virtuals ended the aGDP incentive program (techiexpert via search
  snippets, end-date UNVERIFIED); top-3 agents ≈ $406.6M of the aGDP
  (~85–94% concentration), with Ethy AI converting $218.1M "volume" into
  ~$573K of fees ([chainward.ai](https://chainward.ai/decodes/agdp-fdv-disconnect),
  2026-04-29, fetched 2026-07-04). The February 2026 "Revenue Network"
  (up to $1M/month to agents actually selling services) is an explicit
  pivot from volume incentives to revenue incentives (PR Newswire, Feb
  2026, search-surfaced).
- **The strategic tell — ERC-8183.** On **2026-02-25** Virtuals co-authored
  **ERC-8183 "Agentic Commerce"** with the EF's Davide Crapis
  ([eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183),
  search-surfaced 2026-07-04): an open Ethereum standard generalizing ACP's
  Job primitive (escrowed budget, Open→Funded→Submitted→Terminal,
  evaluator-gated settlement) whose outcomes feed ERC-8004 reputation. The
  incumbent platform is conceding that the open standard layer — 8004
  identity + 8183 commerce + x402 payments — is where EVM agent commerce
  consolidates, and repositioning ACP as an implementation of it.

### What a bridge would actually require, and why WP-H8 is the better wedge

An AgenC↔ERC-8004 **attestation bridge** means someone signs EVM
transactions asserting Solana facts (or vice versa): an oracle/relayer
holding an EVM key, posting our settlement outcomes into the 8004
Reputation Registry, mapping agent PDAs onto ERC-721 tokenIds, paying gas
on ~12 chains, and standing behind claims with no slashing or recourse
model on either side. An AgenC↔ACP bridge is worse: it couples our escrow
lifecycle to a Virtuals-operated evaluator/escrow stack and imports
$VIRTUAL staking — for a market whose *verified* cumulative revenue is ~$4M.

The structural insight: **8004's reputation layer accepts pointers, and our
receipts are already publicly verifiable.** Every AgenC settlement resolves
to `https://agenc.ag/receipt/<sig>` with per-leg on-chain links; any EVM
agent (or 8004 feedback aggregator) can verify a Solana settlement today
without a bridge, the same way 8004 itself expects off-chain aggregation of
feedback evidence. What external platforms need is not a bridge but a
**verification endpoint** — which is exactly WP-H8: Trust Anchors serving
verification-as-API (settlement/receipt/moderation verdicts over HTTP),
per-anchor billed via the x402 rails already sitting disabled in
`agenc-attestation-service`. That sells our trust stack cross-ecosystem
with zero consensus coupling and zero oracle liability.

Two cheap optional wedges short of a bridge, both unilateral and
reversible: (a) register AgenC-ecosystem agents in the 8004 Identity
Registry with the registration file pointing at our `agenc.agentCard.v1`
endpoints (one ERC-721 mint per agent; makes us visible in *their*
discovery without trusting anything); (b) a read-side adapter that
surfaces ACP/8183 listings in our explorer UI. Neither is scheduled;
both are noted so the go/no-go is about the *bridge*, not visibility.

### Recommendation: **NO-GO on bridges; GO on WP-H8 as the counter-position**

**What it earns the thesis:** the honest version of "every marketplace is a
node" across ecosystems is *mutual verifiability*, not shared settlement.
WP-H8 makes AgenC's trust stack consumable by EVM agents (and anyone else)
as an API; bridges would make us a liability-bearing oracle in a registry
whose usage is still mostly free mints. **Revisit 2026-12-01**: if ERC-8004
reaches Final with feedback-entry usage growing organically, or ERC-8183
reference deployments settle real volume, re-price the 8004 identity-mint
wedge (a) above — it is days of work whenever we want it.

## 5. Adjacent standards (verified 2026-07-04; one paragraph each)

**AP2 (Agent Payments Protocol) — DEFER, track.** Google's
payment-method-agnostic mandate protocol (signed Intent/Cart Mandates as a
non-repudiable authorization trail) launched 2025-09-16 with 60+ partners;
spec is **v0.2** (adds human-not-present transactions), and Google donated
it to the **FIDO Alliance** (not the LF) announced 2026-04-27/28, where two
new working groups (Agentic Authentication — CVS/Google/OpenAI chairs;
Payments — Mastercard/Visa chairs) now own standardization alongside
Mastercard's Verifiable Intent ([ap2-protocol.org](https://ap2-protocol.org/),
[fidoalliance.org](https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/),
accessed 2026-07-04). No verifiable large-scale production deployment
settles real payments over AP2 yet. Its crypto leg is x402 — so building
our x402 fast-path *is* our AP2 position for now. Revisit 2027-03-01.

**Stripe/OpenAI Agentic Commerce Protocol + Stripe MPP — NO BUILD,
monitor MPP.** ACP (Apache-2.0, OpenAI+Stripe founding maintainers, latest
spec 2026-04-17, beta) is retail-checkout-shaped, and its flagship surface
visibly stumbled: OpenAI retreated from native Instant Checkout in March
2026 after only ~30 Shopify merchants ever went live, shifting to
"Agentic Storefronts" (CNBC 2026-03-24, accessed 2026-07-04). Irrelevant to
agent-to-agent service settlement. The relevant Stripe artifact is
**MPP (Machine Payments Protocol)** on the Tempo L1 (mainnet 2026-03-18,
Stripe/Paradigm-backed) — now the main non-x402 contender for machine
payments (CoinDesk 2026-03-18; WorkOS comparison, accessed 2026-07-04).
MPP is a competing *rail*, not an interop target for a Solana-settled
marketplace; monitor whether facilitator-style abstraction ever makes it
addressable from our fast-path design at near-zero marginal cost.

**MCP payments + registry — NO BUILD needed; we already sit in the right
place.** MCP core has **no payments spec**; the 2026-07-28 release adds an
extensions framework (the likely future home of one) and payments today
happen by layering x402 onto MCP tool calls (Coinbase x402 MCP server,
Cloudflare Agents SDK x402 — docs accessed 2026-07-04). The official MCP
Registry is still preview (API v0.1 frozen since 2025-10-24, ~9.6k server
records May 2026), with ".well-known MCP Server Cards" on the roadmap.
Our `@tetsuo-ai/marketplace-mcp` 0.4.0 is already an MCP-native surface;
when the x402 fast-path ships, x402-metering designated MCP tools via the
same challenge module is a small increment that matches exactly where the
MCP ecosystem is heading. Publish to the MCP Registry when it GAs.

**Cloudflare Monetization Gateway / Pay Per Crawl — monitor.** Pay Per
Crawl (fiat, closed beta; Stack Overflow marquee adopter 2026-02-19) and
the newer Monetization Gateway (x402 stablecoin charging for any
Cloudflare-fronted resource across 10 chains **including Solana**;
waitlist, not GA — [blog.cloudflare.com/monetization-gateway/](https://blog.cloudflare.com/monetization-gateway/),
accessed 2026-07-04) are distribution for x402, not a separate standard.
If the Gateway GAs with Solana settlement, an AgenC store behind
Cloudflare gets metered-read monetization nearly for free — a reason to
keep our fast-path v2-conformant rather than local-scheme.

**Card networks (Mastercard Agent Pay, Visa Intelligent Commerce) —
monitor only.** Both are live-ish (Agent Pay's first authenticated agentic
transactions in HK/Thailand, Mar–Apr 2026; Visa's Intelligent Commerce
Connect single-integration surface) and both converged into FIDO alongside
AP2 (pymnts/techinformed, accessed 2026-07-04). They are card-rail trust
layers for consumer commerce; nothing for a crypto-settled service
marketplace to integrate today.

## 6. What this buys the thesis, honestly

By mid-2026 the standards landscape consolidated into three governance
homes: **Linux Foundation** (MCP+AAIF, A2A, x402 Foundation), **FIDO**
(AP2 + card-network trust), and **Ethereum's ERC track** (8004 identity +
8183 commerce). The EVM seat of the "global agent economy" is being
claimed exactly as the thesis feared — 8004 mainnet + Virtuals folding ACP
into ERC-8183 is the incumbent conceding to an open standard, which is the
strongest possible confirmation that trust layers consolidate per
ecosystem. **No Solana-native equivalent of 8004/8183 surfaced in any
verified source** (accessed 2026-07-04); Solana's agent-economy presence is
payments-heavy (roughly half of x402 transactions) and trust-light. A
90-instruction settlement program with capped 4-way splits, a
permissionless moderation roster, verifiable receipts, and signed
store/agent identity documents is — as far as this verification pass could
establish — the most complete Solana-native candidate for that seat. The
seat is open, and §2–§4 are the three moves that claim it without
overbuilding: speak x402 v2 (payments lane), emit A2A v1.0 cards
(discovery lane), sell verification-as-API instead of bridging trust
(trust lane).

The equally honest counterweight: **organic demand is small everywhere.**
x402's organic run-rate is ~$1.11M/30d after a >92% cooldown; Virtuals'
verified cumulative agent-to-agent revenue is ~$4M; AP2 and full-A2A have
no verified production settlement at all. Interop in 2026 buys *position*,
not revenue — every GO above is justified by cheapness (reused rails,
days-to-weeks scope) and by the cost of the seat being taken, not by
traffic projections. None of it displaces the D4 demand-evidence work,
and the 2026-10/2026-12 revisit dates exist precisely so position-taking
gets re-priced against measured demand rather than renewed on momentum.
