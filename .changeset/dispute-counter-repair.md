---
"@tetsuo-ai/protocol": patch
"@tetsuo-ai/marketplace-sdk": patch
---

Adds `repair_dispute_initiator_counter`, a one-time governance repair for a
dispute whose initiator-outcome counter unit was lost when an older
`initiate_dispute` received the same agent account as both `agent` and
`worker_agent` (now rejected). The protocol authority proposes and the
ProtocolConfig M-of-N owners approve. It restores exactly one unit, only when
the initiator's counter is zero while a finalizable counter-tracked outcome of
that initiator is pending, and a `DisputeCounterRepair` receipt makes it
one-time. The IDL gains one instruction, one account type
(`DisputeCounterRepair`), one event (`DisputeInitiatorCounterRepaired`) and two
errors (`DisputeCounterRepairNotApplicable`, `DisputeCounterNotDeficient`).
Existing instructions, accounts and errors are unchanged. This is source for
the next coordinated program upgrade, not a deployed release.
