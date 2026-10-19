# Administrative signing and monitoring (#281)

This policy and executable tooling are a candidate for operator adoption. No
current owner acknowledgement, external pager deployment, live nonce revocation
or completed production incident drill is asserted by this PR. Keep #281 open
until those operational receipts exist. Upgrade custody remains covered by #280.

## Owner signing procedure

Each owner constructs administrative instructions from independently reviewed,
hash-pinned source in their own clean signing environment. Review the exact
program, instruction arguments, writable accounts, requested signer set, payer,
treasury/owner changes and release intent. Do not sign imported transaction bytes,
session-based signing prompts, intermediary-provided messages or durable-nonce
administrative transactions. A valid signature is authorization; a nonce does
not bypass the multisig check, but can retain authorization for later execution.
See the [Solana durable-nonce lifecycle](https://solana.com/docs/core/transactions/durable-nonces).

The init/stamp, migration-sweep and fee-change execution rails call the shared
`admin-signing-policy.mjs` gate before signing:

- Accept only locally assembled legacy transactions using the just-fetched
  recent blockhash and explicit last-valid block height. Reject nonce metadata,
  `AdvanceNonceAccount` at **any** instruction position, pre-existing signatures,
  unknown outer programs, unknown canonical-IDL instructions, malformed compute
  budget instructions, and missing/extra signers. Versioned/imported messages and
  address-lookup-table flows are intentionally unsupported by these rails.
- Simulate zero-signature instructions with a placeholder blockhash replaced by
  the RPC. No reusable authority signature is sent to simulation. Reject failed
  or stale simulation and expired/invalid recent blockhashes. Bind the reviewed
  instruction bytes, metas and signer set to a message digest.
- Recheck the existing loader/custody and ceremony-specific state boundaries
  after simulation. The fee rail retains its independent finalized-proposal
  read as the last RPC gate. Immediately before local signing, synchronously
  recheck the exact message and signer set and a 30-second review lifetime.
  Rebuild and re-simulate if anything changes or expires. The logged unsigned
  review records pubkeys, exact instruction data and message digest, never keys.

These rails do not make source review optional, prove the safety of arbitrary
IDL-recognized instructions, or control signatures made in other software.
The Squads upgrade ceremony and Ledger/hardware workflows have their own review
boundaries; this change does not silently replace them. No CLI imports a held
transaction or offers a durable-nonce exception switch.

Maintain an operator-owned inventory of administrative nonce accounts: address,
authority, purpose, creation/review date, and last advance signature/slot. Review
unused nonces daily and before any authority transition. Explicitly authorize
and advance unused nonce accounts from their independently held authority;
verify the new on-chain value. Do not merely discard a transaction file or assume
it expired with ordinary blockhash timing. If a signature was exposed, revoke
its nonce promptly and preserve evidence. This source PR schedules no broadcasts.

## Protocol and treasury alarms

Enable `protocolMonitoring` in the reviewed watchdog settings. The mainnet
example now includes explicit treasury inflow/outflow thresholds. Installation,
baseline approval, durable delivery, independent health checks and pager
operation follow [UPGRADE_WATCHDOG.md](UPGRADE_WATCHDOG.md).

The decoder derives field layout from the committed canonical IDL and fails on
unknown shapes, incorrect owners/discriminators, malformed bools or invalid
multisig controls. It reports changes to treasury, all owner slots and count,
threshold, pause, surface revision and minimum supported version, plus other
administrative economics/version fields. Only the four routine telemetry
counters (`total_agents`, `total_tasks`, `completed_tasks`,
`total_value_distributed`) are excluded from paging comparisons. Raw before/after
account hashes remain in an administrative alert. Malformed/missing config also
alerts. A legitimate registration must not produce a config-write page.

A treasury change immediately alerts and adds the new address to monitoring;
the old address remains observed for that process lifetime. Configure cumulative
balance movement thresholds for both directions. If treasury and vault coincide,
use the stricter applicable threshold. These are balance tripwires, not attribution
of counterparties or a complete transfer-history indexer: net-zero intermediate
flows can escape polling. Investigate signatures and recipients through an
independent provider after a signal; a monitor cannot establish that a wallet
is newly controlled by an attacker. For full flow coverage, add a separately
operated transaction stream with its own measured delivery and retention.

## Local executable drill

```sh
node --test scripts/admin-signing-policy.test.mjs scripts/protocol-config-monitor.test.mjs
node scripts/localnet-up.mjs --dev-ready
AGENC_RPC_E2E=1 node --test scripts/admin-signing-monitor.rpc.test.mjs
```

The test refuses external/non-owned validators. It creates an actual nonce
account, proves the guard refuses the administrative transaction before any
signature, and creates disposable held signatures only as a local negative
control. It advances the nonce, submits the stale bytes, verifies the runtime
drops them and the protocol account is unchanged. An invalid nonce produces no
landed transaction metadata; the evidence records that distinction explicitly.

Fresh unsigned simulation followed by local signing then executes actual treasury,
owner-set and pause changes. A real HTTP receiver must receive each alarm. The
new treasury is automatically followed and an exact outflow is observed; a real
agent registration changes telemetry without paging. Original controls are
restored through signed instructions. JSON evidence records reviews, signatures,
confirmed metadata and received alerts. No external on-call recipient is contacted.

## Operational acceptance record (unfilled)

Before closing #281, each current owner must acknowledge the reviewed policy
digest, independent signing environment and nonce inventory. Record public owner
key, acknowledgement date and evidence location; do not populate acknowledgements
on an owner's behalf. Record production monitor/baseline version, external
heartbeat, pager routing and a recipient acknowledgement. Run the authorized
devnet/tabletop treasury-redirection scenario, preserve alert timing, operator
response, nonce-revocation decision and custody escalation. Local automated
evidence does not substitute for these human and deployment gates.
