# Module map

## Workspace dependencies

```mermaid
flowchart TD
    Program[programs/agenc-coordination] --> Artifact[artifacts/anchor]
    Artifact --> Protocol[@tetsuo-ai/protocol]
    Protocol --> SDK[@tetsuo-ai/marketplace-sdk]
    SDK --> React[@tetsuo-ai/marketplace-react]
    SDK --> Tools[@tetsuo-ai/marketplace-tools]
    SDK --> Worker[@tetsuo-ai/agenc-worker]
    SDK --> CLI[@tetsuo-ai/agenc-cli]
    Tools --> MCP[@tetsuo-ai/marketplace-mcp]
    SDK --> MCP
    Worker --> CLI
    CLI --> Alias[agenc-cli compatibility package]
    Protocol -. contract policy .-> Moderation[@tetsuo-ai/marketplace-moderation]
```

Solid arrows are runtime or build dependencies in package manifests. The moderation-to-protocol dashed edge is a release-train ordering constraint; the moderation package currently has no runtime dependency on protocol. Root scripts encode the release order and verify internal versions before publication.

## Top-level modules

| Path | Responsibility | Important boundaries |
|---|---|---|
| `programs/agenc-coordination` | Anchor program and Rust unit/property tests | Consensus-critical state, authority, accounting, and feature surfaces |
| `packages/protocol` | Published IDL/types/schema/manifest package | Generated from canonical artifacts; consumers should not edit generated files |
| `packages/sdk-ts` | Program client, transactions, queries, event/watch, indexer, orchestration, delivery, sandbox/testing | Main TypeScript integration layer; generated Codama surface is separated from handwritten behavior |
| `packages/marketplace-react` | TanStack Query hooks, components, signers, styles | Wallet and UI state boundary; test-only local signer is isolated |
| `packages/marketplace-tools` | Tool definitions and framework adapters | Returns data or unsigned transaction preparation; no custody |
| `packages/marketplace-mcp` | Stdio MCP framing and tool exposure | Protocol stdout isolation; mutations are opt-in prepare operations |
| `packages/agenc-worker` | Durable task discovery, claiming, execution, upload, and submission | Untrusted job specs and subprocess sandbox boundary |
| `packages/agenc-cli` | Project initialization, development sandbox, promotion | Human/operator command boundary |
| `packages/agenc-cli-alias` | Compatibility binary/package | Delegates to scoped CLI |
| `packages/marketplace-moderation` | Canonical moderation hashes | Deterministic off-chain/on-chain content identity |
| `scripts` | Artifact, localnet, audit, release, deployment, and migration rails | Operator authority and external process boundary |
| `tests-integration` | Compiled-program and cross-package integration tests | Test-only validator/LiteSVM/process orchestration |
| `migrations` | Anchor migration entry and shared migration helper | Deployment-time program initialization |
| `zkvm` | Private-proof guest entry | Feature-gated experimental/private-ZK boundary |
| `artifacts` | Checked-in IDL, generated types, manifest, schemas | Canonical distribution input, not handwritten runtime logic |

## Program module families

`programs/agenc-coordination/src/lib.rs` is the Anchor dispatch surface. Its wrappers delegate to instruction modules; Anchor macros and feature gates obscure some of these edges in GitNexus, so the mapping below was verified from `lib.rs` and the module tree.

| Family | Source modules and state owned |
|---|---|
| Protocol administration | initialization, migration, minimum-version, fee, treasury, multisig, launch-control, rate-limit, pause/state, and release-surface instructions |
| Agents and trust | registration, update/suspension, verification, stats, stores, reputation stakes/delegations, resolver and attestor rosters |
| Tasks | creation variants, dependencies, job-spec pinning, claims, submissions, review, validation, cancellation, closure, and orphan/terminal recovery |
| Marketplace | service and goods listings, hires, ratings, purchases, skills, feeds, and votes |
| Bidding | marketplace configuration, bid books, bids, matching, promotion/demotion, acceptance, expiry, and settlement metadata |
| Disputes and moderation | disputes, slash application, reject-frozen resolution, task/listing moderation, content blocks, and trust lists |
| Governance | configuration, proposals, votes, execution, and cancellation |
| Accounting helpers | native and SPL-token escrow, fee legs, rewards, completion bonds, close/refund helpers, and checked arithmetic |
| Private ZK | verifier-router/CPI helpers, binding/nullifier spends, and private completion; excluded from production release |

The complete list of program files is in [source-inventory.md](source-inventory.md). The public instruction list is in [public-interfaces.md](public-interfaces.md).

## SDK internals

| Area | Role | Representative cross-module calls |
|---|---|---|
| `client.ts` | Transport selection, signer stabilization, transaction assembly/sign/send | Uses generated encoders and RPC transport; called by examples, sandbox, tests, and facades |
| `facade.ts` | Stable ergonomic instruction API | Canonicalizes signer-bearing input, then calls client primitives |
| `queries.ts` | Direct RPC account queries | Decodes generated account layouts and PDA-derived state |
| `indexer/` | Optional indexed reads and prepared transactions | Wraps external HTTP transport with typed errors and abort behavior |
| `events/` and `watch.ts` | Program log subscription plus polling fallback | Decodes attributed events and reconciles claimable-task state |
| `orchestration/` | Resumable hire, activation, review, and delivery workflows | Snapshots input, builds transactions, and exposes resume checkpoints |
| `task-thread/` | Hash-linked task conversation envelopes | Validates bodies, attachments, URIs, timestamps, and parent hashes |
| `delivery/` | Encrypted artifact manifests and key wrapping | X25519/HKDF/AES-256-GCM; v2 authenticates manifest data as AAD |
| `webhooks.ts` | Timestamped HMAC verification | Verifies the exact raw body with bounded clock skew |
| `sandbox/` | Local development environment | Uses node-only process/file helpers and generated fixtures |
| `testing/` | LiteSVM and test fixtures | Exported only from the testing subpath; dynamically loads optional peer `litesvm` |
| `generated/` | Codama instructions, accounts, types, errors, programs | Generated from the IDL; excluded from GitNexus symbol coverage |

## Integration packages

The React package layers query keys and hooks over SDK clients. Read hooks cover listings, agents, tasks, and guarantees; write hooks cover hire, activation, work, review, lifecycle, rating, disputes, and completion bonds. Components implement listing/provider views and transactional modals without owning protocol encoding.

Marketplace tools construct a dynamic `Map` of 19 tools. Framework adapters translate this registry for OpenAI, LangChain, CrewAI, and agent-card consumers. The MCP server selects from the same registry and exposes it through generic list/call handlers, which is why GitNexus's static tool detector reported zero definitions.

The worker composes SDK watching and transaction APIs with job-spec verification, durable state, external executor invocation, artifact upload, and submission recovery. Its `runTickOnce` path acquires the state lock before discovery/resume, while `processCandidate` validates and fetches the pinned spec before it claims or executes work.

## Operational and test modules

Scripts fall into artifact generation/sync, IDL and feature-surface checking, localnet lifecycle, mainnet planning/execution, release packaging, compatibility/security policy, and regression-test families. GitHub workflows invoke these rails rather than carrying all policy inline. Integration tests cover compiled-program behavior and package interactions; Rust fuzz targets exercise instruction/account parsing and state-machine inputs. Exact file groups and dispositions are recorded in the inventory.

## Source-verified cross-module paths

| Origin | Path | Destination |
|---|---|---|
| React `useHire` | signer bridge → SDK orchestration/facade → transaction client | Solana RPC/program |
| MCP stdio request | server dispatch → selected marketplace tool → SDK query/prepare API | RPC/indexer or unsigned transaction payload |
| Worker tick | watcher/list query → job-spec verification → claim → executor → upload → submit | Content host and Solana program |
| Program `complete_task` | account validation → bid settlement → fee/reward execution → bond/escrow cleanup | Program PDAs, system/SPL-token transfers |
| Anchor artifacts | artifact sync → protocol generated assets → SDK generation | Published npm contracts |
| CLI `dev` | sandbox template/environment → localnet scripts → SDK test/sandbox helpers | Local validator and workspace project |

GitNexus traces confirmed several segments, including `runTickOnce → runTickOnceLocked → resumeOpenClaim → executeAndSubmit → runExecutor`, `watchClaimableTasks → listPinnedJobSpecTasks`, `handle_complete_task → execute_completion_rewards`, and MCP `main → createMarketplaceMcpServer`. Macro-generated dispatch, callbacks, and dynamically assembled registries required source verification and remain identified as graph gaps in [coverage-report.md](coverage-report.md).
