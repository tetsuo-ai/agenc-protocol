# Mainnet Mainline

This document records what `main` means for the live AgenC protocol.

## Policy

`main` is the canonical public development branch. When it contains an
undeployed candidate, this document must name the exact deployed revision and
commit separately and must not describe candidate source or artifacts as live.
The deployed commit remains reproducible even while `main` advances.

When the on-chain mainnet program changes, update `main` in the same release
window or before the deploy is announced publicly.

## Current Mainnet Deployment

> **As of 2026-11-21 the revision-9 surface is LIVE on mainnet**
> (`surface_revision = 9` / `SURFACE_REVISION_ACCOUNTABLE_REVIEW`). The
> upgrade was Squads v4 proposal (transaction index) 15 on multisig
> `7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY`, approved by
> `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` and
> `3HvRz5tYADe92Va435ds2nxgUSWZhv8bHxm1wNfSNznx`, and executed through the
> 2-of-3 upgrade-authority vault (`Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf`,
> execute tx
> `NaSwiMaL3Uab3SyMfCg6K9taDr9YiuKbP7qh5Uo7jy33nSRTVLrxEkNocaZrfMVyhkhWRKGVssqzZLD8xgEcBjv`).
> No ProgramData extension was needed. The 106-instruction release IDL was
> published and `stamp_release_surface` atomically stamped the revision while
> the protocol was paused. `update_launch_controls` reopened it at 2026-11-21
> 19:19:26 UTC (tx
> `3xaMUtbCLifFjkhjnptS4UYMELLMGb4Uijn55YnCAUQ3YwkqQD9wAKcyZoauHNjTAqsoTLfcnQScwzS8AjJpPzm6`,
> slot 472253687).
>
> Prior state (superseded): from 2026-10-28 the 104-instruction revision-8
> surface (`surface_revision = 8` / FEE_QUALIFIED_RATINGS, slot 462468899,
> normalized executable hash `ffb8f3cb…`) was live. Before it, from 2026-07-22,
> the 101-instruction revision-5 surface (`surface_revision = 5` /
> AUDIT_HARDENING, slot 434489452, executable SHA-256 `049a66e3…`) was live, and
> from 2026-07-09 the 99-instruction revision-4 surface (`surface_revision = 4` /
> BATCH4, slot 431918664). Growth path: 25-ix canary, 84-ix full surface
> (2026-06-11), 90-ix P1.2 open roster (2026-07-03), additive batches 2 to 4,
> revision 5 (2026-07-22), revision 8 (2026-10-28), then revision 9 (this
> deploy).

- Program ID: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`
- Program source path: `programs/agenc-coordination/`
- `declare_id!` location: `programs/agenc-coordination/src/lib.rs`
- Live surface: 106-instruction revision-9 surface (default features),
  `surface_revision = 9` (ACCOUNTABLE_REVIEW)
- Release commit: `154d286659592c799bd111bf416fdba7ccc704b4` on `main` (git
  tree `a5618409dd63be37dfde6dd6f0c161ca0d0b7149`). The verification record,
  OtterSec and `agenc promote` name this commit. It is the last commit of PR
  #351, which rebase-merged `release/rev9` into `main` on 2026-11-21 at
  15:51:24 UTC. The binary was frozen and signed against
  `e62c82bf1a12b04ef37ef1f1bb6b5ce1058c03a3` (git tree
  `90f6018b49a1dbae04d75866c6633fc5e22baec9`), which was pushed to
  `release/rev9` only after the execute. On `main` that commit is `c8005e3`,
  with the same tree; the three CI fixes after it, up to `154d286`, change
  nothing under `programs/`. Both commits have the program tree
  `df10b3fc66c2707b58305311da6b060c928b594f` (`programs/agenc-coordination`).
- Release binary: 2,183,448 bytes, SHA-256
  `fa56b36b9175f7c1424c8119385e88ee116320d9ab08dc3f590ef662580b5e35`. The
  solana-verify normalized hash (trailing zeros removed) is
  `baf5be55c86f0a5c79eb52229a3412121a1a3c5f2a5699f4b24d75c7e8dc3608`. Built
  reproducibly with solana-verify 0.5.2 and the Agave 4.1.0 image
  `solanafoundation/solana-verifiable-build@sha256:6468b89ae21d87b8eb002f894ac3f3442dbd8bcf5ea93414051e96e00d03b5ab`,
  on a macOS and a Linux machine with the same bytes. OtterSec reproduced it
  independently.
- ProgramData `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw`: capacity unchanged
  at 2,303,653 account-data bytes. The 2,303,608-byte payload has SHA-256
  `5d1ff9c667f9825194974c3f98f5766cc39628f98b290198df634eb78321db68`; it is the
  release binary followed only by zero padding (120,160 bytes of headroom).
  ProgramData still holds 11.703207480 SOL, its rent floor, so nothing spilled
  from it. The loader closed the upload buffer and returned its 11.092754041 SOL
  to the spill account `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh`.
- Deployment slot: 472177819 (block time 2026-11-21 14:47:17 UTC). The upload
  buffer `2QdWbkiRXVHc7YzYuZWRmeVr7hLjDS9BuMGYWoKsaa9f` was consumed by the
  upgrade.
- On-chain IDL: `GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1` holds the
  106-instruction release IDL. The rail published it from the committed
  `artifacts/anchor/idl/agenc_coordination.json` (SHA-256
  `89ed7a9219bffc71178c7111497162efddff4e2bfc6cb2ed43a162bc64bebd8a`, with the
  `TaskMarker` account) and verified it from chain (canonical digest
  `fd49d117121f903d398152bd58aaa907055e04f91c2dafda0c4fcfe59779ce8f`).
- Revision stamp: `stamp_release_surface` set `surface_revision = 9` in tx
  `3vndWhKJ3LsXYXh8kaSoDSTPKrXGp4jdNi2QuH9ydbzSoMCiM7KVzJ5GJF5w9KAchRfRMHq1m4Z73oPybZKozfMb`
  at slot 472180172 (2026-11-21 14:55:39 UTC).
- `ProtocolConfig` `DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs`: 351 bytes
  (layout unchanged), `surface_revision = 9`, `disabled_task_type_mask = 0`.
  `protocol_paused` was true from 14:19:54 UTC until the 19:19:26 UTC unpause.
- Verified build: OtterSec reports `is_verified: true` for commit `154d286…`,
  with `on_chain_hash` and `executable_hash` both `baf5be55…` (last verified
  2026-11-21T15:56:30Z). See [`VERIFIABLE_BUILDS.md`](./VERIFIABLE_BUILDS.md).
- Upgrade authority: unchanged, the Squads vault above. See
  [`UPGRADE_AUTHORITY.md`](./UPGRADE_AUTHORITY.md).
- Explorer security metadata: not updated for revision 9. The canonical PMP
  `security` record `HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw` still holds
  the 841-byte revision-8 `programs/agenc-coordination/security.json` (SHA-256
  `e729a01fe966ded0c7e632d80756a5de8f720f70c74f7e902e75b4f2e7f987e9`), which
  names commit `f39b383…`. The revision-9 update is deferred. See
  [`EXPLORER_METADATA.md`](./EXPLORER_METADATA.md).

## Revision 9 (deployed 2026-11-21)

The production/default `#[program]` surface contains 106 Rust entrypoints. That
number is derived from the cfg-gated source at the release commit, not this
document:

- production defaults: 106 (`spl-token-rewards`; `private-zk` off);
- explicit development `private-zk`: 109;
- restricted `mainnet-canary`: 25;
- raw `pub fn` declarations across the mutually exclusive full/canary modules:
  134, representing 109 unique names because the canary's 25 names are repeated.

`scripts/mainnet-upgrade.mjs` enforces the exact 106/109/25 sets and refuses
stale artifacts. The three private-proof entrypoints stay quarantined.

Revision 9 (accountable review) changes the wire of existing instructions, so
revision-8 clients cannot speak it and revision-9 clients refuse a revision-8
program. The wire changes now live are:

- two new instructions: `dispute_rejection` and `release_claim`;
- three new account types: `CreatorStats`, `DisputeBond` and the 56-byte
  `TaskMarker`;
- 18 existing instructions take appended accounts. Two of them also change
  their data: `hire_from_listing` v3 and a new `resolve_reject_frozen`
  discriminator;
- turn-downs: a single-worker review task is turned down only with
  `reject_and_freeze`, which opens a fixed 72-hour dispute window. The worker
  may dispute once with `dispute_rejection`, posting a bond of max(10% of the
  price, 0.01 SOL), and 2 of the 3 owners then have 72 hours to rule;
- task disputes: every filing posts a `DisputeBond`. A ruling comes from a
  seated resolver with no stake in it or from 2 of the 3 owners;
- records: each creator wallet has a `CreatorStats` record and each worker an
  `AgentStats` record;
- claim deposits: a non-contest, non-bid claim posts max(10% of the worker
  share, 0.005 SOL). It comes back at the first delivery, or with
  `release_claim` within one hour of the claim;
- agent-door hires through `hire_from_listing` v3 get creator review;
- `close_task` compacts a finished task into a `TaskMarker` at the same address
  and refunds the rest of its rent to the creator;
- turning moderation on or off, choosing the moderator, suspending an agent and
  changing the moderation attestor roster need 2 of the 3 owners. A creator
  cannot moderate its own task, and a provider cannot moderate its own listing;
- new tasks can no longer use ExternalAttestation validation, or CreatorReview
  on token-reward and bid tasks.

The details and the known limits are in
[Revision 9 notes](./PROGRAM_SURFACE.md#revision-9-notes). Revision 9 has no
dispute counter repair: the repair rail is revision 8 only and refuses the
revision-9 IDL ([design](./design/dispute-counter-repair.md)).

### Revision-9 ceremony (2026-11-21)

Every step after the pause ran while the protocol was paused. Times are UTC
block times.

1. Pause through the ProtocolConfig multisig (14:19:54, tx
   `35eGLdGNSSdRpjHEtg7PofDkZ4jbpWpHmtJvTQZXuVx8t817gfjDVi4a9abuh3edHrwGgH3Pf8jVL5hUt646jhJL`).
2. Renew the moderation heartbeat on the revision-8 wire (14:20:57, tx
   `M98DrmpwmjXx7CfjtFowqZgsTR3u7shSaByydpCNdT93GZcfg9Ai5KKeisn3Du3FwkN8CEeAZm2ht6bB7dLhdsm`).
   It is valid for 90 days (window 7,776,000 s), so it lapses around 2027-02-19
   unless renewed.
3. Run the release rail preflight. It passed with zero cutover blockers.
4. Upload buffer `2QdWbkiRXVHc7YzYuZWRmeVr7hLjDS9BuMGYWoKsaa9f` and hand its
   authority to the vault. RPC rate limits stopped the upload three times; each
   rerun resumed the same buffer, which then held exactly the release binary.
5. Create Squads proposal 15 (14:43:52) and approve it with
   `HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh` and
   `3HvRz5tYADe92Va435ds2nxgUSWZhv8bHxm1wNfSNznx`.
6. Execute the Squads upgrade (proposal 15, 14:47:17).
7. Check the bytes: the ProgramData payload is the release binary followed only
   by zero padding.
8. Publish the release IDL to `GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1`
   from the committed IDL and verify it from chain.
9. Stamp revision 9 with `stamp_release_surface` (14:55:39).
10. Publish the release commit: push `e62c82b` to `release/rev9`, open PR
    #351, fix three CI failures outside `programs/`, and rebase-merge it once
    the required checks pass (15:51:24). `main` then ends at `154d286` with the
    same program tree.
11. Update the verified-build record through Squads proposal 16 (15:54:48).
    OtterSec verified it at 15:56:30.
12. Publish the revision-9 client train (18:05 to 19:18).
13. Unpause with `update_launch_controls` (19:19:26, tx
    `3xaMUtbCLifFjkhjnptS4UYMELLMGb4Uijn55YnCAUQ3YwkqQD9wAKcyZoauHNjTAqsoTLfcnQScwzS8AjJpPzm6`).

Unlike revision 8, the ceremony had no dispute counter repair, and no Squads
proposal touched the PMP security record (deferred, see
[`EXPLORER_METADATA.md`](./EXPLORER_METADATA.md)).

The coordinated revision-9 client release train is `@tetsuo-ai/protocol` 0.6.0,
`@tetsuo-ai/marketplace-sdk` 0.14.0, `@tetsuo-ai/marketplace-react`,
`@tetsuo-ai/marketplace-tools` and `@tetsuo-ai/marketplace-mcp` 0.7.0,
`@tetsuo-ai/agenc-worker` 0.4.0 and `@tetsuo-ai/agenc-cli` 0.5.0.
`@tetsuo-ai/marketplace-moderation` stays 0.3.0, unchanged. The seven packages
were published on 2026-11-21, before the unpause, through the tag-driven release
workflow with npm trusted publishing and provenance. Each npm integrity equals
its pin in `release-train.json`. The unscoped `agenc-cli` alias 0.5.0 is not
published yet: it waits for npm trusted publishing on that package, and npm
still has 0.2.0. See [`VERSIONING.md`](./VERSIONING.md).

## Revision 8 (deployed 2026-10-28, superseded 2026-11-21)

Revision 8 was live on mainnet from 2026-10-28 until the 2026-11-21 revision-9
upgrade. Its production/default `#[program]` surface contained 104 Rust
entrypoints. That number was derived from the cfg-gated source at the release
commit, not this document:

- production defaults: 104 (`spl-token-rewards`; `private-zk` off);
- explicit development `private-zk`: 107;
- restricted `mainnet-canary`: 25;
- raw `pub fn` declarations across the mutually exclusive full/canary modules:
  132, representing 107 unique names because the canary's 25 names are repeated.

For revision 8, `scripts/mainnet-upgrade.mjs` enforced the exact 104/107/25
sets and refused stale artifacts. The three private-proof entrypoints stayed
quarantined, as in revision 5.

Mainnet moved from revision 5 straight to revision 8. Revisions 6 and 7 were
never stamped on mainnet on their own; their surfaces are part of revision 8.
The wire changes it brought live were:

- revision-6 wallet feed votes: `upvote_post_by_authority` and the
  `FeedAuthorityVote` account family. Legacy `upvote_post` writes fail closed;
  historical `FeedVote` accounts and events stay readable
  ([design](./design/authority-feed-votes.md));
- revision-7 opt-in per-wallet task quotas: `configure_task_creation_quota` and
  one optional writable suffix on the five creation paths
  ([design](./design/authority-task-quotas.md));
- revision-8 fee-qualified ratings: each new listing or skill rating needs a
  recorded SOL protocol fee of at least 100,000 lamports. Historical aggregates
  are not recalculated ([design](./design/fee-qualified-ratings.md));
- AGNC-02: fee-payee snapshots reject payees no transaction can credit
  (`MarketplacePayeeUnpayable`), and the rent-floor payee forfeit pays a fee leg
  that would leave its payee below the rent-exempt minimum to the worker and
  emits `MarketplaceFeeForfeited`;
- AGNC-03: `cancel_dispute` records the disputed duration as review-clock debt
  and requires the writable validation config when it restores
  PendingValidation; `auto_accept_task_result` waits for the review deadline
  plus that debt;
- AGNC-04: `update_bid` requires full bidder eligibility, and
  `demote_ineligible_best` closes the ineligible leader's bid and gains two
  required accounts (`bidder_market_state`, `bidder_authority`);
- the dispute duplicate-agent guard: `initiate_dispute` and
  `validate_task_result` reject the same agent account in a primary and an
  optional writable slot;
- the one-time `repair_dispute_initiator_counter` with its
  `DisputeCounterRepair` receipt ([design](./design/dispute-counter-repair.md)).

The release also carries the other remediation merged since revision 5; see
[`audit/REMEDIATION_REVIEW_2026-10-19.md`](./audit/REMEDIATION_REVIEW_2026-10-19.md).
The published advisories GHSA-gx7m-h6rr-c6qr (duplicate agent accounts, Medium
5.4) and GHSA-qqhf-jhpm-xcw5 (AGNC-02, Medium 5.7) are patched in revision 8.

### Revision-8 ceremony (2026-10-28)

Every step after the pause ran while the protocol was paused:

1. Pause through the ProtocolConfig multisig.
2. Renew the moderation heartbeat. It is valid for 90 days (window 7,776,000 s),
   so it lapses around 2027-01-26 unless renewed.
3. Prepare the dispute repair under revision 5: expire
   `4Ei4hU9C7CjdEH5Zb8CdiPEGzyjQSSaKTvjJrmRMvPXL` and
   `HycAkBQBynmyvxrkHcEK95snxYy7q2EUJ3ZvUD4qYp9v`, then finalize `HycAkB…`.
4. Run the release rail preflight. It passed.
5. Upload buffer `BvLYRwrim58xJqfug7oSAycdwBzYUdneswWbS1jnZ4QF`.
6. Execute the Squads upgrade (proposal 11).
7. Check the bytes: the ProgramData payload is the release binary followed only
   by zero padding.
8. Repair the dispute counter atomically: one transaction ran
   `repair_dispute_initiator_counter` and `apply_initiator_slash` on `4Ei4hU…`.
   Agent `FPppuvejNG8T2iQFnQaezfxjW6WGMN4KkRHeEHgFiu1A` ended with counters 0/0.
   The one-time receipt is `3aDqSrQjpR68Jt5ksCb239DXtTFMjLGZSZJPh5s8vL6G`.
9. Publish the release IDL to `GGj5xvRY6vuvWt3NkNhdtntDipBnAXEDaVVUcyqL7mJ1`.
10. Stamp revision 8 with `stamp_release_surface`.
11. Update the verified-build record through Squads proposals 12 and 13.
    OtterSec verified it at 12:27:32 UTC.
12. Create the canonical PMP security record through Squads proposal 14
    (12:54:52 UTC).
13. Unpause with `update_launch_controls` (13:08:08 UTC, tx
    `42P6rd4EFovhfjVPMjm8kpKjNd6oM2yergFAgK7wL8LfQSvJE64su1dUUbFBLrKaD29tksmLRzj3RWAfPC1mwcmm`).

The coordinated revision-8 client release train is `@tetsuo-ai/protocol` 0.5.2,
`@tetsuo-ai/marketplace-sdk` 0.13.0, `@tetsuo-ai/marketplace-react` and
`@tetsuo-ai/marketplace-tools` 0.6.0, `@tetsuo-ai/marketplace-mcp` 0.6.1,
`@tetsuo-ai/marketplace-moderation` and `@tetsuo-ai/agenc-worker` 0.3.0, and
`@tetsuo-ai/agenc-cli` 0.4.0. It was released through the tag-driven release
workflow. The unscoped `agenc-cli` alias was not published for revision 8 (npm
still has 0.2.0). See [`VERSIONING.md`](./VERSIONING.md).

## Revision 5 (deployed 2026-07-22, superseded 2026-10-28)

Revision 5 was live on mainnet from 2026-07-22 until the 2026-10-28 revision-8
upgrade. Its upgrade was executed through the Squads v4 2-of-3 upgrade-authority
vault (execute tx
`5iZiPGmU5pYSGEaNBHkTR1cpGhmGtffGp8ZSufD71ActwNyTSt4cFkLoGqiucFmQ3DveSRthCK5fuZHb3NB7Smh7`,
deployment slot 434489452), after a top-level ProgramData extension of +120,384
bytes to 2,303,653 account-data bytes, and bracketed by an
`update_launch_controls` pause/unpause. The deployed executable SHA-256 was
`049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2` (2,303,608
bytes, byte-equal to the reviewed candidate). The 101-instruction compact IDL
was published, `stamp_release_surface` stamped `surface_revision = 5`, and the
protocol was unpaused (`protocol_paused = false`).

Post-deploy note: 89 revision-4 bond-post-eligible third-party tasks were live
through the upload window under an explicit operator-accepted race
(`AGENC_ACCEPT_BOND_RACE`); the post-upgrade completion-bond inventory verified
zero, so the race did not materialize.

The revision-5 production/default `#[program]` surface contained 101 actual
Rust entrypoints (the O(1) bid-accept redesign added `promote_bid`,
`demote_ineligible_best`, and `settle_dispute_claim`). That number was derived
from the revision-5 cfg-gated source, not this document:

- production defaults: 101 (`spl-token-rewards`; `private-zk` off);
- explicit development `private-zk`: 104;
- restricted `mainnet-canary`: 25;
- raw `pub fn` declarations across the mutually exclusive full/canary modules:
  129, representing 104 unique names because the canary's 25 names are repeated.

The three private-proof entrypoints are quarantined because the guest,
verifier/router deployment, and end-to-end proof policy have not been
independently established for mainnet. Production builds and IDLs must exclude
them; for revision 5, `scripts/mainnet-upgrade.mjs` enforced the exact
101/104/25 sets and refused stale artifacts.

Revision 5 is a coordinated, paused cutover rather than an in-place client
compatibility promise. It hardens authority and canonical-PDA checks, principal
conservation, disputes and slash finalizers, immutable bid/job-spec terms,
dependency and moderation gates, governance reachability, staking collateral,
service/goods/skill compare-and-swap semantics, token-account validation, and
terminal child cleanup. It also adds the narrowly scoped
`reclaim_orphan_task_child` rent-recovery instruction. `TaskBid` grows
append-only from 250 to 252 bytes to snapshot its accepted-bid no-show policy;
the mainnet inventory then contained no bid accounts.

The three funded-hire/activation writes use explicit revision-5 discriminators
and a separate buyer-specific job-spec commitment; neither old-to-new nor
new-to-old write skew is accepted. Historical indexer replay must retain a
frozen revision-4 decoder. The exact atomic release order and the inventoried
legacy-hire exits are in [`REVISION_5_CUTOVER.md`](./REVISION_5_CUTOVER.md).

The deployment rail is deliberately fail-closed:

- it requires a fresh production binary and matching production IDL (101
  instructions for revision 5, 104 for revision 8, 106 for revision 9);
- it verifies the canonical ProgramData and Squads v4 2-of-3 vault/controller
  policy instead of inferring an EOA from account shape;
- it proves the approved binary fits the live ProgramData allocation and forces
  `--no-auto-extend` on direct CLI deployment;
- in execute mode, it refuses a needed deploy while migration is pending unless
  `sweep` is the immediately following selected step, preventing a partial
  `--only deploy` run from abandoning the typed-read frozen window;
- it requires the protocol to be explicitly paused by a separately approved
  governance/multisig action;
- it repeats account inventories before deployment and immediately before the
  revision stamp;
- it blocks active disputes/proposals, delegation state, unsafe task children,
  token escrow, dependency obligations, RejectFrozen principal, hired-provider
  drift, job-spec/BLOCK drift, accepted/ambiguous bid contracts, collaborative
  reward insolvency, or active marketplace-payee aliases;
- it never pauses, unpauses, signs, deploys, stamps, or publishes an IDL on its
  own.

**Pre-ceremony ProgramData capacity (resolved 2026-07-22):** before the
revision-5 extend, read-only mainnet RPC resolved the canonical ProgramData
account as `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw`, with data length
2,183,269 bytes (45 loader metadata + 2,183,224 executable payload). The
reviewed final production SBF is 2,303,608 bytes, SHA-256
`049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`,
and exceeded that payload by exactly 120,384 bytes. The extension ran; live
ProgramData is now 2,303,653 account-data bytes (see Current Mainnet
Deployment above). That target superseded
the pre-close-task-fix 2,284,496-byte `79f55a68…` identity: the 2026-07-20
close-task fix build and two isolated 2026-07-21 rebuilds of the canonical
`programs/agenc-coordination/target/deploy/agenc_coordination.so` all
reproduced these exact bytes. The loader maximum remains 10,485,760
account-data bytes, or 10,485,715 executable bytes after ProgramData metadata.
The exact 120,384-byte extension satisfies mainnet's active SIMD-0431 minimum.

All former 2,284,496-byte / 101,272-byte-extension figures (and the earlier
2,284,384-byte capacity, rent, Buffer, and 101,160-byte extension figures) are
superseded. For the bound artifact, the target ProgramData account length is
2,303,653 bytes and the upgrade Buffer length is 2,303,645 bytes. The standard
rent formula then gave a 16,034,315,760-lamport ProgramData floor at that length;
the 2026-07-20 dual-provider rent/balance evidence (15,901,296,240 /
15,901,240,560 floors, 15,196,443,120 live balance, 704,853,120-lamport top-up
at context slots 434137752/434137753) was read for the superseded 2,284,541-byte
target and must be re-read from two independent providers for the new length
immediately before any ceremony; the rail recomputes rent, funding, and the
top-up live and additionally requires a 1,000,000-lamport payer fee reserve. The official
[`getMinimumBalanceForRentExemption` contract](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)
accepts a commitment but returns no context slot; it does not support
`minContextSlot`. The extension
rail therefore sends only `{ commitment: "finalized" }`, requires the two
providers to return the same estimate, and uses it only for pre-send funding.
The loader/runtime enforces rent during execution. Finalized postflight re-queries
both providers and requires agreement on the rent floor and immutable postimage.
Each independently observed balance must be at least that floor and records its
own `excessLamports`; permissionless dust or ordinary finalized-provider lag cannot
make a correct irreversible extension unrecoverable. A stable-field/rent-floor
disagreement or a floor above either balance fails closed.

The Squads authority vault held 27,216,000 lamports at finalized provider
context slots 434137753 and 434137755, but current Agave rejects legacy extension
through CPI, so that balance is not used for extension. The former
authority/payer wallet separately held
19.555838965 SOL on both providers at finalized slot 434137785. That balance
exceeds the presently calculated extension plus Buffer requirements, but it is
still only dated evidence: re-query rent and the selected payer during the
ceremony. No vault-funding transfer is required for the top-level extension
itself.

Before the binary upgrade, execute loader legacy `ExtendProgram` for the exact
120,384-byte shortfall as a top-level transaction. Mainnet never activated
`ExtendProgramChecked`, while both legacy and checked extension are unavailable
through current Agave CPI; therefore **do not** create a Squads extension proposal.
The pinned `scripts/program-extend-mainnet.mjs` rail requires official Agave CLI
4.1.0 from the reviewed source commit, the supplied official release archive,
and the exact x86_64 Linux binary hash. It measures both supplied files, copies
the binary through no-follow descriptors into a private mode-0700 directory,
rehashes the destination, and executes that still-open inode rather than reopening
the operator path. The payer keypair is likewise copied once from a private,
single-link no-follow source into a mode-0400 inode, unlinked, and passed as child
file descriptor 4 for both address derivation and the irreversible transaction;
the mutable operator path is never reopened and secret bytes are never logged,
hashed, or serialized. The rail requires an explicitly funded System-owned payer
and a durable untracked evidence file. It checks genesis, Program/ProgramData linkage,
the existing Squads upgrade authority, inactive checked-feature state, active
SIMD-0431 state, exact capacity arithmetic, rent, funding, ProgramData slot, and
original payload hash on two independent finalized RPCs before execution. Its
checked-in production policy is `reviewed-final-twice-reproduced` and binds the
exact SBF hash, 2,303,608-byte payload, and 120,384-byte extension above; policy
arithmetic drift or malformed/unbound fields fail before file or RPC work.
Postflight paginates finalized ProgramData history until it reaches the saved
pre-send signature anchor (bounded at 100 pages of 1,000; failure to reach the
anchor aborts), then independently retrieves and decodes the exact expected
loader instruction through both RPCs. Its signature and ProgramData write slot
must agree and be strictly newer than both saved preflight context slots. Both
providers must
also prove identical whole-payload hashes, an unchanged old payload prefix, an
exact zero-filled 120,384-byte suffix, authority, and rent floor. Each provider's
possibly different dusted balance and exact surplus are retained and validated.
Transaction signature and slot must agree; each provider's standards-valid
nullable `blockTime` is retained and checked when present. Use
`--postflight-only` with the same evidence after an
interrupted run.

The evidence is a mode-0600, version-3, policy-bound record written through an
fsynced exclusive temp file and atomic publication. Phase changes hold an
exclusive sidecar lock across exact-record comparison and atomic rename, then
fsync the parent directory; a surviving lock fails closed and may be removed
only after confirming that no writer remains active. Resume validates every
field and relationship, including bounded-future phase timestamps. Transaction
wall-clock chronology is checked when Solana RPC supplies `blockTime`; canonical
`null` remains valid and slot/signature/anchor/ProgramData ordering stays
mandatory. Validation occurs before making a postflight RPC. `recordSha256` is an unkeyed corruption
checksum, not a signature or MAC: authenticity depends on the local OS account,
mode-0600 file, and protected parent directory. The permissionless
preflight-to-inclusion race is irreducible; exact postflight detects but cannot
undo an unexpected concurrent extension, so any size mismatch aborts.
Extension stamps the ProgramData slot, so the extension and
`Upgrade` cannot execute in the same slot; wait for a later slot, then rerun the
entire preflight. The separate upgrade rail pins Solana CLI 4.1.0, forces
`--no-auto-extend`, and rejects pre/post capacity drift. Re-query size, rent,
authority, balance, feature state, and slot at the ceremony. The 2026-07-22
extend already ran (see the start of this section).

Read-only mainnet inventory on 2026-07-18 found no Active disputes, no Active
governance proposals, no bid accounts, no token-denominated tasks, no
reputation delegations, no completion bonds, and no private/ZK tasks. Historical
terminal accounts and rent-only orphan children are inventory, not authority to
delete them; the recovery instruction validates every canonical parent/child/
worker binding before returning rent.

This surface went **live 2026-07-22** via the Squads upgrade and revision-5
stamp. Mainnet ran the 101-instruction revision-5 binary (executable
`049a66e3…`) until the 2026-10-28 revision-8 upgrade; it superseded the prior
99-instruction revision-4 binary. The three
Squads member key files are currently documented as co-located on one host, so
host-level quorum compromise remains an
operational custody risk even though on-chain control is genuinely 2-of-3.

### Prior deployment history

- **2026-07-05…09 — Additive batches 2–4 (94 → 96 → 99 ix, revisions 2 → 3 → 4).**
  Batch-2: store identity + `moderation_heartbeat` + dispute/freeze-exit referrer
  legs + `rate_hire` rollup. Batch-3: contest surface (`distribute_ghost_share`,
  `reclaim_terminal_claim`, submission-rent return). Batch-4: goods market
  (revision-gated; stamping 4 turns goods on). Client packages:
  marketplace-sdk 0.9.0 / 0.10.0 / 0.11.0. See
  [`VERSIONING.md`](./VERSIONING.md) §1.1 and
  [`design/batch-3-contest-tasks.md`](./design/batch-3-contest-tasks.md) /
  [`design/batch-4-goods.md`](./design/batch-4-goods.md).
- **2026-07-03 — P1.2 open-roster (90 instructions), slot 430491216, commit
  `aad4c0d`.** Flag-day wire cutover: `set_task_job_spec` / `hire_from_listing` /
  `hire_from_listing_humanless` gained a trailing `moderator` arg + required
  `moderation_block` account; moderation records moved to v2 moderator-keyed
  seeds; attestor registration became permissionless. Upgrade executed through
  the Squads vault the same day the upgrade authority moved off the single key.
  See [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) §2.6 and
  [`P1_2_OPEN_ROSTER_SPEC.md`](./P1_2_OPEN_ROSTER_SPEC.md).
- **2026-07-02 — WP-A1 roster-consumption gates.** The three moderation
  consumption gates began honoring registered roster attestors' attestations
  (previously only the single global `moderation_authority` unlocked a
  publish/hire). Additive account only; no layout change. See
  [`WP-A1-DEPLOY-READINESS.md`](./WP-A1-DEPLOY-READINESS.md).
- **2026-06-11 — Phase 9 full-surface upgrade (84 instructions).** The binary
  was swapped from the 25-instruction canary build to the full default-features
  build, the 169 live Task accounts were migrated (382B → 466B, 0 failures), and
  `ProtocolConfig` was migrated (349B → 351B, `surface_revision = FULL (1)`).
  Mainnet stopped being the canary. See
  [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md).

## Branch History Note

The rollout work was staged on `mainnet/hjs-program-id`. At the time this
document was added, the deployed mainnet source tree matched `main`, so `main`
remains the only branch downstream integrators should treat as canonical.

Historical branches may remain in the repo for auditability, but they are not
the branch of record once `main` matches the deployed tree. The deployed
revision-9 program was built from the program tree
`df10b3fc66c2707b58305311da6b060c928b594f`, which `main` has carried since
commit `154d286659592c799bd111bf416fdba7ccc704b4` (PR #351). As of 2026-11-21
the revision-9 client train is released from `main` through the tag-driven
release workflow. The published revision-8 set (protocol 0.5.2, SDK 0.13.0 and
the rest) and the older revision-5 set are superseded: SDK 0.13 treats revision
9 as an unknown surface and fails closed. The revision-8 program was built from
`main` commit `f39b383e416ec5bc511b0ffb781481a658d137d8`.

## Release Discipline

Before or during any future mainnet upgrade:

1. Confirm the live `programId` and upgrade target.
2. For the revision-5 audit-hardening cutover, submit a **separate, explicit
   in-program multisig** `update_launch_controls` action that sets
   `protocol_paused = true` while preserving the live task-type mask and surface
   revision. Verify the paused byte from mainnet before running any cutover scan.
   The deployment tooling deliberately does not create this governance action.
3. Require zero `ReputationDelegation` accounts, zero Active disputes, and zero
   `ValidatorQuorum` `TaskValidationConfig` accounts. Require every
   AgentRegistration initiator and defendant liability counter to be zero. The
   dispute scanner distinguishes new `0xff` provenance-tagged outcomes from
   grandfathered zero-marker records; an expired legacy loss is inventory, not a
   retroactively revived penalty. The canonical upgrade rail
   also inventories every legacy Task with `max_workers > 4` and hard-blocks any
   nonterminal (including Disputed/RejectFrozen) Task whose `current_workers > 4`:
   a maximum-size `resolve_dispute` rationale plus more than four fixed worker
   account groups cannot fit the legacy Solana transaction packet.
   The canonical upgrade rail
   repeats this snapshot immediately before a direct deploy. Because legacy
   delegation was not pause-gated, deploy the disabling binary first and repeat
   the zero-delegation scan after deploy, before stamping revision 5. A raced
   delegation has a deterministic permissionless retirement path, but blocks the
   stamp until purged. Retirement never restores reputation: identity-continuous
   records return rent to the recorded authority; absent or discontinuous
   identities return rent only to the canonical protocol treasury.
   The same predeploy and postdeploy/prestamp snapshots must run the canonical
   ReputationStake custody, skill-rating cutover, task-child, task-dependency,
   token-task escrow, hired-provider, active job-spec BLOCK, bid contract, and
   task-settlement scanners. Malformed account
   ownership/layout/PDA bindings are hard blockers. A valid multisig
   `ModerationBlock::BLOCKED` record is containment
   inventory, not a deploy blocker: the new binary must prevent new assignment
   while preserving already-assigned workers' settlement and exit paths.
4. Keep the protocol paused through binary verification, migrations, config init,
   the postdeploy cutover rescan, IDL publication/verification, and the final
   revision stamp. Unpause only
   through a **later, separately reviewed multisig action** after postdeploy canary
   checks; the upgrade rail preserves `paused=true` and never unpauses itself.
5. Confirm `main` contains the exact program source tree being deployed.
6. Refresh this file if the live scope or rollout rules changed (slot,
   `surface_revision`, instruction count, upgrade authority).
7. Keep committed artifacts and downstream protocol consumers aligned.
8. Before the final surface stamp, publish/upgrade and fetch-verify the **on-chain
   IDL per cluster**. The revision 9 publish (2026-11-21) used the committed
   `artifacts/anchor/idl/agenc_coordination.json`, which is the rail's default IDL
   path. Never publish `target/idl/agenc_coordination.json`: the raw Anchor output
   has no `TaskMarker` account, so clients built from it cannot decode a task that
   `close_task` compacted. The preflight refuses any IDL without that entry. The
   canonical rail derives a deterministic docs-free projection from the
   hash-approved committed IDL, checks Anchor 0.32.1 authority/capacity/rent,
   publishes that ABI-complete projection, and verifies every non-`docs` value from
   chain. Do not pass the oversized documented source IDL directly to
   `anchor idl upgrade`. The 25-instruction
   `agenc_coordination.canary.json` remains the IDL of the restricted
   rehearsal/fallback `--features mainnet-canary` build kept frozen in CI via
   `scripts/canary-idl-baseline.json`. See [./VERSIONS.md](./VERSIONS.md) for the full
   surface-versioning release runbook (config/task migration choreography +
   `surface_revision` stamping).

### Revision-5 read-only inventory (2026-07-18)

The canonical scanners decode the actual account layouts and PDA bindings from
program state; they do not use the prose instruction inventory as an authority.
The latest pre-revision-5 mainnet snapshot found:

- 208 AgentRegistration accounts, all with zero pending initiator outcomes and
  zero defendant-dispute counters. There are three zero-marker Cancelled
  disputes and zero Active disputes. Two unapplied initiator losses are more
  than 35 days old and therefore expired under the deployed seven-day policy;
  they remain immutable inventory and are not cutover blockers. There are zero
  tagged pending outcomes and zero dispute-lifecycle blockers.

- 357 Tasks total; 92 nonterminal. Of those, 69 have canonical job specs and 23
  legacy, unassigned Tasks have no job spec. The 23 cannot accept a new worker
  under the hardened claim path until their creator publishes a moderated job
  spec; none has an existing worker. There are zero active job-spec BLOCKs and
  zero malformed moderation-block conditions.
- 62 exact-layout HireRecords. All 62 use both revision-4 legacy forms: the
  default-provider carve-out and a zero buyer-job-spec commitment tail. Every
  record retains a canonical immutable ServiceListing provider proof. Of the 16
  nonterminal hires, 13 are Open/unassigned and must retain cancel/refund then be
  re-hired with an explicit task commitment; three are assigned and retain only
  their existing settlement/exit lifecycle. The provider compatibility path uses
  the exact `legacy_listing` account, but revision 5 deliberately has no fallback
  that invents a missing buyer work contract. See `REVISION_5_CUTOVER.md` for the
  exact task inventory.
- Zero TaskBid and zero TaskBidBook accounts. The immediate predeploy rescan now
  requires explicit `openBidCount=0` and `openBidBondPrincipal=0`; paused legacy
  exit paths can otherwise mutate or orphan a bid while loader transactions are
  in flight. Accepted bids remain independent hard blockers.
- Zero live CompletionBond principal across all Tasks, enforced by explicit
  `liveCompletionBondCount=0` and `liveCompletionBondPrincipal=0` aggregates at
  the immediate predeploy rescan. This is required even while the parent Task is
  live because the paused legacy binary still permits terminal exits and closure
  during a multi-transaction loader upload.
- Zero Tasks eligible for deployed revision-4 `post_completion_bond`: Exclusive,
  SOL-denominated, Open/InProgress/PendingValidation Tasks using either automatic
  or manual-review completion. Revision 4 does not pause-gate that custody entry,
  so this stricter aggregate is what keeps the zero-bond snapshot stable until
  the new binary lands. The operator must use the scanner's exact Task inventory;
  the earlier 2026-07-18 snapshot did not compute this aggregate.
- Zero SkillRegistration, PurchaseRecord, and SkillRating accounts. The live
  mainnet counts are all zero. Revision 4 pause-gates register, purchase, and
  rating, and none of these account types has a close/retype path, so the empty
  snapshot is stable throughout the loader upload. This deliberately avoids an
  unsafe missing-author recovery: legacy skill and purchase state does not store
  the original author wallet, so after revision 4 closes the author's
  AgentRegistration the program cannot distinguish an honest purchaser from the
  original author rating through a second agent.
- Every 74-byte ReputationStake account is enumerated by exact size, then checked
  for its discriminator, complete layout and zero reserved bytes, canonical
  stake/AgentRegistration PDA relationship, and independent rent-plus-principal
  backing. Healthy nonzero `staked_amount` is compatible and does not block the
  cutover. Malformed identity, principal without an AgentRegistration, or any
  per-account backing deficit is a hard blocker; aggregate surplus in another
  stake cannot mask a deficit.
- Zero nonterminal dependent children of any dependency type (Data, Ordering, or
  Proof), enforced by explicit total and per-type aggregates, plus zero
  CompletionBonds on dependent children. Revision 4 can close a Completed parent
  during the paused loader upload, while the candidate requires that live parent
  for Data/Ordering settlement as well as Proof validation. Revision 4
  pause-gates dependent-task creation, so the zero-child snapshot is stable; even
  an Open/unassigned/no-principal legacy child now blocks the loader.
- Zero RejectFrozen Tasks and therefore zero RejectFrozen escrow or CompletionBond
  principal. Future snapshots resolve each frozen task's immutable fee source
  (task-stamped terms first, exact canonical HireRecord fallback second), validate
  payee/fee presence and combined caps, and block an exit whose SOL escrow or fee
  accounts cannot be constructed exactly.
- The settlement-solvency scan decoded all 357 Tasks and 62 HireRecords. The one
  Collaborative Task satisfies `reward_amount >= required_completions`; there
  are zero underfunded Collaborative Tasks for either SOL or SPL reward units.
  Forty-five Tasks carry active Task-stamped marketplace fee terms; eight of
  those Tasks are nonterminal. Seventeen Tasks use the exact canonical
  HireRecord fee-term fallback (eight nonterminal), but none of those fallbacks
  currently carries an active fee. Across both sources there are zero active
  operator/referrer aliases to creator, Task, or escrow, zero shared active
  operator/referrer wallets, and zero deployment blockers.
- 1,991 decoded task-child accounts and 370 missing-parent, rent-only orphans,
  holding 613,224,720 lamports of rent. There are no active/principal or malformed
  blockers. The supported recovery inventory is 353 TaskValidationConfigs, five
  TaskAttestorConfigs, six terminal TaskSubmissions, and six TaskModeration
  records. All six submission workers have a canonical live or retired-identity
  AgentRegistration, so all six rent recipients are recoverable; zero worker
  identities are unavailable. This snapshot predates support for the
  `TaskValidationVote` family and therefore is not a complete vote-orphan
  inventory. A final expanded scan was attempted on 2026-07-18 but the official
  public RPC repeatedly returned HTTP 429 and the alternate public RPC returned
  HTTP 504; that is an unavailable scan, not a clean or adverse chain finding.

### Reviewed orphan-rent recovery plan (do not execute during deployment)

`reclaim_orphan_task_child` is a deliberately narrow, permissionless recovery
instruction. It closes a supported child only after proving its stored parent
Task is absent and derives the rent destination from the child's program state.
The upgrade orchestrator never invokes it. Recovery is a separate, reviewed
operation after the new binary is verified and while the protocol remains
paused.

1. Re-run `scripts/preflight-task-children-scan.mjs` at a recorded confirmed
   slot. Persist the exact child/parent/recipient/lamport inventory and restrict the
   batch allowlist to `TaskJobSpec`, zero-pending `TaskValidationConfig`,
   `TaskAttestorConfig`, `TaskModeration`, non-Submitted `TaskSubmission`, and
   `TaskValidationVote` whose exact `TaskSubmission` parent is absent.
   Never feed TaskClaim, TaskEscrow, HireRecord, CompletionBond, TaskBidBook, or
   TaskBid to this instruction.
2. For each allowlisted child, construct the account set from decoded state:
   `child` (writable), its stored absent `parent_task`, `rent_recipient`
   (writable), a fee-paying `authority` signer, and `worker_agent`. For the first
   four non-submission families, use a harmless read-only sentinel for the unused
   `worker_agent`. For TaskSubmission, pass the exact stored AgentRegistration;
   its canonical PDA/bump is rechecked on-chain and rent goes to that account's
   stored authority. Both live registrations and permanent `RETD` tombstones are
   valid identities. For `TaskValidationVote`, the ABI-stable `parent_task` slot
   carries the exact stored TaskSubmission, `worker_agent` is an unused harmless
   sentinel, and rent goes to the vote's stored reviewer.
3. Simulate every instruction against the same snapshot. Start with one reclaim
   per transaction; pack multiple instructions only after measuring serialized
   transaction size and compute use, and remain below Solana's transaction packet
   and compute limits. A simulation failure, changed parent, changed child, or
   changed recipient invalidates that item rather than triggering a fallback
   recipient.
4. Obtain explicit operator approval for the final child allowlist, transaction
   messages, recipient mapping, and expected recovered-lamport total. Broadcast
   in small batches and record signatures. This closes program accounts and is
   intentionally not an automatic deployment step.
5. After each batch, re-fetch every target and recipient, reconcile exact child
   lamports transferred (transaction fees are paid separately by the cranker),
   then re-run the scanner. Stop on any mismatch. The final report must show the
   reclaimed children absent, no newly unavailable submission identity, no
   principal-bearing orphan, and the remaining orphan-lamport total reduced by
   exactly the successfully reclaimed amount.

## Why This Exists

Auditors, SDK consumers, operators, and AI agents need one obvious public
answer to the question "which code is live on mainnet?" This document makes the
answer explicit: start with the live revision/commit recorded above, then treat
the current `main` tree as a separate candidate when this document says it is
undeployed. Re-verify the slot, executable hash, and `surface_revision` with
`solana program show` + `getDeployedSurface` when in doubt.
