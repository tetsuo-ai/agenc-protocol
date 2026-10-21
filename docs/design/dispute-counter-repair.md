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
