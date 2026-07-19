# Job Spec Required Flag Decision

> **Historical decision record (banner added 2026-07-17).** Not current state — see `./MAINNET_MAINLINE.md` for what is live and `../TODO.MD` for the completed remediation record.

Issue: `agenc-protocol#32`

## Decision

Do not add a new on-chain `job_spec_required` flag for the current launch
scope.

> Current-state note: since this decision was written, legacy `claim_task` has
> been kept in the ABI but made permanently fail-closed (`TaskJobSpecRequired`).
> The live claim path is `claim_task_with_job_spec`, so job-spec-aware claim
> semantics are now enforced directly by the protocol without adding a separate
> task-level flag.

The protocol already has the primitives needed for marketplace-created tasks:

- `TaskJobSpec` PDA stores a content-addressed off-chain job-spec pointer for a
  specific task.
- `set_task_job_spec` validates non-zero hash and URI shape, and binds the
  pointer to the task PDA.
- `claim_task_with_job_spec` requires the task-specific `TaskJobSpec` account
  and rejects mismatched or malformed pointers.

For launch, job-spec-required behavior is enforced above the base task account:

- The storefront always compiles and persists a job spec before runtime task
  creation.
- Core claim paths use `claimJobSpecVerification: "required"` for marketplace
  CLI/runtime claims.
- Core fails closed when an on-chain pointer exists but the local/off-chain
  job spec cannot be integrity-verified.
- Storefront runtime bridge now emits a per-order capability envelope that
  constrains task creation by reward, mint, service path, job-spec hash, and
  private constraint hash when applicable.

## Why Not Change Protocol Now

Adding a task-level flag would require account-layout migration or a compatible
extension path. That risk is not justified while the marketplace path can
already force `claim_task_with_job_spec` through runtime policy and storefront
controls.

Keeping the protocol unchanged preserves the task account layout while making the
claim boundary strict: every successful worker claim must use
`claim_task_with_job_spec`.

## Residual Risk

A generic client can still build the base `claim_task` instruction because the
ABI remains present, but the instruction returns `TaskJobSpecRequired`. This is
intentional compatibility for IDL consumers, not an alternate live claim path.

The marketplace launch invariant is:

`storefront order -> compiled job spec -> TaskJobSpec pointer -> required
runtime claim-time verification`

## Revisit Trigger

Revisit only if AgenC needs a richer per-task policy than "all successful claims
must carry a valid `TaskJobSpec` pointer" — for example multiple job-spec
revisions, creator-selected attestor sets, or explicit marketplace-governed task
extensions.

If that trigger happens, the compatible plan is:

- Add a migration-safe task extension account keyed by task PDA.
- Store `job_spec_required: bool` and expected `job_spec_hash`.
- Add a protocol instruction to initialize the extension before task claim.
- Keep base `claim_task` fail-closed, or replace it with a new claim router that
  still rejects missing or mismatched job spec hashes when the extension exists.
- Add tests proving claim without expected job spec is rejected.
