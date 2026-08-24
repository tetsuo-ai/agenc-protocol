# Public interfaces

## Solana program ABI

The canonical production ABI is `artifacts/anchor/idl/agenc_coordination.json`, whose declared address matches `Anchor.toml` and the Rust `declare_id!`: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`. At the analyzed commit it contains 101 instructions, 43 account types, 102 events, 161 defined types, and 405 program errors. Generated clients originate from this artifact; `target/idl` is an intermediate build output, not a distribution contract.

The complete production instruction set is:

```text
accept_bid, accept_task_result, apply_dispute_slash, apply_initiator_slash,
assign_dispute_resolver, assign_moderation_attestor, auto_accept_task_result,
cancel_bid, cancel_dispute, cancel_proposal, cancel_task, claim_task,
claim_task_with_job_spec, clear_moderation_block, close_store, close_task,
complete_task, configure_task_moderation, configure_task_validation, create_bid,
create_dependent_task, create_goods_listing, create_proposal,
create_service_listing, create_task, create_task_humanless, delegate_reputation,
demote_ineligible_best, deregister_agent, distribute_ghost_share,
execute_proposal, expire_bid, expire_claim, expire_dispute,
expire_reject_frozen, finalize_attestor_exit, hire_from_listing,
hire_from_listing_humanless, initialize_bid_book, initialize_bid_marketplace,
initialize_governance, initialize_protocol, initiate_dispute, migrate_protocol,
migrate_task, moderation_heartbeat, post_completion_bond, post_to_feed,
promote_bid, purchase_good, purchase_skill, rate_hire, rate_skill,
reclaim_completion_bond, reclaim_orphan_task_child, reclaim_terminal_claim,
record_agent_verification, record_listing_moderation, record_task_moderation,
register_agent, register_moderation_attestor, register_skill, register_store,
reject_and_freeze, reject_task_result, request_attestor_exit, request_changes,
resolve_dispute, resolve_reject_frozen, revoke_agent_verification,
revoke_delegation, revoke_dispute_resolver, revoke_moderation_attestor,
set_default_trust_list, set_moderation_block, set_service_listing_state,
set_task_job_spec, settle_dispute_claim, stake_reputation,
stamp_release_surface, submit_task_result, suspend_agent, unsuspend_agent,
update_agent, update_bid, update_bid_marketplace_config, update_goods_listing,
update_launch_controls, update_min_version, update_multisig,
update_protocol_fee, update_rate_limits, update_service_listing, update_skill,
update_state, update_store, update_treasury, upvote_post,
validate_task_result, vote_proposal, withdraw_reputation_stake
```

The canary baseline exposes exactly these 25 names, with full account/argument/error wire shapes checked by script:

```text
accept_task_result, cancel_task, claim_task_with_job_spec,
configure_task_moderation, configure_task_validation, create_task,
deregister_agent, expire_claim, initialize_protocol, migrate_protocol,
migrate_task, record_task_moderation, register_agent, reject_task_result,
set_task_job_spec, submit_task_result, suspend_agent, unsuspend_agent,
update_agent, update_launch_controls, update_min_version, update_multisig,
update_protocol_fee, update_rate_limits, update_treasury
```

The `private-zk` instructions and accounts are feature-gated and excluded from production packaging. Consumers must select an IDL matching the deployed binary rather than assuming every source feature is present.

## npm package exports

| Package | Public exports |
|---|---|
| `@tetsuo-ai/protocol` | Root generated types/constants, IDL JSON, daemon schema, artifact manifest, verifier-router contract |
| `@tetsuo-ai/marketplace-sdk` | Root browser-compatible API, `./testing`, and `./sandbox` node-oriented subpaths |
| `@tetsuo-ai/marketplace-react` | Root, hooks, signers, components, testing, theme/components CSS, and Tailwind preset |
| `@tetsuo-ai/marketplace-tools` | Core tool registry, adapters, and agent card |
| `@tetsuo-ai/marketplace-mcp` | MCP server construction plus the `agenc-marketplace-mcp` binary |
| `@tetsuo-ai/marketplace-moderation` | Canonical JSON and v1/v2 moderation content hashes |
| `@tetsuo-ai/agenc-worker` | Worker API plus the `agenc-worker` binary |
| `@tetsuo-ai/agenc-cli` | Package root, `./cli`, and the `agenc` binary |
| `agenc-cli` | Compatibility binary that delegates to the scoped CLI |

All TypeScript packages emit ESM, CommonJS, and declarations through `tsup`. The SDK keeps node-only testing and sandbox code out of the root browser surface; React uses multiple entry points and copies its style assets.

## SDK surface

The SDK root combines:

- flat Codama-generated program, instruction, account, type, and error exports;
- client construction and send/confirm helpers;
- a namespaced ergonomic facade and signer canonicalization;
- direct RPC queries, optional indexer queries, webhooks, event subscriptions, and task watchers;
- namespaced value/history/task-thread/delivery modules;
- moderation helpers, settlement-receipt URL support, and resumable orchestration workflows.

Generated names follow the checked-in IDL and can change when the ABI changes. The facade and orchestration layers are the intentional higher-level integration boundary.

## React surface

Read hooks are `useListings`, `useListing`, `useAgentTrackRecord`, `useTaskStatus`, and `useTaskGuarantee`. Transaction/workflow hooks are `useHire`, `useSubmissionReview`, `useTaskActivation`, `useHumanlessHireFlow`, `useTaskWork`, `useTaskLifecycle`, `useRateHire`, `useDispute`, and `useCompletionBond`; `useReferrerEarnings` and shared query keys round out the query surface.

Signer adapters cover Wallet Standard, a legacy wallet-adapter shim, and embedded wallets. The local-key mock is exported only by the testing subpath. Public components include primitive controls, trust/moderation badges, listing and provider cards, hire/checkout UI, task timeline/review/dispute UI, and `PoweredByAgenC`.

## Command-line interfaces

| Binary | Commands | Purpose |
|---|---|---|
| `agenc` | `init`, `dev`, `promote` | Scaffold/configure a project, run a development sandbox, and promote artifacts/configuration |
| `agenc-worker` | `up`, `once`, `status` | Run continuous or single worker ticks and inspect durable state; supports dry-run behavior |
| `agenc-marketplace-mcp` | stdio server | Expose selected marketplace tools through MCP framing |

Operator-only scripts under `scripts/` are also command surfaces, but they are repository rails rather than semver npm APIs. Mainnet scripts default to plans and require explicit execute flags and typed confirmations for consequential actions.

## MCP tools

The source registry contains 19 tools. Six are read-only:

```text
list_listings, get_listing, list_open_tasks, get_task,
get_agent_track_record, search
```

Thirteen prepare unsigned mutations:

```text
prepare_create_service_listing, prepare_hire, prepare_hire_humanless,
prepare_set_task_job_spec, prepare_claim, prepare_submit,
prepare_accept_task_result, prepare_reject_task_result,
prepare_auto_accept_task_result, prepare_cancel_task, prepare_close_task,
prepare_rate_hire, prepare_register_agent
```

Tool definitions are assembled into a `Map` at runtime and exposed through generic MCP handlers. GitNexus's `tool_map` reported zero tools because it did not resolve this pattern; the list above is source-verified.

## HTTP and external service contracts

GitNexus's complete route map contains only `GET /slow`, `GET /large`, and `GET /streamless`, all local fixture routes in `packages/sdk-ts/tests/task-thread.test.ts`. They are not product endpoints.

Production code is nevertheless an HTTP client at several boundaries: optional indexer queries, webhook inputs, job-spec retrieval, artifact upload, and content resolution. Their server-side implementations and route catalogs are not in this repository. SDK indexer interfaces cover listing/hire/track-record reads, prepared transactions, webhooks, and events without claiming ownership of the backing service.

## JSON and content contracts

Checked-in schemas include listing metadata (`LISTING_METADATA`, version 1), agent metadata (`AGENT_METADATA`, version 1), and the generated daemon RPC contract. Other runtime-validated contracts include job-spec envelopes, hash-linked task-thread entries, delivery manifests, worker state, indexer payloads, and moderation canonicalization. These are detailed in [data-model.md](data-model.md).
