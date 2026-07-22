# Revision 5 coordinated cutover

> **Status: EXECUTED 2026-07-22.** Revision 5 is live on mainnet
> (`surface_revision = 5`, deployed executable SHA-256
> `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`, 2,303,608
> bytes). The upgrade was executed through the Squads v4 2-of-3 vault
> `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (loader upgrade execute tx
> `5iZiPGmU5pYSGEaNBHkTR1cpGhmGtffGp8ZSufD71ActwNyTSt4cFkLoGqiucFmQ3DveSRthCK5fuZHb3NB7Smh7`),
> after a top-level ProgramData extension of +120,384 bytes and preceded/followed
> by an `update_launch_controls` pause/unpause; `protocol_paused = false`. The
> live production surface is 101 instructions (the O(1) bid-accept redesign added
> `promote_bid`, `demote_ineligible_best`, and `settle_dispute_claim`). The
> procedure below is retained as the execution record.

Revision 5 is intentionally a flag-day upgrade for the three funded-hire and
activation instructions. It closes the gap where a buyer could fund a listing
hire before committing the exact task-specific work contract. The upgraded
program snapshots both the advertised listing hash and the buyer job-spec hash,
then refuses activation or a fresh claim unless the pinned `TaskJobSpec` matches.

## Atomic wire boundary

The instruction names stay stable at the public facade, but the signed wire uses
new discriminators:

| Instruction                        | Revision-4 discriminator | Revision-5 discriminator                                     | Revision-5 shape                                                        |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `hire_from_listing`                | `aee15144ac1361c2`       | `f15e7f0768aef074` (`global:hire_from_listing_v2`)           | 15 accounts, 7 args; final arg is non-zero `[u8;32] task_job_spec_hash` |
| `hire_from_listing_humanless`      | `5a8e27e196a1d931`       | `e5a3ab722674d755` (`global:hire_from_listing_humanless_v2`) | 14 accounts, 8 args; final arg is non-zero `[u8;32] task_job_spec_hash` |
| `set_task_job_spec` (full surface) | `866666561fa4cac1`       | `7609633ad7573a3b` (`global:set_task_job_spec_v2`)           | 10 accounts; final account is the canonical HireRecord PDA              |

This boundary is designed to be bidirectional: old writers must fail against
revision 5 and new writers must fail against revision 4. The compiled candidate
proves the first direction. The frozen revision-4 IDL and compiled canary prove
the local dispatcher facts described in the go/no section; final proof of the
second direction requires the three recorded pre-upgrade simulations against
the deployed full revision-4 binary. This prevents either side from accepting
trailing data/accounts under older semantics. The frozen mainnet-canary
`set_task_job_spec` surface is unchanged and must not be confused with the
full-surface v2 instruction.

Indexers and disaster-recovery replays are different: they must decode both old
and new transaction history. Keep the SDK's frozen revision-4 decoder in
production permanently and select by discriminator, never by the current IDL
alone.

## Required release set

The cutover is not ready until all of these artifacts are built, tested, and
staged from the same reviewed commit set:

- program binary, canonical IDL, SDK `0.12.0`, and protocol package `0.4.0`;
- React `0.5.0`, tools/MCP `0.5.0`, worker/moderation `0.2.0`, CLI `0.3.0`,
  and the coordinated store packages;
- agenc.ag transaction builder, indexer, web application, and historical replay;
- AgenC MMO and every other first-party writer;
- Ledger clear-signing support for the three v2 discriminators and the new task
  hash, with the legacy discriminator paths rejected for new signing;
- operator scripts, compact on-chain IDL, public documentation, installer pins,
  and rollback/maintenance messaging.

Hosted consumers must be deployable behind a revision-5/maintenance gate before
the program changes. A UI must never offer a hire button unless the backend,
SDK, and detected on-chain surface agree.

## Mainnet legacy-hire disposition

The latest read-only inventory found 62 revision-4 HireRecords, all with a zero
buyer-commitment tail. Revision 5 does not guess or retroactively choose a work
contract for them:

- 13 Open tasks have no assigned worker. Their creators can cancel/refund, then
  re-hire with an explicit buyer job-spec hash after cutover.
- 3 assigned tasks keep their existing settlement/dispute/cancel exits, but may
  not use a new activation or fresh-claim path.
- terminal records remain historical data and need no mutation.

Open tasks requiring cancel/re-hire:

| Task                                           | Creator                                        |
| ---------------------------------------------- | ---------------------------------------------- |
| `4uvNjBVPduegpGXHMGnBEDSKD5s47SMXnc7AuE1jatBe` | `6RA3TFvMtmpzQcX5rgVckXs5pPkTdCVXwXX5GBmh98Qi` |
| `5e3HwZraTPrFwyKNquEMaf5MnT9C9RJ59xqBsvF9gXHn` | `Qi5kLydxHjySoECV9SCkCb5wfQeZ8cS5ZnVRw5zAK99`  |
| `7Lk5r15HJsDF4Rsq4rbQAUDAkQH8rromk6wa3dPNcKyb` | `9DxBkahqY5RugFeHhWHjh6azRgxAf9RbqbMBhiHB5Zgp` |
| `7meCCcabn8s1rsxEuY5B495yQyPordKEkBMhjbg7TaTn` | `28GwhZmaus6gThmwt3WvyBopxNq1AhcgDBtmMgZQGGk2` |
| `855irecPivyvBbgkdAoRxNA49GxeB25mjbC7EJz2nprb` | `Dgu5kqSMdstcTPxsKcT45SHryaToxEEf54uDyUuTtz7P` |
| `8dHTB5JUirPsXrkssBg8bkGEnkXKjp2ctBM2n3m1XKQ4` | `9DxBkahqY5RugFeHhWHjh6azRgxAf9RbqbMBhiHB5Zgp` |
| `8fvBxrcMWxnZg9vJrSz2KwcpaSCYc2cmL4Receo8g8jF` | `9DxBkahqY5RugFeHhWHjh6azRgxAf9RbqbMBhiHB5Zgp` |
| `9B75YTaVLxVaEG1a9K5Yi91nRzE7NFrhbgNjXuTNu4bu` | `4VbnoQVkPCfgmowktwn47kTv3TgVxpFiFLMmQrbnBGXf` |
| `9LuUm62NZSVspm3Y4xkmkPWkTiKDK67JhB25C4hWE2QQ` | `693P1Xqpw8LJT4ve1PHfnEgJDsHNppcaGw7GYM6foYuK` |
| `B1iP3UT3rdMvHnw47iBCfErHihNZNcRV1oQLavoZWn4Q` | `Dgu5kqSMdstcTPxsKcT45SHryaToxEEf54uDyUuTtz7P` |
| `bwDPNVRSjMV2hrMNkRXrdCizS8DpxyGQetaqTnk2KAR`  | `9DxBkahqY5RugFeHhWHjh6azRgxAf9RbqbMBhiHB5Zgp` |
| `H27L83KQTiJtYEMdxTZzP4bZBvkPKvPUN6b74j9pEyfa` | `4VbnoQVkPCfgmowktwn47kTv3TgVxpFiFLMmQrbnBGXf` |
| `Hy8nVgUB52K4drtBCmcwogwwQfc831ZhYgfofNghwKVv` | `DFFnbAJ11gge74u4k4884hDwYQyhXvh12JdMMW74NaCB` |

Assigned, settlement-only tasks:

| Task                                           | Snapshot status   | Creator                                        |
| ---------------------------------------------- | ----------------- | ---------------------------------------------- |
| `5q6SAunSzY8HTNvMjLQnjQLARggugoB2ttjXUyAzFhRy` | InProgress        | `DFFnbAJ11gge74u4k4884hDwYQyhXvh12JdMMW74NaCB` |
| `7ExM8ur2LdC3fWC9GHHg6z5eAmyknfeKdPBwoZtBBLfY` | InProgress        | `Bc5a4UfKiMTFWedCjZZZEUzGb9kRHShbzFPovpSRVLyu` |
| `9Jr9urgNHJb55vDU19UjGsPUUFWpAt4K7nM8MZ2K9Qsy` | PendingValidation | `8oZCwjf58X9Hnv4T3FtqxL5TQnb9vz9xQvKqjBJ5obBC` |

Re-run the canonical scanner immediately before any proposal. These tables are
a human-readable snapshot, not an authority for transaction construction.

## Execution order

1. Freeze the reviewed commits and rerun every local, CI, dependency, SBF,
   consumer, historical-replay, and read-only mainnet gate. Record exact binary
   and IDL hashes. Resolve every repo-controlled failure.
2. Stage agenc.ag, MMO, indexer, Ledger, and other writers behind maintenance or
   surface gates. Confirm the historical decoder can replay one real revision-4
   hire and one revision-5 fixture. Before replacing revision 4, capture unsigned
   `simulateTransaction` evidence that its deployed full binary returns
   `InstructionFallbackNotFound` for each of the three exact v2 discriminators.
   The committed revision-4 IDL dispatcher snapshot and compiled frozen-canary
   rejection test are deterministic supporting evidence, but they are not a
   substitute for executing the deployed 99-instruction revision-4 binary.
3. Obtain a separately reviewed in-program multisig action to pause the protocol.
   Verify the paused byte from mainnet; the deployment rail never pauses itself.
4. Repeat all live-state scans. Any new blocker aborts. Record the current 13/3
   legacy-hire disposition and notify affected creators.
5. If the final binary exceeds ProgramData capacity, execute the exact top-level
   legacy `ExtendProgram` action with the pinned official Agave CLI 4.1.0 rail;
   current Agave rejects extension through Squads CPI. Require two independent
   RPC pre/postflights, wait for a later slot, then repeat every preflight and
   capacity/rent calculation. The thrice-reproduced
   2,303,608-byte candidate needs exactly 120,384 additional payload bytes; the
   prior two-provider 704,853,120-lamport top-up was computed for the superseded
   2,284,496-byte candidate and must be re-read for the new length, plus fees
   from the explicit payer. The former
   authority/payer wallet had sufficient aggregate funds at the recorded snapshot,
   but its balance must be re-read immediately before execution.
6. Upload the reviewed buffer and execute the Squads program-upgrade proposal.
   Verify on-chain executable hash and authority before continuing.
7. Run only the required migrations/sweeps. Repeat all post-deploy inventories.
   Publish and fetch-verify the matching compact on-chain IDL. Stamp
   `surface_revision = 5` last; never advertise revision 5 over an old IDL.
   Then capture the actual finalized ProgramData address/deployment slot,
   retained authority, executable SHA-256, and reviewed source commit. Patch
   that observed identity into `agenc promote`, rebuild and repack the CLI, and
   independently re-audit the resulting artifact. Revision-5 promotion must
   remain blocked until this post-upgrade evidence exists; never substitute a
   predicted slot or pre-upgrade candidate identity.
8. Publish the coordinated packages and switch staged hosted writers to v2 while
   the protocol remains paused. Confirm old-wire writes fail, new-wire canary
   transactions simulate correctly, and historical replay remains intact.
9. Run end-to-end mainnet canaries for direct tasks, registered hire, humanless
   hire, worker claim, submission, review, settlement, refund, and Ledger
   clear-signing. Do not use customer tasks as canaries.
10. Only after the canaries and independent operator review pass, obtain the
    separate action to unpause. Monitor errors, balances, indexer convergence,
    and the hosted UI. Roll hosted consumers back to maintenance mode on any
    anomaly; an on-chain rollback requires its own reviewed Squads proposal and
    cannot restore a transaction already settled under revision 5.

## Go/no-go invariants

- No artifact, dependency, consumer, or documentation drift.
- No unreviewed signing keys, seed phrases, or quorum assumptions.
- ProgramData capacity and wallet/vault funding are measured from the final
  binary at ceremony time, not copied from an earlier estimate.
- The compiled revision-5 candidate rejects all three legacy discriminators.
- The canonical revision-4 IDL at verified source commit `097ded1` has 99 unique
  discriminators, includes the three legacy values, and contains none of the
  three v2 values. The compiled frozen-canary dispatcher independently rejects
  all three v2 values. Because the exact deployed full revision-4 SBF is not a
  committed local fixture, the final go/no additionally requires recorded
  pre-upgrade simulations proving the deployed revision-4 binary returns
  `InstructionFallbackNotFound` for all three v2 values.
- A funded listing hire cannot activate or be claimed with any hash other than
  the immutable buyer commitment.
- Direct tasks keep their canonical one-hash/zero-tail behavior.
- Legacy Open hires retain a refund exit; assigned legacy hires retain
  settlement exits; no compatibility branch invents a missing work contract.
- The indexer permanently preserves revision-4 replay support.
