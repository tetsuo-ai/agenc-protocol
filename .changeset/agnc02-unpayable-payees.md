---
"@tetsuo-ai/protocol": patch
"@tetsuo-ai/marketplace-sdk": patch
---

AGNC-02: reject marketplace fee payees that settlement can never credit. Task
creation, both hire paths and service-listing create/update now fail with the
new `MarketplacePayeeUnpayable` (6415) error when a referrer or operator with a
nonzero fee is the program id or a runtime-reserved builtin/sysvar key. Such a
leg would otherwise block every worker payout. Instruction accounts, arguments
and account layouts are unchanged; only the IDL error list grows by one entry.
This is source hardening for the next coordinated program upgrade, not a
deployed release.
