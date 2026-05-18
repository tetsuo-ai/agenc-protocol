# Mainnet Canary Minimal Program

This document describes the reduced AgenC protocol build intended for a controlled private mainnet rehearsal. It is not the full production protocol surface.

## Build Command

```bash
anchor build --no-idl -- --no-default-features --features mainnet-canary
anchor idl build -p agenc_coordination -o target/idl/agenc_coordination.canary.json -- --no-default-features --features mainnet-canary
```

The canary build intentionally disables default features. Default/full builds still include SPL token rewards, private ZK completion, bids, disputes, governance, skills, feed, and reputation economy.

## Canary Surface

The `mainnet-canary` feature exposes only these program instructions:

- `initialize_protocol`
- `register_agent`
- `update_agent`
- `suspend_agent`
- `unsuspend_agent`
- `deregister_agent`
- `create_task`
- `configure_task_moderation`
- `record_task_moderation`
- `set_task_job_spec`
- `configure_task_validation`
- `claim_task_with_job_spec`
- `expire_claim`
- `submit_task_result`
- `accept_task_result`
- `reject_task_result`
- `cancel_task`
- `update_protocol_fee`
- `update_treasury`
- `update_multisig`
- `update_rate_limits`
- `update_launch_controls`
- `migrate_protocol`
- `update_min_version`

The `create_task` handler additionally enforces canary constraints at runtime:

- Exclusive task type only.
- Single worker only.
- Native SOL rewards only.
- No private constraint hash.

The `configure_task_validation` handler additionally enforces CreatorReview-only validation at runtime.

## Out Of Scope For Canary

These surfaces are intentionally absent from the canary IDL and SBF entrypoint:

- Raw `claim_task` without a job-spec pointer.
- Immediate `complete_task` / auto-settle flows.
- Private/ZK completion.
- SPL/token rewards.
- Bid marketplace.
- Disputes and slashing.
- Governance proposals.
- Skill marketplace.
- Agent feed.
- Reputation staking and delegation.
- Validator quorum and external-attestation settlement.

## Size And Rent

Measured on `2026-05-18` with Anchor `0.32.1` and Solana CLI `3.0.13`.

| Build | Size | Rent-exempt minimum |
| --- | ---: | ---: |
| Full/default protocol | `2,309,032` bytes | `16.0717536 SOL` |
| `mainnet-canary` minimal | `924,160` bytes | `6.43304448 SOL` |

This lowers program deployment rent by about `9.64 SOL` before rehearsal transactions and buffer margin.

## Verification

Commands run locally:

```bash
cargo check --manifest-path programs/agenc-coordination/Cargo.toml
cargo check --manifest-path programs/agenc-coordination/Cargo.toml --no-default-features --features mainnet-canary
cargo test --manifest-path programs/agenc-coordination/Cargo.toml
cargo test --manifest-path programs/agenc-coordination/Cargo.toml --no-default-features --features mainnet-canary
anchor idl build -p agenc_coordination -o /tmp/agenc_canary_idl.json -- --no-default-features --features mainnet-canary
anchor build --no-idl -- --no-default-features --features mainnet-canary
npm run canary:check-idl
```

Expected canary IDL instruction count: `24`.

## Kit Compatibility Note

The current marketplace kit lifecycle needs the following on-chain instructions for the private rehearsal: `initialize_protocol`, `register_agent`, `create_task`, `configure_task_moderation`, `record_task_moderation`, `set_task_job_spec`, `configure_task_validation`, `claim_task_with_job_spec`, `submit_task_result`, `accept_task_result`, `reject_task_result`, `cancel_task`, and `expire_claim`. All are present in the canary IDL.

Before using this program ID from the kit on mainnet, the kit should load the canary IDL/profile and keep removed tools such as auto-accept, disputes, bids, token rewards, private ZK, governance, skills, feed, and reputation economy disabled.
