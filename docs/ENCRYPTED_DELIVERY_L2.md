# Encrypted Deliverable Handoff — Layer 2 (on-chain key escrow)

> **Historical design record (banner added 2026-07-17).** Dated design document, not current state — see `./MAINNET_MAINLINE.md` for what is live and `./audit/ENTERPRISE_REMEDIATION_2026-07.md` for the completed remediation record.

**Status: DESIGN ONLY. [HUMAN: approve design before build.]**
Audit finding #30, PLAN.md P7.2 layer 2. This document is a deploy-gated
protocol design; nothing here is implemented. Layer 1 (the off-chain
encrypted-artifact convention) ships without a program change and is the
prerequisite this layer hardens.

## Problem

Today the fair-exchange gap is structural: the buyer can download the full
plaintext artifact during review and *then* reject, keeping the work without
paying. Layer 1 mitigates this off-chain — the artifact is encrypted to the
creator's pubkey (or a per-task symmetric key), only a preview/manifest is
public, and the artifact host gates full-object download on on-chain task
status `== Accepted`. But layer 1 trusts the **host** to enforce the gate and
to hold/release the key correctly. If the host is down, colludes, or the worker
reveals the *wrong* key after acceptance, the buyer has no trustless recourse.

Layer 2 closes that: the worker **commits** to a decryption key on-chain at
submission, and **reveals** it on-chain at acceptance with hash-match
enforcement, so the buyer can prove (trustlessly, no host) that the worker
revealed the key that actually decrypts the committed ciphertext.

## Design

### 1. Key commitment at submission

`submit_task_result` gains an **optional** `key_commitment: Option<[u8; 32]>`
argument. When present it is `sha256(decryption_key || ciphertext_hash)` — a
binding commitment to both the key and the exact ciphertext the buyer reviewed
(so the worker can't later reveal a key that decrypts a *different* object).
`None` preserves the current plaintext flow byte-for-byte.

The commitment must be stored on a per-submission account. **It cannot live in
`TaskSubmission._reserved`:** that field is only **5 bytes**
(`programs/agenc-coordination/src/state.rs`, `TaskSubmission` — `_reserved:
[u8; 5]`, of which bytes 0–1 already hold validation approval/rejection counts).
A 32-byte commitment plus a 32-byte ciphertext hash plus a reveal deadline does
not fit. Two storable options:

- **(A) Child PDA `SubmissionKeyEscrow`** — `["submission_key", task_submission]`,
  a NEW account holding `{ submission, key_commitment: [u8;32], ciphertext_hash:
  [u8;32], reveal_deadline: i64, revealed_key: [u8;32], status, bump }`. A new
  account + new PDA is **NOT a migration** (per CLAUDE.md): no existing layout
  changes, the 169 live tasks and all existing `TaskSubmission`s are untouched,
  and the account is `init`-ed only when a worker opts into encrypted delivery.
- **(B) Extend `TaskSubmission`** — append-only fields + a `migrate` sweep over
  every existing submission. This is a layout-change migration (deploy-gated,
  multisig, irreversible) for a feature most submissions won't use.

**This design recommends (A), the child PDA.** It is additive, opt-in,
zero-migration, and keeps the all-or-nothing plaintext path completely
unchanged. It mirrors the existing `HireRecord` pattern, which deliberately put
the task↔listing link on a child account precisely to avoid a `Task` layout
change.

### 2. Key reveal at acceptance

`accept_task_result` gains an **optional** `reveal_key: Option<[u8; 32]>`. When
the submission has a `SubmissionKeyEscrow`, acceptance MUST carry the reveal and
the program enforces:

```
require!(sha256(reveal_key || escrow.ciphertext_hash) == escrow.key_commitment,
         CoordinationError::KeyCommitmentMismatch);
```

On success the program stores `revealed_key` in the escrow and emits a
`DeliveryKeyRevealed { task, submission, key_commitment }` event so the buyer's
client (or any observer) can pull the key from chain and decrypt — no host
needed. Settlement (the existing 3-way / 4-way split in
`accept_task_result` → `completion_helpers`) is **unchanged**; the key gate is a
*precondition* on the accept transaction, not a new money path.

Acceptance of a submission that has **no** escrow behaves exactly as today
(`reveal_key` ignored / must be `None`).

### 3. Deadline bounds

The escrow records a `reveal_deadline: i64`, derived at submission from the
existing `TaskSubmission.review_deadline_at` (the review window the buyer
already has). Two bounded exits prevent funds or work from stranding ("money
never locks", per the Batch-1 exit-safety invariant):

- **Buyer never reveals / never accepts:** the existing review-deadline / auto-
  accept and reject/freeze paths already govern the *task*. The key escrow adds
  no new lock on the escrow lamports — it is a side commitment, not a fund
  custodian. If the task is rejected or expires, the `SubmissionKeyEscrow` is
  closeable (rent back to the worker) via `close_task` / a dedicated
  `close_submission_key` exit; the worker keeps their plaintext (never revealed).
- **Worker commits but the buyer wants to accept after the worker vanished:**
  acceptance requires the reveal from the accept signer. Since the *buyer*
  cannot produce the worker's key, an accept of an encrypted submission past
  `reveal_deadline` falls through to the normal reject/refund exit — the buyer
  is refunded, the worker forfeits payment for a deliverable they never made
  decryptable. This makes non-reveal a worker-side loss, which is the correct
  incentive.

### Bounds & invariants (carry into the build)

- `key_commitment` and `reveal_key` are 32 bytes; commitment uses `sha256` (the
  same `HASH_SIZE` / WebCrypto convention as the rest of the protocol).
- All comparisons constant-length; no money arithmetic changes (the split math
  in `completion_helpers.rs` is untouched — checked arithmetic already holds).
- `const_assert` the new `SubmissionKeyEscrow` size with the
  `test_size_constant!` pattern; `_reserved` zeroed + `validate_reserved_fields`.
- Errors (`KeyCommitmentMismatch`, `MissingRevealKey`, `RevealAfterDeadline`) in
  `errors.rs`; events in `events.rs`.
- **Surface gating:** `submit_task_result` and `accept_task_result` are in the
  canary surface today, so the OPTIONAL new args must be added without widening
  the **25-instruction** canary allowlist. Adding an `Option<[u8;32]>` arg to an
  existing instruction does not add an instruction — but the new
  `SubmissionKeyEscrow` init/close instructions and any new accounts MUST be
  `#[cfg(not(feature = "mainnet-canary"))]`-gated and dispatched only in the
  full module, so the canary stays at 25 (`scripts/check-canary-idl.mjs`). If
  the optional account threads through the canary build, it must be passed as
  `null` there (the litesvm gotcha: adding an optional account to a shared
  instruction breaks existing call sites unless they pass `null`).

## What this is NOT

- Not on-chain encryption — the program only stores a hash commitment and a
  revealed key; ciphertext lives off-chain on the existing artifact rails.
- Not a replacement for layer 1 — layer 1 (host read-gating on `Accepted`)
  remains the default UX; layer 2 is the trustless backstop for buyers who want
  host-independent proof.
- Not a new settlement path — the 3-way/4-way split is untouched.

## DECISION-NEEDED

1. **Child PDA (A) vs `TaskSubmission` extension (B).** Recommendation: (A),
   the zero-migration child PDA. Confirm — or accept a `TaskSubmission` layout
   migration if the team would rather keep the escrow inline.
2. **Commitment formula.** `sha256(key || ciphertext_hash)` binds the key to a
   specific ciphertext (recommended). Alternative: `sha256(key)` alone (simpler,
   but lets a worker reveal a key for a *different* uploaded object). Confirm the
   bound-to-ciphertext form.
3. **Key type.** 32-byte symmetric key revealed in clear on-chain (anyone
   watching chain learns the key once revealed — fine, because reveal happens
   only at/after the buyer has paid). Alternative: a key wrapped to the buyer's
   pubkey so only the buyer can decrypt even post-reveal. Wrapping needs a
   defined KEM and a variable-length field; decide whether host-independent buyer
   privacy is in scope for v1.
4. **Reveal enforcement strictness.** MUST the accept of an encrypted submission
   *always* carry a matching reveal (hard fail on mismatch — recommended), or
   may the buyer accept-without-reveal as an explicit "I'll take the plaintext
   out of band" escape hatch? Recommendation: hard fail; no escape hatch (it
   would reintroduce the trust gap).
5. **Deadline source.** Reuse `review_deadline_at` (recommended, no new buyer
   choice) vs a separate worker-set `reveal_deadline`. Confirm reuse.
6. **Dependency ordering.** This is deploy-gated and should land in a Batch-4-
   style change *after* layer 1 has real usage, so the commitment format is
   validated against shipped encrypted artifacts. Confirm sequencing.
