# ZK Private Flow

This file documents the protocol-owned private-completion and zk-config surfaces.

## Launch Scope

- Live revision 5 (deployed 2026-07-22) removes `complete_task_private`,
  `initialize_zk_config`, and `update_zk_image_id` from the 101-instruction
  production IDL. `ZkConfig` is **NOT initialized** on mainnet.
- Those three instructions exist only in the explicit, unsupported
  104-instruction `private-zk` development build; release preflight rejects that
  feature for production. Revision 4 had the entrypoints in the binary but they
  were unusable because `ZkConfig` was never initialized.
- Mainnet settlement uses the public and reviewed (Task Validation V2) flows only.
- Even in the `private-zk` development build, `initialize_zk_config` and
  `update_zk_image_id` call `reject_zk_activation()` and always return
  `PrivateTaskCreationDisabled`. Multisig is not a launch switch. A future
  mainnet ZK launch requires a new reviewed production revision, a real RISC
  Zero guest (this repo's `zkvm/guest` is only the 192-byte journal layout),
  verifier/prover policy, coordinated clients, and a separately approved
  upgrade.

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
- `zkvm/guest/src/lib.rs` (journal field layout only; not an auditable RISC Zero guest binary)
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

- proving-server implementation belongs in `agenc-prover` (outside this repo)
- client helpers for marketplace consumers live in
  `@tetsuo-ai/marketplace-sdk` (`packages/sdk-ts`)
- host-side runtime/operator planes live outside this repo (`agenc-core` is a
  historical sibling name, not a current package)

This repo is the source of truth for the public contract those repos must consume.
