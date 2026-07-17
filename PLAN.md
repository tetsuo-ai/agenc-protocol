# PLAN.md — AgenC Embeddable Marketplace: Road to Mass Adoption

> **Historical planning record (banner added 2026-07-17).** This roadmap is a dated planning document, not current state: mainnet has run the full 99-instruction surface (`surface_revision = 4`) since 2026-07-09 — see `docs/MAINNET_MAINLINE.md` for live state and `TODO.MD` for remaining work. Dated body claims (surface sizes, gates, phases) are kept as written.

**Status:** authored 2026-06-09, immediately after PR #47 (humanless hire, completion
bonds, dispute-resolver roster) merged to `main`.
**Source:** a 45-agent adversarially-verified audit (33 confirmed gaps, 1 refuted) +
standing decisions and deploy gates + a market-evidence pass (2026-06-09: competitive
landscape, demand data, marketplace post-mortems) that added **Track D** and the
demand-side amendments. Every confirmed finding maps to a task below.
**North-star metric for the whole plan: repeat-purchase rate per buyer.** Not registered
agents, not listings, not TVL — every dead marketplace studied (GPT Store, RapidAPI,
Alexa Skills) died with full shelves and absent recurring demand.
**Audience:** an AI agent executing phase by phase. Each task has concrete steps and
"Done when" acceptance criteria. Tasks marked **[HUMAN]** are decisions or actions only
the human can take — prepare everything, then stop and ask.

---

## 0. Standing rules (apply to every phase — read first)

1. **LOCAL ONLY by default.** Never `git push`, open/merge a PR, publish to npm, deploy
   on-chain, deploy/modify hosted services, change DNS, sign up with external vendors, or
   provision keys/secrets into services unless the human explicitly asks in the current
   turn. Mainnet deploys and the irreversible live-account migrations are always
   human-owned. Tasks below that end in a hosted/live action are phrased "prepared +
   verified locally; live after human deploys" — build everything, then stop and ask.
2. **Run the full gate before every commit.** Every line runs from repo root
   (directory-changing steps are subshells so the block is copy-paste executable):
   ```bash
   cargo test --lib --manifest-path programs/agenc-coordination/Cargo.toml
   cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml -- -D warnings
   cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml --features mainnet-canary -- -D warnings
   anchor build && npm run artifacts:refresh && npm run artifacts:check
   npm run canary:build && npm run canary:idl && npm run canary:check-idl
   (cd tests-integration && node --test)
   (cd packages/sdk-ts && npm run sdk:drift && npx tsc --noEmit && npm test && npm run build && npm run examples:check)
   ```
   Baseline at time of writing: **232 Rust unit · 158 litesvm · 103 SDK tests**, all green.
3. **Never hand-edit generated artifacts** (`artifacts/anchor/*`,
   `packages/protocol/src/generated/*`, `packages/sdk-ts/src/generated/*`) — regenerate
   (`anchor build` + `npm run artifacts:refresh`, `npm run sync:artifacts`,
   `cd packages/sdk-ts && npm run sdk:generate`).
4. **Every bug fix and every new guard gets a revert-sensitive test** — prove it fails
   against the broken/missing code, then restore.
5. **A `Task`/`ProtocolConfig`/`AgentRegistration` layout change is a migration:**
   append-only, keep the live 169-task prefix valid, `const_assert` the size, add
   `migrate_task` (or sibling) coverage, deploy-gated.
6. **New full-surface instructions are canary-gated** with
   `#[cfg(not(feature = "mainnet-canary"))]` unless mainnet explicitly needs them.
7. **Repos this plan touches** (all under `/home/tetsuo/git/AgenC/`): `agenc-protocol`
   (this repo — program + SDK), `agenc-services-storefront` (hosted explorer API,
   storefront), `agenc-marketplace-agent-kit` (kit/MCP/CLI), `agenc-docs` (docs site).
   Each is an independent git repo — `cd` into it before git/build commands.

### Phase order & parallel tracks

```
Track D  DEMAND VALIDATION (LOIs, paid-service experiment, first-party fulfillment,
         evidence ledger)                         ← starts WEEK ONE, runs parallel to all
                                                    phases; gates P9.1 + the §11.5 go/no-go
Phase 0  Release engineering (npm publish)        ← start immediately; mostly [HUMAN] decisions
Phase 1  SDK runtime core (client/queries/events) ← the DX arc (see intra-phase ordering note)
Phase 2  Test-mode (local + devnet sandbox)       ← P2.1 needs P1.1; devnet deploy is [HUMAN]
Phase 3  Hosted data plane (index, API, webhooks) ← P3.1 needs P1.3 codecs, P3.2 needs P1.2;
                                                    hire-flow Done-whens need P2.2+P2.3
Phase 4  Embeddable UI (React, widget, wallets,
         store templates → PLAN_2.md)             ← needs 1 + 2 (devnet sandbox) + 3
Phase 5  Agent-native distribution (MCP, adapters)← needs 0–1 + P3.1/P3.2 (5.1) + P3.3 + Phase 2 (5.3)
Phase 6  Program Batch 4 (small high-leverage on-chain changes)  ← parallel with 1–5
Phase 7  Content rails (comms, encrypted delivery, identity) ← 7.1/7.2(L1)/7.3-step-1 off-chain;
                                                    7.3-step-2 needs P6.8
Phase 8  Security & trust artifacts               ← parallel track, start early
Phase 9  Mainnet full-surface rollout             ← [HUMAN]-gated choreography
Phase 10 Liquidity & growth (dogfood, seed supply, SEO)  ← after Phase 9 deploy
```

**Critical path:** P1.1 → P2.1 (local sandbox) is the serialized core. Phase 0 runs in
PARALLEL with Phase 1 development — its [HUMAN] decisions (license, publish, visibility)
gate only the publish-dependent Done-whens (P0.2 final check, P1.6, P2.1's npm-install
form). Do not idle on the license decision before writing P1.1 code. Phases 3, 6, and 8
run concurrently with 1–2 subject to the edges shown above.

**Track D is not optional and not last.** The engineering phases answer "can anyone
integrate AgenC?"; Track D answers "will anyone hire through it twice?" — and its
evidence (not its completion) gates the irreversible steps: D1's LOI outcome gates the
P6.2 referral-migration rehearsal, and the D4 ledger feeds the §11.5 go/no-go in P9.1.

---

## Track D — Demand validation (starts week one, runs parallel to every phase)

> From the 2026-06-09 market-evidence pass. The hard numbers this track exists to
> confront: genuine agent-to-agent settled volume is ~$1.6–3M/month globally
> (post-wash-filter); the incumbent (Virtuals ACP, Base-native, token-incentivized) has
> 1.77M completed jobs; liquid agent-gig boards see 10–30 bids per job at $8–35 tickets;
> and the real "pay an agent" money (~$5B+/yr: Cursor, Claude Code, Sierra) transacts as
> SaaS, not marketplaces. AgenC's wedge is being the **neutral, embeddable, token-free
> trust layer on Solana** (the EVM trust slot is being claimed by ERC-8004/8183; the
> Solana seat is open). This track produces the EVIDENCE that buyers exist before the
> irreversible steps are taken. No engineering phase is blocked on Track D, but P9.1 and
> the §11.5 go/no-go consume its output, and D1 gates the P6.2 migration rehearsal.

### D1 Design-partner embedder LOIs — BEFORE the referral migration is rehearsed **[HUMAN: outreach + signs]**
- **Why:** the entire embeddable go-to-market assumes third parties integrate because
  referral fees pay them (P6.2). A referral fee on zero volume is zero — test the
  premise while the program change is still cheap to reshape.
- **Steps (AI prepares, human pitches):** (1) a one-page embedder pitch: the referral
  economics ("you earn X bps of every hire your surface originates, paid by the
  settlement leg on-chain"), a widget mock (P4.3 design), an integration-effort
  estimate; (2) a target list of 10–20 products with existing buyer audiences
  (dev-tools SaaS, agent-framework vendors, vertical marketplaces); (3) track every
  response — a documented "no" with reasons is Track-D evidence too.
- **Done when:** 2–3 signed LOIs at concrete bps terms, OR a written summary of
  rejections fed into the D4 ledger. **Gate:** if zero embedders sign, do NOT rehearse
  the P6.2 referral migration as-specced — revisit its parameters (or the embeddable
  thesis itself) with the human first.

### D2 First paid-service experiment on the sandbox (target: month 2)
- **Why:** the cheapest falsification test of demand — one real service, real strangers,
  measured funnel. Depends on minimal P2.2 + P2.3 (devnet full surface + auto-attestor).
- **Steps:** put ONE fixed-price, first-party-fulfilled service listing live on the
  devnet sandbox (pick from the D3 verticals); publicize it where agent operators
  already are (the kit's user base, MCP directories once P5.1 lands); instrument the
  funnel end-to-end (visit → hire attempt → completed hire → repeat hire).
- **Done when:** 30 days of data in the D4 ledger: stranger-completed hires, median
  ticket size, repeat rate, drop-off points. **Falsification thresholds (from the
  evidence pass):** if median ticket lands under ~$20, the per-hire overhead is
  mispriced for the observed market — escalate the D5/x402 two-tier strategy; if zero
  strangers complete a hire in 30 days, that is §11.5 input, not a reason to build more.

### D3 First-party worker agents with fulfillment SLAs in 2–3 verticals
- **Why:** supply is software — the one cheat agent marketplaces get. 50 credible
  fixed-price listings that actually deliver beat 5,000 idle registrations; quality
  DENSITY in few verticals beats breadth (every empty-shelf marketplace death).
  P10.1 dogfoods *listings*; this task dogfoods *fulfillment*.
- **Steps:** build worker agents on the kit/SDK that auto-claim and fulfill with an
  SLA, in verticals where work recurs and is verifiable:
  (a) **code/security review** — deliberately the confidential, high-ticket vertical
  that wires `agenc-prover`'s ZK private completion into the adoption funnel as the
  *reason to choose AgenC* (settle work without revealing it — no competitor can);
  (b) **data extraction/cleanup**; (c) **content QA**. Publicly subsidize early worker
  earnings if needed — the first 100 agents earning real SOL are worth more than any
  marketing spend, and an announced-but-unshipped revenue promise is ecosystem poison.
- **Done when:** each vertical has a live sandbox listing with guaranteed-SLA
  fulfillment (mainnet after Phase 9); the ZK-completion flow is demonstrated
  end-to-end in vertical (a).

### D4 Demand-evidence ledger (feeds §11.5)
- **Steps:** maintain `docs/DEMAND_EVIDENCE.md` as a living document: repeat-purchase
  rate per buyer (**north star**), count of unsubsidized repeat buyers, median settled
  ticket size, D1 LOI status + rejection reasons, D2 funnel numbers, and a competitor
  watch (ERC-8183 Solana ports, Virtuals' Solana ACP volume, any Solana-native trust
  layer launching — if any moves materially before Phase 9, escalate to the human
  immediately: the open-seat window is the timing premise of the whole plan).
- **Done when:** updated at least monthly; P9.1's §11.5 go/no-go cites it directly.

### D5 Two-tier settlement strategy (fixes the ticket-size mismatch)
- **Why:** AgenC's per-hire machinery (5–7 transactions, rent, optional 25% bonds)
  amortizes at roughly $50+ jobs; observed market medians are $0.20 (x402) to $8–35
  (gig boards). Two coherent responses — do both:
- **Steps:** (1) aim the trust stack where it earns its overhead: the D3(a)
  confidential/professional vertical and listings priced accordingly; (2) promote the
  x402 fast-path (P5.4) from "parked" to a scheduled deliverable — cheap calls flow
  over cheap rails, and escalate to AgenC escrow only when the job is big enough to
  dispute ("x402 for the API call, AgenC for the engagement"); (3) keep retainers/
  engagements (P7.5) on the roadmap as the amortization layer for repeat
  relationships.
- **Done when:** P5.4 implemented per its revised spec; listing-price guidance
  published in the docs; D2/D4 median-ticket data confirms (or falsifies) the split.

---

## Phase 0 — Release engineering: make the SDK installable

> Audit findings #1, #24 (both **critical**). `npm view @tetsuo-ai/marketplace-sdk`
> returns E404 while the package's own README says `npm install @tetsuo-ai/marketplace-sdk`.
> Nothing else in this plan matters to an outside integrator until this phase ships.

### P0.1 Resolve the license conflict **[HUMAN decision, AI prepares]**
- **Why:** root `LICENSE` is GPL-3.0; `packages/sdk-ts/package.json` and
  `packages/protocol/package.json` claim MIT. This legally clouds any npm publish.
- **Steps:** present the human the options (a: relicense repo to MIT; b: keep GPL root,
  add per-package MIT `LICENSE` files and a license note in the root README; c: dual
  license). On decision: add a `LICENSE` file inside each published package and include
  it in the package.json `files` array.
- **Done when:** `npm pack --dry-run` in both packages shows a LICENSE in the tarball and
  `license` fields are consistent with shipped texts.

### P0.2 Fix the SDK README install + peer deps
- **Steps:** in `packages/sdk-ts/README.md`, fix the install line to
  `npm install @tetsuo-ai/marketplace-sdk @solana/kit @solana/program-client-core`
  (the second peer dep is declared in package.json but omitted from the README). Audit
  the whole README for promises that aren't true yet (it references a `sdk.yml` CI
  workflow that doesn't exist — see P0.3) and either build them or remove them.
- **Done when:** every command in the README succeeds in a clean temp dir against a
  locally-built `npm pack` tarball install; re-verify against the real npm package
  after P0.5.

### P0.3 Add `sdk.yml` CI workflow
- **Steps:** create `.github/workflows/sdk.yml` running on PR + main push:
  `npm run sdk:drift`, `npx tsc --noEmit`, `npm test`, `npm run build`,
  `npm run examples:check` in `packages/sdk-ts`. Keep the existing `ci.yml` for the
  protocol workspace.
- **Done when:** workflow file exists, passes locally via `act` or by inspection of
  script names against package.json, and is referenced accurately by the README.

### P0.4 Versioning + changelog + publish pipeline
- **Why:** three-way version drift already exists for `@tetsuo-ai/protocol`
  (git tag v0.1.1 / npm 0.2.0 / local CHANGELOG 0.2.1). The SDK has no changelog at all.
- **Steps:** adopt changesets (or release-please) for `packages/protocol` and
  `packages/sdk-ts`: per-package `CHANGELOG.md`, version PRs, and a tag-triggered
  `.github/workflows/release.yml` that runs the full SDK gate then
  `npm publish --provenance --access public`, and creates a matching GitHub Release.
  Reconcile the protocol package version drift (bump to 0.2.1+, tag correctly).
- **Done when:** a dry-run release from a test tag produces correct tarballs for both
  packages; CHANGELOGs exist; version drift resolved.

### P0.5 Publish `@tetsuo-ai/marketplace-sdk@0.1.0` + `@tetsuo-ai/protocol@0.2.1` **[HUMAN: confirms publish]**
- **Steps:** after P0.1–P0.4, stage BOTH releases and ask the human to approve
  `npm publish` (publishing is an external, irreversible action — never do it silently).
  Publishing protocol@0.2.1 closes the existing three-way drift (npm is still 0.2.0).
- **Done when:** `npm view @tetsuo-ai/marketplace-sdk version` returns 0.1.0,
  `npm view @tetsuo-ai/protocol version` returns 0.2.1, and `npm install` + the README
  quickstart work in a clean project.

### P0.6 Repo visibility **[HUMAN decision]**
- **Why:** the repo is private, so the clone fallback, verifiable builds (P8.3), and
  "public source of truth" branding are all blocked. Publishing the npm package does
  NOT require the repo to be public — flag the decision, don't block Phase 0 on it.
- **Done when:** human has decided; if public, recheck that no secrets/internal docs leak
  (scan history for keys before flipping).

---

## Phase 1 — SDK runtime core (the DX arc)

> Audit findings #2, #3/#10, #4/#8, #7, #9. The facade stops at instruction bytes;
> integrators cannot send a transaction, find a listing, decode an event, or produce a
> valid hash. **Ordering:** P1.1 → P1.2 is the main sequence, but P1.3 steps 1–2 (event
> codec generation) depend only on the IDL/Codama pipeline — run them FIRST or in
> parallel to unblock P3.1 early. P1.4 is independent; only P1.5 needs P1.4.
> All work in `packages/sdk-ts`; every module gets structural tests + e2e tests against
> litesvm (the existing `tests-e2e/harness.ts` pattern) and TypeDoc comments.

### P1.1 Transaction runtime: `createMarketplaceClient`
- **What:** a client object wrapping the facade so
  `await client.hireFromListing({...})` returns a confirmed signature or throws a typed
  error.
- **Steps:**
  1. Promote the proven pipeline from `tests-e2e/harness.ts` (assemble →
     `signTransactionMessageWithSigners` → send → confirm) into
     `src/client/` as the implementation seed.
  2. `createMarketplaceClient({ rpc | rpcUrl, rpcSubscriptions?, signer, commitment?,
     computeUnitLimit?, priorityFee? })`: per-call overrides allowed; defaults applied
     via compute-budget instructions prepended to each tx.
  3. Confirmation: blockhash-expiry-aware retry (re-fetch blockhash and re-sign on
     expiry, bounded attempts), configurable confirm commitment.
  4. Error path: on simulation/exec failure, hydrate via the existing 288 generated
     error constants (`getAgencCoordinationErrorMessage`,
     `isAgencCoordinationError`) into a thrown `AgencError { code, name, message, logs }`.
     Note: generated messages are stripped when `NODE_ENV=production` — ensure the
     client's error path keeps codes + names useful in production builds.
  5. Wrap every facade instruction as a client method (codegen or a thin generic
     `client.send(ix)` plus named conveniences for the flagship flow: registerAgent,
     createServiceListing, hireFromListing, claimTaskWithJobSpec, submitTaskResult,
     acceptTaskResult, postCompletionBond, the dispute family).
  6. Keep instruction-level builders exported unchanged for power users.
- **Done when:** an e2e test drives the full hire→accept flow through
  `createMarketplaceClient` against litesvm with zero manual kit plumbing; a forced
  failure surfaces a typed `AgencError` with the right code; structural tests cover
  compute-budget defaults and overrides.

### P1.2 Query layer: `queries` module (trustless gPA read path)
- **What:** typed getProgramAccounts helpers so "list active listings / open tasks / my
  claims" is one call. Port the dropped patterns from the legacy
  `agenc-sdk/src/queries.ts` onto the current layouts (Task is 432B post-Batch-2).
- **Steps:**
  1. Export per-account discriminator constants + computed field offsets derived from
     the generated codecs (so they are drift-proof — add a test that decodes a known
     fixture and asserts the offsets).
  2. Helpers, each returning `{ address, account }[]` decoded:
     `listActiveListings(rpc, { provider?, category?, state? })`,
     `listOpenTasks(rpc, { capabilities?, minReward?, creator? })`,
     `listClaimsForWorker(rpc, agent)`, `listingsByProvider`, `bidsByTask`,
     `listHireRecordsForBuyer(rpc, buyer)`.
  3. Document loudly: gPA is RPC-provider-dependent (many public RPCs restrict it); the
     hosted indexer API (P3) is the scale path. Design the signatures so an indexer
     transport can drop in behind the same API later.
- **Done when:** e2e tests create N listings/tasks in litesvm and the helpers return
  exactly the matching subset; offsets are asserted against decoded fixtures.

### P1.3 Event layer: codecs + subscriptions
- **What:** the program emits ~87 events (IDL defines 82); the generated client renders
  zero event codecs. Generate them and add subscription/await helpers.
- **Steps:**
  1. Extend the Codama pipeline in `sdk:generate` to render event codecs (or, if Codama
     can't, hand-write a generated-style `src/generated/events/` keyed by the 8-byte
     Anchor event discriminators — but then it MUST be covered by `sdk:drift` so event
     codecs can never lag the IDL).
  2. Export `decodeAgencEvent(logMessages): AgencEvent | null` and
     `parseAgencCoordinationEvents(logs): AgencEvent[]` (discriminated union).
  3. `subscribeMarketplaceEvents(rpcSubscriptions, { events?, addresses? })` returning
     an async iterable over `logsNotifications`, with an automatic polling fallback.
  4. `waitForTaskStatus(rpc, taskPda, status, { timeoutMs })` promise helper.
- **Done when:** an e2e test performs a hire in litesvm and decodes
  `ServiceListingHired`/`TaskCreated` from the transaction logs via the public API;
  `sdk:drift` fails if an event is added to the IDL without a codec.

### P1.4 Domain-value helpers: `values` module
- **What:** today the public API is raw fixed-width byte arrays and unspecified hashing
  (the canonical example uses `new Uint8Array(32).fill(9)` placeholders).
- **Steps:**
  1. `randomId32()`, `sha256(bytes | string): Uint8Array` (32-byte), and
     `descriptionHash(uri | text): Uint8Array` with a documented canonicalization rule
     (UTF-8 NFC text vs URI-bytes — pick one convention, document it, test vectors).
  2. `encodeListingName(str)` / `encodeListingCategory(str)` / `encodeListingTags(string[])`
     + matching decoders — UTF-8, NUL-padded, length-checked, throw on overflow (the
     encoding standard itself is defined in P1.5).
  3. `canonicalJobSpecHash(spec)`: make the kit's canonical-JSON spec hashing publicly
     available so third-party spec hashes interoperate with moderation + explorer
     verification. **[HUMAN: the kit's `packages/job-spec` is EULA-licensed — porting
     its code into the MIT SDK is a relicensing decision. The no-approval-needed
     alternative is a clean-room reimplementation of the hash algorithm validated
     against shared test vectors checked into both repos.]**
  4. Update `examples/embeddable-marketplace.ts` to use these instead of `.fill(n)`.
- **Done when:** a job-spec hashed by the SDK matches the kit's hash for the same spec
  (cross-implementation test vector checked into both repos); example compiles and uses
  no raw `.fill()` placeholder values.

### P1.5 LISTING_METADATA v1 standard
- **What:** `ServiceListing.name/category/tags` are documented only as "client-encoded";
  nothing defines the encoding, the category taxonomy, or what `spec_uri` points at.
- **Steps:**
  1. Write `docs/LISTING_METADATA.md`: UTF-8 NUL-padded lowercase-kebab encoding; a
     canonical category enum (~20 values: code-generation, translation, data-labeling,
     research, image-gen, audio, video, marketing, data-analysis, scraping, devops,
     security, legal, finance, design, writing, support, search, automation, other);
     tags = comma-separated kebab tokens within 64 bytes; a JSON Schema for the
     off-chain listing document at `spec_uri` (display name, long description, pricing
     notes, sample outputs, SLA).
  2. Make the facade's `createServiceListing` accept
     `{ name: string, category: ListingCategory, tags: string[] }` directly (keeping the
     raw-bytes form for power users), validating via P1.4 encoders.
- **Done when:** the spec doc exists; facade accepts strings; round-trip
  encode→on-chain→decode e2e test passes; the JSON Schema is published in the package.

### P1.6 Release 0.2.0 **[HUMAN confirms publish]**
- Ship P1.1–P1.5 as `@tetsuo-ai/marketplace-sdk@0.2.0` with changeset + changelog.

---

## Phase 2 — Test-mode: local sandbox + hosted devnet sandbox

> Audit findings #5, #25 (**critical**) — context from when mainnet ran the canary.
> **Update (2026-06-11): mainnet now runs the full 84-instruction surface** (Phase 9
> complete — `surface_revision = FULL`, all task types enabled, bid marketplace live,
> `ZkConfig` deferred), so listings/hire/bonds/disputes are live on mainnet. The
> original finding (mainnet ran the 25-instruction canary, so a third party had nowhere
> to execute the flagship flow) is resolved by the upgrade.

### P2.1 `@tetsuo-ai/marketplace-sdk/testing` (local litesvm sandbox)
- **Steps:**
  1. Add a `./testing` subpath export to `packages/sdk-ts/package.json`.
  2. Export the litesvm harness: `startLocalMarketplace()` boots litesvm with the
     compiled program `.so`, `ProtocolConfig` + `ModerationConfig` pre-injected, and
     returns `{ svm, client, moderator }`. Default: ship the `.so` inside the npm
     tarball (accept the size cost — there is no public download host while the repo
     is private). If a download path is ever preferred, the only sanctioned host is a
     GitHub Release on the public `agenc-marketplace-releases` repo, pinned by SHA-256.
  3. `moderator.attestListing(listing, specHash)` / `moderator.attestTask(task, hash)`
     record CLEAN attestations locally so the fail-closed gate passes unaided.
  4. Prefunded signer factories (`fundedSigner()`), `expireBlockhash()` passthrough.
- **Done when:** a brand-new consumer project (temp dir, installed from a local
  `npm pack` tarball; re-verified from real npm after the next publish) runs the full
  register→list→hire→claim→submit→accept flow in <30s with no RPC and no secrets,
  copy-pasted from a README snippet. Fold the `./testing` subpath into the P1.6 0.2.0
  release (do P2.1 before publishing 0.2.0) or schedule a 0.2.x release at the end of
  Phase 2.

### P2.2 Devnet full-surface deployment + cadence **[HUMAN: runs the deploy]**
- **Steps:** prepare a `scripts/devnet-deploy.md` runbook (build full surface, deploy to
  devnet program ID `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, initialize
  protocol + moderation config); document the refresh cadence (e.g. redeploy on every
  main merge that changes the program). The human executes deploys.
- **Done when:** devnet runs the full surface; an `anchor idl fetch`-able IDL is
  published on devnet (see P6.5); runbook committed.

### P2.3 Sandbox moderation auto-attestor (hosted) **[HUMAN: deploys + provisions the key]**
- **Where:** `agenc-services-storefront` (or a small standalone service) — hosted rails.
- **Steps:** a devnet-only service holding the devnet moderation authority key: accepts
  `POST /sandbox/attest { listing | task, specHash }` and records a CLEAN
  `ListingModeration`/`TaskModeration` on devnet within seconds, rate-limited per IP.
  AI builds + tests it locally against litesvm/devnet; the human deploys it and
  provisions the authority key into the service.
- **Done when:** an SDK integration test on devnet completes a moderated hire with no
  human involvement, via `sdk.requestSandboxAttestation(...)` helper.

### P2.4 Seeded fixtures + `createSandboxClient()`
- **Steps:** seed devnet with ~10 provider agents + Active listings at known addresses;
  publish them as `@tetsuo-ai/marketplace-sdk/sandbox` constants. Add
  `createSandboxClient()` wiring devnet RPC + airdrop + a funded throwaway signer.
- **Done when:** `examples/localnet-first-hire.ts` (renamed from
  `devnet-first-hire.ts` in WP-D4 — localnet is the shipped sandbox default now)
  broadcasts real devnet transactions from faucet to accepted result, and runs
  nightly in CI (cron workflow) so the sandbox cannot silently rot.

---

## Phase 3 — Hosted data plane: index listings, public API, webhooks

> Audit findings #19, #20, #28 + the refuted-finding correction: a public paginated read
> API ALREADY EXISTS (`marketplace.agenc.tech/api/explorer/{tasks,agents,disputes,search}`
> + SSE `/events`, served from `agenc-services-storefront/server/explorer.ts`, fed by the
> private runtime EventMonitor). The right move is to EXTEND it, not build a new indexer
> from scratch. What it lacks: ServiceListing/HireRecord coverage (the just-merged
> catalog is indexed NOWHERE), public docs, API keys/quotas, and webhooks.

### P3.1 Index ServiceListing + HireRecord into the explorer API
- **Where:** `agenc-services-storefront/server/explorer.ts` + a NEW ingestion module.
- **Architecture constraint:** the existing explorer pipeline is `EventMonitor` imported
  from the private `@tetsuo-ai/runtime` package — do NOT modify that package. Build a
  self-contained listings ingester inside `agenc-services-storefront`
  (logsSubscribe/poll + the P1.3 SDK event codecs) running alongside the existing
  EventMonitor feed.
- **Steps:** ingest `ServiceListingCreated/Updated/Paused/Hired` + `HireRecord` events
  (decode via P1.3's SDK event codecs — don't reverse-engineer layouts); materialize a
  listings read model; validate each ingested listing against the P1.5
  LISTING_METADATA v1 spec and mark nonconforming ones (`metadataValid: false`, filter
  them from default queries); add
  `GET /api/explorer/listings?category=&tags=&provider=&state=&page=&pageSize=`,
  `GET /api/explorer/listings/:pda`, `GET /api/explorer/listings/:pda/hires`,
  `GET /api/explorer/agents/:pda/track-record` (completion/dispute rates from P6.6
  counters once deployed, plus `slashHistory` reconstructed from indexed events),
  `GET /api/explorer/referrers/:wallet/hires` (once P6.2's referrer fields exist —
  backs the store-owner `/earnings` page, PLAN_2.md C3).
- **Depends on:** P1.3 steps 1–2 (codecs); Done-when verification needs P2.2 (devnet
  full surface). **[HUMAN: deploys the updated service]**
- **Done when:** a devnet listing created via the SDK appears in the API within one
  poll interval; a malformed-metadata listing is flagged; pagination + filters covered
  by service tests (verified locally; live after human deploys).

### P3.2 Publish the API: OpenAPI spec, docs, keys, quotas, tx-builder endpoint
- **Steps:** write the OpenAPI 3 spec for the whole explorer surface; publish it (docs
  site + `GET /api/openapi.json`); add self-serve API keys with per-key quotas and rate
  limits (anonymous tier stays for low-volume reads); published terms.
  Add a thin read client in the SDK: `createIndexerClient({ baseUrl?, apiKey? })`
  with the same return types as the P1.2 `queries` module so it is a drop-in transport.
  Add the **transaction-builder endpoint** — the only no-RPC write path, which exit
  criterion #2 depends on: `POST /v1/hires` (and optionally `/v1/tasks`) accepts hire
  parameters and returns an unsigned base64 transaction built via sdk-ts for
  client-side signing; include it in the OpenAPI spec and exercise it in e2e tests
  (build → sign locally → broadcast on devnet).
- **Depends on:** P1.2 (return-type parity). **[HUMAN: deploys]**
- **Done when:** the spec validates; a typed client can be generated from it; SDK
  `queries`-vs-indexer parity test passes (same listing set from both paths on devnet);
  a hire built by `POST /v1/hires`, signed locally, lands on devnet.

### P3.3 Outbound webhooks (Stripe-style) **[HUMAN: deploys]**
- **Steps:** on the indexer, endpoint registration (URL + signing secret) scoped to an
  API key; HMAC-signed JSON deliveries with event IDs (idempotency), retries with
  backoff, and a replayable `GET /v1/events` log. Event types v1: `task.created`,
  `task.claimed`, `task.submitted`, `task.accepted`, `task.rejected`, `task.disputed`,
  `listing.created`, `listing.hired`, `bid.received`, `dispute.resolved`.
- **Done when:** an e2e test registers an endpoint, performs a hire on devnet, and
  receives signed `listing.hired` + `task.created` deliveries; signature verification
  helper exported from the SDK.

### P3.4 Public moderation-attestation endpoint (mainnet) **[HUMAN: deploys + provisions the mainnet moderation-authority key]**
- **Why (finding #16/#28):** production moderation is marketplace-managed with no public
  request path — non-kit integrators cannot get a listing attested, so the fail-closed
  hire gate is a dead end for them.
- **Steps:** `POST /api/moderation/listings` (and `/tasks`): submit the spec, get a scan
  verdict; CLEAN content gets the on-chain attestation recorded within a documented SLA;
  publish the moderation policy document that `policy_hash` commits to; document the
  appeal path. Expose as `sdk.requestListingModeration(...)`.
- **Done when:** a third-party-style integration test goes spec → attestation → hire on
  devnet via public endpoints only; policy doc published.

### P3.5 RPC story + status page
- **Steps:** document the RPC strategy in the SDK README (bring-your-own RPC guidance +
  recommended providers + gPA restrictions); evaluate extending the kit's
  marketplace-managed RPC proxy to SDK/API-key holders **[HUMAN: cost decision]**.
  Prepare `status.agenc.tech` (program, data API, attestation service, content rails)
  with incident history **[HUMAN: DNS + uptime-vendor signup + deploy]**.
- **Done when:** README has the RPC section; status page live with at least uptime
  checks on the four surfaces.

---

## Phase 4 — Embeddable UI: React package, widget, wallets

> Audit findings #6, #21 (**critical**), #23. "Embeddable" currently means instruction
> builders. Depends on P1 (client), P2.2–P2.4 (every Done-when below runs against the
> devnet sandbox), and P3 (indexer/webhooks).

### P4.1 Wallet signing bridge (browser story)
- **Steps:** document + helper for turning browser wallets into the kit
  `TransactionSigner` the SDK expects: `@solana/react`'s
  `useWalletAccountTransactionSendingSigner` (Wallet Standard), plus a compatibility
  shim/guide for legacy `@solana/wallet-adapter` apps. One runnable React example that
  completes a devnet-sandbox hire with a browser wallet.
- **Done when:** the example app works against the devnet sandbox end to end.

### P4.2 `@tetsuo-ai/marketplace-react` (new package in this repo's `packages/`)
- **Steps:**
  1. Headless hooks over the P1 client + P3 API: `useListing(pda)`, `useListings(filter)`,
     `useHire()`, `useTaskStatus(taskPda)` (event subscription with poll fallback),
     `useSubmissionReview()`, `useAgentTrackRecord(agentPda)`.
  2. Prebuilt themable components: `ListingCard`, `ListingGrid`,
     `HireButton`/`HireCheckoutModal` (price + moderation status + escrow funding +
     confirmation states), `TaskTimeline`, `ReviewPanel` (accept / reject /
     request-changes), `DisputeBanner`.
  3. Same release pipeline as the SDK (changesets, sdk.yml-style CI, npm publish).
- **Done when:** a Next.js demo app renders a populated `ListingGrid` from the indexer
  and completes a sandbox hire through `HireCheckoutModal`; package published
  **[HUMAN confirms publish]**.

### P4.3 Script-tag / iframe hire widget (the Stripe-Checkout equivalent) **[HUMAN: deploys to production hosting]**
- **Where:** hosted at `marketplace.agenc.tech/embed/:listingPda`
  (`agenc-services-storefront`).
- **Steps:** a framework-agnostic embed: `<script>` snippet or iframe rendering the
  listing + hire flow, `postMessage` events for completion callbacks
  (`agenc:hire:funded`, `agenc:task:accepted`), CSP/sandbox-safe, themable via query
  params. Wallet flow inside the iframe via P4.1.
- **Done when:** a plain static HTML page embeds a listing and completes a devnet-sandbox
  hire; integration doc published.

### P4.4 Non-crypto buyer onboarding **[HUMAN: vendor + custody decisions]**
- **Steps:** (1) signer adapters wrapping embedded-wallet providers
  (Privy/Dynamic/Web3Auth email-login wallets) into the `TransactionSigner` interface —
  pick vendor with the human; (2) the fiat leg: EITHER an on-ramp session
  (Coinbase Onramp/MoonPay) wired into the hire modal, OR faster: a custodial
  hire-on-behalf endpoint in the hosted API where the platform wallet funds escrow and
  the buyer is billed in fiat — the existing on-chain `operator`/`operator_fee_bps`
  fields are the economic rails for exactly this reseller pattern.
- **Done when:** a buyer with no wallet and no SOL completes a sandbox hire in the demo.

### P4.5 Store templates + `create-agenc-store` (tier 4 of the embeddable ladder)
- **What:** "deploy your own agent store" as a self-serve product: a public
  `agenc-store-templates` repo (three Next.js variants: marketplace store,
  single-provider storefront, vertical store), config-first via one `agenc.config.ts`
  (branding, curation, and **the store owner's wallet as referrer** — every hire
  through their deployment pays them `referrer_fee_bps` via P6.2), a
  `create-agenc-store` scaffold CLI, and one-click Vercel/Netlify deploys.
- **Why:** converts the D1 embedder problem from B2B sales into self-serve — the
  Shopify-theme move applied to the referral leg. Every deployed store is also a
  distribution node (per-store SEO + llms.txt).
- **Detail:** the full execution spec is **`PLAN_2.md` Part C** (Parts A/B/D expand
  P4.2/P4.3/P4.4). **[HUMAN: creates the public templates repo; confirms npm publish
  of the CLI]**
- **Depends on:** P4.2, P3.1/P3.2, P2.2–P2.4; the "earning" Done-when additionally
  needs P6.2 merged and live on the devnet sandbox (PLAN_2.md §0 gate). Templates
  are devnet-first. Track D's D2 experiment does NOT block on templates — if they
  aren't ready by D2's month-2 target, D2 runs on a bare sandbox listing and is
  re-run on a vertical-store instance later as the template proof.
- **Done when:** time-to-earning-store < 15 minutes (README → deployed store earning
  referral bps on a sandbox hire), measured per the PLAN_2.md C5 protocol; the
  first-party storefront catalog is rebuilt on the template (feeds P10.1).

---

## Phase 5 — Agent-native distribution (open the machine funnel)

> Audit finding #22. For an *agent* marketplace, there is currently no open machine
> path: every MCP/tool package is 404 on public npm or locked inside the signed kit
> binary. Depends on Phase 0–1, plus P3.1/P3.2 (P5.1's discovery tools), P3.3 + Phase 2
> (P5.3). Parallel with Phase 4.

### P5.1 Public `@tetsuo-ai/marketplace-mcp`
- **Steps:** an open-source, npx-able MCP server built on the new SDK (NOT the private
  kit internals): readonly by default — listings/tasks/agents discovery via the P3 API,
  listing/task inspection, track-record lookup; mutation tools (hire, claim, submit)
  only behind an explicit opt-in flag using the signer-local policy-gated pattern the
  kit already established. Submit to the MCP registries.
- **Done when:** `npx @tetsuo-ai/marketplace-mcp` works in a clean environment —
  tasks/agents tools validated against mainnet readonly; listings tools validated
  against devnet (mainnet had zero ServiceListing accounts until the Phase 9 full-surface
  upgrade went live 2026-06-11; listings are now a live mainnet surface); registry
  listing live **[HUMAN confirms publish + registry]**.

### P5.2 `@tetsuo-ai/marketplace-tools` + framework adapters **[HUMAN: confirms publish + approves relicensing]**
- **Steps:** publish the framework-neutral JSON-schema tool definitions (they exist,
  unpublished, in `agenc-marketplace-agent-kit/packages/tools/src/index.ts` — but that
  package is `private: true` under the kit's EULA license; releasing its code publicly
  is a relicensing decision the human must approve, same caveat as P1.4 step 3) with
  thin adapters: `toOpenAITools()`, `toLangChainTools()`, `toCrewAITools()`. Keep
  schemas in sync with the MCP server from P5.1 (shared source of truth).
- **Done when:** a LangChain example agent browses listings and prepares (not signs) a
  hire using only public packages.

### P5.3 Worker notification path
- **Steps:** document + helper for worker agents to learn about new claimable tasks
  without bespoke polling: SSE `/events` subscription + webhook subscription (P3.3) +
  `subscribeMarketplaceEvents` (P1.3). Add a `watchClaimableTasks(filter)` convenience
  in the SDK.
- **Done when:** an example worker bot claims a sandbox task within seconds of creation
  with no hand-tuned poll loop.

### P5.4 x402 fast-path + A2A surface (PROMOTED from exploratory — see D5)
- **Why promoted:** x402 is where agent-payment volume actually is (165M cumulative
  transactions, ~49% on Solana, now Linux Foundation-neutral), and AgenC's per-hire
  overhead only amortizes at ~$50+ tickets. The two-tier story — x402 for cheap
  pay-per-call, AgenC escrow when the job is worth disputing — is the answer to the
  market's observed ticket sizes, not a side quest.
- **Steps:** (1) design doc first (the handshake: x402 HTTP 402 payment for listing
  API calls and micro-tasks on the hosted API, with a documented escalation path that
  converts a paying x402 caller into an escrowed `hire_from_listing` when the
  engagement crosses a price threshold); (2) implement after P3.2 (needs the hosted
  API): accept x402 payment on designated endpoints, including `POST /v1/hires`
  pre-funding; (3) publish an A2A AgentCard surface for listings (overlaps P10.3's
  llms.txt/AgentCard work — share the implementation). **[HUMAN: approves the design
  before build; deploys]**
- **Done when:** an HTTP-native agent with no Solana stack pays for a listing-API call
  via x402 on devnet, and the escalation path to an escrowed hire is demonstrated;
  D4 ledger tracks fast-path volume separately from escrow volume.

---

## Phase 6 — Program Batch 4: small high-leverage on-chain changes

> Audit findings #13, #29, #17, #26, #14, #15, #16(b) + the standing decision to retire
> `vote_dispute`. All deploy-gated (Phase 9). **Phase 9 completed 2026-06-11** — the full
> surface (including the referral/Batch-4 Task layout: live Tasks are now 466B) is live on
> mainnet, so these changes are no longer pending a future deploy. Develop further work on
> the full surface behind `#[cfg(not(feature = "mainnet-canary"))]`, full gate +
> revert-sensitive tests per standing rules. Keep each change a separate commit with its
> own litesvm coverage.

### P6.1 `rate_hire` — make the dead rating fields live
- **What:** `ServiceListing.total_hires/total_rating/rating_count` exist
  (`state.rs:1666-1670`) but NO instruction writes the rating fields.
- **Steps:** new instruction `rate_hire`: signer must equal the buyer recorded on the
  task's `HireRecord`; task must be in a terminal Completed state; one rating per hire
  enforced by PDA `["hire_rating", task]` (init-once); args: `score: u8 (1-5)`,
  optional `review_hash: [u8;32]` + bounded `review_uri`. Atomically update
  `listing.total_rating/rating_count` and a provider-agent aggregate (use
  AgentRegistration reserved space or a separate aggregate PDA — prefer the PDA to
  avoid a migration). Emit `ListingRated`. SDK facade + structural + litesvm tests
  (incl. negative: non-buyer, double-rate, non-terminal task).
- **Done when:** full gate green; revert-sensitive tests prove each guard.

### P6.2 Demand-side referral fee (the embedder incentive)
- **What:** today an embedder who brings the buyer earns nothing — the operator leg is
  supply-side (chosen by the provider at listing time). This is the answer to "why
  would a third party embed this?"
- **Steps:** optional `referrer: Option<Pubkey>` + `referrer_fee_bps: u16` args on
  `hire_from_listing`, `hire_from_listing_humanless`, and the `create_task` family;
  snapshot onto Task/HireRecord exactly like the operator leg. **Layout math:** the
  referrer fields total 34B, which EXCEEDS Task's 16B `_reserved` — this is a
  realloc/size-extending migration of the live tasks (169 at the 2026-06-11 upgrade; 432B → larger, new
  `const_assert`, old-size precondition in `migrate_task`), NOT a value-only write into
  reserved space; HireRecord's 32B reserved also cannot hold both fields. Enforce a
  combined cap in `execute_completion_rewards`
  (protocol + operator + referrer ≤ 4000 bps so the worker keeps ≥60%) as a 4th
  settlement leg with the same default-pubkey skip guards; checked arithmetic
  throughout. SDK: accept `referrer` config at `createMarketplaceClient` construction
  so every hire an integrator builds carries their wallet by default.
- **Done when:** litesvm settlement tests prove the 4-way split to the lamport across
  SOL + SPL paths; cap violations rejected; migration coverage updated; full gate green.

### P6.3 Retire `vote_dispute` + arbiter machinery (standing decision)
- **What:** since the resolver-roster rework, votes/quorum no longer gate resolution —
  `vote_dispute` and arbiter instructions execute but are advisory dead weight.
- **Steps:** remove `vote_dispute`, the vote PDAs, arbiter-specific slash paths and
  events from the full surface; clean `Dispute` vote-tally fields ONLY if no layout
  hazard (they're already allocated — prefer deprecating in docs over shrinking the
  account); update SDK facade (remove `voteDispute`), regenerate everything, update
  `tests-integration` and the e2e dispute test to the roster flow (no arbiters).
  Check the e2e port: `packages/sdk-ts/tests-e2e/dispute.e2e.test.ts` still registers
  3 arbiters and votes — rewrite it to roster-resolution.
- **Done when:** no `vote_dispute` in IDL; canary IDL check unchanged; all dispute tests
  green on the roster model alone; full gate green.

### P6.4 Accountable dispute rulings
- **What:** today a ruling is one boolean with no rationale, no resolver in the event,
  no challenge window.
- **Steps (ordered by leverage, ship at least 1):**
  1. Require `rationale_hash: [u8;32]` + bounded `rationale_uri` args on
     `resolve_dispute`. The Dispute struct has NO reserved space — append
     `rationale_hash`/`rationale_uri`/`resolved_by` fields and update the size
     `const_assert` (layout change; disputes were compiled out of the canary build, so at
     canary time no live mainnet Dispute accounts needed migrating — **but as of the
     2026-06-11 full-surface upgrade disputes ARE live on mainnet**, so re-verify on-chain
     whether any Dispute accounts now exist before relying on this; treat append-only).
     Emit the deciding resolver's pubkey + rationale in `DisputeResolved`.
  2. Use `DisputeResolver`'s 32 reserved bytes (real: `_reserved: [u8;32]`,
     state.rs:1777) for case counters: resolved count, overturned count,
     last_resolved_at.
  3. (Design-doc first, build later) challenge window: resolve records a pending
     outcome; `execute_resolution` settles after N hours unless vacated. Include
     resolver stake-at-assignment in this design doc (stake + overturned counters are
     coupled to the challenge mechanism — explicitly deferred there, not dropped).
- **Done when:** (1)+(2) shipped with tests; (3) documented in `docs/` with a decision
  flag **[HUMAN: approve challenge-window + resolver-stake design before build]**.

### P6.5 Surface-versioning contract
- **What:** one program ID can serve the 25-instruction canary build and the full
  surface (84 ixs); nothing lets a client ask what's live. (As of 2026-06-11 the full
  84-ix surface is what is live on mainnet, `surface_revision = FULL`.)
- **Steps:** (1) add a `surface_revision: u16` to ProtocolConfig — NOTE: ProtocolConfig
  has NO `_reserved` field, so this is a realloc/size-extending migration of the live
  mainnet config account (append-only, new `const_assert`, rehearsed in P9.2);
  (2) SDK `getDeployedSurface(rpc)` returning a typed capability set
  (`{ listings, disputes, bonds, ... }`) — it MUST tolerate the pre-migration layout:
  when the account is the old (shorter) size and `surface_revision` is absent, fall
  back to probe accounts / old-layout decode instead of failing (the naive new-codec
  decode breaks on today's mainnet account and would fail its own acceptance test);
  throw a clear `SurfaceNotDeployedError` early from facade/client methods;
  (3) `anchor idl init` per cluster wired into the release runbook so the deployed IDL
  is fetchable truth; (4) `VERSIONS.md` compatibility matrix (program build ↔ SDK
  semver ↔ cluster) updated by the release workflow; written deprecation policy.
- **Done when:** SDK against TODAY's mainnet (old layout) returns `listings: false`
  via the fallback path without erroring; on devnet full-surface returns true; matrix
  committed.

### P6.6 Track-record counters on AgentRegistration
- **What:** only success-side stats exist; rejections, disputes, expirations vanish.
- **Steps:** append counters (`tasks_rejected`, `disputes_won`, `disputes_lost`,
  `claims_expired`, `total_cancelled`) to AgentRegistration. **Layout reality:**
  AgentRegistration has only FOUR reserved bytes (`_reserved: [u8;4]`, state.rs:536) —
  the counters DO NOT fit. Two options; pick one explicitly:
  (a) **aggregate PDA** (preferred — no migration): a new `AgentStats` PDA
  `["agent_stats", agent]`, init-on-first-write, holding the counters; or
  (b) **size-extending migration** of AgentRegistration: a required `migrate_agent`
  instruction following the `migrate_task` pattern (realloc, idempotent,
  multisig-gated, new `const_assert`) over ALL live mainnet agent accounts —
  `register_agent` IS in the canary, so live accounts exist; this extends the P9.2
  rehearsal scope. Increment at the relevant handlers (`reject_task_result`,
  `reject_and_freeze`, dispute resolution, claim expiry, cancellations). SDK
  `getAgentTrackRecord(agentPda)` helper returning
  `{ completionRate, disputeRate, slashHistory, recentOutcomes }` (slashHistory from
  the `disputes_lost` counter + indexed slash events via P3.1); surface in the P3.1
  API.
- **Done when:** litesvm tests drive each path and assert the counters; migration
  coverage if option (b); full gate green.

### P6.7 Sybil/reputation reset economics
- **What:** a slashed agent (5000→4700) re-registers fresh at 5000 for ~rent; fresh
  sybil strictly beats punished veteran. **[HUMAN: approve the economic parameters]**
- **Steps (present options, then build the approved set):**
  1. Probationary start: new agents begin at e.g. 1000 (not `INITIAL_REPUTATION` 5000),
     earning up via completions — calibrate against existing `task.min_reputation`
     usage so honest new agents aren't locked out of all work.
  2. Nonzero `min_agent_stake` default in ProtocolConfig.
  3. Authority-scoped slash history: aggregate worst-reputation across an authority's
     agents at claim time (the wallet-scoped `AuthorityRateLimit` account already
     exists) and/or a post-slash registration cooldown per authority.
- **Done when:** approved subset implemented with revert-sensitive tests proving a
  re-registered sybil no longer outranks its slashed predecessor.

### P6.8 Moderation attestor registry
- **What:** moderation is a single hardcoded global authority; no path for third-party
  or per-integrator attestors.
- **Steps:** mirror the dispute-resolver roster pattern (it's already in the codebase):
  `ModerationAttestor` PDA `["moderation_attestor", attestor]`,
  authority-only `assign_/revoke_moderation_attestor`; `record_listing_moderation` /
  `record_task_moderation` accept the global authority OR any registered attestor.
  Events for assign/revoke. SDK facade + tests (incl. revoked-attestor negative).
- **Neutrality decision [HUMAN]:** an authority-curated roster alone does NOT retract
  the "one company pre-approves every hire" objection — it just adds deputies. Present
  the human the options and build the chosen one alongside the registry:
  (a) a **moderation-optional listings tier** — unattested listings are hireable but
  flagged on-chain and default-filtered out of discovery ("permissionless to deploy,
  curated to be discovered"); (b) per-listing/per-integrator attestor choice (the
  embedder picks any registered attestor, including their own); (c) status quo
  (fail-closed, roster-only) accepted as an explicit positioning trade-off, documented
  honestly. This decision is load-bearing for P8.6's credible-exit test.
- **Done when:** litesvm proves a registered attestor can attest and a revoked one
  cannot; the chosen neutrality option is implemented + tested; gate green.

---

## Phase 7 — Content rails: comms, fair exchange, identity

> Audit findings #31, #32, #18, #30, #33. Items 7.1–7.2 (layer 1) need NO program
> change and can start anytime after Phase 1. 7.3 step 1 is spec work; 7.3 steps 2–3
> are a Batch-4-style program change (new `AgentVerification` PDA + record instruction,
> canary-gated) that hard-depends on P6.8's attestor registry being built AND deployed
> to the devnet full surface. 7.4–7.5 are larger deploy-gated protocol designs — write
> the design docs now, build after Batch 4.

### P7.1 Task-thread message envelope (buyer↔worker comms)
- **What:** `request_changes`/`reject_task_result` anchor 32-byte hashes with no defined
  envelope, transport, or fetch path — the worker can't learn WHAT changes were asked.
- **Steps:** define a hash-anchored message envelope as a sibling of the job-spec
  format: canonical JSON `{ taskPda, parentHash, role, body, attachments[] }`, signed by
  the buyer/worker wallet, sha256 == the on-chain `changes_hash`/rejection digest;
  publish/fetch through the existing marketplace.agenc.tech content rails (same
  upload-ticket model as artifacts) with `GET /api/task-threads/:taskPda`. SDK:
  `postTaskMessage()`, `fetchTaskThread()`, `resolveChangesRequest(hash)`. Kit MCP
  tools so agent workers consume revision requests structurally. No new instructions.
- **Done when:** e2e: a request_changes round-trip where the worker fetches and renders
  the actual change list whose hash matches on-chain.

### P7.2 Encrypted deliverable handoff (fair exchange, layer 1 — off-chain)
- **What:** today the buyer downloads the full plaintext artifact before paying and can
  then reject; the bonds/disputes that mitigate this were not in the canary but ARE in the
  full surface now live on mainnet (since the 2026-06-11 upgrade).
- **Steps (no program change):** extend the artifacts rails with an encrypted-delivery
  convention: artifact encrypted to the creator's pubkey (or per-task symmetric key), a
  public manifest/preview published for review, and the artifact host gating
  full-object download on on-chain task status == Accepted (the host already verifies
  wallets via upload tickets — read-gating is incremental). SDK + kit helpers.
- **Done when:** a sandbox flow delivers an encrypted artifact, buyer previews, accepts,
  then (and only then) can download plaintext.
- **Layer 2 (deploy-gated, design doc now):** optional `key_commitment` on
  TaskSubmission + `reveal_key` on accept with hash-match enforcement and deadline
  bounds. **[HUMAN: approve design before build]**

### P7.3 Agent identity & verification
- **Steps:** (1) publish a versioned agent-metadata JSON Schema (name, description,
  operator domain, contact, logo, ToS URI) and validate/render it in the SDK — pure
  spec work, immediate; (2) a domain-verification attestation service: operator proves
  domain control (TXT record or `.well-known` file containing the agent PDA + a signed
  challenge), service records an `AgentVerification` PDA
  (`["agent_verification", agent]`, written by a registered attestor — this is a NEW
  on-chain account + instruction: canary-gated, full gate + tests, deploy-gated, and it
  depends on P6.8's registry existing on the target cluster); (3) surface `verified` +
  domain in fetchAgent, the P3 API, and the React components' provider cards.
- **Done when:** an end-to-end verification of a test domain shows `verified: true`
  trustlessly readable on-chain and rendered in the demo embed.

### P7.4 Milestones & partial settlement (design → build)
- **What:** escrow is all-or-nothing; partial payment exists only as a dispute outcome.
- **Steps:** design doc first (`docs/MILESTONES_DESIGN.md`): bounded milestone schedule
  (≤8 of `{amount, spec_hash, status}` — child `TaskMilestone` PDA per stage preferred
  over Task realloc), `submit_milestone`/`accept_milestone` releasing tranches through
  the existing 3-way (4-way after P6.2) split; creator-signed `release_partial(amount)`
  for ad-hoc partials/tips; `create_service_listing` declaring a default milestone
  template. Facade: one `Engagement` object. **[HUMAN: approve design]** Then build
  with full migration discipline.
- **Done when:** design approved; implementation passes the full gate with litesvm
  lamport-exact split tests per milestone.

### P7.5 Recurring engagements / retainers (design → build)
- **Steps:** design doc (`docs/ENGAGEMENTS_DESIGN.md`): `Engagement` PDA referencing a
  ServiceListing; buyer prefunds N periods at locked price into one escrow;
  permissionless `renew_period` mints each period's Task (reusing the existing
  lifecycle); `cancel_engagement` refunds unspent periods pro-rata; pair with a
  one-time signing approval covering the engagement cap (kit policy model).
  **[HUMAN: approve design]** Then build.
- **Done when:** design approved; implementation green; facade
  `createEngagement`/`renewPeriod`/`cancelEngagement` with e2e coverage.

---

## Phase 8 — Security & trust artifacts (parallel track, start early)

> Audit finding #27 (**critical**) + #26(4). The program custodies escrow, bonds, and
> stakes, with no SECURITY.md, no disclosure policy, no bounty, no verifiable build, and
> the audit still pending.

### P8.1 SECURITY.md + disclosure policy (immediate, small)
- **Steps:** add `SECURITY.md` (+ `.well-known/security.txt` on the hosted domains —
  **[HUMAN: deploys the hosted-domain piece]**):
  security contact, scope (program + hosted rails), disclosure SLA, safe-harbor
  language. Document the emergency procedures integrators inherit: pause semantics
  (`update_launch_controls`), the money-never-locks exit guarantees, upgrade-authority
  custody.
- **Done when:** files committed; contact alias live **[HUMAN: create the alias]**.

### P8.2 External audit **[HUMAN: commissions; AI prepares]**
- **Steps:** keep `docs/BATCH_1_3_AUDIT_PREP.md` current through Batch 4 (extend with a
  Batch 4 section as Phase 6 lands); assemble the auditor handoff pack (scope, invariant
  list, threat model, test inventory, prior internal-audit results). When the report
  arrives: fix findings (revert-sensitive tests), publish report + remediations under
  `docs/audit/`.
- **Done when:** report published in-repo; all findings closed or accepted with
  rationale.

### P8.3 Verifiable builds
- **Depends on:** P0.6 (repo public) — flag, don't block other work.
- **Steps:** add `solana-verify` to the release workflow; on-chain verification PDA via
  osec.io so `HJsZ...` provably matches the public repo at a tag; document in README.
- **Done when:** `solana-verify verify-from-repo` passes against the deployed program.

### P8.4 Bug bounty **[HUMAN: budget + platform decision]**
- **Steps:** draft scope doc (program money paths > hosted rails > SDK), reward tiers,
  exclusions. Human picks platform/budget; publish.

### P8.5 Upgrade-authority custody **[HUMAN: executes]**
- **Steps:** document the current single-key upgrade authority; prepare the runbook to
  move it to a multisig (e.g. Squads) and state custody in README/SECURITY.md.
- **Done when:** multisig is the upgrade authority on mainnet (human-executed);
  documented.

### P8.6 The credible-exit test ("the operator vanishes and it still works")
- **Why:** neutrality is AgenC's only wedge against both the token-captured incumbent
  and Web2 platforms — and a sophisticated embedder will spend one day discovering
  that hires need our attestation, reads need our indexer, artifacts live on our
  domain, and the repo is private. The counter is not rhetoric; it is a demonstrable
  property. Sell neutrality as math.
- **Steps:** author and actually EXECUTE `docs/CREDIBLE_EXIT.md`: a scripted
  walkthrough proving an end-to-end hire → settle cycle with ZERO tetsuo-ai hosted
  dependencies — own RPC (gPA path from P1.2), moderation satisfied via the P6.8
  neutrality option (own registered attestor or the optional tier), artifacts on
  self-chosen storage, reads without the hosted indexer, against the verifiable build
  (P8.3) from the public repo (P0.6). Document what degrades gracefully (discovery,
  webhooks) vs what keeps working (settlement, escrow, disputes, reputation).
- **Depends on:** P0.6 (repo public), P6.8 (neutrality option), P8.3 (verifiable
  build), P8.5 (multisig).
- **Done when:** the walkthrough runs clean on devnet, is committed, and is linked
  from the README as a first-class trust artifact embedders are pointed at.

---

## Phase 9 — Mainnet full-surface rollout (the big unlock) **[HUMAN-gated]** — ✅ COMPLETED 2026-06-11

> **DONE (2026-06-11):** mainnet was upgraded from the 25-instruction canary to the full
> **84-instruction** surface — `surface_revision = FULL (1)`, all task types enabled, bid
> marketplace live, `ZkConfig` deferred (`complete_task_private` stays off). The 169 live
> Task accounts migrated (382B → 466B, 0 failures) and `ProtocolConfig` migrated (349B →
> 351B). See `docs/MAINNET_ROLLOUT_RUNBOOK.md`. The notes below are the pre-rollout plan.
>
> Everything above ships value on devnet/sandbox; the flagship flow reached real users when
> mainnet moved beyond the 25-instruction canary. This phase was human-owned choreography;
> the AI prepared every artifact and rehearsed on devnet.

### P9.1 Pre-flight gates (all must be green)
- §11.5 human go/no-go (demand thesis + SDK slice + a success signal) — **decided on
  the D4 demand-evidence ledger**, not on engineering completeness: D1 LOI outcomes,
  D2 funnel data (stranger hires, median ticket, repeat rate), D3 fulfillment record.
- External audit (P8.2) complete, findings closed.
- Batch 4 (Phase 6) merged and devnet-soaked; `VERSIONS.md` + migration docs current.
- SDK/client updates for any new required accounts shipped (P6.2 referral fields etc.).
- D1 gate honored: the P6.2 referral parameters were validated (or consciously
  revised) against real embedder responses before this point.

### P9.2 Migration rehearsal (AI does this on devnet now)
- **Scope — ALL live-account migrations Batch 4 creates, not just Task:**
  1. `migrate_task` over all mainnet-shaped Task accounts (Batch 2 operator fields
     + P6.2 referrer fields → realloc to the new size). (Executed against 169 live tasks.)
  2. The P6.5 ProtocolConfig realloc/extend (`surface_revision`) on the live config
     account.
  3. The P6.6 AgentRegistration migration over ALL live agent accounts — only if
     option (b) was chosen in P6.6; enumerate live agents on the devnet clone the same
     way mainnet will be enumerated.
- **Steps:** script the full choreography against a devnet clone seeded with
  mainnet-shaped accounts (149 tasks at rehearsal time; 169 live at the actual upgrade +
  live-agent set + config): deploy new binary
  FIRST → run every migration (each idempotent, multisig-gated) → version-bump LAST.
  Capture a runbook with exact commands, expected outputs, abort criteria, and
  rollback boundaries (binary rollback possible until version bump; migrations
  themselves are irreversible).
- **Done when:** rehearsal runs clean twice from scratch; runbook committed as
  `docs/MAINNET_ROLLOUT_RUNBOOK.md`.

### P9.3 Surface expansion decision **[HUMAN]**
- Decide canary-widening vs full-surface flip (which instruction groups go live:
  listings+hire first, bonds+disputes with them or staged after). Update the canary
  feature gates and `scripts/check-canary-idl.mjs` expected surface accordingly; the
  P6.5 `surface_revision` is bumped at each stage so `getDeployedSurface` stays truthful.

### P9.4 Execute **[HUMAN runs; AI verifies]**
- Human executes the runbook. AI verifies post-conditions: all live tasks migrated (169
  on 2026-06-11, 0 failures), the ProtocolConfig realloc applied (`surface_revision`
  readable = FULL), all live
  AgentRegistration accounts migrated (if P6.6 option b), `getDeployedSurface` correct,
  explorer indexing the new accounts, SDK e2e smoke test against mainnet readonly paths.

---

## Phase 10 — Liquidity & growth (after Phase 9)

> Audit findings #11, #12. An embeddable marketplace with an empty book converts no one.

### P10.1 Dogfood: first-party surfaces use the on-chain listing book **[HUMAN: approves and signs the mainnet listing-creation and first-hire transactions]**
- **What:** today the on-chain ServiceListing book has ZERO consumers — even the
  storefront sells from a file-backed template catalog.
- **Steps:** (1) migrate the storefront catalog so each service template is backed by a
  real ServiceListing — the storefront becomes operator #1, earning `operator_fee_bps`
  through the same `hire_from_listing` path it asks others to embed (the on-mainnet
  listing creations are real signed spend transactions — human approves each batch);
  the catalog UI itself is the P4.5 template instance (PLAN_2.md Part C6) — the
  flagship store runs on the same artifact third parties deploy;
  (2) add `listings list/create/pause` commands to the kit CLI/MCP so existing canary
  providers can publish listings; (3) listings already indexed publicly via P3.1.
- **Done when:** the storefront's catalog page is rendered from the indexer; at least
  one real, human-approved hire flows through `hire_from_listing` on mainnet.

### P10.2 Seed supply **[HUMAN: outreach/curation]**
- **Steps:** a launch program of 20–50 curated provider listings so the first
  third-party embedder renders a populated marketplace on day one. AI prepares the
  onboarding doc + scripts; human recruits. The D3 first-party SLA-backed worker
  agents graduate to mainnet here and anchor the catalog — depth in the 2–3 proven
  verticals over breadth (curate for quality density, and note the boards with
  liquidity already show 10–30 bids per job: supply is NOT the scarce side; recruit
  listings buyers actually purchased on the sandbox).

### P10.3 Web-visible & syndicable listings
- **Steps:** (1) public SSR listing pages at `marketplace.agenc.tech/listings/:pda`
  with schema.org Service/Offer JSON-LD, OpenGraph tags, `sitemap.xml` regenerated from
  the index; (2) a public versioned listings feed (JSON + the P3.2 OpenAPI) explicitly
  licensed for cross-marketplace syndication; (3) auto-generated per-listing
  agent-facing descriptors (AgentCard / llms.txt rendering: name, category, price, hire
  endpoint) so AI-agent directories and crawlers can discover and act on supply. Every
  page links "Hire via SDK" with listing PDA + expectedPrice/version prefilled.
- **Done when:** listing pages indexed by search engines; feed documented; llms.txt
  served.

---

## Cross-cutting: documentation (continuous, every phase)

- Every phase that adds SDK surface updates: the package README, TypeDoc
  (`npm run docs:api`), `docs/DOCS_INDEX.md`, and the `agenc-docs` site.
- After Phase 2: a true QUICKSTART that goes install → local sandbox hire in <5 minutes,
  CI-executed so it can't rot.
- After Phase 3: API reference from the OpenAPI spec.
- After Phase 6/9: `VERSIONS.md` + migration guides per breaking change.

---

## Finding → task traceability (all 33 confirmed + 1 refuted)

| # | Finding (short) | Task(s) |
|---|---|---|
| 1 | SDK unpublished / no release pipeline | P0.1–P0.5 |
| 2 | No transaction runtime | P1.1 |
| 3 | No discovery/query layer | P1.2 |
| 4 | No event layer (DX) | P1.3 |
| 5 | No test-mode/sandbox (DX) | P2.1–P2.4 |
| 6 | No browser/wallet signing story | P4.1 (+P4.2 hooks package) |
| 7 | No domain-value helpers | P1.4 |
| 8 | Event codecs + subscriptions (discovery) | P1.3 |
| 9 | Listing metadata standard | P1.5 |
| 10 | Typed gPA query builders | P1.2 |
| 11 | Dogfooded liquidity | P10.1–P10.2 |
| 12 | SEO/syndicable listing surface | P10.3 |
| 13 | Ratings dead weight → rate_hire | P6.1 |
| 14 | No verifiable track record | P6.6, P3.1 |
| 15 | Reputation freely resettable | P6.7 |
| 16 | Single central moderation attestor | P6.8, P3.4 |
| 17 | Unaccountable dispute rulings | P6.4 |
| 18 | No identity/verification layer | P7.3 |
| 19 | Hosted REST API + indexer + tx-builder endpoint | P3.1–P3.2 (extend existing explorer — see refuted note) |
| 20 | Outbound webhooks + events | P3.3, P1.3 |
| 21 | Embeddable UI layer | P4.2–P4.3, P4.5 (templates — detail in PLAN_2.md) |
| 22 | Public MCP + framework adapters | P5.1–P5.2 |
| 23 | Non-crypto buyer onboarding | P4.4 |
| 24 | Release engineering | P0.3–P0.5 |
| 25 | No test-mode (ops) | P2.2–P2.4 |
| 26 | No surface/versioning contract | P6.5, P8.5 |
| 27 | No security trust artifacts | P8.1–P8.4 |
| 28 | No integrator-facing hosted platform | P3.2, P3.4, P3.5 |
| 29 | No demand-side referral fee | P6.2 |
| 30 | All-or-nothing escrow | P7.4 |
| 31 | No buyer↔worker comms rail | P7.1 |
| 32 | No fair-exchange handoff | P7.2 |
| 33 | No recurring engagements | P7.5 |
| R | (Refuted) read API "missing" — it exists | P3 reuses `marketplace.agenc.tech/api/explorer` instead of rebuilding |

Plus standing items not from the audit: retire `vote_dispute` (P6.3), the §11.5 /
audit / 149-task-migration deploy gates (P9), devnet full-surface deploy (P2.2).

And the five strategy upgrades from the 2026-06-09 market-evidence pass:
demand contact from week one (D1–D2, gating P6.2/P9.1), the ticket-size two-tier
strategy (D5 + promoted P5.4), the neutrality fixes (P6.8 decision + P8.6
credible-exit test), first-party SLA fulfillment (D3), and the repeat-purchase
north-star metric (D4 + exit criteria #7).

---

## Definition of "mass-adoption ready" (exit criteria for the whole plan)

1. A stranger can `npm install` the SDK and complete a local sandbox hire from the
   README in under 5 minutes, and a devnet hire in under 15.
2. A web2 developer can render a populated listings catalog and accept a hire using
   only the hosted API + React package, never touching an RPC.
3. An AI agent can discover, evaluate (track record + ratings), and execute work
   through publicly installable packages (MCP/tools), and an HTTP-native agent can pay
   for the cheap tier via x402 without holding a Solana stack.
4. An embedder earns referral fees from day one with one line of config — and at least
   two design-partner embedders signed on those terms BEFORE the referral migration
   shipped (D1).
5. The program is audited, verifiably built, and its live surface is detectable
   on-chain; every hold-money path has exits and revert-sensitive test coverage; the
   credible-exit walkthrough (P8.6) runs clean — settlement survives the operator
   vanishing.
6. The on-chain listing book is the real catalog for first-party surfaces, seeded with
   real supply, anchored by first-party SLA-backed fulfillment in 2–3 verticals (D3),
   including the ZK-completion confidential vertical no competitor can serve.
7. **The buyer criterion (north star):** a cohort of unsubsidized buyers exists whose
   repeat-purchase rate is measured and growing (D4 ledger) — people and agents hire
   through AgenC TWICE, by choice. Plumbing criteria 1–6 are means; this is the end.
