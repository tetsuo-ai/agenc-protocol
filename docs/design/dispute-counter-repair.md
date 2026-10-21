# Dispute counter repair

This note explains `repair_dispute_initiator_counter`, a one-time governance
repair for a historical dispute whose counter units were lost. It also gives the
mainnet release order that uses it.

## The defect

`initiate_dispute` takes a writable `agent` and an optional writable
`worker_agent`. Before the alias guard, a caller could pass the same
AgentRegistration in both slots. Anchor deserializes each slot separately and
writes every writable copy back when the instruction ends. On the worker path
the handler records both increments on the `agent` copy:

- `active_dispute_votes`: one pending initiator outcome;
- `disputes_as_defendant`: one defendant liability.

The `worker_agent` copy is never modified and is written back last, so it
overwrote both increments. The dispute still carries the counter-tracked
marker (`total_voters = 0xff`), so it expects to own one unit of each counter.

The guard `worker_agent.key() != agent.key()` now rejects new cases. It cannot
repair an account that was already affected.

## Effect on an affected agent

The defendant side heals on its own. `expire_dispute` and `cancel_dispute`
decrement `disputes_as_defendant` with saturating arithmetic, so once every
affected dispute has exited the counter is back at its true value of zero.
While a dispute was still active the counter was one lower than it should have
been, which weakened the deregistration and stake-withdrawal gates for that
agent.

The initiator side does not heal. `apply_initiator_slash` decrements
`active_dispute_votes` with checked arithmetic and fails with `CorruptedData`
when no unit is left. One tracked outcome of the affected agent can therefore
never be finalized, and the release preflight blocks on it
(`tracked-initiator-outcome-unapplied`).

## The repair

`repair_dispute_initiator_counter(incident_signature)` adds exactly one unit to
the initiator counter. It requires:

- the ProtocolConfig authority as proposer and payer, and the configured M-of-N
  owners as signers in the remaining accounts;
- an incident dispute that is counter-tracked and worker-initiated, whose
  initiator and defendant are both the agent;
- a pending dispute of the same initiator that is counter-tracked, terminal,
  not yet finalized, and accepted by the same outcome decoder as
  `apply_initiator_slash`. It is the incident itself, or another dispute of the
  agent if the incident was finalized first and consumed the only unit;
- `active_dispute_votes == 0` on the agent;
- a nonzero historical transaction signature, stored for public verification.

The `DisputeCounterRepair` receipt PDA (`["dispute_counter_repair", incident]`)
is created with `init`, so each incident can be repaired at most once. The
instruction emits `DisputeInitiatorCounterRepaired`.

Why it cannot overcharge an agent: in every state the program produces, an
agent's `active_dispute_votes` is at least the number of its counter-tracked
disputes whose initiator outcome is not finalized. Only `apply_initiator_slash`
sets `initiator_slash_applied`, and it releases one unit at the same time. A
zero counter while a finalizable tracked outcome is pending is therefore proof
of a lost unit, and adding one unit can never exceed what the agent owes. The
repair never touches `disputes_as_defendant`, task funds, stake or reputation.
The ordinary finalizer then applies the normal outcome policy: no-fault for an
expired dispute, the usual initiator loss for a cancelled one.

## Mainnet incident

The only affected dispute on mainnet is `4Ei4hU9C7CjdEH5Zb8CdiPEGzyjQSSaKTvjJrmRMvPXL`,
created by transaction
`3eqScvKRWfphz2MUATtyrsowQVATiQK82ZCEJe4CHJkydWHWrqXeNy221cFWZ9Qfhm2ajWe7CeBkwmjwir1cf3q1`.
Its initiator agent `FPppuvejNG8T2iQFnQaezfxjW6WGMN4KkRHeEHgFiu1A` also has the
normal dispute `HycAkBQBynmyvxrkHcEK95snxYy7q2EUJ3ZvUD4qYp9v`. The agent holds one
unit of each counter for two tracked disputes. Read-only evidence is in
[the remediation record](../../artifacts/remediation/2026-10-21-dispute-counter-repair.json).

## Release order

The release rail requires zero Active disputes and zero agent counters before an
upgrade. The order below satisfies that and leaves no inconsistent state after
the release:

1. Pause through the ProtocolConfig multisig, as every release does.
2. Under revision 5, expire both disputes and finalize one with
   `apply_initiator_slash`. Both counters reach zero. Exactly one tracked
   outcome stays unfinalized because it owns no unit.
3. Upgrade. The predeploy dispute gate accepts this one state only while the
   live payload is the revision-5 payload, only for the recorded agent and
   disputes, and only with `AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR=1`.
4. Run `scripts/mainnet-repair-dispute-counter.mjs`. One transaction restores
   the unit and finalizes the remaining outcome.
5. Re-run the release rail. The postdeploy and prestamp gates have no allowance.
   They must report zero dispute blockers before the revision stamp, and the
   protocol cannot unpause without that stamp.

## Operator rail

Use `scripts/mainnet-repair-dispute-counter.mjs --phase prepare` while the
reviewed revision-5 payload is live. `RPC_URL` must select mainnet-beta and
`PAYER_KEYPAIR` must name a plain 64-byte JSON keypair file. The protocol must
already be paused. The default PLAN simulates each required expiry with zero
signatures. It never sends or signs a transaction. If either dispute is still
Active, the finalizer simulation is deferred until both are terminal. EXECUTE
expires each Active dispute, reads the resulting state, then finalizes the
recorded sibling. It verifies counters 0/0 and exactly one pending outcome.

Execution requires both `--execute` and
`--confirm 4Ei4hU9C7CjdEH5Zb8CdiPEGzyjQSSaKTvjJrmRMvPXL`. Both phases bind the
live loader and its custody to the committed upgrade-authority policy and
recheck that binding before signing and after confirmation. RPC URLs are
redacted. Only explicitly configured key file paths are loaded.

After upgrading, use `--phase repair` with `AUTHORITY_KEYPAIR` naming the
ProtocolConfig authority file, and `COSIGNERS` listing other owner file paths,
separated by commas. Supply independently reviewed `EXPECTED_IDL_SHA256` and
`EXPECTED_SO_SHA256`; optional `IDL_PATH` and `SO_PATH` select the corresponding
local artifacts. The IDL must include the canonical repair ABI. The approved
SBF must exactly match the live ProgramData payload, allowing only zero padding.
PLAN simulates the single transaction containing repair followed by finalization.
EXECUTE uses the same explicit incident confirmation. The rail checks the
receipt, both counters, finalization, and the full dispute scanner after sending.

The prepare rail supports single-worker SOL Exclusive and BidExclusive tasks.
It supplies parent evidence for dependent tasks, the accepted-bid suffix for
BidExclusive tasks, canonical completion bonds, and submission evidence. A
Submitted manual-validation record also requires its validation config. Token
rewards and peer-worker settlement are refused with an explicit unsupported-shape
error. These cases require a separately reviewed rail.

The predeploy exception requires `AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR=1` and
the exact recorded revision-5 payload hash. It only permits the one recorded
agent with zero counters and one unfinalized tracked outcome. Any additional
blocker fails closed. The postdeploy and prestamp gates never accept the
exception. Keep the protocol paused, repair immediately after upgrading, then
resume the release rail before any stamp.

Local proof: `AGENC_RPC_E2E=1 node --test
scripts/preflight-dispute-counter-repair-rpc.test.mjs` starts a disposable
validator on `AGENC_REPAIR_RPC_PORT` (default 19899), deriving its WebSocket,
faucet, gossip, and dynamic ports from that base. It refuses unavailable ports
or a missing `solana-test-validator`. The test needs the installed Agave tools,
root and tests-integration npm dependencies, the committed current IDL, and the
SBF produced by `cargo build-sbf`; no Anchor CLI or existing wallet is required.
It uses the real program ID and creates throwaway signer keys in memory. Genesis account overrides
reproduce the historical state by changing only the two counter bytes from 2/2
to 1/1. The test executes both exported phases and checks the complete final
state. Local genesis and executable checks are injected into exported helpers;
the CLI has no switch to bypass its mainnet or artifact checks.
