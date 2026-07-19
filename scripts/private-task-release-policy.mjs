// Single source of truth for the 2026-07 private-task release posture.
// Deployment tooling may inspect legacy state, but must never accept an image ID
// or claim readiness until an audited guest and mainnet verifier are available.

export const PRIVATE_TASK_RELEASE_STATE = "disabled";

export function assertPrivateTaskReleaseDisabled({
  zkImageId = "",
  privateTasksReady = false,
  targetClaimsPrivateReadiness = false,
} = {}) {
  if (String(zkImageId).trim() !== "" || privateTasksReady || targetClaimsPrivateReadiness) {
    throw new Error(
      "private-task/ZK readiness is forbidden for this release: no audited guest or " +
      "deployed mainnet verifier exists; ZkConfig initialization/rotation must remain disabled",
    );
  }
  return { releaseState: PRIVATE_TASK_RELEASE_STATE, activationAllowed: false };
}
