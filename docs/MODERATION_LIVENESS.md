# Moderation Liveness Escape Hatch (P1.3 / batch-2 A2)

> **Historical design record (banner added 2026-07-17).** Dated design document, not current state — see `./MAINNET_MAINLINE.md` for what is live and `./audit/ENTERPRISE_REMEDIATION_2026-07.md` for the completed remediation record.

> **Status:** DESIGN + IMPLEMENTED IN BATCH 2 (this document is written first, the
> implementation follows its §5 recommendation exactly). Closes the last half of the
> "key vanishes → network dead forever" failure family (umbrella TODO P1.3): a
> **timelock/deadman** so the moderation consumption gates auto-relax when the
> moderation authority goes silent for a configured window (default ~90 days).
> Companion docs: `P1_2_OPEN_ROSTER_SPEC.md` (the roster that already fixed the
> hard half), `MODERATION_NEUTRALITY.md` (the trust model).

## 1. The residual failure, precisely

P1.2 already killed the catastrophic version of this failure. Post-P1.2:

- **Attestor registration is permissionless** (`register_moderation_attestor`,
  self-signed, self-paid, hardcoded 0.25 SOL refundable bond). No tetsuo key is
  needed for a new attestor to exist.
- **All three consumption gates** (`set_task_job_spec`, `hire_from_listing`,
  `hire_from_listing_humanless`) accept a record authored by the global
  `moderation_authority` **or any registered, non-revoked, non-exiting roster
  attestor** — the caller names the moderator it consumes.
- The **BLOCK floor** is fail-OPEN on key death (an absent/`CLEARED` block passes;
  nothing can be gated *in* through it), and the **default trust list** already
  carries `updated_at` as a display-layer deadman.

So if every tetsuo-ai key vanished today, the network is *not* dead: any publisher
can register as an attestor (or find one) and keep publishing. What **remains** on
authority inactivity is a set of permanent degradations, none of which any
non-authority party can repair:

| # | Degradation on authority silence | Severity |
| --- | --- | --- |
| D1 | **Mandatory-attestation friction becomes permanent.** `ModerationConfig.enabled` can only be changed by the protocol authority (`configure_task_moderation`). With that key dead, every publisher forever needs *some* roster attestation (worst case: bond 0.25 SOL and self-attest) — a dead operator's policy choice frozen into the money path. | The real P1.3 target |
| D2 | **`enabled == false` + dead authority bricks direct-task publication.** `validate_task_moderation_for_job_spec` fail-closes on `enabled == false` (`TaskModerationRequired`), and only the dead authority could flip it back. (The hire gates skip on disabled; the job-spec gate does not.) | Latent (mainnet is `enabled = 1`) but a true brick |
| D3 | `moderation_authority` rotation impossible → the first-party default moderator can never be replaced in the config; surfaces must migrate to naming roster attestors explicitly. | Low (gates already accept roster attestors) |
| D4 | `assign_moderation_attestor` / authority-side `revoke` dead. | None — `register`/`exit` are permissionless |
| D5 | `record_agent_verification` (global-authority-only since P1.2 §4.6) dead → no new domain badges. | Advisory only; out of scope here |

**The deadman's job is D1 + D2:** when the authority demonstrably stops operating,
the *allow*-gate requirement decays to moderation-optional, instead of freezing the
dead operator's gate policy into the protocol forever.

## 2. Attack analysis

The design constraint stated up front: **only the authority heartbeats.** The
relaxation trigger must be a timestamp that moves *only* under an authority
signature, so no third party can either force or prevent relaxation.

1. **Can an attacker trigger relaxation early?** No. The heartbeat timestamp is
   `ModerationConfig.updated_at`, written only by `configure_task_moderation`
   (protocol authority) and the new `moderation_heartbeat` (protocol authority or
   moderation authority). It is monotonic wall-clock “last authority action”; an
   attacker cannot age it. The only path to relaxation is ≥ N seconds of genuine
   authority silence — and one cheap transaction per window (a monthly cron against
   a 90-day window) keeps the gate armed forever.
2. **What does an attacker gain during relaxation?** Unmoderated *publication*
   (job-spec pointers, hires without a listing attestation). Per the P1.2 spec §8
   framing, the allow gate is a **provenance layer, not real-time spam
   protection** — a CLEAN record only proves who underwrote the content. Losing it
   costs provenance on new supply, which surfaces already treat as an edge/trust-list
   concern. The **real-time enforcement layer — the multisig BLOCK floor — is
   deliberately NOT relaxed**: `require_content_not_blocked` stays unconditional in
   relaxed mode, so takedowns keep working exactly as before (and that floor's own
   key-death story is fail-open by design, folded into P0.3 custody).
3. **Can the authority weaponize the deadman?** It could silently let the window
   lapse to make moderation optional without an announcement. But the authority can
   already, openly, achieve strictly more today (disable moderation for hires,
   rotate the moderator, or upgrade the program via the 2-of-3). The deadman adds no
   new authority power; it only removes a *dead* authority's power.
4. **Flapping / boundary games.** Relaxation is instantly reversible: one heartbeat
   re-arms the gate. A transaction racing the boundary either lands strict (record
   validated — the status quo) or relaxed (no record needed — the deadman working as
   specified). Neither side of the boundary mis-pays anyone: this is a publish gate,
   not a settlement path; no lamport routing depends on it.
5. **Clock basis.** Unix time from the cluster clock (the house convention for every
   window in this program — exit cooldowns, review windows, deadlines), not epochs.
   Epoch length (~2–3 days) would add an irrelevant unit conversion; drift is
   negligible against a 90-day window.
6. **Why the window is configurable but bounded on BOTH sides.** `0 = default
   (90 days)`; the protocol authority may tune it (a livelier cadence for a paranoid
   operator, longer for a sleepy one) but only within **[1 day, 400 days]**. The
   floor stops a sub-day window from making the gate effectively always-relaxed by
   accident. The ceiling is the symmetric guard on the *safety-critical* direction:
   without it a units typo (seconds-vs-millis, an accidental multiply) could push the
   deadman decades out, so a later authority-key death would never relax the gate
   within any practical horizon — the exact D1/D2 failure the deadman exists to
   prevent. Neither bound is a trust boundary (the authority can already disable
   moderation openly); both are foot-gun guards.
7. **Storage without a migration.** The window lives in
   `ModerationConfig._reserved[0..4]` as a little-endian `u32` seconds value (the
   ModerationAttestor P1.2 / DisputeResolver P6.4 "carve from reserved, value-only,
   size-identical" precedent). The live mainnet config account needs **no realloc**:
   its reserved bytes are zero, which reads as "default window". `updated_at` (already
   on the account, already maintained) is the heartbeat — zero new accounts on any
   gate, zero layout change.
8. **`configure_task_moderation` also arms the deadman.** Any authority write that
   bumps `ModerationConfig.updated_at` (not just `moderation_heartbeat`) resets the
   window, so a routine reconfigure counts as liveness — the heartbeat ix exists so
   the authority can prove liveness *without* changing any policy.

### Operational note — the lapse is silent

The transition into relaxed mode happens by pure passage of time: there is **no
transaction at the moment the window elapses**, so **no event marks it**.
`ModerationHeartbeatRecorded` fires only when the authority *arms* the gate, never
when it lapses. Off-chain surfaces therefore cannot observe the strict→relaxed edge
by watching logs; they must independently recompute
`now > updated_at + effective_window` against the config account. **Operators should
run a liveness alarm well inside the window** (e.g. alert at 50% elapsed) so a
forgotten or key-lost heartbeat is caught long before the marketplace-wide ALLOW
gate relaxes. The `[1 day, 400 day]` bounds cap the blast radius of a misconfigured
window but do not remove the need for the alarm.

### Rejected alternatives

- **Auto-open `assign_moderation_attestor` on expiry** — pointless;
  `register_moderation_attestor` is already permissionless (P1.2 subsumed this half
  of P1.3 at the roster layer).
- **Per-attestor deadman** — attestors are permissionless and exit-bonded; their
  liveness is a surface trust-list concern, not a protocol gate.
- **Relaxing the BLOCK floor** — never. It is the takedown floor for
  illegal/sanctioned supply, already fail-open on key death, and governed by the
  multisig whose custody story is P0.3's (Squads 2-of-3).
- **A heartbeat on `record_*_moderation` activity** — would require making
  `moderation_config` writable on the record paths (wire/meta change on hot
  instructions) and would let the *default first-party service key* keep the gate
  armed even if the actual config authority is long dead. The explicit heartbeat
  keeps the signal attributable to the keys that own the policy.
- **`enabled` auto-flip instead of gate-side check** — nothing may mutate config
  state without an authority signature; the deadman must be a *read-side* predicate
  so it is trustless, reversible, and cannot be front-run.

## 3. What relaxes and what does not

| Surface | Strict mode (authority live) | Relaxed mode (silence > window) |
| --- | --- | --- |
| `set_task_job_spec` allow gate | CLEAN/HUMAN_APPROVED record from named moderator required (incl. `enabled == true` requirement) | **Skipped** — publish proceeds with no record |
| `hire_from_listing` / `_humanless` allow gate (when `enabled`) | Listing attestation from named moderator required | **Skipped** |
| BLOCK floor (`require_content_not_blocked`) | Enforced | **Enforced (unchanged)** |
| `record_task_moderation` / `record_listing_moderation` | Authority or roster attestor | Unchanged — records remain writable (provenance keeps working for anyone who wants it) |
| Attestor registration / exit | Permissionless | Unchanged (already permissionless) |
| Roster attestor checks (revoked / exiting fail-closed) | Enforced when a record IS presented | Unchanged when a record is presented |

## 4. Recommendation (implemented in batch 2)

1. **Pure predicate** `moderation_liveness_relaxed(updated_at, window_secs, now)`
   in `moderation_gate_helpers.rs`:
   `updated_at > 0 && now > updated_at.saturating_add(effective_window)` where
   `effective_window = window_secs > 0 ? window_secs : DEFAULT_MODERATION_LIVENESS_WINDOW_SECS`
   (90 days = 7,776,000 s). Unit-tested, revert-sensitive.
2. **Gate wiring:** each of the three consumption gates evaluates the predicate
   against the `ModerationConfig` it already loads. Relaxed → skip the allow-record
   load + validation entirely (the record slot may be an empty PDA); the BLOCK floor
   check stays unconditional and FIRST. Strict → byte-identical behavior to today.
3. **`moderation_heartbeat(new_window_secs: Option<u32>)`** — new full-module-only
   instruction. Signer must be `moderation_config.authority` (protocol authority)
   OR `moderation_config.moderation_authority`; a `Some(window)` change additionally
   requires the protocol authority and `window >= 86_400` (1 day floor). Always sets
   `updated_at = now` (the heartbeat). Emits `ModerationHeartbeat`.
4. **Window storage:** `ModerationConfig` reserved-byte accessor
   (`liveness_window_secs()` / `set_liveness_window_secs()`), `_reserved[0..4]` LE
   `u32`, `0 = default`. No migration; the live config reads the default.
5. **Registration relaxation: none** — already permissionless (P1.2). Stated here so
   nobody re-adds a roster deadman later.
6. **Canary build:** untouched. The 25-ix canary keeps the frozen pre-P1.2 gate; the
   deadman is full-module only, like every batch-2/3 feature.

## 5. Test plan (litesvm time-warp, all landed with the batch)

- Strict before the boundary: with `enabled = 1` and `updated_at = now`, publishing
  without a record fails (`TaskModerationRequired` path) — unchanged.
- Warp past `updated_at + window`: the same publish (empty record slot, no attestor)
  **succeeds**; hire without a listing attestation succeeds; a multisig-BLOCKED hash
  **still hard-rejects** in relaxed mode (floor absoluteness).
- Heartbeat re-arms: warp → heartbeat (moderation-authority signer) → the
  record-less publish fails again.
- Window config: non-authority window change rejected; sub-floor window rejected;
  custom window respected across a warp on both sides of the boundary.
- Revert-sensitivity: with the gate wiring reverted (predicate forced `false`), the
  relaxed-publish test goes red; with the BLOCK-floor call reverted, the
  blocked-in-relaxed-mode test goes red.
