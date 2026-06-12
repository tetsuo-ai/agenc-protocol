# Adversarial verification verdicts (2026-06-11)

> **Post-deploy note (2026-06-11):** the full-surface upgrade has since been executed —
> mainnet now runs the full 84-instruction surface (`surface_revision = FULL`), with the 169
> live Task accounts migrated (382B → 466B, 0 failures). The deploy-day ops items below
> (e.g. F42, the `migrate_task` sweep for the then-"149 tasks") were carried out during the
> rollout; the live count at the upgrade was 169. `ZkConfig` remains deferred. See
> `docs/MAINNET_ROLLOUT_RUNBOOK.md`.

The multi-agent verification workflow (94 findings × 3 lens-skeptics + adjudicator) was
blocked twice by a **sustained server-side API throttle** ("Server is temporarily limiting
requests — not your usage limit") that wiped ~376 agents per run. Rather than burn a third
identical burst, these verdicts were produced by **single-verifier inline review** against
current `main` (post PR #77), grounded in greps of the actual code + the 215-test suite.
NOT a substitute for the independent panel or the external audit — but enough to calibrate.

Legend: ✅ real-but-fixed · 🔴 real-unfixed (code) · 🧪 real-unfixed (test/ops/process) ·
🎛 design-decision · 👁 observability-only · 🗑 leave-alone-by-design

## HIGH (15) — verified

| ID | Finding | Verdict |
|----|---------|---------|
| F04 | content-hash gate was dead code | ✅ fixed — wired into create_task/humanless/dependent |
| F08 | resolve_reject_frozen never released claim slot | ✅ fixed — release_claim_slot in uphold branch |
| F15 | InitiatorCannotResolve not wired (self-resolve) | ✅ fixed — guard added in resolve_dispute |
| F50 | #70 cancel_task forfeit ungated (honest-worker theft) | ✅ fixed — forfeit gated to genuine no-show |
| F54 | deregister_agent stake strand/theft | ✅ fixed — requires stake withdrawn (ReputationStakeNotWithdrawn) |
| F58 | validate_task_result drops referrer leg | ✅ fixed — configure_task_validation rejects referrer task |
| F74 | complete_task_private drops referrer leg | ✅ fixed — create_task rejects referrer on private task |
| F82 | zk image rotation single-key | ✅ fixed — now M-of-N multisig |
| F86 | concurrent disputes lock worker stake | ✅ fixed — status != Disputed guard on both paths |
| **F12** | **close_task strands live completion bonds** | **✅ FIXED + HARD-VERIFIED (see below). Was: worker bond principal frozen.** |
| F36 | complete_task_private zero e2e test | 🧪 real-unfixed — still 0 call sites in tests |
| F37 | execute_proposal zero e2e test (treasury spend) | 🧪 real-unfixed — still 0 call sites |
| F38 | initialize_protocol never executed by a test | 🧪 real-unfixed — mitigated (init-once, already live on canary) |
| F42 | no migrate_task sweep script for 149 tasks | 🧪 real-unfixed — deploy-day ops gap, none in scripts/ |
| F59 | DV-03E private-zk path never devnet-validated | 🧪 real-unfixed — process/validation gap |
| F41 | zkVM guest is a serialization shim only | 🎛 by-design — real guest lives in agenc-prover; needs image-ID provenance procedure, not a code fix here |

HIGH tally: **9 fixed, 1 open code bug (F12), 5 test/ops/process, 1 by-design.**

## MEDIUM (31) — triaged (greps spot-checked)

Fixed ✅: F02 (create suspension gate), F14 (register_agent pause gate), F17 (RateLimitsUpdated emit),
F30/F31 (PROGRAM_SURFACE), F44 (program-ID guard), F46 (runbook config-init), F74 (referrer/private), F79 (slash claim close).

Real-unfixed 🔴 (code): F01 (delegate_reputation inert), F05 (attestor-roster equality), F06 (stake_reputation pause gate),
F07/F67 (suspended provider keeps Active listing), F13 (bonds on Cancelled unrecoverable — F12 family),
F51 (#71 foreign-wallet bond bypass), F75 (cancel_task bonds optional on terminal exit — F12 family), F76 (cancel_dispute loses PendingValidation), F84 (configure_task_moderation single-sig).

Observability 👁: F16 (ProposalExecuted dual-outcome), F18 (no ClaimExpired event), F19 (no BondSlashed amount event), F20 (DisputeResolved no amounts).

Leave-alone 🗑: F21 (dead speculation-bond subsystem — strip carefully; deleting errors renumbers Anchor codes).

Docs/ops/process 🧪: F43 (migration_utils stale), F45 (validation-initialize cluster guard), F60 (legacy agenc-sdk), F61 (SECURITY.md placeholder), F62 (react referrer gate), F88 (republish @tetsuo-ai/protocol IDL).

## F12 (+ F13/F75 family) — FIXED + HARD-VERIFIED (2026-06-11)

Root cause: the worker's identity is lost once the claim closes, so `close_task` cannot protect
the worker bond — the fix settles bonds at the terminal paths where the worker authority is still
validated, plus a recovery net. Three parts:

1. **`accept_task_result`, `auto_accept_task_result`, `complete_task`** — completion-bond accounts
   changed from `Option` + `if let Some` to **required + seeds-pinned** (`["completion_bond", task,
   creator]` and `[..., worker_authority/authority]`), settled unconditionally. A Completed
   transition can no longer leave a live bond behind — the strand is structurally impossible.
2. **`reclaim_completion_bond`** — now accepts `Cancelled` as well as `Completed`: a permissionless
   self-recovery net for any bond a `cancel_task` caller omits, while the Task PDA is still alive.
3. **`close_task`** — new `creator_completion_bond` (required, seeds-pinned) + optional
   `worker_completion_bond`; refuses to close (`TaskHasLiveCompletionBond`) while either passed
   account is a live program-owned bond, so the Task PDA can't be destroyed out from under a bond.

**HARD-verify evidence** (not just "tests pass"):
- Two new revert-sensitive integration tests + one rewritten SDK e2e test assert the new guarantees
  (complete_task force-settles even when the caller passes `null`; close_task refuses while a bond
  is live; reclaim-on-Cancelled recovers).
- **Proved revert-sensitive**: temporarily neutered the worker-bond settle → the "force-settles"
  test went RED (strand reappeared); temporarily removed the close_task guard → the "refuses" test
  went RED (close succeeded when it must be refused). Restored, re-verified green.
- Full gate green on the final build: clippy (default + `mainnet-canary`), **321 Rust unit**,
  **216 litesvm integration**, **459 SDK** tests; `artifacts:check` + canary IDL (25 ix) clean;
  SDK client regenerated + `tsc` clean.

Residual (documented, not a fix): a *malicious creator* could still front-run `close_task` on a
Cancelled task while passing a fake-empty worker-bond account IF a worker bonded an unclaimed Open
task (economically irrational, rare). The worker's recourse is reclaim-on-Cancelled. Making this
last edge airtight needs an on-chain task↔worker link or `cancel_task` required worker bond, tracked
as a follow-up.

## Critic coverage gaps (from the one agent that survived run 1)
Money paths judged strong on current main; three under-exercised branches want revert-sensitive
tests before the external audit: (1) treasury rotation vs in-flight token forfeits/slashes;
(2) resolve_dispute SOL Split + hired task draining escrow exactly to zero; (3) the intentional
SOL-vs-token operator-leg asymmetry in expire_dispute refunds.
