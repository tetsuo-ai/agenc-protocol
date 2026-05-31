# Design: on-chain moderation gate for `create_task` (zero-trust task content)

> Status: **design / implementation spec for review — NOT a deploy.**
> This document contains ready-to-apply Rust, but it has **not** been compiled in this
> environment (no `anchor`/`cargo`/`solana` toolchain available here). The team must build,
> test (localnet + canary), and review under the program's multisig upgrade authority before
> any mainnet upgrade.

## Problem

`create_task` is **not gated on moderation** and persists potentially human-readable text on-chain.

- The `Task` account stores `pub description: [u8; 64]` (`state.rs`, doc-comment *"Task description or
  instruction hash"*). The only validation is non-emptiness: `validate_task_params` requires
  `*description != [0u8; 64]` (`task_init_helpers.rs`), and `init_task_fields` writes it verbatim
  (`task.description = description;`).
- The moderation gate exists **only** in `set_task_job_spec` (`validate_task_moderation_for_job_spec`),
  i.e. it gates **job-spec publication**, not task creation, and never inspects `description`.
- `record_task_moderation` requires the task to **already exist** (its `TaskModeration` PDA is keyed
  `[b"task_moderation", task, job_spec_hash]`), so today you cannot attest *before* creating the task.

**Consequence (zero-trust failure):** any caller bypassing the kit can submit `create_task` directly and
write up to 64 bytes of un-moderated, readable text on-chain at creation. The off-chain kit preflight does
not protect against a hand-rolled transaction; only the on-chain program is the universal chokepoint.

The kit-side half of the fix is already up: **agenc-marketplace-agent-kit PR #210** makes the kit always
pack `sha256(content)` into the 64-byte field (digest in bytes `0..31`, zero tail) instead of raw prose.
This document specifies the **protocol-side enforcement** so the guarantee holds against *any* caller, not
just the kit.

## Goals

1. **No readable text on-chain.** The on-chain `description` must provably be a content hash, never prose.
2. **Our attestation is the universal gate.** Task *creation* (not just publication) requires a clean,
   authority-signed moderation attestation — so a non-kit caller cannot create un-moderated tasks.
3. **Fail-closed**, backward-compatible with existing tasks, and rolled out **canary-first** behind the
   existing `mainnet-canary` cfg.

## Approach (recommended): Option A + Option C

- **Option A — pre-task attestation.** Introduce a `PretaskModeration` account the attestor can create
  *before* the task exists, keyed by `[b"pretask_moderation", creator, content_hash]` (a **distinct** seed
  prefix from `TaskModeration` to avoid PDA ambiguity — both second seeds are 32 bytes). `create_task`
  then **requires** a clean, non-expired, authority-signed `PretaskModeration` for the creator+content_hash.
- **Option C — `description == content_hash`.** In `create_task`, require the supplied `description`'s
  first 32 bytes equal `pretask_moderation.content_hash` and the remaining 32 bytes are zero. This binds the
  on-chain commitment to exactly the moderated content and forbids a readable tail. Matches the kit #210
  layout (digest in `0..31`, zero tail).

This solves the chicken-and-egg ("moderate once, then create") **without** mutating the existing
`TaskModeration` type/seeds or the working `set_task_job_spec` job-spec gate.

### Flow after the change

```
attestor (our authority) → record_pretask_moderation(creator, content_hash, status, ...)   [scan passed]
creator                  → create_task(..., description = content_hash ‖ 0x00*32)
                            ├─ requires PretaskModeration[creator, content_hash] is CLEAN/HUMAN_APPROVED,
                            │  not expired, moderator == ModerationConfig.moderation_authority
                            ├─ requires description[0..32] == content_hash, description[32..] == 0
                            └─ marks PretaskModeration.consumed = true (single-use)
... unchanged: record_task_moderation (job-spec) → set_task_job_spec (publish gate) ...
```

## Concrete changes (`programs/agenc-coordination`)

> Apply to **both** `#[program]` mods — `#[cfg(not(feature = "mainnet-canary"))]` and
> `#[cfg(feature = "mainnet-canary")]` — but **gate the new `create_task` precondition behind the
> `mainnet-canary` cfg first** (same mechanism as the existing `create_task.rs` canary block) so it ships to
> canary before mainnet. Reuse existing error variants where possible to avoid enum-ABI churn.

### 1) `state.rs` — new `PretaskModeration` account (do not touch `TaskModeration`)

```rust
/// Pre-task moderation attestation, recordable BEFORE the task exists.
/// PDA seeds: ["pretask_moderation", creator, content_hash]
/// (distinct prefix from ["task_moderation", task, job_spec_hash] to avoid PDA ambiguity).
#[account]
#[derive(Default, InitSpace)]
pub struct PretaskModeration {
    pub creator: Pubkey,
    pub content_hash: [u8; 32], // sha256 of the moderated task content; == Task.description[0..32]
    pub status: u8,            // task_moderation_status namespace (CLEAN=0 / HUMAN_APPROVED=4 publishable)
    pub risk_score: u8,
    pub category_mask: u64,
    pub policy_hash: [u8; 32],
    pub scanner_hash: [u8; 32],
    pub recorded_at: i64,
    pub expires_at: i64,       // 0 = no expiry; else must be > clock at create_task
    pub moderator: Pubkey,     // must equal ModerationConfig.moderation_authority
    pub consumed: bool,        // single-use: set true by create_task
    pub bump: u8,
    pub _reserved: [u8; 7],
}

impl PretaskModeration {
    pub const SIZE: usize = 8 + <Self as anchor_lang::Space>::INIT_SPACE;
}
```

Reuse the existing `is_publishable_task_moderation_status` and `is_valid_task_moderation_status` helpers.

### 2) New instruction `instructions/record_pretask_moderation.rs`

Clone `record_task_moderation.rs` but **drop the `task` account** and key the attestation by
`creator + content_hash`.

```rust
#[derive(Accounts)]
#[instruction(creator: Pubkey, content_hash: [u8; 32])]
pub struct RecordPretaskModeration<'info> {
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Account<'info, ModerationConfig>,

    #[account(
        init_if_needed,
        payer = moderator,
        space = PretaskModeration::SIZE,
        seeds = [b"pretask_moderation", creator.as_ref(), content_hash.as_ref()],
        bump,
    )]
    pub pretask_moderation: Account<'info, PretaskModeration>,

    #[account(
        mut,
        constraint = moderator.key() == moderation_config.moderation_authority
            @ CoordinationError::UnauthorizedTaskModerator,
    )]
    pub moderator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordPretaskModeration>,
    creator: Pubkey,
    content_hash: [u8; 32],
    status: u8,
    risk_score: u8,
    category_mask: u64,
    policy_hash: [u8; 32],
    scanner_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    require!(ctx.accounts.moderation_config.enabled, CoordinationError::TaskModerationRequired);
    require!(is_valid_task_moderation_status(status), CoordinationError::InvalidTaskModerationStatus);

    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.pretask_moderation;
    m.creator = creator;
    m.content_hash = content_hash;
    m.status = status;
    m.risk_score = risk_score;
    m.category_mask = category_mask;
    m.policy_hash = policy_hash;
    m.scanner_hash = scanner_hash;
    m.recorded_at = now;
    m.expires_at = expires_at;
    m.moderator = ctx.accounts.moderator.key();
    m.consumed = false;
    m.bump = ctx.bumps.pretask_moderation;
    Ok(())
}
```

Wire `pub mod record_pretask_moderation;` into `instructions/mod.rs` and add a dispatch fn in **both**
`#[program]` mods (next to the existing `record_task_moderation`).

### 3) Gate `create_task` (`instructions/create_task.rs`)

Add to the `CreateTask` accounts struct (cfg-gated for canary-first rollout). Bind `content_hash` via
`#[instruction(...)]` so the PDA derives from it:

```rust
#[cfg(feature = "mainnet-canary")]
#[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
pub moderation_config: Account<'info, ModerationConfig>,

#[cfg(feature = "mainnet-canary")]
#[account(
    mut,
    seeds = [b"pretask_moderation", creator.key().as_ref(), &content_hash],
    bump = pretask_moderation.bump,
    constraint = pretask_moderation.creator == creator.key()
        @ CoordinationError::TaskModerationTaskMismatch,
    constraint = is_publishable_task_moderation_status(pretask_moderation.status)
        @ CoordinationError::TaskModerationRejected,
    constraint = !pretask_moderation.consumed
        @ CoordinationError::TaskModerationRejected,
)]
pub pretask_moderation: Account<'info, PretaskModeration>,
```

In the handler, right after `validate_task_params`, add (cfg-gated):

```rust
#[cfg(feature = "mainnet-canary")]
{
    let m = &ctx.accounts.pretask_moderation;
    let cfg = &ctx.accounts.moderation_config;
    require!(cfg.enabled, CoordinationError::TaskModerationRequired);
    require!(m.moderator == cfg.moderation_authority, CoordinationError::InvalidTaskModerationAuthority);
    let now = Clock::get()?.unix_timestamp;
    require!(m.expires_at == 0 || m.expires_at > now, CoordinationError::TaskModerationExpired);

    // Option C — description must be exactly the moderated content hash, no readable tail.
    let content_hash: [u8; 32] = description[0..32].try_into().unwrap();
    require!(description[32..].iter().all(|b| *b == 0), CoordinationError::InvalidDescription);
    require!(content_hash == m.content_hash, CoordinationError::TaskModerationHashMismatch);
}
```

After the task is initialized successfully (still cfg-gated), mark the attestation single-use:

```rust
#[cfg(feature = "mainnet-canary")]
{
    ctx.accounts.pretask_moderation.consumed = true;
}
```

### 4) `errors.rs`

Reuse existing variants: `TaskModerationRequired`, `UnauthorizedTaskModerator`,
`TaskModerationTaskMismatch`, `TaskModerationHashMismatch`, `TaskModerationExpired`,
`TaskModerationRejected`, `InvalidTaskModerationAuthority`, `InvalidTaskModerationStatus`,
`InvalidDescription`. (Optionally add a clearer `DescriptionNotHash` / `ModerationCreatorMismatch`, but
reusing avoids enum-ABI churn.)

### 5) IDL / clients

Regenerate the Anchor IDL + types and update `packages/protocol`. Update the kit's real `create_task`
builder to pass `pretask_moderation` + `moderation_config` and the hash-shaped `description`
(coordinated with **kit #210**, which already produces the hash-shaped description).

## Migration / upgrade risks (read before deploying)

1. **ABI/IDL break on `create_task`** — adding required accounts breaks every caller unless updated in
   lockstep. Mitigated by cfg-gating to **canary first** and updating clients (kit #210 + builder) before
   any mainnet flip.
2. **Dual `#[program]` mods** — `create_task` and `record_task_moderation` exist in both the mainnet and
   canary mods; apply the new instruction/dispatch to **both**, but the `create_task` precondition stays
   `#[cfg(feature = "mainnet-canary")]` until the team explicitly promotes it.
3. **Backward-compat** — existing tasks and existing `TaskModeration` accounts are untouched (distinct new
   type + seed prefix; no re-keying). The gate runs only at create-time; nothing retroactively bricks.
4. **Replay** — single-use enforced via `consumed = true` on `create_task`. (Decide with the team if
   multi-use per `content_hash` is ever desired.)
5. **Fail-closed default** — reusing `is_publishable_task_moderation_status` blocks creation for
   `SUSPICIOUS`/`BLOCKED`/`SCANNER_UNAVAILABLE`/`HUMAN_REJECTED`, consistent with `set_task_job_spec`.
6. **Rent / authority** — `PretaskModeration` sized via `InitSpace + 8`; only
   `ModerationConfig.moderation_authority` can record one (mirrors `record_task_moderation`).
7. **Upgrade authority** — this upgrades live program `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`.
   Confirm the multisig holder; regenerate + publish IDL/types with the upgrade. **PR only — do not deploy
   from this work.**

## Coordination

- Pairs with **agenc-marketplace-agent-kit #210** (kit already commits `description` as a sha256 hash).
- A local (unpushed) branch `security/multisig-gate-task-moderation` was observed in an audit checkout —
  reconcile with that effort before implementing so designs don't diverge.

## Test plan (localnet + canary)

- `record_pretask_moderation`: only `moderation_authority` can record; status validity; expiry stored.
- `create_task` (canary cfg): rejects when no/unclean/expired/consumed/wrong-authority attestation; rejects
  when `description != content_hash` or has a non-zero tail; succeeds and sets `consumed = true` on a clean
  attestation; second create with the same attestation fails (replay).
- Regression: `set_task_job_spec` job-spec gate unchanged; existing tasks unaffected; non-canary build
  unchanged.
