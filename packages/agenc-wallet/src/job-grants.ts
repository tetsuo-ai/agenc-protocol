import type { HandoffPermission, JobHandoff } from "./client/connections.js";
import { WalletError } from "./errors.js";

export function jobGrant(
  connectionId: string,
  jobId: string,
  payer: string,
  permissions: HandoffPermission[],
): JobHandoff {
  if (
    !Array.isArray(permissions) ||
    permissions.length > 3 ||
    permissions.some((p) => !["status", "artifacts", "propose"].includes(p))
  ) {
    throw new WalletError(
      "BAD_REQUEST",
      "Choose status, artifacts or permission to propose a decision.",
    );
  }
  return {
    connectionId,
    jobId,
    payer,
    permissions: [...new Set(permissions)],
    grantedAt: Date.now(),
  };
}
