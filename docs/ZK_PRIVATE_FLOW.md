# ZK Private Flow

This file documents the protocol-owned private-completion and zk-config surfaces.

## Launch Scope

- The private zk completion path is part of the protocol surface, but it is not included in the
  first mainnet release.
- The first mainnet release uses the public settlement and review flows only.
- Mainnet rollout of `complete_task_private` is deferred until the H200-backed prover path and the
  zk image-id rotation procedure are validated end to end.

## DV-03E Runner Inputs

Use the protocol-owned rehearsal entrypoint when prover infrastructure is available:

`npm run devnet:marketplace:scenario -- --scenario DV-03E --config scripts/marketplace-devnet.config.example.json`

- put rpc, idl, wallet, and non-secret prover defaults under `scenarioRunner`
- use `scenarioRunner.prover.apiKeyEnvVar` when operators want a DV-03E-specific secret name
- keep in mind that `AGENC_PROVER_ENDPOINT`, `AGENC_PROVER_API_KEY`,
  `AGENC_PROVER_HEADERS_JSON`, and `AGENC_PROVER_TIMEOUT_MS` override config values
- do not mark DV-03E green until the captured artifact bundle proves `complete_task_private`
  against the active validation deployment image ID

## Repo-Owned Pieces

- `programs/agenc-coordination/src/instructions/complete_task_private.rs`
- `programs/agenc-coordination/src/instructions/initialize_zk_config.rs`
- `programs/agenc-coordination/src/instructions/update_zk_image_id.rs`
- `zkvm/guest/src/lib.rs`
- `scripts/idl/verifier_router.json`

## Journal Layout

`zkvm/guest/src/lib.rs` defines a fixed 192-byte journal:

- 6 fields
- 32 bytes per field
- `task_pda`
- `agent_authority`
- `constraint_hash`
- `output_commitment`
- `binding`
- `nullifier`

## Protocol Responsibilities

- define the on-chain private-completion instruction surface
- define the zk-config state that pins trusted image data
- publish verifier-router support artifacts needed by downstream consumers

## Cross-Repo Boundaries

- proving-server implementation belongs in `agenc-prover`
- client-side helper flows belong in `agenc-sdk`
- runtime/operator orchestration belongs in `agenc-core`

This repo is the source of truth for the public contract those repos must consume.
