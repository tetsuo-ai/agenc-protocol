# WP-A6 Addenda — Three WS-H Batch-2 Design Stubs

> **Status:** STUBS ONLY — one page each. These are the three product-driven
> ("WS-H") additions to the batch-2 design slate. Each stub records what the
> item is, what it would require, and the open questions that a full spec must
> answer. **Full specs come later**; nothing here authorizes implementation.
> Program citations verified at `origin/main` @ `bb65952`.

---

## 1. `SpendingBudget` — on-chain budgets for agent hot keys

**What it is.** The corporate card for agents: a program-owned budget/vault
primitive so an agent's hot (session) key can *fund work* without holding
*unconditional spend authority* over the operator's balance. Today the key
that signs `create_task`/`hire_from_listing` escrow funding is, for most
operators, a plain keypair whose compromise drains everything it holds;
client-side mitigations (signer policies, deny-hooks, hardware wallets) only
protect operators who configure them. A bytecode-enforced budget — velocity
cap per time window, destination classes limited to (a) agenc-coordination
escrow PDAs being funded for a real task/hire and (b) a pre-registered owner
withdrawal address, and a timelock on loosening — is the only defense that is
universal and config-free.

**What it requires.**
- A custody decision first: **native** (a `SpendingBudget` PDA inside or
  beside agenc-coordination, with the mint gates optionally drawing escrow
  funding from it) vs **compose** (integrate an existing audited on-chain
  budget/wallet primitive — role-based smart-wallet programs with
  SOL/recurring/destination limits, and capped-delegation programs, already
  exist on mainnet). This is a program that would custody the operating
  balance of the agent population; the bar is a full adversarial review of
  whichever path is chosen.
- If native: new account (`owner`, `agent_authority`, `cap_per_window`,
  `window_secs`, `spent_in_window`, `window_start`, `withdrawal_addr`,
  timelocked-params shadow), fund/spend/withdraw/retune instructions, and a
  CPI-or-account-constraint story for how `create_task`/`hire_from_listing`
  escrow funding proves "this transfer funds a real task escrow."
- Honest-guarantee copy discipline: the primitive bounds **bleed rate, not
  maximum loss** — a compromised key running legitimate hire→settle loops to
  a colluding worker extracts ≈ the cap per window while looking like a busy
  honest operator. All product copy must say "bleed rate."

**Open questions.**
1. Native vs compose (the make-or-buy is genuinely open; prior art is real).
2. Is the budget per agent key, per operator wallet, or per (operator, agent)?
3. How does the spend gate recognize "escrow funding" without becoming a
   general CPI proxy (confused-deputy surface)?
4. Cap semantics defaults: what window/cap makes the kit's autonomous default
   mode safe-by-default without strangling real operators?
5. Does this ship as its own program (isolating audit surface from the
   coordination program) — recommended prior — or as coordination
   instructions?

---

## 2. `award_best_bid` — revisiting a documented Non-Goal

**What it is.** An instruction (or permissionless crank) that awards a
`BidExclusive` task's bid book to the best active bid without a per-award
creator signature — enabling fully autonomous procurement loops
(agent posts task, best bidder wins at deadline).

**Why it's a revisit, not a feature request.** The Marketplace V2 spec
deliberately lists "on-chain automatic optimal-bid enforcement" as a
**Non-Goal** and names "explicit creator acceptance instead of auto-match" as
a conservative design principle (`docs/MARKETPLACE_V2_BID_PROTOCOL.md`,
Non-Goals + Core Design; enforced today by `accept_bid` requiring the creator,
`lib.rs:374-379`). Any spec here must first argue the Non-Goal down, not
around.

**What it requires.**
- An on-chain definition of "best" that cannot be gamed at the margin: bids
  are per-bidder PDAs (`["bid", task, bidder]`-shaped, no sorted structure),
  so either (a) the award ix takes the claimed-best bid plus N competing bids
  as remaining accounts and verifies dominance (account-count bound — see
  `SCALE_COST_MODEL.md` §3), or (b) the book maintains a running best-bid
  pointer updated at bid time (new invariant + griefing surface at update
  races).
- Creator **opt-in at book creation** (an `auto_award` flag + award deadline),
  never a protocol-wide behavior change; the default stays explicit
  acceptance.
- Anti-sniping/undercut design (deadline extension or sealed window), and an
  answer for reputation/quality: price-only awards select for the cheapest
  sybil unless the score folds in weighted track record — which imports the
  full P6.4 provenance problem *on-chain*, exactly where P6.4 said it cannot
  live. This is the hardest open question and may be the reason the Non-Goal
  survives.

**Open questions.**
1. Does any real demand exist yet, or does WS-H's autonomous-procurement story
   work with creator-side agent auto-acceptance (the agent signs `accept_bid`
   under its own policy — zero program change)? **That alternative should be
   costed first.**
2. Best-bid = lowest price only, or price × on-chain reputation (see P6.4
   caveat above)?
3. Award crank permissioning and incentive (who pays the tx, what stops award
   spam at deadline).
4. Interaction with bid bonds and `BidderMarketState` anti-spam accounting on
   auto-award vs explicit accept.

---

## 3. WP-H3 phase 2 — bond-forfeit redirect to the harmed party

**What it is.** Completion bonds (25% of reward, `CompletionBond::BOND_BPS =
2500`, `state.rs:1943`; funded via `post_completion_bond`) currently forfeit
to **different recipients depending on path**, and the marketing-relevant
promise — "if the worker fails, the buyer gets the escrow back *plus* the
worker's bond" — is only true on some of them. Phase 1 (shipped: SDK/react
0.8.4/0.4.1 + agenc.ag guarantee surfaces) was forced to word its copy as
"you're refunded and the worker forfeits the bond" because of this. Phase 2 is
the program change that redirects forfeits to the harmed counterparty.

**Current forfeit routing (verified):**

| Path | Worker bond forfeits to | Cite |
| --- | --- | --- |
| `expire_claim` (no-show) | **creator** (already the harmed party) | `expire_claim.rs:390-397` |
| `cancel_task` no-show branch | **creator** (#70 fix) | `cancel_task.rs:556-575` |
| `reject_frozen_exits` (rejection upheld) | **treasury** | `reject_frozen_exits.rs:220-230` |
| `resolve_dispute` (loser's bond) | **treasury** (both roles) | `resolve_dispute.rs:1022-1073` |

So phase 2 = redirecting the last two rows (dispute + upheld-rejection
forfeits) from treasury to the winning counterparty, making the "plus the
bond" promise uniformly true.

**What it requires.**
- Mechanically S-sized: the recipient is already an account in both contexts
  (`creator` / `worker_wallet`); swap the `BondDisposition::Forfeit`
  recipient. No layout change, no migration.
- **The hard part is incentive analysis, not code:** paying forfeits to the
  counterparty mints a bounty for manufacturing losses. A creator who will
  receive the worker's 25% bond has a direct incentive to reject good work and
  win the freeze/dispute; a worker facing a creator bond has the mirror
  incentive. Today's treasury routing is incentive-neutral *by accident*. The
  full spec must weigh: redirect-in-full vs split (e.g. half harmed party /
  half treasury) vs redirect-only-on-resolver-decided disputes (a neutral
  third party made the call — `resolve_dispute` — while the self-serve
  `reject_frozen_exits` path keeps treasury routing).
- Copy + SDK updates gated on deploy (phase 1 deliberately pinned the honest
  wording with a test; phase 2 flips that test).

**Open questions.**
1. Full redirect vs split vs resolver-decided-only (recommend starting the
   spec from resolver-decided-only: the least grief-prone subset that still
   makes the guarantee real for disputes).
2. Does the creator-side bond redirect (worker as harmed party) ship
   simultaneously for symmetry, or is worker-bond redirect alone the product?
3. Slashing interplay: dispute loss already slashes worker stake/reputation
   (`REPUTATION_SLASH_LOSS`, `constants.rs:55`) — does bond redirect stack, and
   does the combined penalty overshoot for small-reward tasks?
4. Should `expire_claim`/`cancel_task` (already-correct rows) be cited in
   guarantee copy *now* — i.e. can phase 1.5 marketing truthfully say "plus
   the bond" for no-shows before any deploy? (Likely yes; verify copy tests.)
