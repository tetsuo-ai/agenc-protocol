# ZK Private Flow

This file documents the protocol-owned private-completion and zk-config surfaces.

## Launch Scope

- Deployed revision 4 contains the three private-ZK entrypoints, but they are not
  usable on mainnet: `ZkConfig` is **NOT initialized** there.
- The pending revision-5 production build goes further and removes
  `complete_task_private`, `initialize_zk_config`, and `update_zk_image_id` from
  its 98-instruction IDL. They exist only in the explicit, unsupported
  101-instruction `private-zk` development build; release preflight rejects that
  feature for production.
- Mainnet settlement uses the public and reviewed (Task Validation V2) flows only.
- `initialize_zk_config` is **multisig-gated** (audit H-5), matching
  `update_zk_image_id`, inside the quarantined development surface. That guard is
  necessary defense in depth; it is not permission to deploy the feature. A future
  mainnet ZK launch requires a new reviewed production revision, verifier/prover
  policy, coordinated clients, and a separately approved upgrade.

## DV-03E Runner Inputs

Use the protocol-owned rehearsal entrypoint with an explicit `private-zk`
validation deployment when prover infrastructure is available:

`npm run devnet:marketplace:scenario -- --scenario DV-03E --config scripts/marketplace-devnet.config.example.json`

- put rpc, idl, wallet, and non-secret prover defaults under `scenarioRunner`
- use `scenarioRunner.prover.apiKeyEnvVar` when operators want a DV-03E-specific secret name
- keep in mind that `AGENC_PROVER_ENDPOINT`, `AGENC_PROVER_API_KEY`,
  `AGENC_PROVER_HEADERS_JSON`, and `AGENC_PROVER_TIMEOUT_MS` override config values
- do not mark DV-03E green until the captured artifact bundle proves
  `complete_task_private` against the active private-ZK validation deployment
  image ID; this evidence does not make the build production-releasable

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

- define the quarantined development-only private-completion instruction surface
- define the zk-config state that pins trusted image data
- publish verifier-router support artifacts needed by downstream consumers

## Cross-Repo Boundaries

- proving-server implementation belongs in `agenc-prover`
- client-side helper flows belong in `agenc-sdk`
- runtime/operator orchestration belongs in `agenc-core`

This repo is the source of truth for the public contract those repos must consume.
