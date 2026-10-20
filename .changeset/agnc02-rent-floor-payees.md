---
"@tetsuo-ai/protocol": patch
"@tetsuo-ai/marketplace-sdk": patch
---

AGNC-02 follow-up: a marketplace fee leg that would leave its operator or
referrer payee below the rent-exempt minimum no longer blocks settlement. The
runtime rejects such a credit (`InsufficientFundsForRent`), so a small fee owed
to an unfunded payee made every worker payout revert until someone funded that
address. Settlement now pays the leg to the worker and emits the new
`MarketplaceFeeForfeited` event instead of `OperatorFeePaid` /
`ReferrerFeePaid`. Payees must keep their payout address rent-exempt to receive
fees below that floor. Instruction accounts, arguments, errors and account
layouts are unchanged; the IDL gains one event. This is source hardening for
the next coordinated program upgrade, not a deployed release.
