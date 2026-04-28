# Job Spec Required Flag Decision

Issue: `agenc-protocol#32`

## Decision

Do not add a new on-chain `job_spec_required` flag for the current launch
scope.

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

Keeping the protocol unchanged also preserves direct core/CLI task creation for
non-storefront users while allowing marketplace-created orders to be stricter at
the runtime boundary.

## Residual Risk

A generic client can still call the base `claim_task` instruction for tasks that
were not created through the marketplace-controlled path. That is acceptable for
the current scope because those tasks are outside the storefront capability
envelope.

The marketplace launch invariant is:

`storefront order -> compiled job spec -> TaskJobSpec pointer -> required
runtime claim-time verification`

## Revisit Trigger

Add a protocol-level flag if AgenC needs permissionless public marketplace task
creation where arbitrary creators can mark a task as marketplace-governed and
expect every client to enforce job-spec-aware claim semantics directly on-chain.

If that trigger happens, the compatible plan is:

- Add a migration-safe task extension account keyed by task PDA.
- Store `job_spec_required: bool` and expected `job_spec_hash`.
- Add a protocol instruction to initialize the extension before task claim.
- Gate base `claim_task` or introduce a new claim router that rejects missing or
  mismatched job spec hashes when the extension exists.
- Add tests proving claim without expected job spec is rejected.
