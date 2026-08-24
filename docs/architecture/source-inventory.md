# Tracked source inventory

This is the exact `git ls-files` inventory at commit `1765a2eaf146d9abe6e252dfdcdf9ebf2d1b636f`. It contains 1,273 baseline paths, each exactly once. The disposition is architectural: generated and test files are still part of the repository contract, but they are not counted as handwritten production implementation.

Classification order is generated output; tests/examples/fuzz/model inputs; documentation/evidence; handwritten runtime/operations; build/policy/configuration; then other metadata. A path matching more than one rule appears in the first applicable group.

## Handwritten runtime and operations (379)

### `migrations`

- `migrations/migration_utils.ts`
- `migrations/v1_to_v2.rs`

### `packages/agenc-cli`

- `packages/agenc-cli/src/bin.ts`
- `packages/agenc-cli/src/bots.ts`
- `packages/agenc-cli/src/cli.ts`
- `packages/agenc-cli/src/config.ts`
- `packages/agenc-cli/src/detect.ts`
- `packages/agenc-cli/src/dev.ts`
- `packages/agenc-cli/src/gpa-sim.ts`
- `packages/agenc-cli/src/index.ts`
- `packages/agenc-cli/src/init.ts`
- `packages/agenc-cli/src/localnet.ts`
- `packages/agenc-cli/src/promote.ts`
- `packages/agenc-cli/src/sandbox.ts`
- `packages/agenc-cli/src/split.ts`
- `packages/agenc-cli/src/templates.ts`

### `packages/agenc-cli-alias`

- `packages/agenc-cli-alias/bin/agenc-cli.js`

### `packages/agenc-worker`

- `packages/agenc-worker/src/account-reader.ts`
- `packages/agenc-worker/src/cli.ts`
- `packages/agenc-worker/src/config.ts`
- `packages/agenc-worker/src/executor.ts`
- `packages/agenc-worker/src/index.ts`
- `packages/agenc-worker/src/job-spec.ts`
- `packages/agenc-worker/src/redact.ts`
- `packages/agenc-worker/src/result.ts`
- `packages/agenc-worker/src/runtime.ts`
- `packages/agenc-worker/src/settlement.ts`
- `packages/agenc-worker/src/state.ts`
- `packages/agenc-worker/src/wallet.ts`
- `packages/agenc-worker/templates/launchd/ai.tetsuo.agenc-worker.plist`
- `packages/agenc-worker/templates/systemd/agenc-worker.service`
- `packages/agenc-worker/templates/systemd/agenc-worker.timer`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/src/bin.ts`
- `packages/marketplace-mcp/src/config.ts`
- `packages/marketplace-mcp/src/context.ts`
- `packages/marketplace-mcp/src/index.ts`
- `packages/marketplace-mcp/src/redact.ts`
- `packages/marketplace-mcp/src/server.ts`

### `packages/marketplace-moderation`

- `packages/marketplace-moderation/src/index.ts`

### `packages/marketplace-react`

- `packages/marketplace-react/src/components/DisputeBanner.tsx`
- `packages/marketplace-react/src/components/GuaranteedBadge.tsx`
- `packages/marketplace-react/src/components/HireButton.tsx`
- `packages/marketplace-react/src/components/HireCheckoutModal.tsx`
- `packages/marketplace-react/src/components/ListingCard.tsx`
- `packages/marketplace-react/src/components/ListingGrid.tsx`
- `packages/marketplace-react/src/components/Modal.tsx`
- `packages/marketplace-react/src/components/PoweredByAgenC.tsx`
- `packages/marketplace-react/src/components/ProviderCard.tsx`
- `packages/marketplace-react/src/components/ReferrerDisclosure.tsx`
- `packages/marketplace-react/src/components/ReviewPanel.tsx`
- `packages/marketplace-react/src/components/TaskTimeline.tsx`
- `packages/marketplace-react/src/components/agenc-components.css`
- `packages/marketplace-react/src/components/badges.tsx`
- `packages/marketplace-react/src/components/format.ts`
- `packages/marketplace-react/src/components/index.ts`
- `packages/marketplace-react/src/components/primitives.tsx`
- `packages/marketplace-react/src/components/strings.ts`
- `packages/marketplace-react/src/components/useAgentVerification.ts`
- `packages/marketplace-react/src/components/useFocusTrap.ts`
- `packages/marketplace-react/src/hooks/index.ts`
- `packages/marketplace-react/src/hooks/internal.ts`
- `packages/marketplace-react/src/hooks/moderation-attestor.ts`
- `packages/marketplace-react/src/hooks/useAgentTrackRecord.ts`
- `packages/marketplace-react/src/hooks/useCompletionBond.ts`
- `packages/marketplace-react/src/hooks/useDispute.ts`
- `packages/marketplace-react/src/hooks/useHire.ts`
- `packages/marketplace-react/src/hooks/useHumanlessHireFlow.ts`
- `packages/marketplace-react/src/hooks/useListing.ts`
- `packages/marketplace-react/src/hooks/useListings.ts`
- `packages/marketplace-react/src/hooks/useRateHire.ts`
- `packages/marketplace-react/src/hooks/useReferrerEarnings.ts`
- `packages/marketplace-react/src/hooks/useSubmissionReview.ts`
- `packages/marketplace-react/src/hooks/useTaskActivation.ts`
- `packages/marketplace-react/src/hooks/useTaskGuarantee.ts`
- `packages/marketplace-react/src/hooks/useTaskLifecycle.ts`
- `packages/marketplace-react/src/hooks/useTaskStatus.ts`
- `packages/marketplace-react/src/hooks/useTaskWork.ts`
- `packages/marketplace-react/src/hooks/useWalletSigner.ts`
- `packages/marketplace-react/src/index.ts`
- `packages/marketplace-react/src/provider/AgencProvider.tsx`
- `packages/marketplace-react/src/provider/context.ts`
- `packages/marketplace-react/src/provider/index.ts`
- `packages/marketplace-react/src/provider/network.ts`
- `packages/marketplace-react/src/provider/referrer.ts`
- `packages/marketplace-react/src/signers/embedded-wallet-mock.ts`
- `packages/marketplace-react/src/signers/embedded-wallet.ts`
- `packages/marketplace-react/src/signers/index.ts`
- `packages/marketplace-react/src/signers/strings.ts`
- `packages/marketplace-react/src/signers/types.ts`
- `packages/marketplace-react/src/signers/wallet-account.ts`
- `packages/marketplace-react/src/signers/wallet-adapter.ts`
- `packages/marketplace-react/src/strings/index.ts`
- `packages/marketplace-react/src/testing/index.ts`
- `packages/marketplace-react/src/theme/agenc-tailwind-preset.cjs`
- `packages/marketplace-react/src/theme/agenc-tokens.css`
- `packages/marketplace-react/src/theme/index.ts`
- `packages/marketplace-react/src/transport/index.ts`
- `packages/marketplace-react/src/types.ts`

### `packages/marketplace-tools`

- `packages/marketplace-tools/src/adapters.ts`
- `packages/marketplace-tools/src/agent-card.ts`
- `packages/marketplace-tools/src/index.ts`
- `packages/marketplace-tools/src/project.ts`
- `packages/marketplace-tools/src/tools/index.ts`
- `packages/marketplace-tools/src/tools/prepare.ts`
- `packages/marketplace-tools/src/tools/readonly.ts`
- `packages/marketplace-tools/src/tools/schema.ts`
- `packages/marketplace-tools/src/types.ts`

### `packages/protocol`

- `packages/protocol/scripts/pack-smoke.mjs`
- `packages/protocol/src/index.ts`

### `packages/sdk-ts`

- `packages/sdk-ts/scripts/drift-check.mjs`
- `packages/sdk-ts/scripts/generate-events.mjs`
- `packages/sdk-ts/scripts/generate.mjs`
- `packages/sdk-ts/scripts/pack-smoke.mjs`
- `packages/sdk-ts/scripts/sbf-profile.mjs`
- `packages/sdk-ts/scripts/seed-devnet-sandbox.d.mts`
- `packages/sdk-ts/scripts/seed-devnet-sandbox.mjs`
- `packages/sdk-ts/scripts/sync-testing-so.mjs`
- `packages/sdk-ts/src/client/client.ts`
- `packages/sdk-ts/src/client/compute-budget.ts`
- `packages/sdk-ts/src/client/errors.ts`
- `packages/sdk-ts/src/client/index.ts`
- `packages/sdk-ts/src/client/signer-identity.ts`
- `packages/sdk-ts/src/client/transport.ts`
- `packages/sdk-ts/src/delivery/crypto.ts`
- `packages/sdk-ts/src/delivery/index.ts`
- `packages/sdk-ts/src/delivery/manifest.ts`
- `packages/sdk-ts/src/events/index.ts`
- `packages/sdk-ts/src/events/internal.ts`
- `packages/sdk-ts/src/events/parse.ts`
- `packages/sdk-ts/src/events/subscribe.ts`
- `packages/sdk-ts/src/events/wait.ts`
- `packages/sdk-ts/src/facade/agents.ts`
- `packages/sdk-ts/src/facade/bids.ts`
- `packages/sdk-ts/src/facade/bonds.ts`
- `packages/sdk-ts/src/facade/disputes.ts`
- `packages/sdk-ts/src/facade/goods.ts`
- `packages/sdk-ts/src/facade/governance.ts`
- `packages/sdk-ts/src/facade/index.ts`
- `packages/sdk-ts/src/facade/listings.ts`
- `packages/sdk-ts/src/facade/moderation.ts`
- `packages/sdk-ts/src/facade/reputation.ts`
- `packages/sdk-ts/src/facade/stores.ts`
- `packages/sdk-ts/src/facade/surface.ts`
- `packages/sdk-ts/src/facade/tasks.ts`
- `packages/sdk-ts/src/facade/verification.ts`
- `packages/sdk-ts/src/facade/wire.ts`
- `packages/sdk-ts/src/history/index.ts`
- `packages/sdk-ts/src/history/marketplace-write.ts`
- `packages/sdk-ts/src/index.ts`
- `packages/sdk-ts/src/indexer/client.ts`
- `packages/sdk-ts/src/indexer/errors.ts`
- `packages/sdk-ts/src/indexer/index.ts`
- `packages/sdk-ts/src/orchestration/hire-and-activate.ts`
- `packages/sdk-ts/src/orchestration/index.ts`
- `packages/sdk-ts/src/orchestration/moderation-accounts.ts`
- `packages/sdk-ts/src/queries/helpers.ts`
- `packages/sdk-ts/src/queries/index.ts`
- `packages/sdk-ts/src/queries/offsets.ts`
- `packages/sdk-ts/src/queries/transport.ts`
- `packages/sdk-ts/src/receipt.ts`
- `packages/sdk-ts/src/sandbox/attest.ts`
- `packages/sdk-ts/src/sandbox/client.ts`
- `packages/sdk-ts/src/sandbox/environment.ts`
- `packages/sdk-ts/src/sandbox/fixtures.json`
- `packages/sdk-ts/src/sandbox/fixtures.ts`
- `packages/sdk-ts/src/sandbox/index.ts`
- `packages/sdk-ts/src/sandbox/moderation.ts`
- `packages/sdk-ts/src/task-thread/client.ts`
- `packages/sdk-ts/src/task-thread/envelope.ts`
- `packages/sdk-ts/src/task-thread/index.ts`
- `packages/sdk-ts/src/task-thread/transport.ts`
- `packages/sdk-ts/src/testing/index.ts`
- `packages/sdk-ts/src/testing/litesvm-peer.ts`
- `packages/sdk-ts/src/testing/litesvm-transport.ts`
- `packages/sdk-ts/src/testing/local-marketplace.ts`
- `packages/sdk-ts/src/testing/program-asset.ts`
- `packages/sdk-ts/src/testing/seed.ts`
- `packages/sdk-ts/src/values/agent-metadata.ts`
- `packages/sdk-ts/src/values/categories.ts`
- `packages/sdk-ts/src/values/fixed-bytes.ts`
- `packages/sdk-ts/src/values/hash.ts`
- `packages/sdk-ts/src/values/index.ts`
- `packages/sdk-ts/src/values/job-spec.ts`
- `packages/sdk-ts/src/values/listing.ts`
- `packages/sdk-ts/src/values/options.ts`
- `packages/sdk-ts/src/values/protocol-limits.ts`
- `packages/sdk-ts/src/values/random.ts`
- `packages/sdk-ts/src/values/store.ts`
- `packages/sdk-ts/src/values/structured-clone.ts`
- `packages/sdk-ts/src/watch/index.ts`
- `packages/sdk-ts/src/watch/watch.ts`
- `packages/sdk-ts/src/webhooks/index.ts`
- `packages/sdk-ts/src/webhooks/verify.ts`

### `programs/agenc-coordination`

- `programs/agenc-coordination/src/errors.rs`
- `programs/agenc-coordination/src/events.rs`
- `programs/agenc-coordination/src/instructions/accept_task_result.rs`
- `programs/agenc-coordination/src/instructions/agent_stats_helpers.rs`
- `programs/agenc-coordination/src/instructions/apply_dispute_slash.rs`
- `programs/agenc-coordination/src/instructions/apply_initiator_slash.rs`
- `programs/agenc-coordination/src/instructions/assign_dispute_resolver.rs`
- `programs/agenc-coordination/src/instructions/assign_moderation_attestor.rs`
- `programs/agenc-coordination/src/instructions/attestor_exit.rs`
- `programs/agenc-coordination/src/instructions/auto_accept_task_result.rs`
- `programs/agenc-coordination/src/instructions/bid_marketplace.rs`
- `programs/agenc-coordination/src/instructions/bid_settlement_helpers.rs`
- `programs/agenc-coordination/src/instructions/bond_helpers.rs`
- `programs/agenc-coordination/src/instructions/cancel_dispute.rs`
- `programs/agenc-coordination/src/instructions/cancel_proposal.rs`
- `programs/agenc-coordination/src/instructions/cancel_task.rs`
- `programs/agenc-coordination/src/instructions/claim_task.rs`
- `programs/agenc-coordination/src/instructions/close_task.rs`
- `programs/agenc-coordination/src/instructions/complete_task.rs`
- `programs/agenc-coordination/src/instructions/complete_task_private.rs`
- `programs/agenc-coordination/src/instructions/completion_helpers.rs`
- `programs/agenc-coordination/src/instructions/configure_task_moderation.rs`
- `programs/agenc-coordination/src/instructions/configure_task_validation.rs`
- `programs/agenc-coordination/src/instructions/constants.rs`
- `programs/agenc-coordination/src/instructions/create_dependent_task.rs`
- `programs/agenc-coordination/src/instructions/create_goods_listing.rs`
- `programs/agenc-coordination/src/instructions/create_proposal.rs`
- `programs/agenc-coordination/src/instructions/create_service_listing.rs`
- `programs/agenc-coordination/src/instructions/create_task.rs`
- `programs/agenc-coordination/src/instructions/create_task_humanless.rs`
- `programs/agenc-coordination/src/instructions/delegate_reputation.rs`
- `programs/agenc-coordination/src/instructions/deregister_agent.rs`
- `programs/agenc-coordination/src/instructions/dispute_helpers.rs`
- `programs/agenc-coordination/src/instructions/distribute_ghost_share.rs`
- `programs/agenc-coordination/src/instructions/execute_proposal.rs`
- `programs/agenc-coordination/src/instructions/expire_claim.rs`
- `programs/agenc-coordination/src/instructions/expire_dispute.rs`
- `programs/agenc-coordination/src/instructions/hire_from_listing.rs`
- `programs/agenc-coordination/src/instructions/hire_from_listing_humanless.rs`
- `programs/agenc-coordination/src/instructions/initialize_governance.rs`
- `programs/agenc-coordination/src/instructions/initialize_protocol.rs`
- `programs/agenc-coordination/src/instructions/initialize_zk_config.rs`
- `programs/agenc-coordination/src/instructions/initiate_dispute.rs`
- `programs/agenc-coordination/src/instructions/lamport_transfer.rs`
- `programs/agenc-coordination/src/instructions/launch_controls.rs`
- `programs/agenc-coordination/src/instructions/migrate.rs`
- `programs/agenc-coordination/src/instructions/mod.rs`
- `programs/agenc-coordination/src/instructions/moderation_block.rs`
- `programs/agenc-coordination/src/instructions/moderation_gate_helpers.rs`
- `programs/agenc-coordination/src/instructions/moderation_heartbeat.rs`
- `programs/agenc-coordination/src/instructions/post_completion_bond.rs`
- `programs/agenc-coordination/src/instructions/post_to_feed.rs`
- `programs/agenc-coordination/src/instructions/program_account_helpers.rs`
- `programs/agenc-coordination/src/instructions/purchase_good.rs`
- `programs/agenc-coordination/src/instructions/purchase_skill.rs`
- `programs/agenc-coordination/src/instructions/rate_hire.rs`
- `programs/agenc-coordination/src/instructions/rate_limit_helpers.rs`
- `programs/agenc-coordination/src/instructions/rate_skill.rs`
- `programs/agenc-coordination/src/instructions/reclaim_completion_bond.rs`
- `programs/agenc-coordination/src/instructions/reclaim_orphan_task_child.rs`
- `programs/agenc-coordination/src/instructions/reclaim_terminal_claim.rs`
- `programs/agenc-coordination/src/instructions/record_agent_verification.rs`
- `programs/agenc-coordination/src/instructions/record_listing_moderation.rs`
- `programs/agenc-coordination/src/instructions/record_task_moderation.rs`
- `programs/agenc-coordination/src/instructions/register_agent.rs`
- `programs/agenc-coordination/src/instructions/register_moderation_attestor.rs`
- `programs/agenc-coordination/src/instructions/register_skill.rs`
- `programs/agenc-coordination/src/instructions/reject_and_freeze.rs`
- `programs/agenc-coordination/src/instructions/reject_frozen_exits.rs`
- `programs/agenc-coordination/src/instructions/reject_task_result.rs`
- `programs/agenc-coordination/src/instructions/request_changes.rs`
- `programs/agenc-coordination/src/instructions/resolve_dispute.rs`
- `programs/agenc-coordination/src/instructions/revoke_agent_verification.rs`
- `programs/agenc-coordination/src/instructions/revoke_delegation.rs`
- `programs/agenc-coordination/src/instructions/revoke_dispute_resolver.rs`
- `programs/agenc-coordination/src/instructions/revoke_moderation_attestor.rs`
- `programs/agenc-coordination/src/instructions/set_default_trust_list.rs`
- `programs/agenc-coordination/src/instructions/set_service_listing_state.rs`
- `programs/agenc-coordination/src/instructions/set_task_job_spec.rs`
- `programs/agenc-coordination/src/instructions/settle_dispute_claim.rs`
- `programs/agenc-coordination/src/instructions/slash_helpers.rs`
- `programs/agenc-coordination/src/instructions/stake_reputation.rs`
- `programs/agenc-coordination/src/instructions/stamp_release_surface.rs`
- `programs/agenc-coordination/src/instructions/store_identity.rs`
- `programs/agenc-coordination/src/instructions/submit_task_result.rs`
- `programs/agenc-coordination/src/instructions/suspend_agent.rs`
- `programs/agenc-coordination/src/instructions/task_init_helpers.rs`
- `programs/agenc-coordination/src/instructions/task_parent_helpers.rs`
- `programs/agenc-coordination/src/instructions/task_validation_helpers.rs`
- `programs/agenc-coordination/src/instructions/token_helpers.rs`
- `programs/agenc-coordination/src/instructions/unsuspend_agent.rs`
- `programs/agenc-coordination/src/instructions/update_agent.rs`
- `programs/agenc-coordination/src/instructions/update_goods_listing.rs`
- `programs/agenc-coordination/src/instructions/update_launch_controls.rs`
- `programs/agenc-coordination/src/instructions/update_multisig.rs`
- `programs/agenc-coordination/src/instructions/update_protocol_fee.rs`
- `programs/agenc-coordination/src/instructions/update_rate_limits.rs`
- `programs/agenc-coordination/src/instructions/update_service_listing.rs`
- `programs/agenc-coordination/src/instructions/update_skill.rs`
- `programs/agenc-coordination/src/instructions/update_state.rs`
- `programs/agenc-coordination/src/instructions/update_treasury.rs`
- `programs/agenc-coordination/src/instructions/update_zk_image_id.rs`
- `programs/agenc-coordination/src/instructions/upvote_post.rs`
- `programs/agenc-coordination/src/instructions/validate_task_result.rs`
- `programs/agenc-coordination/src/instructions/validation.rs`
- `programs/agenc-coordination/src/instructions/vote_proposal.rs`
- `programs/agenc-coordination/src/instructions/withdraw_reputation_stake.rs`
- `programs/agenc-coordination/src/instructions/zk_config_helpers.rs`
- `programs/agenc-coordination/src/lib.rs`
- `programs/agenc-coordination/src/private_completion_payload.rs`
- `programs/agenc-coordination/src/state.rs`
- `programs/agenc-coordination/src/utils/borsh.rs`
- `programs/agenc-coordination/src/utils/compute_budget.rs`
- `programs/agenc-coordination/src/utils/mod.rs`
- `programs/agenc-coordination/src/utils/multisig.rs`
- `programs/agenc-coordination/src/utils/validation.rs`
- `programs/agenc-coordination/src/utils/version.rs`

### `scripts`

- `scripts/anchor-idl-publication.mjs`
- `scripts/audit-tests-integration.mjs`
- `scripts/canary-idl-baseline.json`
- `scripts/check-canary-idl.mjs`
- `scripts/check-coverage.mjs`
- `scripts/check-idl-reference.mjs`
- `scripts/check-mainnet-program-artifacts.mjs`
- `scripts/check-npm-install-scripts.mjs`
- `scripts/check-npm-licenses.mjs`
- `scripts/check-rust-supply-chain-policy.mjs`
- `scripts/check-stack-frames.mjs`
- `scripts/credible-exit.mjs`
- `scripts/enterprise-readiness.mjs`
- `scripts/env-flags.mjs`
- `scripts/generate-idl-reference.mjs`
- `scripts/goods-purchase-watcher.mjs`
- `scripts/idl/verifier_router.json`
- `scripts/localnet-down.mjs`
- `scripts/localnet-guarded-spawn.mjs`
- `scripts/localnet-lifecycle-lock.mjs`
- `scripts/localnet-marketplace-policy.mjs`
- `scripts/localnet-process-identity.mjs`
- `scripts/localnet-process-signal.mjs`
- `scripts/localnet-program-binding.mjs`
- `scripts/localnet-program-snapshot.mjs`
- `scripts/localnet-record-attestor.mjs`
- `scripts/localnet-status.mjs`
- `scripts/localnet-up.mjs`
- `scripts/localnet-validator-launch.mjs`
- `scripts/mainnet-fee-change.mjs`
- `scripts/mainnet-init-and-stamp.mjs`
- `scripts/mainnet-migrate-sweep.mjs`
- `scripts/mainnet-release-boundary.mjs`
- `scripts/mainnet-upgrade-authority-policy.json`
- `scripts/mainnet-upgrade.mjs`
- `scripts/mainnet-upgrade.sh`
- `scripts/marketplace-devnet-readiness.mjs`
- `scripts/marketplace-devnet-scenario-shared.mjs`
- `scripts/marketplace-devnet-scenario.mjs`
- `scripts/marketplace-devnet.config.example.json`
- `scripts/preflight-active-job-spec-block-scan.mjs`
- `scripts/preflight-bid-contract-scan.mjs`
- `scripts/preflight-delegation-scan.mjs`
- `scripts/preflight-dispute-scan.mjs`
- `scripts/preflight-governance-scan.mjs`
- `scripts/preflight-hire-provider-scan.mjs`
- `scripts/preflight-private-task-scan.mjs`
- `scripts/preflight-reject-frozen-fee-scan.mjs`
- `scripts/preflight-reputation-stake-scan.mjs`
- `scripts/preflight-skill-rating-cutover-scan.mjs`
- `scripts/preflight-task-children-scan.mjs`
- `scripts/preflight-task-dependency-scan.mjs`
- `scripts/preflight-task-settlement-scan.mjs`
- `scripts/preflight-task-validation-scan.mjs`
- `scripts/preflight-token-task-scan.mjs`
- `scripts/private-task-release-policy.mjs`
- `scripts/program-extend-mainnet.mjs`
- `scripts/program-upgrade-authority-policy.mjs`
- `scripts/release-pack-smoke.mjs`
- `scripts/release-policy.mjs`
- `scripts/release-sbom.mjs`
- `scripts/release-state.mjs`
- `scripts/sync-anchor-artifacts.mjs`
- `scripts/sync-package-protocol-assets.mjs`
- `scripts/validation-deploy-preflight.mjs`
- `scripts/validation-initialize.mjs`
- `scripts/verify-npm-provenance.mjs`
- `scripts/verify-release-tag-binding.mjs`

### `zkvm`

- `zkvm/guest/src/lib.rs`

## Generated contracts and packaged outputs (349)

### `artifacts`

- `artifacts/anchor/idl/agenc_coordination.json`
- `artifacts/anchor/manifest.json`
- `artifacts/anchor/types/agenc_coordination.ts`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/dist/bin.cjs`
- `packages/marketplace-mcp/dist/bin.d.cts`
- `packages/marketplace-mcp/dist/bin.d.ts`
- `packages/marketplace-mcp/dist/bin.js`
- `packages/marketplace-mcp/dist/chunk-FEPQZAGS.js`
- `packages/marketplace-mcp/dist/index.cjs`
- `packages/marketplace-mcp/dist/index.d.cts`
- `packages/marketplace-mcp/dist/index.d.ts`
- `packages/marketplace-mcp/dist/index.js`

### `packages/marketplace-tools`

- `packages/marketplace-tools/dist/index.cjs`
- `packages/marketplace-tools/dist/index.d.cts`
- `packages/marketplace-tools/dist/index.d.ts`
- `packages/marketplace-tools/dist/index.js`

### `packages/protocol`

- `packages/protocol/src/generated/agenc_coordination.json`
- `packages/protocol/src/generated/agenc_coordination.ts`
- `packages/protocol/src/generated/daemon-json-rpc.schema.json`
- `packages/protocol/src/generated/manifest.json`
- `packages/protocol/src/generated/verifier_router.json`

### `packages/sdk-ts`

- `packages/sdk-ts/src/generated/accounts/agentRegistration.ts`
- `packages/sdk-ts/src/generated/accounts/agentStats.ts`
- `packages/sdk-ts/src/generated/accounts/agentVerification.ts`
- `packages/sdk-ts/src/generated/accounts/authorityRateLimit.ts`
- `packages/sdk-ts/src/generated/accounts/bidMarketplaceConfig.ts`
- `packages/sdk-ts/src/generated/accounts/bidderMarketState.ts`
- `packages/sdk-ts/src/generated/accounts/completionBond.ts`
- `packages/sdk-ts/src/generated/accounts/coordinationState.ts`
- `packages/sdk-ts/src/generated/accounts/defaultTrustList.ts`
- `packages/sdk-ts/src/generated/accounts/dispute.ts`
- `packages/sdk-ts/src/generated/accounts/disputeResolver.ts`
- `packages/sdk-ts/src/generated/accounts/feedPost.ts`
- `packages/sdk-ts/src/generated/accounts/feedVote.ts`
- `packages/sdk-ts/src/generated/accounts/goodsListing.ts`
- `packages/sdk-ts/src/generated/accounts/governanceConfig.ts`
- `packages/sdk-ts/src/generated/accounts/governanceVote.ts`
- `packages/sdk-ts/src/generated/accounts/hireRating.ts`
- `packages/sdk-ts/src/generated/accounts/hireRecord.ts`
- `packages/sdk-ts/src/generated/accounts/index.ts`
- `packages/sdk-ts/src/generated/accounts/listingModeration.ts`
- `packages/sdk-ts/src/generated/accounts/moderationAttestor.ts`
- `packages/sdk-ts/src/generated/accounts/moderationBlock.ts`
- `packages/sdk-ts/src/generated/accounts/moderationConfig.ts`
- `packages/sdk-ts/src/generated/accounts/proposal.ts`
- `packages/sdk-ts/src/generated/accounts/protocolConfig.ts`
- `packages/sdk-ts/src/generated/accounts/purchaseRecord.ts`
- `packages/sdk-ts/src/generated/accounts/reputationDelegation.ts`
- `packages/sdk-ts/src/generated/accounts/reputationStake.ts`
- `packages/sdk-ts/src/generated/accounts/saleReceipt.ts`
- `packages/sdk-ts/src/generated/accounts/serviceListing.ts`
- `packages/sdk-ts/src/generated/accounts/skillRating.ts`
- `packages/sdk-ts/src/generated/accounts/skillRegistration.ts`
- `packages/sdk-ts/src/generated/accounts/store.ts`
- `packages/sdk-ts/src/generated/accounts/task.ts`
- `packages/sdk-ts/src/generated/accounts/taskAttestorConfig.ts`
- `packages/sdk-ts/src/generated/accounts/taskBid.ts`
- `packages/sdk-ts/src/generated/accounts/taskBidBook.ts`
- `packages/sdk-ts/src/generated/accounts/taskClaim.ts`
- `packages/sdk-ts/src/generated/accounts/taskEscrow.ts`
- `packages/sdk-ts/src/generated/accounts/taskJobSpec.ts`
- `packages/sdk-ts/src/generated/accounts/taskModeration.ts`
- `packages/sdk-ts/src/generated/accounts/taskSubmission.ts`
- `packages/sdk-ts/src/generated/accounts/taskValidationConfig.ts`
- `packages/sdk-ts/src/generated/accounts/taskValidationVote.ts`
- `packages/sdk-ts/src/generated/codecs/borshString.ts`
- `packages/sdk-ts/src/generated/codecs/fixedBytes.ts`
- `packages/sdk-ts/src/generated/errors/agencCoordination.ts`
- `packages/sdk-ts/src/generated/errors/index.ts`
- `packages/sdk-ts/src/generated/events/agencEvent.ts`
- `packages/sdk-ts/src/generated/events/agentDeregistered.ts`
- `packages/sdk-ts/src/generated/events/agentRegistered.ts`
- `packages/sdk-ts/src/generated/events/agentSuspended.ts`
- `packages/sdk-ts/src/generated/events/agentTrackRecordUpdated.ts`
- `packages/sdk-ts/src/generated/events/agentUnsuspended.ts`
- `packages/sdk-ts/src/generated/events/agentUpdated.ts`
- `packages/sdk-ts/src/generated/events/agentVerificationRevoked.ts`
- `packages/sdk-ts/src/generated/events/agentVerified.ts`
- `packages/sdk-ts/src/generated/events/attestorExitFinalized.ts`
- `packages/sdk-ts/src/generated/events/attestorExitRequested.ts`
- `packages/sdk-ts/src/generated/events/bidAccepted.ts`
- `packages/sdk-ts/src/generated/events/bidBookInitialized.ts`
- `packages/sdk-ts/src/generated/events/bidCancelled.ts`
- `packages/sdk-ts/src/generated/events/bidCreated.ts`
- `packages/sdk-ts/src/generated/events/bidExpired.ts`
- `packages/sdk-ts/src/generated/events/bidMarketplaceInitialized.ts`
- `packages/sdk-ts/src/generated/events/bidPromoted.ts`
- `packages/sdk-ts/src/generated/events/bidUpdated.ts`
- `packages/sdk-ts/src/generated/events/bidWinnerDemoted.ts`
- `packages/sdk-ts/src/generated/events/bondForfeited.ts`
- `packages/sdk-ts/src/generated/events/bondPosted.ts`
- `packages/sdk-ts/src/generated/events/bondRefunded.ts`
- `packages/sdk-ts/src/generated/events/contestDepositForfeited.ts`
- `packages/sdk-ts/src/generated/events/defaultTrustListUpdated.ts`
- `packages/sdk-ts/src/generated/events/dependentTaskCreated.ts`
- `packages/sdk-ts/src/generated/events/disputeCancelled.ts`
- `packages/sdk-ts/src/generated/events/disputeExpired.ts`
- `packages/sdk-ts/src/generated/events/disputeInitiated.ts`
- `packages/sdk-ts/src/generated/events/disputePeerClaimSettled.ts`
- `packages/sdk-ts/src/generated/events/disputeResolved.ts`
- `packages/sdk-ts/src/generated/events/disputeResolverAssigned.ts`
- `packages/sdk-ts/src/generated/events/disputeResolverRevoked.ts`
- `packages/sdk-ts/src/generated/events/ghostShareDistributed.ts`
- `packages/sdk-ts/src/generated/events/goodPurchased.ts`
- `packages/sdk-ts/src/generated/events/goodsListingCreated.ts`
- `packages/sdk-ts/src/generated/events/goodsListingUpdated.ts`
- `packages/sdk-ts/src/generated/events/governanceInitialized.ts`
- `packages/sdk-ts/src/generated/events/governanceVoteCast.ts`
- `packages/sdk-ts/src/generated/events/index.ts`
- `packages/sdk-ts/src/generated/events/launchControlsUpdated.ts`
- `packages/sdk-ts/src/generated/events/listingModerationRecorded.ts`
- `packages/sdk-ts/src/generated/events/listingRated.ts`
- `packages/sdk-ts/src/generated/events/migrationCompleted.ts`
- `packages/sdk-ts/src/generated/events/moderationAttestorAssigned.ts`
- `packages/sdk-ts/src/generated/events/moderationAttestorRegistered.ts`
- `packages/sdk-ts/src/generated/events/moderationAttestorRevoked.ts`
- `packages/sdk-ts/src/generated/events/moderationBlockCleared.ts`
- `packages/sdk-ts/src/generated/events/moderationBlockSet.ts`
- `packages/sdk-ts/src/generated/events/moderationHeartbeatRecorded.ts`
- `packages/sdk-ts/src/generated/events/multisigUpdated.ts`
- `packages/sdk-ts/src/generated/events/operatorFeePaid.ts`
- `packages/sdk-ts/src/generated/events/orphanTaskChildReclaimed.ts`
- `packages/sdk-ts/src/generated/events/postCreated.ts`
- `packages/sdk-ts/src/generated/events/postUpvoted.ts`
- `packages/sdk-ts/src/generated/events/proposalCancelled.ts`
- `packages/sdk-ts/src/generated/events/proposalCreated.ts`
- `packages/sdk-ts/src/generated/events/proposalExecuted.ts`
- `packages/sdk-ts/src/generated/events/protocolConfigMigrated.ts`
- `packages/sdk-ts/src/generated/events/protocolFeeUpdated.ts`
- `packages/sdk-ts/src/generated/events/protocolInitialized.ts`
- `packages/sdk-ts/src/generated/events/protocolVersionUpdated.ts`
- `packages/sdk-ts/src/generated/events/rateLimitHit.ts`
- `packages/sdk-ts/src/generated/events/rateLimitsUpdated.ts`
- `packages/sdk-ts/src/generated/events/referrerFeePaid.ts`
- `packages/sdk-ts/src/generated/events/rejectFrozenExpired.ts`
- `packages/sdk-ts/src/generated/events/rejectFrozenResolved.ts`
- `packages/sdk-ts/src/generated/events/releaseSurfaceStamped.ts`
- `packages/sdk-ts/src/generated/events/reputationChanged.ts`
- `packages/sdk-ts/src/generated/events/reputationDelegationRetired.ts`
- `packages/sdk-ts/src/generated/events/reputationDelegationRevoked.ts`
- `packages/sdk-ts/src/generated/events/reputationStakeWithdrawn.ts`
- `packages/sdk-ts/src/generated/events/reputationStaked.ts`
- `packages/sdk-ts/src/generated/events/rewardDistributed.ts`
- `packages/sdk-ts/src/generated/events/serviceListingCreated.ts`
- `packages/sdk-ts/src/generated/events/serviceListingHired.ts`
- `packages/sdk-ts/src/generated/events/serviceListingStateChanged.ts`
- `packages/sdk-ts/src/generated/events/serviceListingUpdated.ts`
- `packages/sdk-ts/src/generated/events/skillPurchased.ts`
- `packages/sdk-ts/src/generated/events/skillRated.ts`
- `packages/sdk-ts/src/generated/events/skillRegistered.ts`
- `packages/sdk-ts/src/generated/events/skillUpdated.ts`
- `packages/sdk-ts/src/generated/events/stateUpdated.ts`
- `packages/sdk-ts/src/generated/events/storeClosed.ts`
- `packages/sdk-ts/src/generated/events/storeRegistered.ts`
- `packages/sdk-ts/src/generated/events/storeUpdated.ts`
- `packages/sdk-ts/src/generated/events/taskCancelled.ts`
- `packages/sdk-ts/src/generated/events/taskChangesRequested.ts`
- `packages/sdk-ts/src/generated/events/taskClaimed.ts`
- `packages/sdk-ts/src/generated/events/taskClosed.ts`
- `packages/sdk-ts/src/generated/events/taskCompleted.ts`
- `packages/sdk-ts/src/generated/events/taskCreated.ts`
- `packages/sdk-ts/src/generated/events/taskJobSpecSet.ts`
- `packages/sdk-ts/src/generated/events/taskMigrated.ts`
- `packages/sdk-ts/src/generated/events/taskModerationConfigUpdated.ts`
- `packages/sdk-ts/src/generated/events/taskModerationRecorded.ts`
- `packages/sdk-ts/src/generated/events/taskRejectFrozen.ts`
- `packages/sdk-ts/src/generated/events/taskResultAccepted.ts`
- `packages/sdk-ts/src/generated/events/taskResultRejected.ts`
- `packages/sdk-ts/src/generated/events/taskResultSubmitted.ts`
- `packages/sdk-ts/src/generated/events/taskResultValidationRecorded.ts`
- `packages/sdk-ts/src/generated/events/taskValidationConfigured.ts`
- `packages/sdk-ts/src/generated/events/terminalClaimReclaimed.ts`
- `packages/sdk-ts/src/generated/events/treasuryUpdated.ts`
- `packages/sdk-ts/src/generated/index.ts`
- `packages/sdk-ts/src/generated/instructions/acceptBid.ts`
- `packages/sdk-ts/src/generated/instructions/acceptTaskResult.ts`
- `packages/sdk-ts/src/generated/instructions/applyDisputeSlash.ts`
- `packages/sdk-ts/src/generated/instructions/applyInitiatorSlash.ts`
- `packages/sdk-ts/src/generated/instructions/assignDisputeResolver.ts`
- `packages/sdk-ts/src/generated/instructions/assignModerationAttestor.ts`
- `packages/sdk-ts/src/generated/instructions/autoAcceptTaskResult.ts`
- `packages/sdk-ts/src/generated/instructions/cancelBid.ts`
- `packages/sdk-ts/src/generated/instructions/cancelDispute.ts`
- `packages/sdk-ts/src/generated/instructions/cancelProposal.ts`
- `packages/sdk-ts/src/generated/instructions/cancelTask.ts`
- `packages/sdk-ts/src/generated/instructions/claimTask.ts`
- `packages/sdk-ts/src/generated/instructions/claimTaskWithJobSpec.ts`
- `packages/sdk-ts/src/generated/instructions/clearModerationBlock.ts`
- `packages/sdk-ts/src/generated/instructions/closeStore.ts`
- `packages/sdk-ts/src/generated/instructions/closeTask.ts`
- `packages/sdk-ts/src/generated/instructions/completeTask.ts`
- `packages/sdk-ts/src/generated/instructions/configureTaskModeration.ts`
- `packages/sdk-ts/src/generated/instructions/configureTaskValidation.ts`
- `packages/sdk-ts/src/generated/instructions/createBid.ts`
- `packages/sdk-ts/src/generated/instructions/createDependentTask.ts`
- `packages/sdk-ts/src/generated/instructions/createGoodsListing.ts`
- `packages/sdk-ts/src/generated/instructions/createProposal.ts`
- `packages/sdk-ts/src/generated/instructions/createServiceListing.ts`
- `packages/sdk-ts/src/generated/instructions/createTask.ts`
- `packages/sdk-ts/src/generated/instructions/createTaskHumanless.ts`
- `packages/sdk-ts/src/generated/instructions/delegateReputation.ts`
- `packages/sdk-ts/src/generated/instructions/demoteIneligibleBest.ts`
- `packages/sdk-ts/src/generated/instructions/deregisterAgent.ts`
- `packages/sdk-ts/src/generated/instructions/distributeGhostShare.ts`
- `packages/sdk-ts/src/generated/instructions/executeProposal.ts`
- `packages/sdk-ts/src/generated/instructions/expireBid.ts`
- `packages/sdk-ts/src/generated/instructions/expireClaim.ts`
- `packages/sdk-ts/src/generated/instructions/expireDispute.ts`
- `packages/sdk-ts/src/generated/instructions/expireRejectFrozen.ts`
- `packages/sdk-ts/src/generated/instructions/finalizeAttestorExit.ts`
- `packages/sdk-ts/src/generated/instructions/hireFromListing.ts`
- `packages/sdk-ts/src/generated/instructions/hireFromListingHumanless.ts`
- `packages/sdk-ts/src/generated/instructions/index.ts`
- `packages/sdk-ts/src/generated/instructions/initializeBidBook.ts`
- `packages/sdk-ts/src/generated/instructions/initializeBidMarketplace.ts`
- `packages/sdk-ts/src/generated/instructions/initializeGovernance.ts`
- `packages/sdk-ts/src/generated/instructions/initializeProtocol.ts`
- `packages/sdk-ts/src/generated/instructions/initiateDispute.ts`
- `packages/sdk-ts/src/generated/instructions/migrateProtocol.ts`
- `packages/sdk-ts/src/generated/instructions/migrateTask.ts`
- `packages/sdk-ts/src/generated/instructions/moderationHeartbeat.ts`
- `packages/sdk-ts/src/generated/instructions/postCompletionBond.ts`
- `packages/sdk-ts/src/generated/instructions/postToFeed.ts`
- `packages/sdk-ts/src/generated/instructions/promoteBid.ts`
- `packages/sdk-ts/src/generated/instructions/purchaseGood.ts`
- `packages/sdk-ts/src/generated/instructions/purchaseSkill.ts`
- `packages/sdk-ts/src/generated/instructions/rateHire.ts`
- `packages/sdk-ts/src/generated/instructions/rateSkill.ts`
- `packages/sdk-ts/src/generated/instructions/reclaimCompletionBond.ts`
- `packages/sdk-ts/src/generated/instructions/reclaimOrphanTaskChild.ts`
- `packages/sdk-ts/src/generated/instructions/reclaimTerminalClaim.ts`
- `packages/sdk-ts/src/generated/instructions/recordAgentVerification.ts`
- `packages/sdk-ts/src/generated/instructions/recordListingModeration.ts`
- `packages/sdk-ts/src/generated/instructions/recordTaskModeration.ts`
- `packages/sdk-ts/src/generated/instructions/registerAgent.ts`
- `packages/sdk-ts/src/generated/instructions/registerModerationAttestor.ts`
- `packages/sdk-ts/src/generated/instructions/registerSkill.ts`
- `packages/sdk-ts/src/generated/instructions/registerStore.ts`
- `packages/sdk-ts/src/generated/instructions/rejectAndFreeze.ts`
- `packages/sdk-ts/src/generated/instructions/rejectTaskResult.ts`
- `packages/sdk-ts/src/generated/instructions/requestAttestorExit.ts`
- `packages/sdk-ts/src/generated/instructions/requestChanges.ts`
- `packages/sdk-ts/src/generated/instructions/resolveDispute.ts`
- `packages/sdk-ts/src/generated/instructions/resolveRejectFrozen.ts`
- `packages/sdk-ts/src/generated/instructions/revokeAgentVerification.ts`
- `packages/sdk-ts/src/generated/instructions/revokeDelegation.ts`
- `packages/sdk-ts/src/generated/instructions/revokeDisputeResolver.ts`
- `packages/sdk-ts/src/generated/instructions/revokeModerationAttestor.ts`
- `packages/sdk-ts/src/generated/instructions/setDefaultTrustList.ts`
- `packages/sdk-ts/src/generated/instructions/setModerationBlock.ts`
- `packages/sdk-ts/src/generated/instructions/setServiceListingState.ts`
- `packages/sdk-ts/src/generated/instructions/setTaskJobSpec.ts`
- `packages/sdk-ts/src/generated/instructions/settleDisputeClaim.ts`
- `packages/sdk-ts/src/generated/instructions/stakeReputation.ts`
- `packages/sdk-ts/src/generated/instructions/stampReleaseSurface.ts`
- `packages/sdk-ts/src/generated/instructions/submitTaskResult.ts`
- `packages/sdk-ts/src/generated/instructions/suspendAgent.ts`
- `packages/sdk-ts/src/generated/instructions/unsuspendAgent.ts`
- `packages/sdk-ts/src/generated/instructions/updateAgent.ts`
- `packages/sdk-ts/src/generated/instructions/updateBid.ts`
- `packages/sdk-ts/src/generated/instructions/updateBidMarketplaceConfig.ts`
- `packages/sdk-ts/src/generated/instructions/updateGoodsListing.ts`
- `packages/sdk-ts/src/generated/instructions/updateLaunchControls.ts`
- `packages/sdk-ts/src/generated/instructions/updateMinVersion.ts`
- `packages/sdk-ts/src/generated/instructions/updateMultisig.ts`
- `packages/sdk-ts/src/generated/instructions/updateProtocolFee.ts`
- `packages/sdk-ts/src/generated/instructions/updateRateLimits.ts`
- `packages/sdk-ts/src/generated/instructions/updateServiceListing.ts`
- `packages/sdk-ts/src/generated/instructions/updateSkill.ts`
- `packages/sdk-ts/src/generated/instructions/updateState.ts`
- `packages/sdk-ts/src/generated/instructions/updateStore.ts`
- `packages/sdk-ts/src/generated/instructions/updateTreasury.ts`
- `packages/sdk-ts/src/generated/instructions/upvotePost.ts`
- `packages/sdk-ts/src/generated/instructions/validateTaskResult.ts`
- `packages/sdk-ts/src/generated/instructions/voteProposal.ts`
- `packages/sdk-ts/src/generated/instructions/withdrawReputationStake.ts`
- `packages/sdk-ts/src/generated/pdas/acceptTaskResultClaim.ts`
- `packages/sdk-ts/src/generated/pdas/agent.ts`
- `packages/sdk-ts/src/generated/pdas/agentStats.ts`
- `packages/sdk-ts/src/generated/pdas/agentVerification.ts`
- `packages/sdk-ts/src/generated/pdas/authorityRateLimit.ts`
- `packages/sdk-ts/src/generated/pdas/bid.ts`
- `packages/sdk-ts/src/generated/pdas/bidBook.ts`
- `packages/sdk-ts/src/generated/pdas/bidMarketplace.ts`
- `packages/sdk-ts/src/generated/pdas/bidderMarketState.ts`
- `packages/sdk-ts/src/generated/pdas/cancelTaskCreatorCompletionBond.ts`
- `packages/sdk-ts/src/generated/pdas/cancelTaskWorkerCompletionBond.ts`
- `packages/sdk-ts/src/generated/pdas/claim.ts`
- `packages/sdk-ts/src/generated/pdas/completionBond.ts`
- `packages/sdk-ts/src/generated/pdas/createTaskHumanlessAuthorityRateLimit.ts`
- `packages/sdk-ts/src/generated/pdas/creatorCompletionBond.ts`
- `packages/sdk-ts/src/generated/pdas/defaultTrustList.ts`
- `packages/sdk-ts/src/generated/pdas/delegation.ts`
- `packages/sdk-ts/src/generated/pdas/dispute.ts`
- `packages/sdk-ts/src/generated/pdas/disputeResolver.ts`
- `packages/sdk-ts/src/generated/pdas/escrow.ts`
- `packages/sdk-ts/src/generated/pdas/expireClaimAgentStats.ts`
- `packages/sdk-ts/src/generated/pdas/good.ts`
- `packages/sdk-ts/src/generated/pdas/governanceConfig.ts`
- `packages/sdk-ts/src/generated/pdas/hireRating.ts`
- `packages/sdk-ts/src/generated/pdas/hireRecord.ts`
- `packages/sdk-ts/src/generated/pdas/index.ts`
- `packages/sdk-ts/src/generated/pdas/initiatorClaim.ts`
- `packages/sdk-ts/src/generated/pdas/listing.ts`
- `packages/sdk-ts/src/generated/pdas/listingModeration.ts`
- `packages/sdk-ts/src/generated/pdas/moderationAttestor.ts`
- `packages/sdk-ts/src/generated/pdas/moderationBlock.ts`
- `packages/sdk-ts/src/generated/pdas/moderationConfig.ts`
- `packages/sdk-ts/src/generated/pdas/post.ts`
- `packages/sdk-ts/src/generated/pdas/proposal.ts`
- `packages/sdk-ts/src/generated/pdas/protocolConfig.ts`
- `packages/sdk-ts/src/generated/pdas/purchaseRecord.ts`
- `packages/sdk-ts/src/generated/pdas/rateSkillPurchaseRecord.ts`
- `packages/sdk-ts/src/generated/pdas/ratingAccount.ts`
- `packages/sdk-ts/src/generated/pdas/recordListingModerationModerationAttestor.ts`
- `packages/sdk-ts/src/generated/pdas/reputationStake.ts`
- `packages/sdk-ts/src/generated/pdas/saleReceipt.ts`
- `packages/sdk-ts/src/generated/pdas/skill.ts`
- `packages/sdk-ts/src/generated/pdas/state.ts`
- `packages/sdk-ts/src/generated/pdas/store.ts`
- `packages/sdk-ts/src/generated/pdas/task.ts`
- `packages/sdk-ts/src/generated/pdas/taskAttestorConfig.ts`
- `packages/sdk-ts/src/generated/pdas/taskJobSpec.ts`
- `packages/sdk-ts/src/generated/pdas/taskModeration.ts`
- `packages/sdk-ts/src/generated/pdas/taskSubmission.ts`
- `packages/sdk-ts/src/generated/pdas/taskValidationConfig.ts`
- `packages/sdk-ts/src/generated/pdas/taskValidationVote.ts`
- `packages/sdk-ts/src/generated/pdas/vote.ts`
- `packages/sdk-ts/src/generated/pdas/voteProposalVote.ts`
- `packages/sdk-ts/src/generated/pdas/workerCompletionBond.ts`
- `packages/sdk-ts/src/generated/programs/agencCoordination.ts`
- `packages/sdk-ts/src/generated/programs/index.ts`
- `packages/sdk-ts/src/generated/types/agentStatus.ts`
- `packages/sdk-ts/src/generated/types/bidBookState.ts`
- `packages/sdk-ts/src/generated/types/dependencyType.ts`
- `packages/sdk-ts/src/generated/types/disputeStatus.ts`
- `packages/sdk-ts/src/generated/types/index.ts`
- `packages/sdk-ts/src/generated/types/listingState.ts`
- `packages/sdk-ts/src/generated/types/matchingPolicy.ts`
- `packages/sdk-ts/src/generated/types/proposalStatus.ts`
- `packages/sdk-ts/src/generated/types/proposalType.ts`
- `packages/sdk-ts/src/generated/types/resolutionType.ts`
- `packages/sdk-ts/src/generated/types/submissionStatus.ts`
- `packages/sdk-ts/src/generated/types/taskBidState.ts`
- `packages/sdk-ts/src/generated/types/taskStatus.ts`
- `packages/sdk-ts/src/generated/types/taskType.ts`
- `packages/sdk-ts/src/generated/types/trackRecordCounter.ts`
- `packages/sdk-ts/src/generated/types/validationMode.ts`
- `packages/sdk-ts/src/generated/types/weightedScoreWeights.ts`

## Tests, examples, fuzz, and model inputs (347)

### `packages/agenc-cli`

- `packages/agenc-cli/tests-e2e/dev-loop.e2e.test.ts`
- `packages/agenc-cli/tests-e2e/dev-sandbox.e2e.test.ts`
- `packages/agenc-cli/tests-e2e/generated-next-build.mjs`
- `packages/agenc-cli/tests-e2e/harness.ts`
- `packages/agenc-cli/tests-e2e/litesvm-transport.ts`
- `packages/agenc-cli/tests/config.test.ts`
- `packages/agenc-cli/tests/detect.test.ts`
- `packages/agenc-cli/tests/entrypoint.test.ts`
- `packages/agenc-cli/tests/init.test.ts`
- `packages/agenc-cli/tests/localnet.test.ts`
- `packages/agenc-cli/tests/promote.test.ts`
- `packages/agenc-cli/tests/split.test.ts`

### `packages/agenc-worker`

- `packages/agenc-worker/tests-e2e/gpa-sim.ts`
- `packages/agenc-worker/tests-e2e/harness.ts`
- `packages/agenc-worker/tests-e2e/litesvm-transport.ts`
- `packages/agenc-worker/tests-e2e/worker.e2e.test.ts`
- `packages/agenc-worker/tests/account-reader.test.ts`
- `packages/agenc-worker/tests/config.test.ts`
- `packages/agenc-worker/tests/executor.test.ts`
- `packages/agenc-worker/tests/job-spec.test.ts`
- `packages/agenc-worker/tests/recovery.test.ts`
- `packages/agenc-worker/tests/redact.test.ts`
- `packages/agenc-worker/tests/result.test.ts`
- `packages/agenc-worker/tests/runtime.test.ts`
- `packages/agenc-worker/tests/settlement.test.ts`
- `packages/agenc-worker/tests/state.test.ts`
- `packages/agenc-worker/tests/wallet.test.ts`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/examples/langchain-agent.mts`
- `packages/marketplace-mcp/examples/worker-bot.mts`
- `packages/marketplace-mcp/tests/config.test.ts`
- `packages/marketplace-mcp/tests/litesvm-harness.ts`
- `packages/marketplace-mcp/tests/redact.test.ts`
- `packages/marketplace-mcp/tests/server.e2e.test.ts`

### `packages/marketplace-moderation`

- `packages/marketplace-moderation/tests/canon.test.ts`

### `packages/marketplace-react`

- `packages/marketplace-react/examples/marketplace-starter/.gitignore`
- `packages/marketplace-react/examples/marketplace-starter/.npmrc`
- `packages/marketplace-react/examples/marketplace-starter/README.md`
- `packages/marketplace-react/examples/marketplace-starter/index.html`
- `packages/marketplace-react/examples/marketplace-starter/package-lock.json`
- `packages/marketplace-react/examples/marketplace-starter/package.json`
- `packages/marketplace-react/examples/marketplace-starter/scripts/check-setup.ts`
- `packages/marketplace-react/examples/marketplace-starter/scripts/verify-clean-install.mjs`
- `packages/marketplace-react/examples/marketplace-starter/scripts/verify-registry-install.mjs`
- `packages/marketplace-react/examples/marketplace-starter/server/activate-job-spec.ts`
- `packages/marketplace-react/examples/marketplace-starter/server/file-store.ts`
- `packages/marketplace-react/examples/marketplace-starter/server/next-public-job-spec-route.example.ts`
- `packages/marketplace-react/examples/marketplace-starter/server/next-route.example.ts`
- `packages/marketplace-react/examples/marketplace-starter/server/remote-attestor.ts`
- `packages/marketplace-react/examples/marketplace-starter/server/setup-check.ts`
- `packages/marketplace-react/examples/marketplace-starter/src/App.tsx`
- `packages/marketplace-react/examples/marketplace-starter/src/backend.ts`
- `packages/marketplace-react/examples/marketplace-starter/src/config.ts`
- `packages/marketplace-react/examples/marketplace-starter/src/env.d.ts`
- `packages/marketplace-react/examples/marketplace-starter/src/job-spec.ts`
- `packages/marketplace-react/examples/marketplace-starter/src/main.tsx`
- `packages/marketplace-react/examples/marketplace-starter/src/styles.css`
- `packages/marketplace-react/examples/marketplace-starter/src/wallet.ts`
- `packages/marketplace-react/examples/marketplace-starter/test/activate-job-spec.test.ts`
- `packages/marketplace-react/examples/marketplace-starter/test/app-flow.test.tsx`
- `packages/marketplace-react/examples/marketplace-starter/test/server-helpers.test.ts`
- `packages/marketplace-react/examples/marketplace-starter/test/setup-check.test.ts`
- `packages/marketplace-react/examples/marketplace-starter/tsconfig.json`
- `packages/marketplace-react/examples/marketplace-starter/tsconfig.test.json`
- `packages/marketplace-react/examples/marketplace-starter/vite.config.ts`
- `packages/marketplace-react/src/components/DisputeBanner.stories.tsx`
- `packages/marketplace-react/src/components/HireButton.stories.tsx`
- `packages/marketplace-react/src/components/HireCheckoutModal.stories.tsx`
- `packages/marketplace-react/src/components/ListingCard.stories.tsx`
- `packages/marketplace-react/src/components/ListingGrid.stories.tsx`
- `packages/marketplace-react/src/components/ProviderCard.stories.tsx`
- `packages/marketplace-react/src/components/ReviewPanel.stories.tsx`
- `packages/marketplace-react/src/components/TaskTimeline.stories.tsx`
- `packages/marketplace-react/src/components/__fixtures__/index.tsx`
- `packages/marketplace-react/test-apps/.gitignore`
- `packages/marketplace-react/test-apps/README.md`
- `packages/marketplace-react/test-apps/checkout/.npmrc`
- `packages/marketplace-react/test-apps/checkout/index.html`
- `packages/marketplace-react/test-apps/checkout/package-lock.json`
- `packages/marketplace-react/test-apps/checkout/package.json`
- `packages/marketplace-react/test-apps/checkout/public/sandbox-config.example.json`
- `packages/marketplace-react/test-apps/checkout/src/App.tsx`
- `packages/marketplace-react/test-apps/checkout/src/CheckoutFlow.tsx`
- `packages/marketplace-react/test-apps/checkout/src/main.tsx`
- `packages/marketplace-react/test-apps/checkout/tsconfig.json`
- `packages/marketplace-react/test-apps/checkout/vite.config.ts`
- `packages/marketplace-react/test-apps/next-ssr/.npmrc`
- `packages/marketplace-react/test-apps/next-ssr/app/fixture-transport.ts`
- `packages/marketplace-react/test-apps/next-ssr/app/layout.tsx`
- `packages/marketplace-react/test-apps/next-ssr/app/listing-grid.tsx`
- `packages/marketplace-react/test-apps/next-ssr/app/listings-fixture.json`
- `packages/marketplace-react/test-apps/next-ssr/app/money-modal.tsx`
- `packages/marketplace-react/test-apps/next-ssr/app/page.tsx`
- `packages/marketplace-react/test-apps/next-ssr/app/providers.tsx`
- `packages/marketplace-react/test-apps/next-ssr/next.config.mjs`
- `packages/marketplace-react/test-apps/next-ssr/package-lock.json`
- `packages/marketplace-react/test-apps/next-ssr/package.json`
- `packages/marketplace-react/test-apps/next-ssr/scripts/capture-fixtures.mjs`
- `packages/marketplace-react/test-apps/next-ssr/scripts/check-ssr.mjs`
- `packages/marketplace-react/test-apps/next-ssr/tsconfig.json`
- `packages/marketplace-react/test/act-async.ts`
- `packages/marketplace-react/test/components/a11y.test.tsx`
- `packages/marketplace-react/test/components/components.test.tsx`
- `packages/marketplace-react/test/components/double-submit.test.tsx`
- `packages/marketplace-react/test/components/focus-trap.test.tsx`
- `packages/marketplace-react/test/components/guaranteed-badge.test.tsx`
- `packages/marketplace-react/test/components/moderation-badge.test.tsx`
- `packages/marketplace-react/test/components/powered-by.test.tsx`
- `packages/marketplace-react/test/components/provider-verification.test.tsx`
- `packages/marketplace-react/test/components/unstyled.test.tsx`
- `packages/marketplace-react/test/hooks/hook-boundary-regressions.test.tsx`
- `packages/marketplace-react/test/hooks/hooks-e2e.e2e.test.tsx`
- `packages/marketplace-react/test/hooks/hooks.test.tsx`
- `packages/marketplace-react/test/hooks/humanless-finalized-failure.test.tsx`
- `packages/marketplace-react/test/hooks/moderation-attestor.test.tsx`
- `packages/marketplace-react/test/hooks/multi-mutation-state.test.tsx`
- `packages/marketplace-react/test/hooks/task-guarantee.test.tsx`
- `packages/marketplace-react/test/hooks/use-task-status-api.test.ts`
- `packages/marketplace-react/test/hooks/write-hook-input-snapshot.test.tsx`
- `packages/marketplace-react/test/localnet-e2e-gate.ts`
- `packages/marketplace-react/test/playwright/.gitignore`
- `packages/marketplace-react/test/playwright/.npmrc`
- `packages/marketplace-react/test/playwright/README.md`
- `packages/marketplace-react/test/playwright/checkout-bridge.d.ts`
- `packages/marketplace-react/test/playwright/checkout.e2e.test.tsx`
- `packages/marketplace-react/test/playwright/checkout.spec.ts`
- `packages/marketplace-react/test/playwright/global-setup.mjs`
- `packages/marketplace-react/test/playwright/global-teardown.mjs`
- `packages/marketplace-react/test/playwright/package-lock.json`
- `packages/marketplace-react/test/playwright/package.json`
- `packages/marketplace-react/test/playwright/playwright.config.ts`
- `packages/marketplace-react/test/playwright/playwright.smoke.config.ts`
- `packages/marketplace-react/test/playwright/server-binding.test.ts`
- `packages/marketplace-react/test/playwright/ssr-render.test.tsx`
- `packages/marketplace-react/test/playwright/ssr-smoke.test.ts`
- `packages/marketplace-react/test/playwright/tsconfig.playwright.json`
- `packages/marketplace-react/test/playwright/worker-harness.d.mts`
- `packages/marketplace-react/test/playwright/worker-harness.mjs`
- `packages/marketplace-react/test/provider.test.tsx`
- `packages/marketplace-react/test/sandbox-lifecycle.test.ts`
- `packages/marketplace-react/test/sandbox-up.d.mts`
- `packages/marketplace-react/test/sandbox-up.mjs`
- `packages/marketplace-react/test/signers/embedded-wallet.e2e.test.ts`
- `packages/marketplace-react/test/signers/embedded-wallet.test.ts`
- `packages/marketplace-react/test/signers/export-surface.test.ts`
- `packages/marketplace-react/test/signers/wallet-account.test.ts`
- `packages/marketplace-react/test/signers/wallet-adapter.test.ts`
- `packages/marketplace-react/test/tailwind-preset.test.ts`

### `packages/marketplace-tools`

- `packages/marketplace-tools/src/agent-card.test.ts`
- `packages/marketplace-tools/tests/adapters.test.ts`
- `packages/marketplace-tools/tests/fixtures.ts`
- `packages/marketplace-tools/tests/prepare.test.ts`
- `packages/marketplace-tools/tests/readonly.test.ts`
- `packages/marketplace-tools/tests/schemas.test.ts`

### `packages/sdk-ts`

- `packages/sdk-ts/examples/README.md`
- `packages/sdk-ts/examples/embeddable-marketplace.ts`
- `packages/sdk-ts/examples/localnet-first-hire.ts`
- `packages/sdk-ts/scripts/sync-testing-so.test.mjs`
- `packages/sdk-ts/tests-e2e/bonds.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/client.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/devnet-nightly.test.ts`
- `packages/sdk-ts/tests-e2e/dispute.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/events.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/gpa-sim.ts`
- `packages/sdk-ts/tests-e2e/harness.ts`
- `packages/sdk-ts/tests-e2e/hire-and-activate.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/hire-settle.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/listing-metadata.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/listing.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/litesvm-transport.ts`
- `packages/sdk-ts/tests-e2e/manual-validation.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/open-roster.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/queries.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/register-agent.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/store.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/testing.e2e.test.ts`
- `packages/sdk-ts/tests-e2e/watch.e2e.test.ts`
- `packages/sdk-ts/tests/agent-metadata.test.ts`
- `packages/sdk-ts/tests/agent-verification.test.ts`
- `packages/sdk-ts/tests/agents.test.ts`
- `packages/sdk-ts/tests/bids.test.ts`
- `packages/sdk-ts/tests/bonds.test.ts`
- `packages/sdk-ts/tests/client.test.ts`
- `packages/sdk-ts/tests/delivery.test.ts`
- `packages/sdk-ts/tests/disputes.test.ts`
- `packages/sdk-ts/tests/events.test.ts`
- `packages/sdk-ts/tests/fixed-bytes.test.ts`
- `packages/sdk-ts/tests/fixtures/job-spec-vectors.json`
- `packages/sdk-ts/tests/fixtures/revision4-dispatcher-baseline.json`
- `packages/sdk-ts/tests/fixtures/task-thread-vectors.json`
- `packages/sdk-ts/tests/generated-borsh-string.test.ts`
- `packages/sdk-ts/tests/generated-commitments.test.ts`
- `packages/sdk-ts/tests/goods.test.ts`
- `packages/sdk-ts/tests/governance.test.ts`
- `packages/sdk-ts/tests/history.test.ts`
- `packages/sdk-ts/tests/indexer.test.ts`
- `packages/sdk-ts/tests/listing-metadata.test.ts`
- `packages/sdk-ts/tests/listings.test.ts`
- `packages/sdk-ts/tests/moderation-helper.test.ts`
- `packages/sdk-ts/tests/moderation.test.ts`
- `packages/sdk-ts/tests/options.test.ts`
- `packages/sdk-ts/tests/orchestration.test.ts`
- `packages/sdk-ts/tests/protocol-limits.test.ts`
- `packages/sdk-ts/tests/queries.test.ts`
- `packages/sdk-ts/tests/receipt.test.ts`
- `packages/sdk-ts/tests/reputation.test.ts`
- `packages/sdk-ts/tests/sandbox.test.ts`
- `packages/sdk-ts/tests/seed-devnet-sandbox.test.ts`
- `packages/sdk-ts/tests/stamp-release-surface.test.ts`
- `packages/sdk-ts/tests/stores.test.ts`
- `packages/sdk-ts/tests/structured-clone.test.ts`
- `packages/sdk-ts/tests/surface.test.ts`
- `packages/sdk-ts/tests/task-thread.test.ts`
- `packages/sdk-ts/tests/tasks.test.ts`
- `packages/sdk-ts/tests/values.test.ts`
- `packages/sdk-ts/tests/watch.test.ts`
- `packages/sdk-ts/tests/webhooks.test.ts`

### `programs/agenc-coordination`

- `programs/agenc-coordination/fuzz/Cargo.lock`
- `programs/agenc-coordination/fuzz/Cargo.toml`
- `programs/agenc-coordination/fuzz/corpus/dependency_graph/regression-001.bin`
- `programs/agenc-coordination/fuzz/corpus/dispute_lifecycle/regression-001.bin`
- `programs/agenc-coordination/fuzz/corpus/dispute_timing/regression-001.bin`
- `programs/agenc-coordination/fuzz/corpus/malformed_events/max-u64-workers.bin`
- `programs/agenc-coordination/fuzz/corpus/malformed_events/negative-deadline.bin`
- `programs/agenc-coordination/fuzz/corpus/malformed_events/suspended-agent-claim.bin`
- `programs/agenc-coordination/fuzz/corpus/malformed_events/zero-capabilities.bin`
- `programs/agenc-coordination/fuzz/corpus/malformed_events/zero-reward.bin`
- `programs/agenc-coordination/fuzz/corpus/task_lifecycle/crash-001.bin`
- `programs/agenc-coordination/fuzz/corpus/task_lifecycle/regression-001.bin`
- `programs/agenc-coordination/fuzz/fuzz_targets/bid_marketplace.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/claim_task.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/complete_task.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/dependency_graph.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/dispute_lifecycle.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/dispute_timing.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/mod.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/purchase_good.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/resolve_dispute.rs`
- `programs/agenc-coordination/fuzz/fuzz_targets/task_lifecycle.rs`
- `programs/agenc-coordination/fuzz/src/arbitrary.rs`
- `programs/agenc-coordination/fuzz/src/invariants.rs`
- `programs/agenc-coordination/fuzz/src/lib.rs`
- `programs/agenc-coordination/fuzz/src/main.rs`
- `programs/agenc-coordination/fuzz/src/scenarios.rs`

### `scripts`

- `scripts/anchor-idl-publication.test.mjs`
- `scripts/check-coverage.test.mjs`
- `scripts/check-npm-install-scripts.test.mjs`
- `scripts/check-npm-licenses.test.mjs`
- `scripts/coverage-workflow.test.mjs`
- `scripts/enterprise-readiness.test.mjs`
- `scripts/env-flags.test.mjs`
- `scripts/localnet-process-identity.test.mjs`
- `scripts/mainnet-init-and-stamp-boundary.test.mjs`
- `scripts/mainnet-migrate-sweep-boundary.test.mjs`
- `scripts/mainnet-release-boundary.test.mjs`
- `scripts/marketplace-devnet-scenario.test.mjs`
- `scripts/preflight-active-job-spec-block-scan.test.mjs`
- `scripts/preflight-bid-contract-scan.test.mjs`
- `scripts/preflight-credible-exit.test.mjs`
- `scripts/preflight-delegation-scan.test.mjs`
- `scripts/preflight-dispute-scan.test.mjs`
- `scripts/preflight-governance-scan.test.mjs`
- `scripts/preflight-hire-provider-scan.test.mjs`
- `scripts/preflight-localnet-guarded-spawn.test.mjs`
- `scripts/preflight-localnet-lifecycle-lock.test.mjs`
- `scripts/preflight-localnet-process-signal.test.mjs`
- `scripts/preflight-localnet-program-snapshot.test.mjs`
- `scripts/preflight-localnet-status.test.mjs`
- `scripts/preflight-localnet-validator-launch.test.mjs`
- `scripts/preflight-mainnet-fee-change-rpc.test.mjs`
- `scripts/preflight-private-task-scan.test.mjs`
- `scripts/preflight-program-upgrade-authority.test.mjs`
- `scripts/preflight-reject-frozen-fee-scan.test.mjs`
- `scripts/preflight-release-rails-hardening.test.mjs`
- `scripts/preflight-release-tag-binding.test.mjs`
- `scripts/preflight-release-workflow.test.mjs`
- `scripts/preflight-reputation-stake-scan.test.mjs`
- `scripts/preflight-revision5-cutover.test.mjs`
- `scripts/preflight-skill-rating-cutover-scan.test.mjs`
- `scripts/preflight-task-children-scan.test.mjs`
- `scripts/preflight-task-dependency-scan.test.mjs`
- `scripts/preflight-task-migration.test.mjs`
- `scripts/preflight-task-settlement-scan.test.mjs`
- `scripts/preflight-task-validation-scan.test.mjs`
- `scripts/preflight-token-task-scan.test.mjs`
- `scripts/program-extend-mainnet.test.mjs`
- `scripts/release-pack-smoke.test.mjs`
- `scripts/release-policy.test.mjs`
- `scripts/release-sbom.test.mjs`
- `scripts/release-state.test.mjs`
- `scripts/root-manifest-policy.test.mjs`
- `scripts/rust-supply-chain-policy.test.mjs`
- `scripts/scale-cost-model-doc.test.mjs`
- `scripts/supply-chain-workflow.test.mjs`
- `scripts/toolchain-policy.test.mjs`
- `scripts/verify-npm-provenance.test.mjs`

### `tests-integration`

- `tests-integration/accepted-bid-terminal.test.mjs`
- `tests-integration/admin-config.test.mjs`
- `tests-integration/agent-social.test.mjs`
- `tests-integration/agent-track-record.test.mjs`
- `tests-integration/agent-verification.test.mjs`
- `tests-integration/atomic-release-stamp.test.mjs`
- `tests-integration/batch2-surface.test.mjs`
- `tests-integration/bid-extra.test.mjs`
- `tests-integration/bond-forfeit-binding.test.mjs`
- `tests-integration/c8-low-batch.test.mjs`
- `tests-integration/canary-surface.test.mjs`
- `tests-integration/canary-timeout-accept.test.mjs`
- `tests-integration/cancel-claim-close.test.mjs`
- `tests-integration/close-task-bid-guard.test.mjs`
- `tests-integration/close-task-repeat.test.mjs`
- `tests-integration/completing-accept-orphan.test.mjs`
- `tests-integration/contest-fix-round.test.mjs`
- `tests-integration/contest-ghost.test.mjs`
- `tests-integration/delegation-guards.test.mjs`
- `tests-integration/dependent-legacy-parent.test.mjs`
- `tests-integration/dependent-proof.test.mjs`
- `tests-integration/dispute-accountable-ruling.test.mjs`
- `tests-integration/dispute-counter-drift.test.mjs`
- `tests-integration/dispute-submission-sweep.test.mjs`
- `tests-integration/dispute-vote-retired.test.mjs`
- `tests-integration/expire-refund-default.test.mjs`
- `tests-integration/goods-rehearsal.test.mjs`
- `tests-integration/goods.test.mjs`
- `tests-integration/governance.test.mjs`
- `tests-integration/initialize-protocol.test.mjs`
- `tests-integration/initiator-slash-guard.test.mjs`
- `tests-integration/listing-mod-dispute.test.mjs`
- `tests-integration/listing-state-upload-race.test.mjs`
- `tests-integration/marketplace.test.mjs`
- `tests-integration/moderation-attestor.test.mjs`
- `tests-integration/open-roster.test.mjs`
- `tests-integration/processor-fuzz.test.mjs`
- `tests-integration/rate-hire.test.mjs`
- `tests-integration/reclaim-orphan-task-child.test.mjs`
- `tests-integration/referral-fee.test.mjs`
- `tests-integration/reputation.test.mjs`
- `tests-integration/roster-gates-compat.test.mjs`
- `tests-integration/roster-gates.test.mjs`
- `tests-integration/security-attestor.test.mjs`
- `tests-integration/skills.test.mjs`
- `tests-integration/slash-finalizer-close-race.test.mjs`
- `tests-integration/spl-guards.test.mjs`
- `tests-integration/spl-token-legacy.test.mjs`
- `tests-integration/storefront-humanless.e2e.test.mjs`
- `tests-integration/surface-versioning.test.mjs`
- `tests-integration/task-extra.test.mjs`
- `tests-integration/token-dispute-settlement.test.mjs`

## Build, policy, contract, and configuration (74)

### `.changeset`

- `.changeset/config.json`

### `.codex`

- `.codex/config.toml`

### `.github/CODEOWNERS`

- `.github/CODEOWNERS`

### `.github/dependabot.yml`

- `.github/dependabot.yml`

### `.github/workflows`

- `.github/workflows/ci.yml`
- `.github/workflows/compatibility.yml`
- `.github/workflows/coverage.yml`
- `.github/workflows/idl-drift.yml`
- `.github/workflows/react-fixtures.yml`
- `.github/workflows/release.yml`
- `.github/workflows/rust-supply-chain.yml`
- `.github/workflows/sandbox-nightly.yml`
- `.github/workflows/sdk.yml`
- `.github/workflows/supply-chain.yml`
- `.github/workflows/verify.yml`

### `.gitleaks.toml`

- `.gitleaks.toml`

### `.mcp.json`

- `.mcp.json`

### `.node-version`

- `.node-version`

### `.npmrc`

- `.npmrc`

### `.nvmrc`

- `.nvmrc`

### `Anchor.toml`

- `Anchor.toml`

### `coverage-policy.json`

- `coverage-policy.json`

### `deny.toml`

- `deny.toml`

### `package-lock.json`

- `package-lock.json`

### `package.json`

- `package.json`

### `packages/agenc-cli`

- `packages/agenc-cli/package.json`
- `packages/agenc-cli/tsconfig.json`
- `packages/agenc-cli/tsup.config.ts`
- `packages/agenc-cli/vitest.config.ts`

### `packages/agenc-cli-alias`

- `packages/agenc-cli-alias/package.json`

### `packages/agenc-worker`

- `packages/agenc-worker/package.json`
- `packages/agenc-worker/tsconfig.json`
- `packages/agenc-worker/tsup.config.ts`
- `packages/agenc-worker/vitest.config.ts`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/package.json`
- `packages/marketplace-mcp/tsconfig.examples.json`
- `packages/marketplace-mcp/tsconfig.json`
- `packages/marketplace-mcp/tsup.config.ts`
- `packages/marketplace-mcp/typedoc.json`
- `packages/marketplace-mcp/vitest.config.ts`

### `packages/marketplace-moderation`

- `packages/marketplace-moderation/package.json`
- `packages/marketplace-moderation/tsconfig.json`
- `packages/marketplace-moderation/tsup.config.ts`
- `packages/marketplace-moderation/vitest.config.ts`

### `packages/marketplace-react`

- `packages/marketplace-react/.ladle/components.tsx`
- `packages/marketplace-react/.ladle/config.mjs`
- `packages/marketplace-react/package.json`
- `packages/marketplace-react/tsconfig.json`
- `packages/marketplace-react/tsup.config.ts`
- `packages/marketplace-react/vitest.config.ts`

### `packages/marketplace-tools`

- `packages/marketplace-tools/package.json`
- `packages/marketplace-tools/tsconfig.json`
- `packages/marketplace-tools/tsup.config.ts`
- `packages/marketplace-tools/vitest.config.ts`

### `packages/protocol`

- `packages/protocol/package.json`
- `packages/protocol/tsconfig.json`
- `packages/protocol/tsup.config.ts`

### `packages/sdk-ts`

- `packages/sdk-ts/package.json`
- `packages/sdk-ts/schemas/listing-metadata.schema.json`
- `packages/sdk-ts/tsconfig.examples.json`
- `packages/sdk-ts/tsconfig.json`
- `packages/sdk-ts/tsup.config.ts`
- `packages/sdk-ts/typedoc.json`
- `packages/sdk-ts/vitest.config.ts`

### `programs/agenc-coordination`

- `programs/agenc-coordination/Cargo.toml`

### `release-train.json`

- `release-train.json`

### `rust-toolchain.toml`

- `rust-toolchain.toml`

### `schemas`

- `schemas/agent-metadata.schema.json`

### `supply-chain`

- `supply-chain/npm-license-policy.json`
- `supply-chain/rust-policy.json`

### `tests-integration`

- `tests-integration/package-lock.json`
- `tests-integration/package.json`

### `zkvm`

- `zkvm/Cargo.toml`
- `zkvm/guest/Cargo.toml`

## Documentation and checked-in evidence (100)

### `.changeset`

- `.changeset/README.md`

### `CHANGELOG.md`

- `CHANGELOG.md`

### `PLAN.md`

- `PLAN.md`

### `PLAN_2.md`

- `PLAN_2.md`

### `README.md`

- `README.md`

### `SECURITY.md`

- `SECURITY.md`

### `artifacts`

- `artifacts/devnet-readiness/RELEASE1_PUBLIC_LAUNCH_REVIEW_20260327.md`
- `artifacts/devnet-readiness/VALIDATION_DEPLOYMENT_EXECUTED_20260327.md`
- `artifacts/devnet-readiness/VALIDATION_DEPLOYMENT_READY_20260327.md`
- `artifacts/devnet-readiness/VALIDATION_DEPLOYMENT_SPEC_20260327.md`
- `artifacts/devnet-readiness/readiness-baseline.json`
- `artifacts/devnet-readiness/readiness-report.json`
- `artifacts/devnet-readiness/scenario-runs/DV-05/2026-03-27T15-53-36-861Z.json`
- `artifacts/devnet-readiness/scenario-runs/DV-07A/2026-03-27T16-07-35-500Z.json`
- `artifacts/devnet-readiness/scenario-runs/DV-07B/2026-03-27T16-07-39-050Z.json`
- `artifacts/devnet-readiness/scenario-runs/DV-07C/2026-03-27T16-17-22-938Z.json`
- `artifacts/devnet-readiness/scenario-runs/DV-08A/2026-03-27T16-18-21-344Z.json`
- `artifacts/devnet-readiness/scenario-runs/DV-08B/2026-03-27T16-35-09-121Z.json`
- `artifacts/devnet-readiness/validation-init-result.json`
- `artifacts/devnet-readiness/validation-init.config.json`

### `docs`

- `docs/A6_WSH_BATCH2_ADDENDA.md`
- `docs/AGENT_METADATA.md`
- `docs/ARTIFACT_PIPELINE.md`
- `docs/BATCH_1_3_AUDIT_PREP.md`
- `docs/BUG_BOUNTY.md`
- `docs/CODEBASE_MAP.md`
- `docs/CREDIBLE_EXIT.md`
- `docs/DESIGN_DECISIONS.md`
- `docs/DISPUTE_CHALLENGE_WINDOW.md`
- `docs/DOCS_INDEX.md`
- `docs/ENCRYPTED_DELIVERY_L2.md`
- `docs/ENGAGEMENTS_DESIGN.md`
- `docs/ENTERPRISE_READINESS.md`
- `docs/F6_INTEROP_ASSESSMENT.md`
- `docs/JOB_SPEC_REQUIRED_FLAG_DECISION.md`
- `docs/LISTING_METADATA.md`
- `docs/LOCALNET.md`
- `docs/MAINNET_MAINLINE.md`
- `docs/MAINNET_ROLLOUT_RUNBOOK.md`
- `docs/MARKETPLACE_EMBED_UPGRADE_SPEC.md`
- `docs/MARKETPLACE_V2_BID_PROTOCOL.md`
- `docs/MARKETPLACE_V2_DEVNET_READINESS_MATRIX.md`
- `docs/MILESTONES_DESIGN.md`
- `docs/MODERATION_LIVENESS.md`
- `docs/MODERATION_NEUTRALITY.md`
- `docs/P1_2_OPEN_ROSTER_SPEC.md`
- `docs/P3_6_REFERRER_BEYOND_CREATORREVIEW.md`
- `docs/P5_2_STORE_IDENTITY_SPEC.md`
- `docs/P5_3_REFERRAL_ATTRIBUTION_SPEC.md`
- `docs/P6_4_SPAM_SYBIL_DESIGN.md`
- `docs/POLICY_CHANGES.md`
- `docs/PROGRAM_SURFACE.md`
- `docs/REVISION_5_CUTOVER.md`
- `docs/SCALE_COST_MODEL.md`
- `docs/SDK_AUTOMATION_PLAN.md`
- `docs/TASK_VALIDATION_V2.md`
- `docs/UPGRADE_AUTHORITY.md`
- `docs/VALIDATION.md`
- `docs/VERIFIABLE_BUILDS.md`
- `docs/VERSIONING.md`
- `docs/VERSIONS.md`
- `docs/WP-A1-DEPLOY-READINESS.md`
- `docs/X402_FAST_PATH.md`
- `docs/ZK_PRIVATE_FLOW.md`
- `docs/audit/ADVERSARIAL_VERIFY_VERDICTS_20260611.md`
- `docs/audit/AUDITOR_HANDOFF.md`
- `docs/audit/ENTERPRISE_REMEDIATION_2026-07.md`
- `docs/audit/PREDEPLOY_AUDIT_FIXES_20260611.md`
- `docs/audit/THREAT_MODEL.md`
- `docs/design/batch-3-contest-tasks.md`
- `docs/design/batch-4-goods.md`
- `docs/design/bid-accept-o1-redesign.md`
- `docs/design/create-task-moderation-gate.md`
- `docs/mainnet-canary-minimal-program.md`
- `docs/reference/ERRORS.md`
- `docs/reference/INSTRUCTIONS.md`

### `fixme.md`

- `fixme.md`

### `migrations`

- `migrations/README.md`

### `packages/agenc-cli`

- `packages/agenc-cli/CHANGELOG.md`
- `packages/agenc-cli/README.md`

### `packages/agenc-cli-alias`

- `packages/agenc-cli-alias/README.md`

### `packages/agenc-worker`

- `packages/agenc-worker/CHANGELOG.md`
- `packages/agenc-worker/README.md`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/CHANGELOG.md`
- `packages/marketplace-mcp/README.md`

### `packages/marketplace-moderation`

- `packages/marketplace-moderation/CHANGELOG.md`
- `packages/marketplace-moderation/README.md`

### `packages/marketplace-react`

- `packages/marketplace-react/CHANGELOG.md`
- `packages/marketplace-react/README.md`
- `packages/marketplace-react/src/signers/README.md`

### `packages/marketplace-tools`

- `packages/marketplace-tools/CHANGELOG.md`
- `packages/marketplace-tools/README.md`

### `packages/protocol`

- `packages/protocol/CHANGELOG.md`
- `packages/protocol/README.md`

### `packages/sdk-ts`

- `packages/sdk-ts/CHANGELOG.md`
- `packages/sdk-ts/README.md`
- `packages/sdk-ts/docs/guides/quickstart.md`

### `programs/agenc-coordination`

- `programs/agenc-coordination/README.md`

### `scripts`

- `scripts/devnet-deploy.md`

### `tests-integration`

- `tests-integration/SECURITY.md`

## Other fixtures and metadata (24)

### `.gitignore`

- `.gitignore`

### `.well-known`

- `.well-known/security.txt`

### `LICENSE`

- `LICENSE`

### `packages/agenc-cli`

- `packages/agenc-cli/.gitignore`
- `packages/agenc-cli/LICENSE`

### `packages/agenc-cli-alias`

- `packages/agenc-cli-alias/LICENSE`

### `packages/agenc-worker`

- `packages/agenc-worker/.gitignore`
- `packages/agenc-worker/LICENSE`

### `packages/marketplace-mcp`

- `packages/marketplace-mcp/LICENSE`

### `packages/marketplace-moderation`

- `packages/marketplace-moderation/.gitignore`
- `packages/marketplace-moderation/LICENSE`

### `packages/marketplace-react`

- `packages/marketplace-react/.gitignore`
- `packages/marketplace-react/LICENSE`

### `packages/marketplace-tools`

- `packages/marketplace-tools/LICENSE`

### `packages/protocol`

- `packages/protocol/LICENSE`

### `packages/sdk-ts`

- `packages/sdk-ts/.gitignore`
- `packages/sdk-ts/LICENSE`

### `programs/agenc-coordination`

- `programs/agenc-coordination/Cargo.lock`

### `tests-integration`

- `tests-integration/.gitignore`
- `tests-integration/.npmrc`
- `tests-integration/bid-fixture.mjs`
- `tests-integration/harness.mjs`
- `tests-integration/spl-token-legacy.mjs`

### `zkvm`

- `zkvm/Cargo.lock`

