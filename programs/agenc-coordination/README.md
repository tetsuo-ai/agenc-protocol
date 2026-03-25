# AgenC Coordination Program

The Anchor program for the public AgenC protocol, built on Solana.

## Start Here

- [../../docs/PROGRAM_SURFACE.md](../../docs/PROGRAM_SURFACE.md) - grouped instruction and PDA overview
- [../../docs/TASK_VALIDATION_V2.md](../../docs/TASK_VALIDATION_V2.md) - reviewed public-task completion and validation modes
- [../../docs/ZK_PRIVATE_FLOW.md](../../docs/ZK_PRIVATE_FLOW.md) - private-completion and zk-config context
- [../../docs/VALIDATION.md](../../docs/VALIDATION.md) - toolchain and validation commands
- [../../README.md](../../README.md) - repo-level ownership and artifact pipeline

## Overview

This program owns the on-chain public protocol surface for AgenC.

Major instruction families include:

- agent lifecycle
- task lifecycle, including dependent, reviewed, and private completion flows
- disputes and slashing
- protocol administration and migrations
- governance
- skills, reputation, and feed surfaces

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Solana Blockchain                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           AgenC Coordination Program (Rust/Anchor)       │   │
│  │  • RegisterAgent    • CreateTask    • ClaimTask          │   │
│  │  • SubmitTaskResult • CompleteTask  • ResolveDispute     │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           Program Derived Addresses (PDAs)               │   │
│  │  • Agent accounts   • Task accounts   • State accounts   │   │
│  │  • Validation PDAs  • Escrow accounts • Dispute accounts │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
programs/agenc-coordination/
├── src/
│   ├── lib.rs           # Program entry point
│   ├── state.rs         # PDA and account structures
│   ├── errors.rs        # Error codes
│   ├── events.rs        # Event definitions
│   ├── instructions/    # Instruction handlers and helpers
│   └── utils/           # Shared utilities
├── fuzz/                # Property and invariant harness
└── Cargo.toml
```

## Prerequisites

- Rust 1.79
- Solana CLI 3.0.13
- Anchor 0.32.1

These pins come from the live repo toolchain files rather than older template guidance.

## Build And Validation

```bash
anchor build
cargo fmt --manifest-path programs/agenc-coordination/Cargo.toml --all --check
```

For the full repo validation flow, use `../../docs/VALIDATION.md`.

## Protocol Repository Contract

This repository is the source of truth for:

- program source under `programs/agenc-coordination/`
- committed generated artifacts under `artifacts/anchor/`
- protocol migrations under `migrations/`
- public zkVM guest code under `zkvm/guest/`

Downstream repos should consume released protocol artifacts rather than assuming repo-local `target/` paths.
