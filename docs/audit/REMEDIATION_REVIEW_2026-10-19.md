# Remediation review — 2026-10-19

This is an internal, evidence-bounded update to issue #279. It is not an external
audit certification. Dependency findings, program regressions and operational
acceptance have separate evidence and closure criteria.

The old blanket conclusions that all locked versions are clear and all principal
loss scenarios require compromised keys are not supported. AGNC-01 demonstrated
a reachable deferred-dispute claim-reclaim failure. The six current npm graphs
also included applicable advisories beyond the short package list in #279.
Those observations require both source fixes and a more complete dependency gate.

## Reproducible dependency observation

The [machine-readable snapshot](../../supply-chain/reviews/2026-10-19-advisory-snapshot.json)
records observation time, all six npm lock hashes, all three Cargo lock hashes,
the RustSec database commit and tool versions. The recurring command is:

```sh
node --test scripts/audit-all-npm-locks.test.mjs
node scripts/audit-all-npm-locks.mjs --output npm-audit-evidence.json
```

CI retains raw full-graph and runtime reports. Unknown, incomplete or inconsistent
reports fail; a transport error is not a zero-finding result. The audit and license
gate share actual repository-wide lock discovery. An unlisted lock stops the
audit before npm executes. Per-finding severities must match the summary counts,
so a critical finding cannot be hidden by a misleading aggregate.

| npm graph | Before: affected packages | After: full graph | After: runtime |
| --- | --- | --- | --- |
| Root workspaces | 19 high, 7 moderate | 18 high, from one reviewed advisory | 0 |
| Integration/deployment tooling | 0 | 0 | 0 |
| Marketplace starter | 3 high | 0 | 0 |
| Playwright harness | 0 | 0 | 0 |
| Checkout fixture | 4 high, 1 moderate | 0 | 0 |
| Next SSR fixture | 1 critical, 4 high | 0 | 0 |

These counts are affected packages reported by npm, including transitive parent
chains; they are not counts of distinct vulnerabilities. Zero is scoped to that
lock, audit mode and observation time, not a guarantee of vulnerability absence.

Next is pinned to **15.5.28**, PostCSS to **8.5.31**, Sharp to **0.35.5** in the
private SSR fixture, and Vitest to **4.1.12** across workspaces. Compatible lock
updates cover nanoid, source-map-js, browserslist and baseline-browser-mapping.
Relevant primary advisories include [Next](https://github.com/advisories/GHSA-p293-qw3h-jr36),
[Vitest](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), and
[PostCSS](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp).

Two global overrides in the root development dependency graph force majors
outside the callers' declared ranges and require explicit compatibility evidence:

- `read-yaml-file@2.1.0` retains the CommonJS async/default/sync API used by
  Changesets, moves to js-yaml 4, and removes the legacy argparse/sprintf-js
  chain. js-yaml resolves to 4.3.2. The real Changesets release plan before and
  after the update is byte-identical.
- `postcss-selector-parser@7.1.6` fixes the
  [parser advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) while keeping
  Tailwind 3. Its major change concerns safe insertion during iteration. The
  existing Tailwind compilation assertions, React tests and actual Ladle
  production build exercise this override.

The remaining development-only advisory is
[GHSA-vfj7-8cjw-p6xm in braces 3.0.3](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The upstream advisory reports no patched version. The
[bounded review](../../supply-chain/npm-advisory-reviews.json) allows only its
exact npm archive in the root development graph, through **2026-11-18 13:55 UTC**.
It does not allow runtime exposure, another version, another archive or another
advisory. All runtime findings and all critical findings fail the new gate.
Do not feed untrusted network input into development glob parsers or expose
these build tools as services. Maintainers must replace or patch this dependency
before the review expires, or conduct a new bounded review. The 18 high package
entries remain visible in every full report.

The Sharp update removes its old install lifecycle script. The exact install
policy therefore has 10 approvals and 3 denials across 13 script-bearing
packages. All 14 replacement optional binary archives were downloaded and
SRI-verified; bundled licensing tables were reviewed. Their existing fixture-only
scope and November 18 expiry remain, with
[new archive evidence](../../supply-chain/reviews/2026-10-19-sharp-security-update.json).
They are not added to published AgenC package payloads.
Every license exception now binds both `resolved` and SHA-512 `integrity` to
that reviewed archive. Changing either without a new review fails the evaluator
and the actual CLI. This closes the archive-binding gap found in the independent
pre-merge review; expiry and ownership requirements remain in force.

Pinned cargo-audit **0.22.2** and cargo-deny **0.20.2** passed on all three
independent Cargo locks against the recorded live RustSec database. The existing
bincode unmaintained notice remains an explicit expiring review, not an assertion
that the notice disappeared. The Anchor 0.32.1 compatibility line and the
1.0.0/1.0.1 prohibition are enforced by #286; the supported migration floor is
documented there.

## Finding-to-evidence map

Each PR states its source commit, executable hash where applicable and exact
limits. All RPC statements below concern disposable local validators or GitHub
CI; the historical revision-5 rebuild separately matched read-only mainnet bytes.

| Finding | PR | Demonstrated acceptance |
| --- | --- | --- |
| AGNC-01: reclaim before deferred settlement | [#285](https://github.com/tetsuo-ai/agenc-protocol/pull/285) | Old binary accepted the unsafe ordering; fixed SBF and five real RPC settlement/expiry cases preserve liabilities and exits. Historically deleted claim data is not recreated. |
| #274: disabled moderation funds unclaimable hires | [#288](https://github.com/tetsuo-ai/agenc-protocol/pull/288) | Registered/humanless hires reject, existing deposits cancel/refund, BLOCK persists, and existing work completes through actual RPC. |
| #275: multiple feed votes per wallet | [#293](https://github.com/tetsuo-ai/agenc-protocol/pull/293) | 653 RPC transactions, 91 paid jobs and an actual one-hour wait; wallet duplicate/self-vote and retired-author provenance checks. |
| #276: cheap cross-wallet storefront ratings | [#296](https://github.com/tetsuo-ai/agenc-protocol/pull/296) | 48 real RPC transactions check actual 99,999/100,000-lamport fee boundaries and rollback. The cheap-cycle test fails on the preceding binary. Historical aggregates stay mixed. |
| #82: claim-expiry observability | [#289](https://github.com/tetsuo-ai/agenc-protocol/pull/289) | Actual expiry/grace timing and RPC event/state checks; the earlier proposed fix emits the wrong reopen flag in the negative control. |
| #124: u8 task capacity | [#294](https://github.com/tetsuo-ai/agenc-protocol/pull/294) | 409 RPC transactions: 256 funded creations, shared-wallet N+1 rejection, one completion and 255 refunds; grant edits cannot replenish consumed usage. |
| #277: expired advisory exception | [#284](https://github.com/tetsuo-ai/agenc-protocol/pull/284) | Exact bounded bincode review; real audit/deny gates and expired-policy CLI rejection. |
| #278: capacity, moderation schema, bid recovery | [#290](https://github.com/tetsuo-ai/agenc-protocol/pull/290) | Actual outstanding-work capacity rejection and settlement; real bid reordering, grace, winner and losing-bond recovery. |
| #282: dependency/toolchain floors | [#286](https://github.com/tetsuo-ai/agenc-protocol/pull/286) | Anchor version/feature checks across all locks; pinned Agave 4.1.0 and verifier 0.5.2; SBF and reproducible-build checks. |
| #199: Explorer metadata/attestation | [#295](https://github.com/tetsuo-ai/agenc-protocol/pull/295) | Historical source reproduces live revision-5 bytes; 29 real local Squads/PMP/verification transactions reject one approval and accept two, update a stale attestation and return buffer rent. Live ceremony pending. |
| #280: upgrade-custody/watchdog risk | [#291](https://github.com/tetsuo-ai/agenc-protocol/pull/291) | Actual local loader upgrade, separate monitor process and HTTP delivery/outage retry. Host/HSM separation and live pager acceptance pending. |
| #281: delayed signing/configuration risk | [#292](https://github.com/tetsuo-ai/agenc-protocol/pull/292) | Actual nonce invalidation, fresh-message guard and configuration/treasury alarms through RPC and HTTP. Operator acknowledgements and live routing pending. |

The coordinated revision-8 candidate keeps the production SBF hash
`ab1456145d3958e0d5b6f39fea27775af9b5a5a208e26a06f6dfcc7ad3d103f8` in this
dependency/documentation PR: no Rust program or IDL change is made here.

## Validation of this dependency update

- 1,767 workspace tests passed: SDK 887, React 311, tools 98, MCP 35,
  moderation 15, worker 273 and CLI 148; 16 intentionally skipped tests remain.
- Real Chromium checkout passed: the browser funds a hire and observes its
  acceptance on the disposable local validator. No external wallet or network
  funds are used.
- Next 15.5.28 production build and HTTP SSR proof passed for the provider,
  ListingGrid, HireButton and open checkout modal. Ladle production build passed.
- All six clean npm installs passed the exact install policy; license checks
  cover 1,621 package records, six locks and 19 owned exact exceptions.
- The new audit rejects the actual pre-fix Next graph as a negative control;
  tests reject expiry, changed archives, runtime exposure, unrelated advisories,
  malformed reports and dependency-chain inconsistencies.
- Two final policy regressions fail against the preceding audit implementation:
  a critical finding hidden by inconsistent summary counts, and an additional
  unlisted lock. The corrected implementation rejects both; the real six-lock
  audit then passes with the same explicit development-only review.

## Remaining release and operational acceptance

The post-review read-only mainnet dispute scan on 2026-10-19 found 254 agents
and five disputes: two Active, three Cancelled, zero SettlementPending. Four
release blockers remain: the two active disputes plus nonzero legacy initiator
and defendant liability counters. The scanner also reports two expired legacy
initiator liabilities. [Recorded evidence](../../artifacts/remediation/2026-10-19-mainnet-disputes.json)
contains the public account identifiers and observed deadlines. This is a
release blocker, not evidence of a missing-peer SettlementPending incident.
No mainnet recovery, finalization or upgrade transaction was submitted.

The observed mainnet program is still revision 5. Candidate tests do not upgrade
it. The paused upgrade, IDL verification, coordinated client release and atomic
surface stamp remain governed by [VERSIONING](../VERSIONING.md). Claims already
deleted under the historical AGNC-01 behavior need separately designed recovery.
Run the read-only dispute scan before scheduling that release; any pending set
with missing peer claims is a separate recovery/release blocker. The restricted
canary keeps its frozen 25-instruction wire shape, but shared handlers inherit
the quota checks and expiry event behavior. A frozen IDL is not a guarantee of
unchanged semantics; the canary semantic regressions remain required.

Member-key co-location remains a custody risk until independent custody evidence
exists. The monitor implementations cannot prove physical key separation or
24/7 staffing. Watchdog delivery and admin alarms require hosted deployment,
actual pager delivery and operator acknowledgement before #280/#281 close.
Explorer acceptance requires the authorized mainnet ceremony, external job and
final display checks in [EXPLORER_METADATA](../EXPLORER_METADATA.md).

The candidate is SBPF v0. New deployment of v0 fails on a validator with the
SBPFv3-only feature active; the loader upgrade drill explicitly uses an owned
legacy-feature genesis. At the recorded mainnet observation that feature was
inactive. Recheck the target and complete the v3 migration before activation;
successful genesis execution is not deployment compatibility evidence. See
[Solana's upgrade notice](https://solana.com/upgrades/sbpfv3-programs).

Worker prompt-injection, trusted RPC previews and compromised upgrade authority
remain architectural/operational risks in the [threat model](THREAT_MODEL.md).
No finite test suite establishes that every exploitable high-severity source
bug is absent. The claims here are limited to the identified invariants and
reproductions above.
