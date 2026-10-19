# Bounded wallet task quotas (#124), revision-7 candidate

Status: implementation candidate, not deployed. The current code already keys
task and dispute throttles by wallet authority, so rotating agents under one
wallet is no longer a way around the budget. The remaining hard ceiling is the
legacy `u8` configuration and counter. Their fields sit inside live accounts;
widening them in place would corrupt subsequent fields.

The candidate preserves the 351-byte ProtocolConfig and 67-byte AuthorityRateLimit
layouts and their existing instruction wires. It adds an optional 64-byte
`AuthorityTaskQuota` account at `["authority_task_quota", authority]`, with a
`u32` maximum and count. The protocol's actual M-of-N approval grants individual
wallets finite capacity from **256 through 1,000 tasks per calendar-day window**.
The existing `update_rate_limits` dial remains the default legacy limit; it does
not revoke an extended grant. Operators must explicitly lower or disable that
wallet's grant. Existing task-creation cooldown policy still applies to both
paths, including the minimum one second, and dispute limits remain unchanged.

This deliberately retains throttling and its compromised-multisig floors.
Escrow principal can return to the same controlling party after cancellation or
completion; it is not by itself an irreversible spam cost. Removing counters
or permitting zero/unlimited capacity would expand scope without an adequate
economic replacement. A bounded per-wallet approval supports integrators while
keeping today's default permissionless path. Different wallets can still have
common ownership; this is capacity policy, not person-level Sybil resistance.

## Budget continuity

All five creation paths (registered, humanless, dependent, listing hire and
humanless listing hire) accept one optional writable quota suffix on revision
7. The SDK's `taskQuotaSurface` option derives that account from the detached
authority signer and requires `taskCreationQuotas`; omitting the option retains
the old account wire and stricter default cap.

The quota copies the existing wallet's consumed count when first granted.
Before every extended use, it reconciles the maximum of the legacy and wide
counts for the same calendar window. Every extended creation mirrors its count
back to the legacy counter, saturating at 255. Therefore an omitted suffix can
never create more capacity: once the wide count reaches 255, every legacy cap
is exhausted. The extended maximum is always at least 256, so a legacy path can
never exceed a smaller extended maximum. Legacy writes before saturation are
included on the next reconciliation. Grant updates, disable/re-enable and agent
retirement never close the account or reset its count. Lowering a cap below
current usage blocks further creation immediately.

Both families use the existing UTC-aligned calendar-day start and the same
`last_task_created`. Only the existing expired-window transition replenishes
usage. Dispute counters reset on that existing boundary as before; their last
action timestamp/cooldown is preserved. Backward Clock movement does not grant
capacity. Account creation, funding and both counters roll back atomically if
any instruction in the transaction fails.

## Adversarial review and acceptance

| Attempt | Required outcome and executable coverage |
| --- | --- |
| One owner grants capacity; zero, 255, 1001 or `u32::MAX` maximum | M-of-N and finite-range rejection; no rent/state creation |
| Pre-fund the quota PDA | Anchor initialization still succeeds with valid approvals |
| Switch agents, creation path or omit the quota | Shared wallet budget; every path rejects N+1 |
| Mix legacy and quota writes, then disable/re-enable | Existing consumption survives every transition |
| Substitute another wallet's account, omit writability or add surplus accounts | Canonical PDA/owner/size/bump/suffix rejection |
| Reuse reserved flags or move the clock backward | Fail closed; no refreshed capacity |
| Cross the exact calendar boundary | Both counters reset once, dispute cooldown timestamp persists |
| Fail a second instruction after funding the first | Both task accounts, escrow funding and counters roll back |
| Exhaust creation allowance then complete/cancel existing work | Settlement and refunds remain available; no allowance replenishment |

`tests-integration/task-creation-quota.test.mjs` executes the compiled program
with explicit boundary/corruption fixtures. The separate
`packages/sdk-ts/tests-e2e/task-creation-quota.rpc.test.ts` uses a production-feature
validator, actual 2-of-3 approvals, 256 signed funded task creations across two
agents of one wallet, real one-second cooldowns, N+1 rejection, one completed
job and refunds for the other 255. A different wallet provides the independence
control. It never injects lifecycle accounts or counter values and never warps
Clock. Calendar-boundary coverage is explicitly fixture-based; the RPC run
waits until the next day if starting too near midnight to finish its assertions.

This is an internal design and regression review, not independent external
audit certification. Deployment requires the reviewed candidate release and
atomic revision-7 stamp. New grants should be visible in operator policy and
monitoring through `TaskCreationQuotaConfigured`; `TaskCreationQuotaHit` reports
the wide counts without truncating the legacy event's fields.
