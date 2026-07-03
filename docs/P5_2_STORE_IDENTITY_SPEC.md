# P5.2 — Store/Marketplace Identity Primitive

> **Status:** DESIGN — draft for founder review. Nothing here is implemented or
> deployed. This is the design-doc-first half of TODO P5.2; the program half is
> an **additive** batch (new account type + three instructions, zero layout
> changes to live accounts) and the manifest half ships with **no program change
> at all**. The deploy, as always, is a human-owned Moment (`CLAUDE.md` golden
> rules + `UPGRADE_AUTHORITY.md`).
>
> Adjacent-but-separate: P5.3 (verifiable referral attribution) is explicitly
> **not** solved here, but §7.6 designs the attachment point so the P5.3
> referrer PDA can hang off this primitive without rework.

## 1. The problem this closes

The thesis says marketplace operators "keep their brand and users" and stores
are "discoverable as a store/marketplace from other nodes." Today neither is
true, because a store has **no existence outside agenc.ag's Neon database**:

- The on-chain program has **45 `#[account]` structs and zero
  store/marketplace entities** (`programs/agenc-coordination/src/state.rs` —
  grep `#[account]`). The closest things are *fee-leg snapshots*, not
  identities: `ServiceListing.operator/operator_fee_bps` (`state.rs:1720-1722`)
  and `HireRecord.operator/referrer` snapshots (`state.rs:1773-1787`). The
  money legs exist; the entity that *earns* them does not.
- A store row is a Neon table row (`agenc-ag/apps/web/lib/server/store-registry.ts:1-14`,
  `UNIQUE(handle)` primary key + `UNIQUE(wallet)`), carrying
  `handle, wallet, title, bio, theme, logoUri, coverUri, tokenMint,
  tokenSymbol, feeBps, operatorFeeBps, operatorWallet, agents[]`
  (`store-types.ts:126-180`). If the Neon database dies, every store identity
  dies with it.
- Store ownership is proven by a wallet signature over a message **domain-bound
  to the literal string `agenc.ag store claim`** —
  `storeClaimMessage()` at `agenc-ag/apps/web/lib/store-types.ts:453`
  (the TODO's `store-types.ts:299` citation is stale; the delete message
  `agenc.ag store delete` is at `:458`). The signed body is
  `canonicalStoreClaimPayload()` (`store-types.ts:397-412`), which **does**
  bind the operator terms (`feeBps`, `operatorFeeBps`, `operatorWallet`) into
  the signature — good — but the envelope is verifiable only as "this wallet
  claimed this config *on agenc.ag*" (`api-stores-route.ts:120-133`). No other
  surface can accept or issue that proof.
- An independent `create-agenc-store` node's entire identity is an **unsigned
  build-time config** (`agenc.config.ts` → `defineStore()` →
  `storeConfigSchema`: `name`, `referrer.wallet/feeBps`, `operator.wallet/feeBps`,
  `moderation.attestorEndpoint/moderator` — `store-core/src/config/schema.ts`).
  Nothing signs it, nothing enumerates it, and no other node can discover it or
  verify that "store X on domain D" and "store X on agenc.ag" are the same
  operator.

This is the last scoreboard row ("operators keep their brand and users:
BROKEN") with no design work done.

## 2. Requirements and non-goals

The acceptance test, concretely:

- **R1 — Enumerable from any node.** A stranger running their own node (RPC
  gPA or the P5.1 indexer) can list all registered stores without asking
  agenc.ag.
- **R2 — Provable fee terms.** A store's default referrer/operator terms are
  verifiable against an owner signature or an owner-signed on-chain account —
  not a claim in someone's database.
- **R3 — Cross-surface recognition.** The same store is recognizable as the
  same store on agenc.ag, on its own domain, and in a third node's UI, by a
  stable key an impersonator cannot forge.
- **R4 — Survives agenc.ag.** If agenc.ag (Neon, Vercel, the company) goes
  away, store identity and discoverability keep working.

Explicit non-goals:

- **Not the referral-attribution fix (P5.3).** `hire_from_listing` still takes
  a client-supplied `referrer: Option<Pubkey>` arg
  (`hire_from_listing.rs:352-353`); any tx builder can still name any wallet.
  We only make sure the future referrer PDA has something to hang off (§7.6).
- **Not a DNS replacement.** We bind identities to domains; we do not replace
  domains, and we do not adjudicate who "deserves" a name (§6).
- **Not content storage.** The chain stores a pointer + hash; branding assets,
  listing feeds, and manifest bodies live off-chain (P5.5's problem).
- **Not curation or quality.** Registration is permissionless; "is this store
  any good / is it a scam" stays at the surfaces (trust lists), exactly like
  the P1.2 roster (`docs/P1_2_OPEN_ROSTER_SPEC.md` §8).

## 3. Architecture A — an on-chain `Store` account

Permissionless `register_store`, following the P1.2 roster shape (self-signed,
self-paid, refundable hardcoded bond, clean exit).

- **PDA seeds:** `["store", owner]` — address-keyed, one store per wallet.
  This matches the live product invariant (Neon `UNIQUE(wallet)`;
  `api-stores-route.ts:151-157` rejects a second handle per wallet) and makes
  the *owner pubkey* the identity, which no one can squat. The alternative,
  handle-keyed `["store", handle]`, gives global handle uniqueness but imports
  the full squatting problem into the program: first-come "nike", confusable
  `n1ke`, dead-owner handle lockup, and a takedown/adjudication lever nobody
  should hold (§6). Rejected.
- **Fields:** display handle (bytes, *not* a uniqueness key), metadata
  `uri + hash` pointing at the §4 manifest, default `referrer_fee_bps`,
  default `operator + operator_fee_bps`, an optional self-declared domain, and
  bond bookkeeping. These are **advertised defaults, not enforcement** — the
  program keeps enforcing fee legs where it already does, at listing creation
  and hire snapshot (`ServiceListing`/`HireRecord`), same snapshot discipline
  as today.
- **Domain binding:** two options. (a) Reuse the `AgentVerification` pattern
  (`state.rs:2234`, attestor-recorded `verified_domain`) — but P1.2 §4.6
  deliberately **decoupled** `record_agent_verification` back onto the single
  global authority because attested domain badges don't belong on the
  permissionless roster; a `StoreVerification` would inherit exactly that
  centralization. (b) **Mutual self-serve binding** — the Store account
  self-declares `domain`, and the domain serves the §4 manifest naming the
  Store PDA; a verifier checks both directions. No attestor, no trust
  delegation, verifiable by anyone with an RPC and an HTTPS client. **Choose
  (b)**; an attested badge can be layered on later if a surface wants it.
- **Enumeration:** gPA by the `Store` discriminator (cheap at any plausible
  store count), plus a `GET /api/explorer/stores` route on the P5.1 indexer
  (same envelope/byte-true `accountData` contract as the four live listing
  endpoints).
- **Cost:** rent ≈ 0.006 SOL (§7.1) + a hardcoded refundable bond (§8 Q1),
  both returned at `close_store`.
- **Squatting/impersonation:** PDA is address-keyed → nothing to squat at the
  identity layer. Handle-display squatting ("Nike Official") is possible and
  is a *surface curation* problem — identical to the P1.2 stance that quality
  lives in edge trust lists, and identical to how the product already treats
  agent names.
- **Migration from Neon:** requires one new signature per owner — a
  `register_store` transaction. agenc.ag cannot migrate anyone unilaterally
  (it doesn't hold keys — correctly). See §7.4.
- **P5.3 attachment:** the Store PDA *is* the registerable referrer identity;
  a future hire gate can accept a `referrer_store` account and resolve the
  payee from `store.owner` (§7.6).

**What it proves:** owner-signed, rent-paid, globally enumerable identity with
tamper-evident metadata. **What it costs:** a program upgrade batch (additive,
but still a deploy Moment) plus ~0.006 SOL + bond per store.

## 4. Architecture B — a signed, domain-neutral store manifest

A canonical JSON document the store wallet signs, served at
`/.well-known/agenc-store.json` on the store's own origin. Schema marker
`agenc.storeManifest.v1` (same versioning discipline as the unified
`agenc.agentCard.v1`, `store-core/src/seo/agent-card.ts:22`).

- **Canonical body (sorted-key JSON, the `canonicalStoreClaimPayload`
  discipline):** `schema`, `wallet` (base58 owner), `handle`, `title`,
  `origin` (the https origin this manifest is authoritative for; empty for a
  hosted store with no own domain), `referrerFeeBps`,
  `operator` + `operatorFeeBps`, `moderation` (optional: the store's
  `moderator` pubkey / attestor endpoint, from `schema.ts:309-326`), `agents[]`,
  `storePda` (optional — filled once Architecture A ships), `updatedAt`.
- **Signature:** ed25519 detached, by `wallet`, over the **domain-neutral**
  message `agenc store manifest v1\nsha256: <hex of canonical body>`. No
  surface string in the envelope — the fix for the `agenc.ag store claim`
  binding. Any surface can verify with `nacl.sign.detached.verify` (the exact
  code already in `api-stores-route.ts:72-87`).
- **What it proves:** the wallet authored exactly this config. Served from
  `origin`, it *also* proves domain control at fetch time (the manifest's own
  `origin` field is inside the signature, so copying it to `evil.com` fails
  the origin check without breaking anything else — the impersonation story).
- **Cost:** zero deploy, zero rent, ships in store-core + agenc.ag this week.
- **Squatting:** there is no global namespace at all — handles are per-origin.
- **Enumeration — the fatal gap:** a crawl needs a seed list of origins, and
  the seed list is… a registry again (Neon, an npm package, a Google search).
  **R1 fails.** A manifest standard alone makes identity *portable* but not
  *discoverable*; a store that agenc.ag delists vanishes from every node that
  seeded from agenc.ag.
- **Migration from Neon:** trivial — agenc.ag already holds every field and a
  wallet-signature ceremony already exists in the store wizard; one re-sign
  per owner produces the neutral manifest.
- **P5.3 attachment:** none. A signed JSON on a website cannot be a
  program-checkable referrer identity.

## 5. The hybrid, and the recommendation

The two halves are not actually competing: **B is A's metadata layer.**

**Recommendation: ship both, manifest first.**

1. **Now (no program change):** define `agenc.storeManifest.v1` (§7.3);
   store-core emits it at `/.well-known/agenc-store.json` from
   `agenc.config.ts` + one owner signature; agenc.ag serves one per hosted
   store and offers a one-click re-sign in the store wizard. This alone fixes
   R2/R3/R4-identity and un-binds ownership proofs from the string
   `agenc.ag store claim`.
2. **Next additive program batch:** the `Store` account (§7.1-7.2), whose
   `metadata_uri`/`metadata_hash` point at the manifest. The PDA supplies
   R1 (gPA enumeration) and R4-discovery; the manifest supplies the rich
   config; the hash makes the pair tamper-evident in both directions
   (PDA → manifest by hash; manifest → PDA by `storePda`).

This ordering means the product surface (templates, agenc.ag, verifiers) is
already built and exercised before the deploy Moment, and the program batch is
a pure identity anchor with no schema churn risk.

## 6. Handle/naming policy — the hard part

Three options, honestly:

| Option | Mechanics | What breaks |
| --- | --- | --- |
| **No on-chain handles** | Store PDA + off-chain display names only | Every gPA consumer must join an off-chain source just to render a list; the account is useless standalone; doesn't even remove display-squatting (it just moves it) |
| **First-come unique handles + bond** | `["store", handle]` PDA or a `["handle", handle]` claim account | A squatting market (bonds are refundable → free options on every brand name); confusables (`n1ke`) survive any charset rule; releasing a trademark to its "rightful" owner requires an adjudicator — a discretionary takedown lever, the exact thing P1.2 refused to hold (roster spec §7: "any judge re-centralizes"); dead owners lock names forever |
| **Handle on-chain, display-only; uniqueness is a surface concern** | `handle: [u8; 32]` on the Store account, charset-validated, *not* a PDA seed, duplicates allowed | Two stores can both display `acme`; surfaces must disambiguate |

**Recommend the third.** Reasoning, not hand-waving:

- The *identity* key must be unforgeable and un-squattable → the owner pubkey
  (and PDA derived from it). Handles are for humans; making them the key makes
  human-meaningfulness a consensus problem, and Zooko's triangle says you then
  give up either decentralization or security. We refuse to build a name court.
- Uniqueness is already, today, a **per-surface** property: Neon enforces
  `UNIQUE(handle)` for agenc.ag routes (`store-registry.ts:11-13`), each
  independent node owns its own routing namespace, and `RESERVED_HANDLES`
  (`store-types.ts:13-17`) is a *route-collision* rule that only makes sense
  per surface. On-chain global uniqueness would force every node to inherit
  agenc.ag's routing constraints.
- Cross-surface recognition (R3) never needed unique handles: the recognizable
  key is the Store PDA / owner wallet, corroborated by the domain binding.
  Surfaces render `@acme` + a verified-domain badge + a truncated PDA, exactly
  how every wallet UI already disambiguates tokens with duplicate tickers.
- On-chain floor we do keep: `register_store`/`update_store` validate the
  handle bytes against the product charset (lowercase `[a-z0-9-]`, 3-20 chars,
  starts alphanumeric — mirror of `HANDLE_RE`, `store-types.ts:9`), zero-padded
  into `[u8; 32]`. This keeps garbage out of every downstream UI without
  claiming uniqueness. The reserved-handle list stays off-chain, per surface.

## 7. Concrete recommendation

### 7.1 Account layout

Follows the house conventions: `#[derive(InitSpace)]`,
`SIZE = INIT_SPACE + 8`, trailing `_reserved` that MUST stay zeroed with a
`validate_reserved_fields()` (the `DefaultTrustList`/`AgentVerification`
shape, `state.rs:2172/2234`), and a size-pin unit test.

```rust
/// P5.2 — permissionless store/marketplace identity. Address-keyed: the owner
/// wallet is the identity; `handle` is DISPLAY-ONLY and not unique on-chain
/// (uniqueness is a surface concern — see P5_2_STORE_IDENTITY_SPEC.md §6).
/// Fee fields are advertised DEFAULTS, not enforcement: listings and hires
/// keep snapshotting terms exactly as today (ServiceListing / HireRecord).
/// PDA seeds: ["store", owner]
#[account]
#[derive(Default, InitSpace)]
pub struct Store {
    /// Owner wallet (signer of register/update/close; the referral payee).
    pub owner: Pubkey,                      // 32
    /// Display handle, lowercase [a-z0-9-], zero-padded. NOT a uniqueness key.
    pub handle: [u8; 32],                   // 32
    /// sha256 of the canonical agenc.storeManifest.v1 body this store points at.
    pub metadata_hash: [u8; 32],            // 32
    /// Manifest URI (typically https://<domain>/.well-known/agenc-store.json).
    #[max_len(256)]                         // MODERATION_URI_MAX_LEN precedent
    pub metadata_uri: String,               // 4 + 256
    /// Advertised default referral fee (bps, <= MAX_REFERRER_FEE_BPS).
    pub referrer_fee_bps: u16,              // 2
    /// Advertised default operator payee (Pubkey::default() = none).
    pub operator: Pubkey,                   // 32
    /// Advertised default operator fee (bps).
    pub operator_fee_bps: u16,              // 2
    /// Self-declared domain (empty = hosted-only store). Verified only by the
    /// MUTUAL manifest check — never trusted alone. Same charset floor as
    /// validate_verified_domain (state.rs:2265).
    #[max_len(253)]                         // AGENT_VERIFICATION_DOMAIN_MAX
    pub domain: String,                     // 4 + 253
    /// Registration bond held as excess lamports on this PDA (P1.2 §4.1 framing:
    /// an identity deposit, never confiscatable; refunded in full at close).
    pub bond_lamports: u64,                 // 8
    /// Monotonic version, bumped on every update (staleness/CAS for indexers).
    pub version: u64,                       // 8
    pub created_at: i64,                    // 8
    pub updated_at: i64,                    // 8
    pub bump: u8,                           // 1
    /// Reserved (future: verification refs, P5.3 referrer bookkeeping). MUST
    /// stay zeroed.
    pub _reserved: [u8; 64],                // 64
}
// INIT_SPACE = 746; SIZE = 754 (+8 discriminator).
// Rent-exempt minimum ≈ (128 + 754) * 6,960 = 6,138,720 lamports ≈ 0.0061 SOL.
```

### 7.2 Instructions

All three are **full-module only** (never in the mainnet-canary allowlist —
no `check-canary-idl` re-baseline, same reasoning as P1.2 §6) and purely
additive: no existing account layout, seed, or instruction signature changes,
so **no migration** — this is the cheap kind of upgrade per golden rule 3.

| Instruction | Signer | Accounts / seeds | Notes |
| --- | --- | --- | --- |
| `register_store(handle, metadata_hash, metadata_uri, referrer_fee_bps, operator, operator_fee_bps, domain)` | `owner` | `init` `["store", owner]`, `system_program` | Permissionless. In-handler `system_program::transfer` of the hardcoded `STORE_REGISTRATION_BOND_LAMPORTS` onto the PDA (the P1.2 finding-5 discipline: enforce the bond, don't assume it). Validate handle charset, `referrer_fee_bps <= MAX_REFERRER_FEE_BPS`, operator-fee pairing (`operator != Pubkey::default()` when fee > 0 — the `create_service_listing` rule), domain via `validate_verified_domain`-equivalent. |
| `update_store(...)` same args | `owner` | `mut`, `has_one = owner` | Bumps `version`, sets `updated_at`. No bond change. |
| `close_store` | `owner` | `mut`, `has_one = owner`, `close = owner` | Refunds rent + bond in one close. **No exit cooldown**: unlike the moderation roster, nothing money-bearing consumes `Store` in v1, so there is no scam-then-exit window to close. Revisit if/when P5.3 makes hire gates read it. |

No authority, no multisig, no attestor anywhere in the lifecycle — a store
registers, updates, and leaves with zero tetsuo-ai keys alive (the
`CREDIBLE_EXIT.md` test).

### 7.3 The manifest standard (`agenc.storeManifest.v1`)

- **Path:** `/.well-known/agenc-store.json` on dedicated-domain nodes. Hosted
  multi-tenant stores can't each own the agenc.ag origin's `/.well-known`, so
  the well-known path is a *convention*, not a requirement — the authoritative
  pointer is `Store.metadata_uri` (agenc.ag serves
  `https://agenc.ag/api/stores/<handle>/manifest`).
- **Canonical body:** UTF-8, sorted keys, the §4 field list. Canonicalization
  reuses the `canonicalStoreClaimPayload` fixed-key-order discipline
  (`store-types.ts:397-412`) so both codebases share one serializer.
- **Signature envelope:** `{ body, wallet, signature }` where `signature` is
  ed25519 over `agenc store manifest v1\nsha256: <hex(sha256(canonical body))>`.
  Deliberately **no origin/surface string in the message prefix** — the body's
  `origin` field carries domain intent *inside* the signed content instead.
- **Verification algorithm (any surface, ~20 lines):** (1) canonicalize body,
  hash, verify signature against `wallet`; (2) if fetched over HTTPS, require
  `body.origin` == fetch origin (empty origin = hosted store, skip); (3) if
  `body.storePda` set: fetch the account, require `owner == wallet` and
  `metadata_hash == sha256(canonical body)` — staleness here means "manifest
  newer than chain" and surfaces should prefer the chain-anchored version.
- Ships in `store-core` (emit + verify + a `verify-store` CLI subcommand) and
  is consumed by agenc.ag when rendering third-party store links.

### 7.4 Neon export/import path

1. **Export (no owner action needed):** a public
   `GET /api/stores/export` dump of all rows **plus each row's most recent
   claim `{message, signature, ts}`**. The existing signatures are
   domain-bound (`agenc.ag store claim`) — they can never become neutral
   manifests — but they *do* prove to any third party that each exported
   config was really claimed by that wallet through agenc.ag at time `ts`,
   i.e. the export is not fabricable by agenc.ag. This is the day-one
   dead-database insurance and costs one API route.
2. **Re-sign (one signature per owner):** the store wizard gains a
   "portable identity" step — build the canonical manifest from the row, owner
   signs the §7.3 message with the already-connected wallet (the same
   `signMessage` flow the claim uses today), agenc.ag hosts the result at the
   stable manifest URL. Lazy migration: prompt on next store edit.
3. **Anchor (one transaction per owner, once the batch deploys):** agenc.ag
   and the templates offer a "register on-chain" button that builds
   `register_store` with `metadata_uri/hash` pointing at the hosted manifest.
   agenc.ag's Neon registry then treats the chain as the source of truth for
   any handle whose owner has a Store PDA (row becomes a cache/render layer).

There is no path that migrates a store without its owner signing something
new — agenc.ag holds no keys, and the old signatures are surface-bound by
construction. State this plainly in the product copy.

### 7.5 What changes where (adoption)

| Repo | Change |
| --- | --- |
| `agenc-store-templates` (store-core) | Manifest emit/verify module + `storePda`/manifest fields on `storeConfigSchema`; templates serve `/.well-known/agenc-store.json`; `create-agenc-store` prints the register-on-chain step in GO_LIVE |
| `agenc-ag` | Export route (§7.4.1); wizard re-sign step (§7.4.2); serve per-store manifests; render other nodes' stores from gPA/indexer enumeration ("Stores elsewhere") |
| `agenc-protocol` (program) | `Store` + 3 instructions (§7.1-7.2), size-pin test, litesvm coverage: bond enforced at register, close refunds bond+rent to owner only, fee-pairing/charset rejects, update bumps version |
| `agenc-protocol` (SDK) | Regenerate kit client (`npm run sdk:generate`, keep `sdk:drift` green), facade wrappers for the three instructions, a `stores list/get/verify` surface |
| P5.1 indexer | `GET /api/explorer/stores` (+ `/stores/:pda`) in the house envelope |

**Ship order:** this doc → manifest standard + export route (product-only, no
deploy) → `Store` program batch — **standalone or ridden on the P1.2 batch-2
Moment** (§8 Q5) → indexer route → agenc.ag/template adoption + migration
prompts. Each stage delivers value without the next: after stage 2 the
scoreboard row moves to "portable but centrally discovered"; after stage 3 it
is fixed.

### 7.6 P5.3 attachment point (design-ahead, not built)

The `Store` PDA is the natural **registered referrer identity**: it is
owner-signed, bonded, enumerable, and already carries `referrer_fee_bps`.
When P5.3 lands, the hire gates can accept an optional `referrer_store`
account constrained to `["store", referrer]` and resolve the snapshot payee
from `store.owner` — replacing "any tx builder names any wallet"
(`hire_from_listing.rs:352`) with "the referrer must be a registered store (or
None)". The 64 reserved bytes leave room for referral bookkeeping
(attribution nonce, lifetime referred volume) without a layout change. Nothing
in this spec depends on that future; nothing in it blocks it.

## 8. Open questions for the founder

1. **Bond size** — recommend a hardcoded `STORE_REGISTRATION_BOND_LAMPORTS` of
   **0.05 SOL** (smaller than the roster's 0.25: a Store gates no consumption
   path, so the bond only prices gPA-namespace spam), refundable in full at
   close, hardcoded for the same no-repricing-rivals reason as P1.2 §4.1.
   Zero-bond is defensible (rent alone ≈ 0.006 SOL) if you'd rather maximize
   registration; I'd keep the small bond.
2. **One store per wallet** — recommend **yes** (`["store", owner]`), matching
   the live product rule. Multi-store operators use one wallet per store
   (wallets are free); a `["store", owner, store_id]` seed can be added later
   as a *new* account type if real demand appears. Confirm.
3. **Handle policy** — recommend **display-only, non-unique on-chain** (§6).
   This is the load-bearing naming decision; confirm you accept "two stores
   can both display `acme`, surfaces disambiguate by PDA + domain badge."
4. **Domain binding** — recommend **mutual self-serve** (§3b: PDA names
   domain, domain serves manifest naming PDA) with **no attestor**. The
   alternative — a roster-attested `StoreVerification` — re-imports the P1.2
   §4.6 problem. Confirm no attested badge in v1.
5. **Batch composition** — ride the P1.2 open-roster upgrade Moment (one
   deploy, but couples an additive feature to a flag-day cutover) or a
   standalone additive batch (smaller blast radius, one more Moment)?
   Recommend **riding P1.2** only if its deploy is still pending when this
   implementation is review-complete; otherwise standalone — never delay the
   P1.2 cutover for this.
6. **Should any money path read `Store` in v1?** Recommend **no** — fee
   enforcement stays at listing/hire snapshots exactly as today; `Store` is
   pure identity until P5.3 deliberately wires the referrer gate. Confirm, so
   nobody "helpfully" adds a `store` account to `hire_from_listing` early.
7. **Manifest `moderation` field** — include the store's trusted
   `moderator`/attestor endpoint in the signed manifest (recommend **yes** —
   it makes a store's moderation posture portable and verifiable, matching
   `schema.ts:309-326`), or keep the manifest to identity+fees only?
