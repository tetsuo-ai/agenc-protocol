# POLICY CHANGES — mainnet configuration log

A dated log of **authority-signed POLICY mutations** on the live mainnet
`agenc-coordination` program — fee levels, rate limits, and similar on-chain
configuration changes. This log covers config-instruction executions only;
program **deploys/upgrades** are recorded in
[`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md) and
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md).

**Mechanism:** policy mutations are gated by the in-program config multisig
(3 owners, threshold 2). A change requires two owner signatures before the
config instruction executes; a single key cannot move policy.

**Fee-governance signing rail:** an executing `--vote` or `--finalize` run of
`scripts/mainnet-fee-change.mjs` requires `SECONDARY_RPC_URL` on a different
host operated independently from `RPC_URL`. The rail verifies the secondary
genesis is mainnet-beta, then—after the immediate executable/custody check and
immediately before Anchor signs—requires both endpoints to return identical
finalized Proposal account metadata and bytes. It decodes only that agreed raw
snapshot with the hash-approved IDL and reasserts the exact `PROPOSAL` PDA and
`NEW_FEE_BPS` intent. Do not satisfy the two variables with aliases or endpoints
run by the same provider; hostname diversity is only the script's mechanically
checkable minimum. Read-only plans do not require the secondary endpoint.

Entries are newest-first. Every entry must carry the date, the values
before→after (or the decision), the transaction signature where applicable,
and the rationale.

---

## 2026-07-05 — `update_rate_limits`: task-creation limits raised

**Signature:**
[`4ajp8KzZJqBAfWpQPkkgys7UGd79Wdqi2JuzAyWzzbRQiDX5NN6CJa3m9hYJpfuwvud1uKivgcQhw7pAzTyxAMY`](https://solscan.io/tx/4ajp8KzZJqBAfWpQPkkgys7UGd79Wdqi2JuzAyWzzbRQiDX5NN6CJa3m9hYJpfuwvud1uKivgcQhw7pAzTyxAMY)

| Limit | Before | After |
| --- | --- | --- |
| Task creation cooldown | 60s | **1s** |
| `max_tasks_per_24h` | 50 | **255** (the u8 field ceiling) |
| Dispute limits | unchanged | unchanged |

**Rationale:** per-agent creation counters throttle honest volume; spam is
already economically priced (escrow, rent, fees). The limits are raised to
the maximum the current field types allow.

**Floor kept:** the program forbids setting a limit to 0 (= unlimited) even
for the multisig — by design. `max_tasks_per_24h = 255` is therefore the
ceiling reachable without a program change. The structural fix (u8→u32,
retiring creation counters as an economic limit entirely) is batch-3 design
issue [#124](https://github.com/tetsuo-ai/agenc-protocol/issues/124).

## 2026-07-04 — Fee decision: protocol fee stays at 500 bps

**No transaction** — a decision, recorded here because it reverses a
previously published intent. The live `protocol_fee_bps = 500` (5%) **stays**;
the planned relaunch decrease to 350 bps is **cancelled** and will not be
re-proposed. The remaining fee-policy work is publication, not mutation: the
fee policy page (notice window on changes, per-task snapshot protection,
500 bps cap) ships with the agenc.ag fees/policy page (WP-E1, `/docs/fees`).
