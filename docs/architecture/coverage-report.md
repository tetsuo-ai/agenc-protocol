# Coverage report

## Scope and method

This report accounts for the repository at commit `1765a2eaf146d9abe6e252dfdcdf9ebf2d1b636f`. Structural discovery used GitNexus repository context, clusters, processes, symbol queries, symbol context, route/tool maps, call traces, cycle checks, and schema inspection. Every substantive architecture statement was then checked against tracked source, package/Cargo manifests, the canonical IDL, JSON schemas, tests, scripts, or workflows.

The accounting baseline is the exact output of `git ls-files`: 1,273 paths. [source-inventory.md](source-inventory.md) lists every one of those paths once under a disposition. Architecture coverage does not mean every line was manually reviewed; it means every tracked file has been classified and every runtime-bearing family was sampled or traced deeply enough to establish its role and boundaries.

## Tracked-file disposition

| Disposition | Files | Treatment |
|---|---:|---|
| Handwritten runtime and operations | 379 | Architectural role mapped; entry points, important symbols, security checks, and cross-module paths directly inspected |
| Generated contracts and packaged outputs | 349 | Provenance, distribution role, counts, and drift controls checked; not treated as handwritten implementation |
| Tests, examples, fuzz/model inputs | 347 | Used as behavioral evidence and entry/fixture discovery; not treated as production ingress |
| Build, policy, contract, and configuration | 74 | Manifests, schemas, CI, feature policy, and release/deployment controls inspected |
| Documentation and checked-in evidence | 100 | Used as secondary evidence and cross-checked where it makes runtime claims |
| Other fixtures and metadata | 24 | Classified for completeness; inspected when referenced by runtime/build paths |
| **Total** | **1,273** | Exact tracked baseline |

The handwritten runtime/operations population includes program and package source, non-test repository and package scripts, the compatibility CLI launcher, worker service templates, migrations, and the ZK guest entry. The path inventory is the authority when category summaries overlap or a file serves more than one purpose.

## GitNexus index coverage

| Measure | GitNexus result | Interpretation |
|---|---:|---|
| File nodes | 4,081 | Not comparable to tracked source without normalization |
| Symbols | 38,897 | Includes ignored generated documentation symbols |
| Relationships | 68,940 | Includes containment/import/call/access/process and other edge kinds |
| Execution processes | 300 | Heuristic traces, useful for navigation rather than completeness proof |
| Aggregate cluster labels | 66 | Heuristic functional labels; lower-level communities contain repeats |
| Entry-point edges | 0 | Entry points had to be established from manifests and source |
| HTTP routes | 3 | All are SDK test fixtures, not production routes |
| Detected tools | 0 | False negative caused by dynamic registry assembly; source contains 19 tools |
| Import cycles | 0 | Clean within the indexed graph |
| PDG/taint findings | 0 | PDG/taint layer was not present; no security conclusion is possible |

The largest normalization issue is `packages/sdk-ts/docs/api`: GitNexus indexed 3,238 ignored TypeDoc Markdown pages that are absent from `git ls-files`. Conversely, it indexed none of the 328 tracked Codama-generated files under `packages/sdk-ts/src/generated` and omitted generated protocol assets except their handwritten barrel. GitNexus source counts matched the main handwritten TypeScript and Rust areas closely, but its file count is not a coverage denominator.

## Generated and derived code

The 349 tracked generated/package-output files comprise 328 Codama SDK files, five protocol generated assets, 13 checked-in package distribution files, and three canonical Anchor artifacts. They were checked for their generation boundary and public-contract role, while representative and aggregate ABI facts were verified directly from the IDL and manifests.

`packages/sdk-ts/docs/api` is ignored derived TypeDoc output and therefore is not in the tracked inventory, despite appearing in GitNexus. `target`, `node_modules`, package caches, localnet state, coverage output, and build staging directories are likewise excluded from the repository baseline. Fuzz corpus/model files are classified as test inputs rather than implementation.

## Entry-point and relationship coverage

| Area | How verified | Known relationship gap |
|---|---|---|
| Anchor program | `lib.rs`, instruction modules, state, IDL, feature checks | Anchor macros and `cfg` wrappers hide some wrapper→handler edges |
| SDK | package exports, barrels, client/facade/query/orchestration source, GitNexus contexts | Generic transports, callbacks, and generated encoders are only partially linked |
| React | package exports, hook/component/signer barrels and implementations | Hook→facade trace for `useHire` did not resolve under the queried symbol name |
| Worker | binary/runtime/job-spec/executor/state source plus call traces | Injected resolver/uploader/executor callbacks cannot be exhaustively resolved statically |
| MCP/tools | binary/server and dynamic tool registry source | GitNexus tool detector missed all runtime-created definitions |
| CLI/scripts | bins, command dispatch, script mains, child-process sites | Dynamic imports and spawned commands terminate static call paths |
| HTTP | GitNexus route map and source lines | Only test fixture handlers exist; external services are client contracts only |
| Private-ZK/canary | feature-gated modules, build checks, baseline IDL | Mutually exclusive compile-time graphs are merged or omitted by single-config indexing |

Source-verified GitNexus paths include:

- `runTickOnce → runTickOnceLocked → resumeOpenClaim → executeAndSubmit → runExecutor`;
- `runTickOnce → runTickOnceLocked → resumeOpenClaim → fetchAndVerifyJobSpec`;
- `watchClaimableTasks → listPinnedJobSpecTasks` and its event-decoding chain;
- `handle_complete_task → load_bid_settlement_meta → load_accepted_bid_account_suffix → validate_bid_settlement_accounts`;
- `handle_complete_task → execute_completion_rewards`;
- MCP binary `main → createMarketplaceMcpServer`;
- facade task creation → signer capture/canonicalization → address-locked signer.

## Dynamic loading and process boundaries

The following production or operator-relevant behavior cannot be completely represented by static imports:

| Location | Dynamic behavior | Coverage treatment |
|---|---|---|
| CLI sandbox | Dynamically imports `@tetsuo-ai/marketplace-sdk/testing` | Source inspected; testing-only dependency is conditional |
| CLI templates | Dynamically imports `node:fs/promises` | Source inspected; Node runtime boundary documented |
| SDK testing | Dynamically imports optional `litesvm` peer | Testing subpath only; not a root runtime dependency |
| SDK sandbox | Guarded dynamic Node file APIs and fixture loading | Node-only sandbox boundary documented |
| SDK generation/seed scripts | Dynamically load generation helpers or built SDK | Build/operator behavior, not browser runtime |
| Mainnet/preflight scripts | Use independent dependency resolution and dynamically load built packages | Deployment dependency tree inspected as an operator boundary |
| Pack/release smoke tests | Dynamically import packed tarballs | Used to verify published shape |
| Worker executor | Spawns a configured external executable | Security and recovery behavior inspected; executable internals are out of repository scope |
| Localnet/release/deploy scripts | Spawn validators, package tools, build tools, and Solana commands | Command construction and guards inspected; child implementations external |
| Tool registry | Constructs definitions and handlers in a runtime `Map` | All 19 source definitions enumerated manually |

No production `eval` or `new Function` use was found. Test fixtures contain strings and process simulations that should not be interpreted as production dynamic execution.

## Skipped or externally unresolved components

The analysis intentionally did not treat the following as repository implementation:

- Solana validator, RPC/WebSocket providers, system program, SPL-token program, and upgradeable loader;
- hosted indexer, moderation, content-addressed resolver, artifact upload, and webhook-producing services;
- wallet implementations, optional LiteSVM peer, and configured worker executor binaries;
- npm registry, GitHub Actions runners, release provenance service, DNS, and external package internals;
- ignored build outputs, local state, caches, coverage artifacts, and TypeDoc output.

Their interfaces and trust assumptions are documented, but their internal correctness is unresolved because their source is not in scope. Live cluster state, deployed binary hashes, upgrade-authority custody, and service availability were not queried; this is a repository architecture analysis, not a mainnet attestation.

## Test and measured coverage

The repository contains 223 `.test` files, including 28 end-to-end files and 52 compiled-program integration tests; it also has 10 Rust fuzz targets and 52 script-test files (these categories overlap, so they must not be summed). Tests span Rust instruction/state behavior, SDK units and integration paths, downstream packages, scripts, React fixtures, CLI/worker/MCP behavior, and deployment guards.

The committed Rust coverage policy records an empirical baseline measured on 2026-07-19 with `cargo-llvm-cov 0.6.21` over default features/all targets:

| Metric | Covered / total | Baseline |
|---|---:|---:|
| Functions | 878 / 1,804 | 48.66962305986696% |
| Lines | 10,139 / 23,893 | 42.43502281002804% |
| Regions | 3,831 / 11,331 | 33.80990203865502% |

`scripts/check-coverage.mjs` enforces these values as a non-regression ratchet. No current coverage output artifact was found, so this report does not claim those numbers describe the current checkout after a fresh run. No JavaScript/TypeScript statement-coverage threshold or checked-in report was found; file/test counts are structural evidence, not line coverage.

## Completeness statement

Every path tracked at the baseline commit appears in [source-inventory.md](source-inventory.md). Known static-analysis omissions, ignored/generated over-inclusion, feature-gated code, unresolved callback/dynamic relationships, external components, test-only routes, and the absence of a current coverage run are all disclosed above. Future changes should regenerate both the inventory and GitNexus index before relying on these counts.
