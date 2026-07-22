# @tetsuo-ai/marketplace-react

## 0.5.0 (unreleased candidate)

### Breaking Changes

- Raise the runtime floor to Node 22.23.1 for the coordinated revision-5 train;
  Node 20 is EOL.
- The optional `./tailwind-preset` export is now a dependency-free Tailwind v3
  plugin descriptor. Importing the React package's advertised preset no longer
  fails in clean consumers that do not otherwise install Tailwind; pinned
  Tailwind compilation coverage verifies the descriptor and emitted utilities.
- Require the revision-5 SDK peer (`^0.12.0`) for the coordinated cutover.
  `useHire` and the humanless flow now require the buyer's non-zero
  `taskJobSpecHash` before they can fund escrow, and activation verifies that
  the moderation callback returned that exact hash. This is an intentional API
  and wire break; published 0.4.1 remains current while mainnet is revision 4.
- `useHumanlessHireFlow` now delegates to the SDK's non-resubmitting recovery
  orchestration. Post-submission failures surface `HireAndActivateError`,
  `progress.recovery` exposes its durable `hiring`/`moderating`/`activating`
  token, and `resumeHireAndActivate(input, token)` resumes without issuing a
  second funded hire. This intentionally replaces the old raw backend/send
  error identity after a hire may have committed.
- Add an explicit `orchestrationRpc` provider seam and keep funded
  reconciliation separate from ordinary read endpoints. Provider-built clients
  use their resolved RPC; pre-built custom clients use only an explicitly
  supplied `rpcUrl`/`orchestrationRpc` and never inherit a network default.
- Harden the marketplace starter's funded job contract across custom backend
  seams. The task-bound normalized specification is detached and deeply frozen,
  backends receive a separate clone, the local hash is rechecked before and
  after hosting, and activation/state consume fresh copies of the originally
  funded bytes rather than backend-owned mutable arrays.
- Preserve custom signer compatibility in `useHumanlessHireFlow`: React now
  canonicalizes a same-address creator override to the client fee-payer object
  and stabilizes a distinct-address signer at its enqueue boundary. This keeps
  one signer object per address as Solana Kit requires without collapsing an
  intentional separate signer.
- Close async intent races in the direct `useHire` and `useTaskActivation`
  money paths. They synchronously detach `taskId`, `listingSpecHash`,
  `taskJobSpecHash`, and `jobSpecHash` before enqueue, derive the Task PDA once
  from the captured bytes/address, canonicalize same-address overrides to the
  client signer, and preserve distinct-address signer identities before
  moderation or funded-client awaits. Standard hires also use one object when
  separate creator/authority wrappers expose the same non-client address.
- `useHumanlessHireFlow` now validates and detaches every 32-byte hire and
  activating-recovery commitment at the public enqueue boundary. Exact
  Uint8Arrays from another browser/worker realm are accepted, while wrong
  widths, non-byte views, and SharedArrayBuffer-backed views fail before any
  funded or resumed SDK work begins.
- Snapshot every caller-owned mutable input in `useTaskWork`,
  `useSubmissionReview`, `useDispute`, `useCompletionBond`,
  `useTaskLifecycle`, and `useRateHire` before TanStack enqueue. Fixed byte
  fields accept exact `Uint8Array` views across JavaScript realms and preserve
  raw, nullable, and explicit Solana `Option` representations. A signer
  override for the client fee-payer address resolves to the canonical client
  signer object, satisfying Solana Kit's one-signer-instance-per-address rule;
  distinct-address overrides retain their identity.

## 0.4.1

### Patch Changes (additive — WP-H3 phase 1, Guaranteed Hire)

- New `useTaskGuarantee(taskPda)` read hook: a task's completion-bond state
  (`guarantee` + a plain `guaranteed` flag — true iff the worker's 25% bond is
  posted and unresolved). Reads through an injected `guaranteeReader` seam, or
  defaults to the provider's resolved `rpcUrl` via the SDK
  `fetchTaskGuarantee` (a task-scoped `getProgramAccounts`; the RPC must allow
  gPA).
- New `useCompletionBond(taskPda)` mutation hook: `post(...)` /
  `reclaim(...)` over the client's named bond methods, with the post
  `authority` defaulted to the client signer, the reclaim `party` defaulted to
  the signer's address, and the task's guarantee cache invalidated on success.
- New `<GuaranteedBadge task={...} />` component: renders NOTHING unless the
  task is guaranteed; when it is, a small success-tone badge ("Guaranteed —
  worker has 25% at stake") with the full detail sentence on title/aria. The
  copy is deliberately phase-1-honest: the buyer is refunded and the worker
  FORFEITS the bond — it does not claim the buyer receives the bond (a
  forfeited bond pays the protocol treasury until the phase-2 program work
  redirects it to the harmed party).

## 0.4.0

### Minor Changes (breaking — the P1.2 open-roster flag-day cutover)

- Rebuild on `@tetsuo-ai/marketplace-sdk@^0.8.0` (peer): hire and activation
  inputs now REQUIRE the P1.2 `moderator` — the pubkey whose attestation the
  gate consumes, read from your attestation service (e.g. attest.agenc.ag
  `GET /v1/info` → `moderator`). `HumanlessHireFlowModerationResult` gains a
  required `moderator` field (the flow's activation consumes the record of
  whoever signed the moderation), validated fail-closed like the hash/URI.
- The hooks resolve the gate MECHANICS automatically (the trust decision
  stays the caller's): `useHire`, `useHumanlessHireFlow`, and
  `useTaskActivation` attach the `["moderation_attestor", moderator]` roster
  entry when the named moderator is a registered attestor — only after
  verifying the entry exists on-chain (attaching an uninitialized PDA fails
  the gate harder than the authority branch) — and point the gate at the
  FROZEN pre-P1.2 record when no v2 record exists but a legacy record by the
  same moderator does (grace window). Caller-supplied `moderationAttestor` /
  `moderatorIsAttestor` / record overrides win over resolution.
- `resolveActivationModerationAttestor` (internal) is replaced by
  `resolveActivationModerationAccounts` + `resolveHireListingModerationAccounts`.

## 0.3.2

### Patch Changes

- `useReferrerEarnings` is LIVE: it now fetches the deployed P3.8 explorer
  endpoint (`GET /api/explorer/referrers/:wallet/hires`) instead of returning
  the gated zero state. The endpoint base resolves from
  `config.indexer.baseUrl`, else the hosted per-network default (mainnet:
  `https://api.agenc.ag`); when no base resolves the documented not-live zero
  state is returned with no network request, and a failed fetch surfaces as
  `error` with zero totals — earnings are never fabricated. The provider
  context now also exposes `indexerBaseUrl`.

## 0.3.1

### Patch Changes

- Activation now attaches the WP-A1 roster `moderation_attestor` account
  automatically. `useTaskActivation` and `useHumanlessHireFlow` read the
  recorded `TaskModeration`, and when its moderator differs from the global
  moderation authority (i.e. a roster attestor — the default when the
  activation backend is the public attestation service at attest.agenc.ag)
  they attach the attestor's roster-entry PDA to `set_task_job_spec`.
  Without this, roster-attested tasks failed activation on-chain with
  `UNAUTHORIZED_TASK_MODERATOR` (2026-07-02 cross-node canary finding). A
  caller-supplied `moderationAttestor` always wins; read failures degrade to
  the previous behavior. The provider context now exposes the resolved
  `rpcUrl` for such single-account reads.

## 0.3.0

### Minor Changes (breaking against pre-A1 programs)

- Require `@tetsuo-ai/marketplace-sdk@^0.7.0` as the peer dependency (was
  `^0.4.0 || ^0.5.0 || ^0.6.0`). The mainnet program was upgraded 2026-07-02
  with the WP-A1 roster moderation gates (breaking IDL: an optional
  `moderation_attestor` account on `set_task_job_spec` /
  `hire_from_listing` / `hire_from_listing_humanless`); hooks driving those
  instructions through an older sdk are rejected fail-closed by the deployed
  program, so the old peer range would resolve to broken installs.

## 0.2.0

### Minor Changes

- Add the humanless marketplace lifecycle hook surface under `./hooks`, including
  `useHumanlessHireFlow`, task activation, worker submission, buyer review,
  task close, and hire rating helpers for escrow-backed service-listing flows.
- Add the marketplace starter example with a self-hosted job-spec activation
  route, setup-readiness checks, clean package-artifact verification, public
  registry verification, and a UI lifecycle smoke covering hire, activation,
  claim, submit, accept, rate, and close with injected seams.
- Extend lifecycle tests, signer exports, and referrer handling so builders can
  exercise the same listing-to-settlement path through public SDK and React
  package surfaces.

## 0.1.1

### Patch Changes

- Widen the `@tetsuo-ai/marketplace-sdk` peer range to `^0.4.0 || ^0.5.0 || ^0.6.0`.
  The published 0.1.0 pinned `^0.4.0`, which on a 0.x caret excludes sdk 0.5.0+ and
  made installs alongside the current SDK fail peer resolution.
- Treat protocol referral settlement as live with sdk 0.6.0: provider referrer
  config now injects into hires, while aggregated referrer earnings remain
  indexer-gated.

## 0.1.0

Initial scaffold (PLAN.md P4.2 / PLAN_2.md Part A).

- `<AgencProvider>` context: indexer-first read transport with RPC/gPA fallback,
  the write `MarketplaceClient` (with a `client` override slot), the resolved
  referrer config and `resolveReferrerCapability()`, and the signer. Wraps a
  bundled TanStack Query client.
- `createReadTransport()` unified read interface
  (`listActiveListings` / `getListing` / `listingHires` / `agentTrackRecord`).
- Vendored AgenC brand theme (`--agenc-*` CSS custom properties) +
  side-effect `theme.css` export and a Tailwind preset.
- Minimal English string catalog + `t(id, vars?)` resolver.
- Prebuilt themable components (PLAN_2 A3), exported from the root and the
  tree-shakeable `./components` subpath: `ListingCard`, `ListingGrid`,
  `HireButton` (connected over `useHire`), `HireCheckoutModal` (accessible money
  modal: price + moderation badge + escrow note + referrer disclosure +
  confirmation states, focus trap + ARIA), `TaskTimeline`, `ReviewPanel`,
  `DisputeBanner`, `ProviderCard`, `PoweredByAgenC`, plus shared primitives
  (`Modal`, `Button`, `Badge`, `Spinner`, `StateMessage`) and the
  `ModerationBadge`/`VerifiedBadge`. Each accepts `unstyled` for white-label and
  routes copy through a `components.*` string catalog. The referrer disclosure
  never claims a charged fee while inactive.
- Optional component-recipe stylesheet at `./components.css` (no CSS-in-JS).
- Ladle stories for every component state (`.ladle/`, `npm run ladle`) and an
  axe accessibility check in the test suite (fails on serious/critical).
