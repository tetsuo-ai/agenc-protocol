# Marketplace V2 Validation Deployment Spec

Generated: 2026-03-27

## Goal

Finish the remaining red Marketplace V2 validation scenarios in a controlled environment without mutating the shared long-horizon devnet deployment.

Target scenarios:

- `DV-03E`
- `DV-05`
- `DV-07A`
- `DV-07B`
- `DV-07C`
- `DV-08A`
- `DV-08B`

Current shared-devnet status remains:

- `11` pass
- `7` fail
- `0` not-run

Source of truth:

- `artifacts/devnet-readiness/readiness-report.json`

## Deployment Decision

Use a dedicated validation deployment on Solana devnet with:

- a new upgradeable program ID
- isolated PDAs under that program ID
- shortened protocol timing defaults
- low-friction but nonzero bid / stake settings

Do not repurpose the existing shared devnet deployment. The current shared deployment already has valid green evidence for `DV-01`, `DV-02`, `DV-03A/B/C/D`, `DV-04A/B`, `DV-06A/B`, and `DV-09`. Replacing its timing behavior would create unnecessary risk and would blur which evidence came from which environment.

## Code Facts That Drive This Spec

These are the protocol facts that make a dedicated validation deployment necessary:

1. `initialize_protocol` does not accept claim, dispute, or voting timing arguments.
2. `initialize_protocol` writes:
   - `max_claim_duration = ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION`
   - `max_dispute_duration = ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION`
   - `voting_period = ProtocolConfig::DEFAULT_VOTING_PERIOD`
3. Current defaults are:
   - `DEFAULT_MAX_CLAIM_DURATION = 604800`
   - `DEFAULT_MAX_DISPUTE_DURATION = 604800`
   - `DEFAULT_VOTING_PERIOD = 86400`
4. `update_rate_limits` can shorten cooldowns and lower `min_stake_for_dispute`, but it cannot change:
   - `max_claim_duration`
   - `max_dispute_duration`
   - `voting_period`
5. `accept_bid` derives accepted-claim expiry as:
   - `task.deadline + 3600` when `task.deadline > 0`
   - `now + max_claim_duration` when `task.deadline == 0`
6. `expire_claim` has a `60` second grace period after `claim.expires_at`.
7. `resolve_dispute` requires at least `3` arbiter votes.
8. `expire_dispute` becomes legal when either:
   - `now > dispute.expires_at`
   - `now >= voting_deadline + 120`

Implications:

- `DV-05` must use tasks with `deadline = 0`, or the accepted claim gets a built-in extra hour.
- `DV-07*` and `DV-08*` need short voting windows plus three arbiter-capable agents.
- `DV-03E` still needs either prover access or a reusable proof fixture matching the validation deployment's `zk_config.active_image_id`.

## Recommended Validation-Only Code Delta

Fastest path:

- build a validation binary that changes only these compile-time defaults:
  - `ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION = 300`
  - `ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION = 600`
  - `ProtocolConfig::DEFAULT_VOTING_PERIOD = 300`

Recommended implementation shape:

- gate the timing constants behind a validation-only compile flag or branch-specific patch
- keep all other business logic identical
- deploy this binary under a new devnet program ID

Implemented build switch:

```bash
anchor build -- --features validation-timings
```

Targeted verification command:

```bash
cargo test test_protocol_timing_profile_matches_build_mode \
  --manifest-path programs/agenc-coordination/Cargo.toml \
  --features validation-timings
```

Not recommended for the immediate unblock:

- adding a brand-new timing-update instruction first

That would be cleaner long term, but it is extra surface area and extra review work compared with a dedicated validation binary.

## Exact Validation Profile

### 1. Program Deployment

- Cluster: `devnet`
- Program ID: `<NEW_VALIDATION_PROGRAM_ID>`
- Upgrade authority: protocol ops multisig or designated validation deployer
- IDL address: must match `<NEW_VALIDATION_PROGRAM_ID>`

Important harness note:

- `scripts/marketplace-devnet-readiness.mjs` currently loads the generated IDL address from `packages/protocol/src/generated/agenc_coordination.json`
- validation runs therefore need either:
  - a regenerated IDL whose `address` is the validation program ID, or
  - a small harness override for program ID / IDL path

### 2. `initialize_protocol`

Use exactly:

```json
{
  "dispute_threshold": 51,
  "protocol_fee_bps": 100,
  "min_stake": 1000000,
  "min_stake_for_dispute": 1000,
  "multisig_threshold": 2,
  "multisig_owners": [
    "<ADMIN_A>",
    "<ADMIN_B>",
    "<ADMIN_C>"
  ]
}
```

Initialization accounts:

- `authority = <ADMIN_A>`
- `second_signer = <ADMIN_B>`
- `treasury = <TREASURY_WALLET>`

Treasury requirement:

- if `<TREASURY_WALLET>` is a system account, it must sign initialization
- use a dedicated validation treasury wallet, not the shared devnet treasury

Rationale:

- `51` keeps dispute approval above a 50/50 split while still allowing a 2-of-3 majority.
- `100` preserves existing 1% fee behavior already proven by the green scenarios.
- `1000000` is the minimum sensible protocol stake allowed by init validation.
- `1000` is the lowest dispute stake accepted by `update_rate_limits` semantics and keeps dispute setup cheap.
- `2-of-3` is the smallest operational multisig that satisfies init constraints.

### 3. Validation-Only Timing Defaults

Bake into the validation deployment:

```json
{
  "max_claim_duration": 300,
  "max_dispute_duration": 600,
  "voting_period": 300
}
```

Why these numbers:

- `300` seconds is short enough to finish `DV-05` and `DV-07*` in one session.
- `600` seconds keeps `dispute.expires_at` comfortably after the vote window.
- `300` seconds plus the `120` second dispute grace gives a predictable `~7` minute `DV-08*` wait.

### 4. `update_rate_limits`

Run immediately after protocol init:

```json
{
  "task_creation_cooldown": 1,
  "max_tasks_per_24h": 50,
  "dispute_initiation_cooldown": 1,
  "max_disputes_per_24h": 50,
  "min_stake_for_dispute": 1000
}
```

Execution requirement:

- call this with one admin signer plus enough remaining multisig signers to satisfy the `2-of-3` threshold

Rationale:

- `1` second cooldowns avoid rate-limit friction while respecting protocol lower bounds.
- `50` per 24h is comfortably above fixture needs without turning the validation environment into "unlimited mode."
- leaving `min_stake_for_dispute` at `1000` keeps creator-initiated dispute stake checks trivial because the creator agent already has `1000000` stake from registration.

### 5. `initialize_bid_marketplace`

Use exactly:

```json
{
  "min_bid_bond_lamports": 1000000,
  "bid_creation_cooldown_secs": 0,
  "max_bids_per_24h": 50,
  "max_active_bids_per_task": 8,
  "max_bid_lifetime_secs": 900,
  "accepted_no_show_slash_bps": 2500
}
```

Execution requirement:

- call this with one admin signer plus enough remaining multisig signers to satisfy the `2-of-3` threshold

Rationale:

- `1000000` creates a visible but affordable bond and makes `DV-05` slash math easy to audit.
- `0` bid cooldown is allowed on the marketplace surface and speeds fixture churn.
- `8` active bids per task is more than enough for the current matrix.
- `900` seconds keeps bids alive during setup without forcing long waits.
- `2500` matches the existing 25% no-show slash profile already used elsewhere in the codebase.

### 6. `initialize_zk_config`

Use exactly:

```json
{
  "active_image_id": "<VALIDATION_IMAGE_ID>"
}
```

Rules:

- `<VALIDATION_IMAGE_ID>` must match the proof source used for `DV-03E`
- if using a reusable proof fixture, its seal and journal must have been generated for this image ID
- if using a live prover, the prover must target this image ID

## Required Fixture Inventory

Minimum inventory:

- `1` creator wallet
- `1` treasury wallet
- `2` worker-capable agents
- `3` arbiter-capable agents
- `1` proof source for `DV-03E`

Minimum funding / registration state:

- every agent stake: `>= 1000000` lamports
- creator-controlled agent stake: `>= 1000000` lamports
- each bidder bond wallet: enough SOL for rent + `1000000` lamport bid bond

Recommended role map:

- `creator_agent`
- `worker_agent_a`
- `worker_agent_b`
- `arbiter_a`
- `arbiter_b`
- `arbiter_c`

## Scenario-Specific Fixture Rules

### `DV-03E`

Needs:

- one `BidExclusive` task
- one accepted bid
- one valid private completion proof

Proof requirements:

- valid seal
- valid journal
- image ID equal to `zk_config.active_image_id`
- router/verifier accounts matching the trusted router constraints in `complete_task_private`

### `DV-05`

Use this exact task shape:

```json
{
  "task_type": "BidExclusive",
  "deadline": 0
}
```

This is mandatory. If `deadline > 0`, `accept_bid` derives claim expiry as `deadline + 3600`, which defeats the short validation claim window.

Expected wait:

- `300` seconds claim duration
- plus `60` seconds grace
- target operator wait: `~6` minutes after `accept_bid`

### `DV-07A`, `DV-07B`, `DV-07C`

Use this fixture pattern for each resolution type:

1. create `BidExclusive` task
2. initialize bid book
3. create accepted bid
4. move task into a disputable state
5. initiate dispute with resolution type:
   - `Refund` for `DV-07A`
   - `Complete` for `DV-07B`
   - `Split` for `DV-07C`
6. attach `3` arbiter votes
7. wait until `voting_deadline`
8. call `resolve_dispute`

Expected wait:

- target operator wait: `~5` minutes after `initiate_dispute`

### `DV-08A`

Use this fixture pattern:

1. create `BidExclusive` dispute
2. ensure `worker_completed = true`
3. ensure `no votes`
4. wait until `voting_deadline + 120`
5. call `expire_dispute`

Expected wait:

- `300` second voting period
- `120` second grace
- target operator wait: `~7` minutes after `initiate_dispute`

### `DV-08B`

Use this fixture pattern:

1. create `BidExclusive` dispute
2. keep the dispute on a slash-on-expiry path:
   - no completion with no votes, or
   - some votes but fewer than quorum
3. wait until `voting_deadline + 120`
4. call `expire_dispute`

Expected wait:

- target operator wait: `~7` minutes after `initiate_dispute`

## Recommended Execution Order

Run in this order:

1. `DV-03E`
2. `DV-05`
3. `DV-07A`
4. `DV-07B`
5. `DV-07C`
6. `DV-08A`
7. `DV-08B`

Why this order:

- `DV-03E` is independent except for proof setup, so it should clear first once proof material exists.
- `DV-05` validates the short claim window immediately.
- `DV-07*` then proves each resolution branch with quorum votes.
- `DV-08*` finishes the expiry branches using the same short dispute window.

## Exit Criteria

The validation deployment is successful when:

- all `7` currently red scenarios capture valid bundles
- `artifacts/devnet-readiness/readiness-report.json` moves to `18 pass / 0 fail / 0 not-run`
- the proof source for `DV-03E` is documented alongside the validation image ID used
- the validation deployment program ID and commit hash are recorded with the evidence set

## Minimal Deliverables Before Execution

Required before anyone starts running fixtures:

- validation program deployed on devnet under a new program ID
- IDL regenerated or harness pointed at the validation program ID
- protocol initialized with the exact values above
- bid marketplace initialized with the exact values above
- zk config initialized with the exact validation image ID
- six fixture agents registered and funded
- proof fixture or prover path ready for `DV-03E`

## Practical Recommendation

If the goal is speed, do exactly this:

1. create a validation-only branch that changes only the three timing defaults
2. deploy it under a new devnet program ID
3. initialize protocol and marketplace with the values in this document
4. use `deadline = 0` for `DV-05`
5. use three arbiter agents for all `DV-07*` and `DV-08*`
6. record the validation program ID next to the final evidence bundles

That is the smallest honest change set that turns the current external blockers into runnable scenarios.
