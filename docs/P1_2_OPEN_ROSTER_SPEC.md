# P1.2 — Permissionless Moderation: the Hardened Open Roster

> **Status:** DESIGN — reviewed. Direction decided 2026-07-03 by an 18-agent
> design search (6 lenses → 4 steel-manned models → attack → scored judge, HIGH
> confidence); this spec then went through a 36-agent adversarial review
> (5 reviewer lenses → per-finding verification → synthesis) that raised 30
> findings, 29 code-confirmed. Verdict: **FIX_SPEC_FIRST — the model is sound,
> the spec had holes** (all in the two hardenings, §5). **This revision folds
> in every confirmed fix.** Input to the batch-2 program upgrade. **Nothing
> here is deployed.** The deploy is a human-owned Moment (`CLAUDE.md` golden
> rules + `UPGRADE_AUTHORITY.md`).
>
> Supersedes the recommendation in `MODERATION_NEUTRALITY.md` (whose central
> premise — "consumption gates require `moderator == moderation_authority`" —
> was made false by WP-A1 on 2026-07-02).

## 1. The problem this closes

WP-A1 (deployed 2026-07-02) made the consumption gates
(`set_task_job_spec`, `hire_from_listing`, `hire_from_listing_humanless`)
accept an attestation from **any registered, non-revoked** `ModerationAttestor`,
not only the global `moderation_authority`. That was the hard part.

But **registration is still closed**: `assign_moderation_attestor` /
`revoke_moderation_attestor` are gated on `moderation_config.authority` — one
tetsuo key. So a third-party marketplace can moderate its own supply *only if
tetsuo adds them to the roster*. That gatekeeping is the last thing standing
between the current state and the thesis's Definition-of-Global item 3 ("a
team with no contact with tetsuo-ai can moderate its own supply"). It is also
the compounding half of P0.3 (the same key is the roster authority) and the
open half of P1.3 (if that key dies, no new attestor can ever register).

## 2. What we are building (one paragraph)

Make attestor registration **permissionless** (self-signed, self-paid, a
hardcoded bond as an attributable-identity deposit that caps concurrent
identities per unit capital — never confiscatable, not a sybil rate-limit),
make moderation
records **moderator-keyed** so no attestor can overwrite another's verdict,
let the **risk-bearing caller choose** which attestor's verdict it consumes
per transaction, and keep quality curation **at the surfaces** (each store
trusts an attestor list it controls; agenc.ag ships a signed, forkable
default). Two hardenings the plain version lacked, both surfaced by the
adversarial pass: the default trust list lives **on-chain under the existing
2-of-3 multisig** (not an npm key), and a narrow multisig-governed
**BLOCK-only global floor** exists so illegal/sanctioned supply can be taken
down without any single party being able to gate anything *in*.

## 3. Why this and not the alternatives (the search result)

Four models were steel-manned and attacked. Weighted scoring (structural spam
defense 25, credible neutrality/liveness 25, program-diff risk 20, integrator
UX/adoption 20, thesis fit 10; an unmitigated FATAL caps a model at 30):

| Model | Score | Why it lost |
| --- | --- | --- |
| **Hardened Open Roster** (this spec) | **61 — WINNER** | — |
| Pin-Default BYOA | 55 | The pin is optional + creator-mutable, so it can't enforce its own "moderated by X" badge; omit-the-pin forges the badge and pin-cycling erases a BLOCKED verdict. Fixing it (required pins + CAS) erases its only edge over this model. |
| Slashable Bonded Roster | 49 | Its whole differentiator — slashing teeth — isn't real: the judge is either tetsuo's keys (the confiscation lever it claims to remove) or a sybil-capturable stake vote; slash throughput loses to sybil throughput. Collapses to this model + money-path risk. |
| Owner-Pinned Attestor | 30 | **FATAL:** exclusive-writer pins make self-attested illegal/sanctioned supply structurally *un-takedownable* on a real-escrow program. The only fix (a governance BLOCK override) deletes the differentiator it exists for. Its listing-side owner-pin is elegant and worth revisiting post-PMF. |

Decisive argument for the winner: it **subsumes a moderation-optional tier**
without building one — a party wanting "no moderation" self-registers and
self-attests, which is opt-out *with on-chain provenance*. Same freedom as an
unattested tier, strictly more information (every live listing still names an
identifiable, revocable-by-reputation attester). There is no reason to build
the weaker thing.

## 4. Mechanism

### 4.1 Permissionless bonded registration
- New instruction `register_moderation_attestor`: a clone of
  `assign_moderation_attestor` **minus the authority constraint**. The
  attestor self-signs and self-pays rent; `assigned_by = self` (already a
  field — distinguishes self-registered from authority-deputized).
- A **hardcoded** `REGISTRATION_BOND_LAMPORTS` compile-time constant
  (~0.25–0.5 SOL) is system-transferred as excess lamports onto the existing
  `["moderation_attestor", attestor]` PDA. **Hardcoded, not a config field** —
  so nobody can quietly reprice registration to exclude rivals; changing it is
  a visible multisig'd upgrade. Framed honestly as an *identity/registration*
  cost, **never a quality bond**, and **never confiscatable** (see §7).
- Bookkeeping (`bond_lamports: u64`, `registered_at: i64`, `exit_at: i64`,
  flags) lives in the existing `ModerationAttestor._reserved: [u8; 32]`
  (verified present). Legacy authority-assigned entries read these as 0 =
  unstaked/grandfathered. **Value-only migration; no account-layout change.**

### 4.2 Two-step exit (concurrency cap, honestly framed)
- `request_attestor_exit` sets `exit_at` on the entry; `finalize_attestor_exit`
  refunds bond+rent via `close = attestor`, and **must assert
  `exit_at != 0 && now >= exit_at + EXIT_COOLDOWN`** (review finding 5). Without
  the `exit_at != 0` guard, a freshly-registered or grandfathered entry (whose
  reserved bytes are zeroed at register — `assign_moderation_attestor.rs:64`)
  satisfies `0 + COOLDOWN` and finalizes **instantly, zero cooldown**, nullifying
  the whole point. `request_attestor_exit` must be **monotonic** (cannot reset a
  running clock).
- **Register must enforce the bond, not assume it** (finding 5): either deposit
  via an in-handler `system_program::transfer` CPI that cannot be skipped, or
  assert `pda.lamports >= rent_exempt_min + REGISTRATION_BOND_LAMPORTS` as a
  post-condition.
- **What the exit actually buys — stated honestly** (findings 5a, 7): the record
  path rejects an exiting attestor, but the **consumption gates are the
  question**. Decision required (Open Question 6): either the three gates also
  read `exit_at` from `ModerationAttestor._reserved` and reject an in-window
  attestor, **or** we consciously document that exit-flagged attestations stay
  consumable until finalize (a ≤7-day scam-then-exit window) and drop any claim
  that "exited" records stop publishing. **This spec chooses the former** — gates
  reject an in-exit-window attestor — so the window closes at request, not
  finalize.
- **Honest framing** (finding 7): with a 100% refund and no slashing, the
  marginal cost of a throwaway identity is ~a 7-day float on the bond ≈ zero.
  The bond **caps concurrent identities per unit of working capital**; it is NOT
  an identity-creation cost or a "sybil rate-limit." Real sybil defense lives in
  the edge trust lists (§8) and is P6.4's job. Do not oversell this.

### 4.3 Moderator-keyed records (the risk center)
- Today `TaskModeration`/`ListingModeration` are seeded
  `["task_moderation", task, job_spec_hash]` (no moderator) and written with
  `init_if_needed` — **so any registered attestor can overwrite any other's
  verdict** (flip a trusted BLOCKED→CLEAN, or grief CLEAN→BLOCKED). Under a
  closed roster that's inert; under open registration it's an open door.
- Move records to **v2 moderator-keyed seeds**:
  `["task_moderation_v2", task, job_spec_hash, moderator]` (+ listing mirror).
  Each attestor owns an exclusive slot → `init_if_needed` becomes
  self-re-review only. N concurrent verdicts coexist; a trusted attestor's
  BLOCKED is **un-erasable evidence** (the Certificate-Transparency property).
- This is the one **seed change** and the highest-risk diff. It is de-risked
  by an already-proven pattern: the consumers *already* derive the optional
  attestor PDA off the **stored** `task_moderation.moderator`
  (`set_task_job_spec.rs:60`), so dual-derivation on the consumer side is a
  known shape, not new ground. A wrong-seed bug fails **closed** (no record
  loads → gate rejects).

### 4.4 Consumption (caller chooses the underwriter)
- The three gates keep **every** downstream check byte-identical (binding,
  publishable status ∈ {CLEAN=0, HUMAN_APPROVED=4}, `risk_score ≤ 100`,
  expiry, live-roster-PDA-or-global-authority). The only change: they load the
  v2 record of the attestor **the caller presents** — which means a **new
  explicit `moderator` instruction argument** on all three gates (an
  IDL/SDK/canary-surface change — see §6, review finding "new instruction
  arg"). The risk-bearing hirer/surface selects the underwriter per
  transaction; the hire tx permanently records whose attestation was relied on.
- **This is a refactor of a currently fail-CLOSED path — the risk is
  REGRESSION, not a new fix** (review finding 4, correcting the previous
  draft). Today `set_task_job_spec.rs:58-65` binds the optional attestor PDA
  off `task_moderation.moderator` with a **declarative Anchor** `constraint =
  attestor == moderator`, and `rs:211-214` already rejects a non-authority
  record with no attestor. A revoked attestor already fails closed (its PDA is
  gone → won't load). The earlier draft called this a "fail-open must-fix" — it
  is not; it is a shipped property we must not break.
- **Why v2 forces hand-rolled derivation** (finding 4): the "already-proven
  shape" claim conflated two patterns. `resolve_listing_attestor` derives a
  **secondary** PDA off an already-loaded, moderator-free **primary** record.
  v2 `["task_moderation_v2", task, hash, moderator]` puts the moderator **inside
  the primary** record's seed — circular for Anchor's declarative seeds. So:
  - Take `moderator` as an explicit instruction arg.
  - Keep the attestor sub-binding **Anchor-static** where possible: seeds
    `["moderation_attestor", moderator_arg]`, require it to load.
  - Only the **v2-else-legacy record fallback** needs handler-level
    `find_program_address`. For that manual slot, **enumerate the exact
    `require!` re-checks that replace each dropped Anchor constraint**:
    `owner == crate::ID`, discriminator match, and the binding
    (`task`/`creator`/`job_spec_hash` on the task side;
    `listing`/`spec_hash` on **both** hire gates, whose `listing_moderation`
    also becomes moderator-keyed — mind the load-order inversion: `moderator`
    is needed *before* the record loads). One revert-sensitive litesvm test
    **per re-implemented constraint**.
- **Legacy branch (grace window):** a legacy-seed record is accepted **only**
  where its stored `moderator == moderation_authority` (unforgeable — legacy
  writes required authorization) **OR** where the stored moderator is a
  currently-registered, non-revoked roster attestor with its roster PDA
  presented. The second clause eliminates the 13tuj/attest.agenc.ag
  dark-window at cutover and is overwrite-safe (post-upgrade `record_*` only
  writes v2 seeds, so legacy PDAs are frozen).

### 4.5 The takedown gate (BLOCK floor) — read §5.2; every gate consumes it
All three consumption gates additionally load and honor the **required**
content-hash-keyed BLOCK account (§5.2). This is not optional and not
caller-chosen; see §5.2 for why that distinction is load-bearing.

### 4.6 Agent-verification is a fourth/fifth roster consumer (review finding 3)
`record_agent_verification` and `revoke_agent_verification` call the **same**
`require_moderation_authorized` against the **same** `ModerationAttestor`
roster (`record_agent_verification.rs:21`), and `AgentVerification` is
`init_if_needed` single-slot keyed only `["agent_verification", agent]`. So
opening §4.1 registration would silently let any bonded self-registered key
(a) write "operator domain D controls agent A" badges for domains it does not
control, and (b) overwrite/revoke another attestor's legitimate verification —
the exact single-slot clobber §4.3 closes for moderation records but *not*
here.
- **Mitigating fact:** no on-chain **money** gate consumes `AgentVerification`
  today — it is a read-only provenance badge (P7.3).
- **Decision (Open Question 7):** **decouple** — gate
  `record/revoke_agent_verification` on the **global `moderation_authority`
  only**, reverting them off the open roster. Domain-verification is a
  different trust question from content moderation and shouldn't ride the
  permissionless roster in v1. (Alternative, deferred: accept
  permissionless-with-provenance and apply the same v2-keying + exit-rejection
  hardenings to `AgentVerification` — more surface, no v1 benefit.)

### 4.7 Non-confiscatory revoke
- `revoke_moderation_attestor` is constrained to `assigned_by == authority`:
  the authority may remove only entries **it itself deputized**. A
  self-registered attestor can be removed from chain by **no one but itself**.
  (The "authority revoke confiscates the deposit" variant was rejected: it is
  literally the stake-confiscation lever this design exists to remove.)

## 5. The two hardenings (attack-driven, not in the plain baseline)

**Governance primitive (corrected — review finding 2).** The live 2-of-3
multisig on mainnet is `require_multisig_threshold(protocol_config,
&unique_signers)` over `ProtocolConfig.multisig_owners[..multisig_owners_len]`
with `multisig_threshold` (`utils/multisig.rs:90`), exactly as
`update_protocol_fee.rs:33` uses it — a **direct M-of-N key check with a
`remaining_accounts` signer convention** (WP-B2 live decode:
`multisig_owners_len=3, threshold=2`). It is **NOT** the
`createProposal/voteProposal/executeProposal` machinery — that is a separate,
**closed** system whose `ProposalType` is a fixed enum
`{ProtocolUpgrade, FeeChange, TreasurySpend, RateLimitChange}`
(`state.rs:1510`, hardcoded `match` in `execute_proposal.rs:132`) and is
**stake-weighted** — i.e. the plutocratic, sybil-capturable vote this very
design rejected as FATAL for the Slashable Bonded Roster (§3). **Both setters
below are NEW standalone instructions each gated by `require_multisig_threshold`
— never routed through the proposal system.** Pre-req: confirm the multisig
owners/threshold are actually initialized on mainnet (they are per WP-B2, but
verify at implementation — ties to Open Question 4 / P0.3).

### 5.1 On-chain, multisig-governed default trust list
The plain baseline put agenc.ag's default trusted-attestor list behind a
single **npm publish key** — quietly re-centralizing the gatekeeping we
removed on-chain. Instead:
- A **new state account** holds a content-addressed pointer (hash + URI) to
  the default trusted-attestor list, written by a **new
  `set_default_trust_list` instruction gated by `require_multisig_threshold`**
  (new Accounts struct + handler + state account with defined fields/seeds/
  size — **not** "reuse" of anything). Emit a change event; store an
  `updated_at` for a deadman.
- The list is **forkable**: it ships as a signed, versioned artifact in
  `@tetsuo-ai/marketplace-moderation` with a public inclusion/distrust log
  (Mozilla root-store discipline). Any surface can fork it; the SDK makes forks
  first-class.

### 5.2 BLOCK-only takedown floor (respecced — review BLOCKER)
**The previous draft was unbuildable and, on its most natural reading, a
gate-bypass.** It sized the floor as "a few `require!` lines; consumers already
load `moderation_config`" — but `ModerationConfig` carries **no per-hash data**
(only `_reserved: [u8;6]`, `state.rs:897`), so a per-hash block cannot live
there. And if the block account were modeled like every other moderation
account in this spec (optional, caller-supplied), the operator publishing
sanctioned supply simply **passes `None`** and the "absolute" floor never fires
— re-inheriting the exact "un-takedownable illegal supply" FATAL that capped
Model 3 at 30. Correct design:

- **A new per-content account, REQUIRED on all three gates, keyed by CONTENT
  HASH alone:** `["moderation_block", job_spec_hash]` (task path) /
  `["moderation_block", spec_hash]` (listing path). **Content-hash, not
  task/listing-scoped** — otherwise a takedown is trivially evaded by
  re-minting the same content under a fresh task/listing PDA.
- Each of `set_task_job_spec`, `hire_from_listing`,
  `hire_from_listing_humanless` **derives this address in-handler from the same
  hash it is already gating** (caller cannot substitute a different account —
  the handler computes the PDA), loads it as an `UncheckedAccount`, and:
  **system-owned / empty = no block (pass); program-owned + status BLOCKED =
  hard reject**, regardless of which CLEAN attestor the caller presents.
- **Write path:** a **new multisig-gated `set_moderation_block` /
  `clear_moderation_block`** (via `require_multisig_threshold`), **NOT** the
  single-key `record_*` moderation-authority path (which is what "a
  global-authority BLOCKED record" collapses to — the centralized lever this
  design claims to remove; resolving that internal inconsistency was review
  finding "floor authority inconsistent").
- **Bound the discretionary power** (review finding 9): a BLOCK-any-hash key is
  mechanically a takedown veto. Require an on-chain **rationale** on each block
  — `rationale_hash: [u8;32]` + `rationale_uri` (the exact precedent
  `resolve_dispute` already sets, `state.rs:1252-1256`) — and make blocks
  clearable (`clear_moderation_block`). Document plainly in the neutrality doc
  (§8) that this is a **discretionary multisig takedown lever, accepted as the
  price of removing illegal-supply legal exposure**. It is a **fail-open
  blacklist** (default-open; key-death preserves publishing per §9), materially
  unlike an allow-side whitelist — keep that distinction explicit.
- **Size: M, not S** — a new account on every gate (IDL/SDK/canary surface
  change on `set_task_job_spec`) + a new setter instruction + block-account
  struct.
- **Revert-sensitive litesvm coverage:** a blocked hash reverts **even with a
  valid CLEAN attestor presented**; omission or address-substitution of the
  block account cannot skip it (handler-derived); a re-minted task/listing with
  the same content hash is still blocked.
- **Display semantics** (off-chain): OR-of-trusted-CLEAN (one trusted
  attestor's BLOCKED does not suppress a listing another trusted attestor
  cleared) — **except** the on-chain BLOCK floor, which is absolute.

## 6. Program changes (grounded, sized)

One upgrade batch, full-surface module only, **zero account-layout
migrations** (all reserved-byte fits verified against `state.rs`).

| Change | Size | Notes |
| --- | --- | --- |
| `register_moderation_attestor` (new) | S | clone of assign − authority constraint; bond transfer; reserved-byte bookkeeping |
| `request_attestor_exit` + `finalize_attestor_exit` (new) | S | timestamp in reserved; ~2 lines in each `record_*`; terminal `close=attestor` |
| v2 moderator-keyed seeds in `record_task_moderation` + `record_listing_moderation` | **M — risk center** | append `moderator` to seed; consumers switch to handler-level dual `find_program_address` |
| v2 derivation + legacy branch + fail-open fix in `set_task_job_spec`, `hire_from_listing`, `hire_from_listing_humanless` | M | reuses the proven `resolve_listing_attestor` pattern; all downstream checks byte-identical |
| `revoke_moderation_attestor` → `assigned_by`-scoped | S | ~1 line |
| **BLOCK floor: new `["moderation_block", hash]` account (required) on all 3 gates + new multisig-gated `set_moderation_block`/`clear_moderation_block` (§5.2)** | **M** | new account struct + handler-derived load on every gate + 2 setter instructions; content-hash-keyed; `require_multisig_threshold` |
| On-chain default-trust-list account + new `set_default_trust_list` (multisig-gated) + deadman (§5.1) | S–M | new standalone `require_multisig_threshold` instruction + new state account; **not** proposal-machinery reuse |
| `record/revoke_agent_verification` → gate on global authority only (decouple P7.3 from open roster, §4.6) | S | ~1 line each; keeps forgeable-badge + clobber off the permissionless path |
| `ModerationAttestor::validate_reserved_fields` relaxed to remaining bytes | S | value-only |
| **Deferred:** creator pin PDA (`["task_attestor_pin", task]` + listing mirror) | — | not in v1; if ever shipped, must be *required-at-consumption* + CAS (Model 3's mechanics + the BLOCK floor) |

**Explicit non-program deliverables (review finding 6 — CLAUDE.md golden rules
2 & 6):** regenerate the `@solana/kit` client (`npm run sdk:generate`) and pass
`sdk:drift`; add facade wrappers for every new instruction
(`register_moderation_attestor`, `request/finalize_attestor_exit`,
`set_moderation_block`/`clear_moderation_block`, `set_default_trust_list`); and
update **every existing `set_task_job_spec`/hire integration + e2e call site**
to pass the new `moderator` argument and to `null` / derive the new required
BLOCK account — the repo's own gotcha: *adding an account to a shared
instruction breaks existing call sites unless they pass it correctly.*

**Canary build (corrected — review finding 8):** `check-canary-idl.mjs` is a
**name-only** allowlist of 25 fixed instruction names. The new instructions are
full-module-only (never in the canary IDL — adding their names would make the
canary check fail as "Missing"), and the v2 seed change alters no instruction
**name**. So there is **no allowlist re-baseline**. The real canary safeguard
is `cfg`-gating the shared `record_task_moderation`/`set_task_job_spec` **seed
literal** (`record_task_moderation.rs:33`) so the canary build keeps the frozen
legacy seed while the full module uses v2 — plus watching the full-IDL /
account-struct **drift** gates, which do change.

**Untouched:** settlement math, escrow, the 4-way split,
`Task`/`ProtocolConfig` layouts. No external audit (never); the gate is
internal adversarial review + revert-sensitive litesvm coverage for:
overwrite-isolation, legacy-branch unforgeability, **no-regression of the
existing revoked-attestor fail-closed**, the per-re-implemented-constraint
manual checks (§4.4), exit cooldown clock (`exit_at != 0` guard, monotonic
request), bond deposit + refund accounting, and **BLOCK-floor absoluteness**
(blocked-despite-CLEAN, un-omittable, re-mint-resistant).

## 7. What we deliberately did NOT build, and why

- **Slashing / any confiscation** — moderation verdicts are subjective; any
  slash needs a judge; any judge re-centralizes. The bond is identity
  friction, not a quality bond.
- **A configurable bond** — a governance dial is an exclusion dial; hardcode
  it.
- **An on-chain attestor fee leg** — pays for volume, not accuracy, and
  touches the highest-risk code in the program (the 4-way settlement).
- **A moderation-optional/unattested tier** — subsumed by
  self-attestation-with-provenance (§3).
- **A roster deadman instruction** — permissionless registration subsumes
  P1.3 at the roster layer; residual config/upgrade-authority deadness folds
  into P0.3 (Squads multisig).

## 8. Honest framing (must land in the rewritten neutrality doc)

- **The positive (allow) gate becomes a provenance layer**, not real-time spam
  protection: it loads only the CLEAN record the caller presents, so a trusted
  attestor's BLOCKED verdict is post-hoc forensic evidence, not CT-style
  prevention. **The negative (BLOCK) floor is different** — required,
  handler-derived, content-hash-keyed hard reject on every gate (§5.2), so a
  global takedown *is* enforced in real time. Keep the two straight.
- **Spam/quality defense moves to the edges** (surface trust lists), which is
  the right place for it, and consciously **reverses the 2026-06-10 pre-PMF
  deferral** that kept the roster curated. This is a deliberate, dated
  decision, not a drift.
- **The BLOCK floor is a discretionary multisig takedown lever** (review
  finding 9): nothing on-chain bounds *what* may be blocked, only *who*
  (2-of-3) and *that a rationale is recorded*. Accepted as the price of not
  hosting structurally-un-takedownable illegal/sanctioned supply on an
  escrow-custodying program. It is **fail-open** (default publish; key-death
  preserves publishing, §9) — materially unlike an allow-side whitelist. Say
  this plainly; do not pretend the floor is neutral.
- **The bond is not a sybil defense** (review finding 7): it caps *concurrent*
  identities per unit of working capital, nothing more. Real sybil/spam defense
  is P6.4.
- **P6.4 (spam/sybil) now needs its own workstream** — the moderation gate was
  the network's only spam defense; once the allow-side is a provenance layer,
  that defense must be designed explicitly (task-escrow bonds task spam;
  attestor-paid record rent prices attestation spam linearly; edge lists do the
  rest — but this is a real design item, not an assumption).

## 9. Liveness / credible-exit (P8.6)

With every tetsuo key dead: registration, attestation, consumption, and exit
all keep working forever; only *parameters* freeze (the `enabled` flag,
authority rotation, upgrades, the multisig-gated list + BLOCK floor — all P0.3
scope). The credible-exit walkthrough passes with **zero tetsuo-ai keys**:
register → attest own supply → hire consuming own record → settle.

## 10. Open questions for the founder (pre-implementation)

1. **Bond size** — 0.25 vs 0.5 SOL. Higher = more sybil friction but more
   friction for honest small operators. Recommend 0.25 with the number
   hardcoded and revisited by upgrade if abused.
2. **Exit cooldown** — 7 days proposed. Longer strengthens the sybil
   rate-limit; shorter is friendlier to legitimate churn.
3. **BLOCK-floor governance** — reuse the existing 2-of-3 `update_protocol_fee`
   multisig as-is, or a separate signer set? (Reusing is simpler and already
   live; a separate set narrows blast radius.) Ties into P0.3.
4. **Sequencing vs P0.3** — this batch hands more weight to the multisig
   (trust list + BLOCK floor). Do the Squads custody ceremony (P0.3)
   **before** this deploys, so the governance it leans on isn't a 1-of-1.
   **Recommended: yes — P0.3 first.**
5. **Batch composition** — ship this alone, or with P3.4 (dispute referrer
   leg) + P6.3 (rating rollup) in one upgrade Moment? Smaller batch = smaller
   risk on a money program; recommend this alone first.
6. **Exit-window consumption** (review finding 5) — do the three gates read
   `exit_at` and reject an in-exit-window attestor (this spec's choice: window
   closes at *request*), or do exit-flagged attestations stay consumable until
   *finalize* (a ≤7-day scam-then-exit window)? The former is stricter and
   recommended; confirm.
7. **Agent-verification** (review finding 3, §4.6) — decouple
   `record/revoke_agent_verification` onto the global authority only
   (recommended, simplest, no money gate consumes it), or apply the full
   open-roster hardenings to `AgentVerification` too? Recommend decouple in v1.
8. **BLOCK-floor rationale** — require the `rationale_hash + rationale_uri`
   per block (recommended — matches `resolve_dispute`, keeps takedowns
   auditable), and are blocks time-boxed/renewable or indefinite-until-cleared?
