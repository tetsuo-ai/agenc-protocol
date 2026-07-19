import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey, TransactionMessage, VersionedTransaction } = require(
  "@solana/web3.js",
);

// The RPC replaces this placeholder only inside simulation. The serialized
// transaction sent to the RPC retains zero signatures and is therefore never a
// broadcastable authority transaction, even if the configured RPC is hostile.
const NON_BROADCASTABLE_BLOCKHASH = PublicKey.default.toBase58();

export const DEFAULT_MODERATION_LIVENESS_WINDOW_SECS = 90n * 24n * 60n * 60n;
export const MIN_STAMP_MODERATION_FRESHNESS_SECS = 300n;

export function canonicalSha256(value, label = "sha256") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be exactly 64 hexadecimal characters`);
  }
  return normalized;
}

export function accountDataSha256(account, label = "account") {
  if (
    !account ||
    (!Buffer.isBuffer(account.data) && !(account.data instanceof Uint8Array))
  ) {
    throw new Error(`${label} account data is missing or malformed`);
  }
  return createHash("sha256").update(Buffer.from(account.data)).digest("hex");
}

export function sha256DigestBytes(value, label = "sha256") {
  return [...Buffer.from(canonicalSha256(value, label), "hex")];
}

function asSimulationPublicKey(value, label) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
}

/**
 * Build a VersionedTransaction whose signer slots are deliberately all zero.
 * It is suitable only for `simulateTransaction` with signature verification
 * disabled and an RPC-replaced blockhash; it cannot be relayed as a valid tx.
 */
export function buildNonBroadcastableSimulationTransaction({
  feePayer,
  instructions,
}) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error("simulation instructions must be a non-empty array");
  }
  const message = new TransactionMessage({
    payerKey: asSimulationPublicKey(feePayer, "simulation fee payer"),
    recentBlockhash: NON_BROADCASTABLE_BLOCKHASH,
    instructions,
  }).compileToLegacyMessage();
  const transaction = new VersionedTransaction(message);
  if (
    transaction.signatures.length === 0 ||
    transaction.signatures.some((signature) =>
      Buffer.from(signature).some((byte) => byte !== 0),
    )
  ) {
    throw new Error("simulation transaction unexpectedly contains a signature");
  }
  return transaction;
}

export async function simulateNonBroadcastableInstructions(
  connection,
  { feePayer, instructions, commitment = "confirmed" },
) {
  if (!connection || typeof connection.simulateTransaction !== "function") {
    throw new Error("simulation connection is missing simulateTransaction");
  }
  const transaction = buildNonBroadcastableSimulationTransaction({
    feePayer,
    instructions,
  });
  return connection.simulateTransaction(transaction, {
    commitment,
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
}

function explicitOneFlag(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return false;
  if (raw !== "1") {
    throw new Error(`${name} must be exactly 1 when set`);
  }
  return true;
}

/**
 * FORCE_STAMP is deliberately a two-key control. A stale ambient FORCE_STAMP
 * must never turn a normal init/verification invocation into an idempotent
 * launch-control write; the parent must explicitly identify the stamp-only
 * child phase with RUN_STAMP=1 as well.
 */
export function resolveStampMode(env = {}) {
  const skipStamp = explicitOneFlag(env, "SKIP_STAMP");
  const runStamp = explicitOneFlag(env, "RUN_STAMP");
  const forceStamp = explicitOneFlag(env, "FORCE_STAMP");
  if (forceStamp && !runStamp) {
    throw new Error("FORCE_STAMP=1 requires RUN_STAMP=1");
  }
  if (runStamp && skipStamp) {
    throw new Error("RUN_STAMP=1 and SKIP_STAMP=1 are mutually exclusive");
  }
  return Object.freeze({ skipStamp, runStamp, forceStamp });
}

function asCanonicalNonNegativeBigInt(value, label) {
  const raw =
    typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${label} must be a canonical non-negative integer`);
  }
  return BigInt(raw);
}

/**
 * A reviewed moderation heartbeat must still be live when the surface stamp is
 * sent. Five minutes of headroom prevents a policy that is technically live at
 * planning time from expiring while the transaction is being signed/landed.
 */
export function assertModerationFreshForStamp(
  moderation,
  chainUnixTimestamp,
  {
    minimumReviewedUpdatedAt = 0n,
    minimumRemainingSecs = MIN_STAMP_MODERATION_FRESHNESS_SECS,
  } = {},
) {
  if (!moderation || typeof moderation !== "object") {
    throw new Error("ModerationConfig is required at the stamp boundary");
  }
  const now = asCanonicalNonNegativeBigInt(
    chainUnixTimestamp,
    "chain Clock unix timestamp",
  );
  const updatedAt = asCanonicalNonNegativeBigInt(
    moderation.updatedAt,
    "ModerationConfig updated_at",
  );
  const reviewedFloor = asCanonicalNonNegativeBigInt(
    minimumReviewedUpdatedAt,
    "reviewed ModerationConfig updated_at floor",
  );
  const remainingFloor = asCanonicalNonNegativeBigInt(
    minimumRemainingSecs,
    "minimum moderation freshness",
  );
  if (updatedAt < reviewedFloor) {
    throw new Error(
      `ModerationConfig updated_at ${updatedAt} regressed below reviewed ${reviewedFloor}`,
    );
  }
  if (updatedAt > now) {
    throw new Error(
      `ModerationConfig updated_at ${updatedAt} is ahead of chain Clock ${now}`,
    );
  }
  const configuredWindow = asCanonicalNonNegativeBigInt(
    moderation.livenessWindowSecs,
    "ModerationConfig liveness window",
  );
  const effectiveWindow =
    configuredWindow === 0n
      ? DEFAULT_MODERATION_LIVENESS_WINDOW_SECS
      : configuredWindow;
  const expiresAt = updatedAt + effectiveWindow;
  const remainingSecs = expiresAt > now ? expiresAt - now : 0n;

  // A disabled policy does not apply ALLOW decisions and therefore cannot be
  // weakened by the liveness deadman. We still enforce the reviewed timestamp
  // floor and reject future timestamps above.
  if (moderation.enabled === false) {
    return {
      effectiveWindowSecs: effectiveWindow,
      enforced: false,
      expiresAt,
      remainingSecs,
    };
  }
  if (moderation.enabled !== true) {
    throw new Error("ModerationConfig enabled state is malformed");
  }
  if (remainingSecs < remainingFloor) {
    throw new Error(
      `ModerationConfig heartbeat has only ${remainingSecs}s remaining; ` +
        `${remainingFloor}s is required before the surface stamp. Submit and review a moderation heartbeat first`,
    );
  }
  return {
    effectiveWindowSecs: effectiveWindow,
    enforced: true,
    expiresAt,
    remainingSecs,
  };
}
