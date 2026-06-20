# Moderation neutrality — options for the attestor model (P6.8)

> Status: **DECISION PENDING — [HUMAN]**. This document presents three neutrality options
> and a recommendation. The **registry mechanism** (the `ModerationAttestor` roster:
> `assign_moderation_attestor` / `revoke_moderation_attestor`, and the
> registered-attestor-OR-global-authority acceptance path on
> `record_task_moderation` / `record_listing_moderation`) is **already built** as of P6.8.
> None of the three options below is built yet — pick one, then build it alongside the
> registry. This decision is load-bearing for **P8.6 (the credible-exit test)**.

## TL;DR

- **Built now (P6.8):** an authority-curated attestor roster. The protocol authority can
  deputize additional moderation attestors; any registered, non-revoked attestor (or the
  single global moderation authority) can record a moderation decision.
- **The objection it does NOT retract on its own:** a curated roster just adds *deputies*.
  An embedder still cannot list/hire unless **someone tetsuo-ai approved** holds the pen.
  "One company pre-approves every hire" becomes "a club tetsuo-ai curates pre-approves
  every hire." That is a weaker claim of decentralization, not a true one.
- **Recommendation:** ship **(b) per-listing / per-integrator attestor choice** as the
  default neutrality answer, with **(a) the moderation-optional discovery tier** layered
  on as the permissionless-deploy escape hatch. Treat **(c) status-quo fail-closed** as the
  honest fallback only if (a)/(b) slip — and document it as a positioning trade-off, not a
  silent default.

---

## Why this matters (the wedge)

Neutrality is AgenC's only durable wedge against both the token-captured incumbent and the
Web2 platforms. The credible-exit test (P8.6) asks: *if tetsuo-ai vanishes, does an
end-to-end hire → settle still work?* Settlement, escrow, disputes, and reputation already
survive that test — they are on-chain and authority-minimised. **Moderation is currently
the one hard gate that does not.** Today, on the moderation-enabled path, a listing cannot
be hired and a task job-spec cannot publish unless the single global moderation authority
(a tetsuo-ai key) attested it. That is a centralized choke point sitting directly on the
money path. P6.8 is the start of removing it; this decision finishes the job.

## What "moderation" gates today (ground truth)

- `ModerationConfig.enabled` toggles the whole gate. When **disabled**, none of this binds
  (the fail-open "Model-A" world used in much of the test harness).
- When **enabled**:
  - `hire_from_listing` requires a matching `ListingModeration` for the listing's
    `spec_hash` (recorded by `record_listing_moderation`).
  - `set_task_job_spec` requires a matching `TaskModeration` for the task's job-spec hash
    (recorded by `record_task_moderation`).
- Before P6.8, only `ModerationConfig.moderation_authority` could record either. After
  P6.8, **that authority OR any registered `ModerationAttestor`** can.

The neutrality question is therefore precisely: **who is allowed to hold the pen, and who
chooses which pen a given listing/integrator trusts?**

---

## Option (a) — Moderation-optional listings tier ("permissionless to deploy, curated to be discovered")

**Mechanism.** Add a per-listing (and per-task-job-spec) `moderation_required` /
`unattested_ok` flag. An **unattested** listing is *hireable* on-chain but carries an
on-chain `unattested` marker; the hosted discovery/indexer **default-filters** it out, and
the SDK/widget surfaces it only behind an explicit "show unattested" opt-in.

**What it buys.** True permissionless deployment: anyone can list and be hired with **zero**
tetsuo-ai approval. Curation moves from a *hard money gate* to a *soft discovery ranking* —
exactly the property that survives a credible-exit walkthrough (settlement never depended on
us; only discovery did, and discovery is allowed to degrade).

**Trade-offs.**
- Buyers who rely on the default discovery surface never see unattested listings, so the
  curated set still has all the distribution. Good (safety by default) and bad (the
  "club" still owns reach).
- Marketplace operators embedding the widget must consciously decide whether to expose the
  unattested tier; most will not, which preserves brand-safety but blunts the neutrality
  claim *for typical embedders*.
- **Layout:** a per-listing flag is a `ServiceListing` field. `ServiceListing` is a
  full-surface account (not in the canary build); since the 2026-06-11 full-surface
  upgrade the full surface is live on mainnet, so treat it as a live mainnet account type —
  adding a field is still an append-only change with a new `const_assert`; verify there are
  no live accounts that need migrating on the target cluster before relying on in-place
  value writes. The task-side flag rides `TaskJobSpec`/`Task` and must respect the task
  migration rules (the live Task corpus was 169 at the 2026-06-11 upgrade).

## Option (b) — Per-listing / per-integrator attestor choice (RECOMMENDED core)

**Mechanism.** Let the listing/integrator name **which attestor** must sign — *any*
registered `ModerationAttestor`, **including their own**. Concretely: store an
`attestor: Option<Pubkey>` (or a small attestor-set / policy hash) on the listing (and/or a
per-integrator default carried in the SDK client config), and have `hire_from_listing` /
`set_task_job_spec` accept an attestation **from the named attestor** rather than only from
the single global authority. An embedder registers *their own* attestor and points their
own listings at it.

**What it buys.** This is the real retraction of "one company pre-approves every hire." The
embedder becomes their own moderation authority for their own surface; tetsuo-ai is no
longer in the loop for that integrator's hires. Different integrators can run different
policies (a kids-safe storefront vs. a research tool) without a central arbiter. Combined
with P7.3 (`AgentVerification`), it generalizes to a federation of trust roots.

**Trade-offs.**
- "Pick your own attestor" is also "pick a lax attestor." Neutrality and safety pull in
  opposite directions; the default discovery surface (see (a)) is what keeps a floor under
  buyer safety. The two options are **complementary**, not alternatives.
- Requires a per-listing attestor binding and a hire-time check that the supplied
  attestation came from the bound attestor — more surface than the roster alone.
- Governance question: does the *global* authority retain a revoke/override on a rogue
  registered attestor? Recommended yes (revoke closes the PDA, already built), but document
  that this is the residual centralization and is bounded (revoke ≠ re-moderate; existing
  attestations stand).
- **Layout:** same `ServiceListing` / task-job-spec append considerations as (a).

## Option (c) — Status quo (fail-closed, roster-only), accepted as an explicit trade-off

**Mechanism.** Keep exactly what P6.8 builds: a single global authority plus an
authority-curated roster. No per-listing choice, no unattested tier. Moderation stays a hard
gate; the only liberalization is "the authority can deputize more signers."

**What it buys.** Simplicity and a strong safety floor. Every hireable listing was approved
by someone the authority trusts. Lowest implementation and audit surface.

**Trade-offs.**
- **Does not pass an honest credible-exit test.** If tetsuo-ai (and its deputies) vanish,
  the moderation-enabled hire path is dead — the one gate that does not survive the
  operator's disappearance. P8.6 would have to footnote moderation as a hosted dependency.
- The neutrality pitch becomes "curated, but transparently so." Defensible only if sold
  honestly as a curated marketplace, not as a neutral protocol.

---

## Recommendation

Build **(b) as the core** and **(a) as the escape hatch**, in that priority:

1. **(b) per-integrator attestor choice** is the option that actually answers the objection
   for the embedders we are courting: they run their own attestor and owe tetsuo-ai nothing
   on the hire path. This is the neutrality *math* P8.6 wants to demonstrate.
2. **(a) the moderation-optional tier** backstops the truly permissionless case (no attestor
   at all) while keeping buyers safe by default via discovery filtering. It is also the
   cleanest thing to point the credible-exit walkthrough at: "moderation satisfied via your
   own registered attestor (b), or skipped with an on-chain `unattested` marker (a) — either
   way, settlement never touched our keys."
3. Keep **(c)** only as the documented fallback if (a)/(b) slip a milestone. If shipped,
   say so plainly in the README/positioning: curated, fail-closed, with a roadmap to (a)/(b).

### Coupling to P8.6 (credible-exit)

P8.6's scripted walkthrough must satisfy moderation **without a tetsuo-ai key**. Only (a)
and (b) make that possible:
- **(b):** the walkthrough registers its *own* attestor (via `assign_moderation_attestor`,
  run by the cluster's own authority on a self-hosted full-surface deployment) and records
  its own attestations.
- **(a):** the walkthrough lists with `unattested` and shows the hire still settles, with
  discovery degradation called out as the graceful-degradation surface.

Under (c) alone, P8.6 cannot run clean — moderation would remain a hosted dependency. That
is the concrete reason this decision is load-bearing for the credible-exit test.

## Scope built in P6.8 vs. deferred to this decision

| Item | Status |
|------|--------|
| `ModerationAttestor` PDA `["moderation_attestor", attestor]` | **Built (P6.8)** |
| `assign_moderation_attestor` / `revoke_moderation_attestor` (authority-only) | **Built (P6.8)** |
| `record_task_moderation` / `record_listing_moderation` accept global authority OR registered attestor | **Built (P6.8)** |
| Assign/revoke events; revoked-attestor-cannot-attest test | **Built (P6.8)** |
| (a) moderation-optional listing/task flag + discovery default-filter | **Not built — pending this decision** |
| (b) per-listing/per-integrator bound attestor + hire-time bound check | **Not built — pending this decision** |
| (c) keep fail-closed roster-only | **Default if (a)/(b) not chosen** |

---

_Decision owner: [HUMAN]. Once decided, link the chosen option from `docs/CREDIBLE_EXIT.md`
(P8.6) and update `PLAN.md` P6.8 "Done when" to reference the implemented option._

---

## DECISION (2026-06-10) — recorded

**Chosen: the registry (curated attestor roster) is the launch answer; permissionless
per-integrator attestor choice is the committed post-PMF path.**

Rationale (money/adoption framing): the attestor registry (P6.8, shipped) already
improves the recording side — `record_listing_moderation` / `record_task_moderation`
accept the global authority **or any registered attestor**. The consumption side is
stricter today: `hire_from_listing` and `set_task_job_spec` still require the consumed
moderation record's `moderator` to equal `ModerationConfig.moderation_authority`. A
partner can therefore record through a registered attestor for auditability, but that
record does **not** unlock hire/publish unless the same key is the configured moderation
authority, or the embedder runs a self-hosted deployment where they hold that authority.
Going *fully permissionless* now (anyone self-registers an attestor and self-attests
CLEAN) would open a self-attestation scam vector the on-chain fail-closed gate cannot
stop; an early scam/lemons flood destroys the buyer trust that drives repeat purchases
(the north-star revenue metric). Per the governance lesson — decentralize **after**
product-market fit, not before — we keep attestor *assignment* authority-gated at launch
(quality), surface "attested by &lt;X&gt;" in discovery (the demand side sees who vouched),
and publicly commit to opening attestor registration / per-listing attestor designation
once there is real attestor diversity. The credible-exit promise is structural for the
runtime and settlement path; moderation independence still requires holding the configured
moderation authority until the per-integrator attestor-choice work lands. Option (a) the
moderation-optional discovery tier is deferred to the same post-PMF window (it only means
"curated discovery" once multiple attestors exist). Option (c) pure status-quo is
superseded by this.
