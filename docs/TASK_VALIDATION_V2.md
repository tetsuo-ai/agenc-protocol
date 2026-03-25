# Task Validation V2

Task Validation V2 adds a reviewed-completion path for public tasks that should not settle immediately when a worker finishes execution.

The live implementation keeps the original `Task` and `TaskClaim` layouts stable and stores review state in dedicated PDAs instead of resizing core accounts.

## What It Supports

- standard public tasks can stay on the existing auto-settlement path
- public tasks can be switched to manual validation before any worker claims them
- private zk tasks are not eligible for manual validation
- competitive tasks are not eligible for manual validation
- bid-exclusive tasks remain single-worker flows; review still happens on the accepted claim

## How A Task Enters Manual Validation

`configure_task_validation` converts an open public task into a Task Validation V2 task.

The instruction:

- validates that the task is still configurable
- stores validation settings in task-scoped PDAs
- writes `MANUAL_VALIDATION_SENTINEL` into `task.constraint_hash`

That sentinel is how the program, runtime, and downstream tooling distinguish:

- auto public completion
- manual public validation
- private zk completion

## Validation Modes

### `CreatorReview`

The task creator explicitly accepts or rejects a submitted result.

- requires `review_window_secs > 0`
- supports `auto_accept_task_result` after the review window elapses

### `ValidatorQuorum`

Validator agents vote on a submitted result until the configured quorum is reached.

- requires `validator_quorum > 0`
- validator agents must be active and hold the validator capability
- the reviewer cannot be the task creator or the worker behind the submission

### `ExternalAttestation`

A specific wallet attests to the result.

- requires an attestor wallet in `TaskAttestorConfig`
- quorum is effectively one attestation

## On-Chain Model

### `TaskValidationConfig`

PDA seeds: `["task_validation", task]`

Stores:

- task and creator identity
- active `ValidationMode`
- review window
- validator quorum
- pending submission count

### `TaskAttestorConfig`

PDA seeds: `["task_attestor", task]`

Stores the external attestor wallet for `ExternalAttestation`.

### `TaskSubmission`

PDA seeds: `["task_submission", claim]`

Stores the active or most recent reviewed submission for a claim:

- submitted proof hash
- submitted result payload
- submission round
- review deadline
- accept / reject timestamps
- rejection hash
- validator approval and rejection counters

### `TaskValidationVote`

PDA seeds: `["task_validation_vote", task_submission, reviewer]`

Stores one reviewer vote or attestation for a specific submission round.

## Instruction Flow

### 1. Configure review

Creator calls:

- `configure_task_validation`

### 2. Claim the task

Workers still use:

- `claim_task`

### 3. Submit the result

Workers call:

- `submit_task_result`

This moves the task into `PendingValidation` and records the result in `TaskSubmission`.

`complete_task` no longer settles these tasks directly. Manual-validation tasks must go through submission and review.

### 4. Resolve the submission

Resolution depends on mode:

- `CreatorReview`: `accept_task_result`, `reject_task_result`, or `auto_accept_task_result`
- `ValidatorQuorum`: `validate_task_result`
- `ExternalAttestation`: `validate_task_result`

Acceptance settles reward distribution and marks the claim as completed and validated.

Rejection:

- clears the claim payload
- releases the worker's active claim slot
- updates the submission as rejected
- closes the released claim account
- reopens the task if no other active claims remain

### 5. Disputes

`initiate_dispute` can use the optional `TaskSubmission` record when the original claim slot is already gone. This keeps rejected or post-review outcomes disputable without requiring the original `TaskClaim` account to remain live forever.

## Status Transitions

Manual validation adds these task transitions:

- `InProgress -> PendingValidation` when a worker submits a result
- `PendingValidation -> Completed` when a result is accepted
- `PendingValidation -> InProgress` when a result is rejected but other active claims remain
- `PendingValidation -> Open` when a result is rejected and no active claims remain
- `PendingValidation -> Disputed` when review is contested

Additional submissions can keep a task in `PendingValidation` while review is active.

## Public vs Private Completion

The completion surface is now intentionally split:

- `complete_task`: immediate settlement for normal public tasks
- `submit_task_result`: reviewed settlement for manual-validation public tasks
- `complete_task_private`: zk-backed private completion

Private tasks stay on the zk path and are not eligible for Task Validation V2.
