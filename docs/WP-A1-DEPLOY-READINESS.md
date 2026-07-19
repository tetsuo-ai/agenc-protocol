# WP-A1 — Roster-honored moderation gates: verification & deploy readiness

> **Status: historical record (as of 2026-07-02). Execution complete — retained
> as record.** A1 has since been deployed and surpassed: mainnet now runs the
> full 99-instruction surface (live since 2026-07-09, slot 431918664,
> `surface_revision = 4`), the upgrade authority moved to a Squads v4 2-of-3
> multisig on 2026-07-03 (the "single-key / FD4 not set up" precondition below is
> stale), and the OtterSec verified-build badge is live. Where the body says
> "NOT DEPLOYED", that is the doc-date state. See `docs/MAINNET_MAINLINE.md`
> (deploy record), `TODO.MD` (completed 2026-07 hardening record), and
> `README.md`.

**Status: BUILT · REVIEWED · TESTED · MERGED to `main` · NOT DEPLOYED.**
This document is the permanent record so the work is never redone. It captures
exactly what was verified, that everything passed, the artifact hash, and the
precise steps + preconditions to deploy. Do not repeat the review/build effort —
read this.

- **Change merged:** PR #93, squash commit `254078a` on `main` (2026-07-02).
- **Program:** `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (mainnet). **Live
  bytecode is still PRE-A1 — this change is not deployed.**
- **Built `.so` sha256:** `e8e6ca896afb1a9ad862e748d62be7fbdf585ce7d3dc721fdc9845d487b12334`
  (2.0 MB, full 84-instruction surface, from `anchor build`).

## What A1 does

The three moderation *consumption* gates —
`set_task_job_spec`, `hire_from_listing`, `hire_from_listing_humanless` — now
accept a moderation attestation authored EITHER by the single global
`ModerationConfig.moderation_authority` OR by a registered, non-revoked
`ModerationAttestor` (the P6.8 roster that until now could only *record*
attestations, never satisfy the gates). This is the #1 structural fix: it lets a
third-party marketplace moderate its own supply instead of depending on one
tetsuo key. Additive optional account only — **no layout/size change, no
migration, program-id and `surface_revision` unchanged.**

## Verification — everything that passed (this is the "audit")

No paid external audit was performed (deliberate, cost-constrained decision). In
its place, a multi-agent **adversarial security review** attacked the change and
found **0 security blockers**. Specifically verified:

- **No forgeable attestor acceptance** — an uninitialized/fake/wrong-owner
  account cannot pass as a `ModerationAttestor`; the gate checks program
  ownership, the PDA, and that the attestation's `moderator` matches the passed
  attestor (no mix-and-match).
- **Revoked attestors are truly rejected** at all three gates.
- **Global-authority path is byte-for-byte unchanged** — no regression that
  could lock legitimate existing flows.
- **No layout/size/discriminator change** → no migration, existing accounts
  unaffected. Canary build unaffected (optional account is `#[cfg]`-gated out;
  canary IDL still 25 ix).

### Gates (all green, re-run against the full 84-ix `.so`)

| Gate | Result |
| --- | --- |
| `cargo test --lib` | **330 passed / 0 failed** |
| `cargo clippy --lib` + `--features mainnet-canary` | **0 warnings** |
| `anchor build` | `.so` 2.0 MB, sha256 `e8e6ca89…b12334` |
| `npm run artifacts:check` | committed artifacts match build; programId `HJsZ…w1xK` |
| litesvm `tests-integration` (`node --test`, Node 24+) | **231 pass / 0 fail** (12 roster-gate + 3 breaking-change compat) |
| `canary:check-idl` | OK (25 ix) |
| SDK `sdk:drift` / `tsc` / vitest | in sync / exit 0 / **464 pass, 1 skip** |

Revert-sensitivity proven: the new litesvm tests fail against the pre-A1 code.

## The one caveat that governs the deploy: A1 is a BREAKING interface change

A1 adds an optional `moderation_attestor` account to three live instructions
(`set_task_job_spec` 7→8 accounts, `hire_from_listing` 12→13,
`hire_from_listing_humanless` 11→12). Proven empirically in litesvm: **Anchor
0.32 requires every optional account present regardless of position**, so there
is NO account ordering that keeps a pre-A1 client working. The instant the new
bytecode is live, every un-upgraded client (published SDK 0.6.1 / tools 0.2.0 /
mcp 0.2.0 / agenc.ag / MCP) **hard-errors on publish/hire** (fail-closed — no
security hole, no fund loss) until regenerated against the new IDL.

**Therefore A1 must ship as a COORDINATED release, not a standalone bytecode
swap.** Because the account lists change, there is a brief hard cutover: old
clients break the moment the program upgrades; new clients only work against the
upgraded program. Do it while traffic is ~zero (now) — the cutover cost is
minimal pre-launch and grows with real users.

### Consequence for the repo right now

`main` (`254078a`) contains the A1 breaking IDL but mainnet does NOT.
**Do NOT publish `@tetsuo-ai/marketplace-sdk`/`-tools`/`-mcp` from `main`** for
any unrelated reason until the coordinated deploy — it would ship the breaking
IDL to consumers before the program supports it. Branch near-term SDK work from a
pre-A1 base or exclude the A1 delta. A verifiable build (WP-G2) of the *currently
deployed* program must target the deployed commit, not `main`.

## Deploy runbook (human-executed; corrected)

**Preconditions:**
- **Working capital: ~13.6 SOL** for the upgrade buffer (ProgramData is 1,948,429
  bytes → 13.562 SOL rent). It is **fully refunded** the moment the upgrade
  completes (net cost ≈ tx fees ~0.01 SOL) but must be present upfront in the
  deploy wallet. As of 2026-07-02 total accessible SOL ≈ 5.03 (upgrade authority
  `HcecpK…` 4.71 + others) — **~8.5 SOL short. This is the only blocker.**
- **Upgrade authority: single key `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh`**
  (`agenc-mainnet-restore/mainnet/sensitive-index/upgrade-authority.json`, plain
  keypair, used for the canary funding). The FD4 Squads 2-of-3 multisig is NOT
  set up — this is a single-key upgrade until it is. Verify live with
  `solana program show HJsZ…w1xK`.

**Sequence (roughly atomic; do at ~zero traffic):**
0. **Stage regenerated clients first (BREAKING, lockstep):** from `254078a`,
   rebuild + republish `@tetsuo-ai/marketplace-sdk` (bump), `-tools`, `-mcp`
   against the new IDL; prepare an agenc.ag deploy pinned to the new SDK. These
   must go live before/with the bytecode so the site doesn't stay broken.
1. Reproducible `anchor build`; confirm `.so` sha256 == `e8e6ca89…b12334`.
   (Gotcha: `canary:build` overwrites the shared deploy `.so` path — rebuild the
   full `.so` right before deploying and re-verify the hash.)
2. Fund the deploy wallet to ≥13.6 SOL (borrowed is fine — refunded immediately).
   `solana program write-buffer <full.so>`; set buffer authority to the deploy key.
3. `solana program deploy --buffer <buffer> --program-id HJsZ…w1xK
   --upgrade-authority <key>` (or `solana program upgrade`). Confirm the buffer
   rent refunds to the payer.
4. **Post-upgrade smoke test** (a mini-canary like the WP-B2 run): a
   regenerated-client publish (`set_task_job_spec`) + hire (`hire_from_listing`)
   on the global-authority path (the exact flow that breaks for un-regenerated
   callers), then a roster path: assign a `ModerationAttestor`, record + publish +
   hire through it, then revoke. All from the reviewed litesvm expectations.
5. Verifiable build (WP-G2): dump the now-deployed program, confirm its hash
   matches an independent reproducible build of `254078a`.
6. **Rollback:** re-deploy the prior verified `.so` (clean; no migration), rolling
   clients back in lockstep.

## TL;DR for future you

The hard work is DONE and green. A1 is not deployed only because a mainnet
upgrade needs ~13.6 SOL of *refundable* buffer liquidity we don't currently have
in hand. When that SOL is available for ~a minute, run the coordinated release
above. No audit, no re-review, no re-build needed — just the SOL and the lockstep
client rollout.
