# Protocol Docs Index

This is the developer-documentation entrypoint for `agenc-protocol`.

## Start Here

- [../README.md](../README.md) - repo overview, ownership, and top-level layout
- [./MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md) - current mainnet deployment source-of-truth and branch policy (full 84-ix surface live as of 2026-06-11)
- [./MAINNET_ROLLOUT_RUNBOOK.md](./MAINNET_ROLLOUT_RUNBOOK.md) - the Phase 9 full-surface rollout choreography — **COMPLETED 2026-06-11** (historical record + post-rollout state)
- [./CODEBASE_MAP.md](./CODEBASE_MAP.md) - path-by-path map for programs, artifacts, packages, scripts, migrations, zkVM, and workflows
- [./PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md) - grouped instruction and account model for the Anchor program
- [./MARKETPLACE_V2_BID_PROTOCOL.md](./MARKETPLACE_V2_BID_PROTOCOL.md) - RFC for bid-book accounts, lifecycle, settlement hooks, and anti-spam controls
- [./ARTIFACT_PIPELINE.md](./ARTIFACT_PIPELINE.md) - how `anchor build` output becomes committed and published artifacts
- [./VALIDATION.md](./VALIDATION.md) - local toolchain and CI-equivalent commands
- [./LOCALNET.md](./LOCALNET.md) - one-command local stack (localnet-up/status/down), the env-file convention, and the localnet-to-devnet-to-hosted switchover map
- [./TASK_VALIDATION_V2.md](./TASK_VALIDATION_V2.md) - reviewed public-task completion and validation-account model
- [./ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md) - private-completion and zk-config flow
- [./JOB_SPEC_REQUIRED_FLAG_DECISION.md](./JOB_SPEC_REQUIRED_FLAG_DECISION.md) - decision record for job-spec-required protocol flag evaluation
- [./LISTING_METADATA.md](./LISTING_METADATA.md) - LISTING_METADATA v1: ServiceListing name/category/tags encoding, category taxonomy, and the spec_uri JSON Schema
- [./AGENT_METADATA.md](./AGENT_METADATA.md) - AGENT_METADATA v1 (P7.3 step 1): the versioned off-chain agent-identity document (name/description/operatorDomain/contact/logo/tosUri), its JSON Schema, the SDK validator/renderer, and the claim-vs-verified trust boundary
- [./VERSIONS.md](./VERSIONS.md) - P6.5 surface-versioning: program build ↔ SDK semver ↔ cluster matrix, `surface_revision` / `getDeployedSurface`, the `anchor idl init` release-runbook note, and the deprecation policy
- [./VERSIONING.md](./VERSIONING.md) - **WP-D3 versioning & deprecation contract**: the cross-package support matrix (program surface × sdk × react × tools/mcp × store-core), the dated break-event history (2026-06-11 / 2026-07-02 / 2026-07-03), required capability detection, the announce-before-deploy rule, the flag-day lockstep policy, and the template pin check
- [./P1_2_OPEN_ROSTER_SPEC.md](./P1_2_OPEN_ROSTER_SPEC.md) - **P1.2 hardened open roster** (batch-2 upgrade, IMPLEMENTED in source 2026-07-03, deploy-gated): permissionless bonded attestor registration + two-step exit, v2 moderator-keyed moderation records, explicit `moderator` gate argument, the multisig BLOCK-only takedown floor, and the on-chain default trust list; supersedes MODERATION_NEUTRALITY.md

## Other Active Docs

- [../programs/agenc-coordination/README.md](../programs/agenc-coordination/README.md) - program-specific entrypoint
- [../packages/protocol/README.md](../packages/protocol/README.md) - npm package consumer view
- [../migrations/README.md](../migrations/README.md) - migration authority and current-state guidance
- [./audit/THREAT_MODEL.md](./audit/THREAT_MODEL.md) - security assumptions referenced by the fuzz harness
- [./audit/AUDITOR_HANDOFF.md](./audit/AUDITOR_HANDOFF.md) - external-auditor entry point: scope (84-ix full surface + the two migrations), invariants, prior internal audits, test inventory, migration choreography
- [./BATCH_1_3_AUDIT_PREP.md](./BATCH_1_3_AUDIT_PREP.md) - Batch 1–4 (Phase 6) change inventory, per-invariant test map, and internal adversarial-audit results
- [./VERIFIABLE_BUILDS.md](./VERIFIABLE_BUILDS.md) - reproducible build + verifying the deployed program matches source (what's provable now vs public-repo-gated)
- [./CREDIBLE_EXIT.md](./CREDIBLE_EXIT.md) - P8.6 "the operator vanishes and it still works": the executed, reproducible zero-hosted-dependency hire→settle proof (`scripts/credible-exit.mjs`), with the honest gap list (source/verifiable-build deferred)
- [./ENCRYPTED_DELIVERY_L2.md](./ENCRYPTED_DELIVERY_L2.md) - **DESIGN ONLY [HUMAN: approve]** P7.2 layer 2: optional on-chain `key_commitment` at submit + `reveal_key` on accept with hash-match enforcement and deadline bounds, for trustless fair-exchange (child `SubmissionKeyEscrow` PDA, no migration)
- [./MILESTONES_DESIGN.md](./MILESTONES_DESIGN.md) - **DESIGN ONLY [HUMAN: approve]** P7.4: bounded (≤8) milestone schedule via child `TaskMilestone` PDAs (not a Task realloc), `submit_milestone`/`accept_milestone` releasing tranches through the existing split, creator-signed `release_partial`, listing default templates, facade `Engagement`
- [./ENGAGEMENTS_DESIGN.md](./ENGAGEMENTS_DESIGN.md) - **DESIGN ONLY [HUMAN: approve]** P7.5 retainers: an `Engagement` PDA referencing a `ServiceListing`, one prefunded escrow for N locked-price periods, permissionless `renew_period` minting each period's Task (reusing the lifecycle), pro-rata `cancel_engagement`, one-approval kit policy model
- [./F6_INTEROP_ASSESSMENT.md](./F6_INTEROP_ASSESSMENT.md) - **WP-F6 ecosystem interop assessment** (web-verified 2026-07-04): x402 v2 / A2A v1.0 AgentCard / ERC-8004 + Virtuals ACP / AP2-MPP-MCP adjacents — per-standard go/no-go/defer with revisit dates; pairs with [X402_FAST_PATH.md](./X402_FAST_PATH.md)

## Read By Task

- I need the neutrality / credible-exit proof: [CREDIBLE_EXIT.md](./CREDIBLE_EXIT.md)
- I need the open-roster moderation model (P1.2): [P1_2_OPEN_ROSTER_SPEC.md](./P1_2_OPEN_ROSTER_SPEC.md)
- I need the agent-identity metadata standard: [AGENT_METADATA.md](./AGENT_METADATA.md)
- I need the encrypted-delivery / fair-exchange layer-2 design: [ENCRYPTED_DELIVERY_L2.md](./ENCRYPTED_DELIVERY_L2.md)
- I need the milestones / partial-settlement design: [MILESTONES_DESIGN.md](./MILESTONES_DESIGN.md)
- I need the recurring-engagement / retainer design: [ENGAGEMENTS_DESIGN.md](./ENGAGEMENTS_DESIGN.md)
- I need the interop go/no-go (x402 / A2A / ERC-8004 / ACP): [F6_INTEROP_ASSESSMENT.md](./F6_INTEROP_ASSESSMENT.md)

- I need the repo layout: [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- I need the on-chain surface: [PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md)
- I need the Marketplace V2 bid design: [MARKETPLACE_V2_BID_PROTOCOL.md](./MARKETPLACE_V2_BID_PROTOCOL.md)
- I need artifact sync rules: [ARTIFACT_PIPELINE.md](./ARTIFACT_PIPELINE.md)
- I need CI or local validation: [VALIDATION.md](./VALIDATION.md)
- I need reviewed public-task completion: [TASK_VALIDATION_V2.md](./TASK_VALIDATION_V2.md)
- I need private completion or zk-config context: [ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md)
- I need job-spec-required flag context: [JOB_SPEC_REQUIRED_FLAG_DECISION.md](./JOB_SPEC_REQUIRED_FLAG_DECISION.md)
