# Bug Bounty — Draft Scope

> **Status: DRAFT.** This is the scope and severity rubric for an AgenC bug
> bounty. The **platform** (Immunefi / HackerOne / self-hosted) and the **reward
> budget / amounts** are **[HUMAN: decides]** and are left as explicit TBDs
> below. Do not treat the reward figures as committed until the human fills them
> in and the program is published.
>
> Reporting, the disclosure SLA, and safe-harbor terms live in
> [`/SECURITY.md`](../SECURITY.md) — this document references them, it does not
> restate them.

## Why a bounty

The `agenc-coordination` program (`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`)
custodies escrow, completion bonds, and reputation stakes. A bounty is the
standing complement to the internal adversarial audits and any commissioned external
audit report (`docs/audit/`): it pays for the bugs those processes
miss, prioritized strictly by **how close the bug is to user funds**.

## Priority ordering (reward weighting)

```
TIER 1  program money paths        (highest reward)
TIER 2  hosted rails               (medium)
TIER 3  SDK                        (lowest)
```

The same ordering is used by `SECURITY.md` §2. A bug's reward is set by its
**severity** (below) and its **tier**: a Critical in Tier 1 pays the top band; an
equivalent class of issue in the SDK pays materially less.

## Severity rubric

Severity is driven by **impact on funds and protocol integrity**, not by
cleverness. Examples are concrete and tied to the actual program.

### Critical — direct loss or permanent lock of funds

- **Fund loss:** drain / steal / double-spend of escrowed SOL or SPL reward
  tokens, completion bonds, or reputation stakes by a party not entitled to them
  (e.g. settling `accept_task_result` to an attacker, forging a `complete_task`,
  bypassing the bond-disposition rules, slashing/withdrawing another agent's
  stake).
- **Fund lock:** any input that makes escrow / a bond / a stake **permanently
  unrecoverable** — i.e. defeats the money-never-locks exits
  (`cancel_task`, `expire_claim`, `reject_task_result`, `close_task`,
  `reclaim_completion_bond`, `expire_dispute`, `resolve_dispute`,
  `resolve_reject_frozen` / `expire_reject_frozen`). A state a task can enter
  that has **no** funded-exit is Critical.
- **Fee-cap bypass:** routing > `MAX_COMBINED_FEE_BPS` (4000 bps) to
  protocol/operator/referrer so the worker keeps < 60%, or exceeding a per-leg
  cap (`MAX_PROTOCOL_FEE_BPS` / `MAX_OPERATOR_FEE_BPS` / `MAX_REFERRER_FEE_BPS`,
  each 2000 bps).
- **Authorization break:** unauthorized state transition, PDA substitution /
  account confusion, missing-signer, or arithmetic bug that moves funds or
  escapes a money-path guard. (The release build sets `overflow-checks = true`
  and money paths use checked arithmetic; a working overflow that nonetheless
  affects funds is Critical.)
- **Migration corruption:** a `migrate_task` / `migrate_protocol` input that
  corrupts the live account layout or strands funds (irreversible on a live
  program).
- **Fail-closed moderation bypass** that lets unmoderated/disallowed tasks fund
  and settle.

### High — conditional fund loss/lock, or griefing with economic damage

- Fund loss/lock that requires a specific but realistic precondition (a
  particular task type, timing window, or counterparty cooperation).
- A griefing vector that forces another party to lose a bond/stake or pay rent
  unfairly without consent (beyond the by-design no-show forfeiture).
- Defeating the **pause exit guarantee**: causing an exit path to revert *because*
  the protocol is paused (pause must never block §5.2 exits).

### Medium — incorrect accounting / DoS without direct theft

- Off-by-one or rounding that mis-credits fees/refunds within caps (no
  unbounded theft), recoverable fund-stranding that a permissionless cleanup
  (e.g. `expire_claim`, `reclaim_completion_bond`) does NOT already recover,
  capacity-counter corruption, or a denial-of-service of a single task/listing
  reachable at realistic cost.

### Low — limited-impact / informational-with-impact

- Event/log inconsistencies that could mislead an indexer or signer, missing
  validation with no current fund impact, minor SDK mis-decode that a careful
  signer would catch.

> Final severity is assigned at triage (`SECURITY.md` §3). The reporter's
> proposed severity is a starting point, not binding.

## Reward tiers — **[HUMAN: decides amounts + budget]**

| Severity | Tier 1 (program) | Tier 2 (hosted rails) | Tier 3 (SDK) |
|----------|------------------|-----------------------|--------------|
| Critical | **TBD** (top band) | TBD | TBD |
| High     | TBD | TBD | TBD |
| Medium   | TBD | TBD | TBD |
| Low      | TBD / swag | TBD | TBD |

- **Total budget:** TBD — **[HUMAN: decides]**.
- **Platform:** TBD — Immunefi / HackerOne / Cantina / self-hosted advisory —
  **[HUMAN: decides]**. There is currently no verified private intake channel;
  `SECURITY.md` §1 records the blocker. The bounty must not launch until a
  platform or other private channel is enabled and tested end to end.
- **Payment:** TBD (currency, KYC threshold) — **[HUMAN: decides]**.
- Rewards scale with **demonstrated impact and report quality** (a working PoC /
  failing test against `scripts/localnet-up.mjs` earns the top of its band).

## Exclusions

Out of scope (no reward):

- Anything requiring a **compromised or malicious trusted role** — the program
  **upgrade authority** (now 2-of-3 multisig; see
  `docs/UPGRADE_AUTHORITY.md`), the **protocol/config multisig**, or an
  **assigned dispute resolver**. These are trusted by design; governance-design
  feedback is welcome but not paid as a vulnerability.
- Findings only reproducible by **modifying the program / SDK** rather than
  against the deployed build.
- **Theoretical** issues with no demonstrated on-chain or economic impact;
  missing best-practice that cannot be turned into a concrete exploit.
- Spam / volumetric DoS against public or third-party **RPC**, mainnet-beta
  congestion, or attacks needing unrealistic SOL/transaction volume.
- Vulnerabilities in **third-party dependencies** already patched upstream, or
  reachable only with an outdated dependency the project does not ship.
- Issues in **hosted web UIs / landing pages** with no path to fund loss,
  signed-transaction tampering, or attestation forgery.
- Social engineering, phishing, physical attacks, and anything against
  tetsuo-ai staff or infrastructure outside the listed scope.
- **Self-inflicted** loss (signing a malicious transaction you constructed,
  sending funds to a wrong address) and known-limitation items already recorded
  in `docs/audit/` or in published audit findings.
- Claims that "the repo is private / publicly verifiable builds are
  unavailable" — the repository is public and OtterSec-verified
  (`SECURITY.md` §6, `docs/VERIFIABLE_BUILDS.md`). Report real verification
  failures against the live badge or a tagged release instead.

## Safe harbor

Good-faith research is authorized under the safe-harbor terms in
[`SECURITY.md` §4](../SECURITY.md#4-safe-harbor): use **only your own**
tasks/listings/funds, prefer **localnet/devnet** (`scripts/localnet-up.mjs`),
take a finding no further than needed to prove it, and disclose coordinately. Do
not exploit on mainnet for profit.

## How to report

Follow [`SECURITY.md` §1](../SECURITY.md#1-reporting-a-vulnerability). Include
the affected tier/instruction, program ID + cluster, impact, and a reproduction
(a failing test or a localnet script is ideal).
