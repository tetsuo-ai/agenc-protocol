import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  DEFAULT_MODERATION_LIVENESS_WINDOW_SECS,
  accountDataSha256,
  assertModerationFreshForStamp,
  buildNonBroadcastableSimulationTransaction,
  canonicalSha256,
  resolveStampMode,
  sha256DigestBytes,
  simulateNonBroadcastableInstructions,
} from "./mainnet-release-boundary.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { Keypair, SystemProgram, VersionedTransaction } = require(
  "@solana/web3.js",
);

test("forced stamp mode requires an explicit, non-skipped stamp phase", () => {
  assert.deepEqual(resolveStampMode({}), {
    skipStamp: false,
    runStamp: false,
    forceStamp: false,
  });
  assert.deepEqual(resolveStampMode({ SKIP_STAMP: "1" }), {
    skipStamp: true,
    runStamp: false,
    forceStamp: false,
  });
  assert.deepEqual(resolveStampMode({ RUN_STAMP: "1", FORCE_STAMP: "1" }), {
    skipStamp: false,
    runStamp: true,
    forceStamp: true,
  });
  assert.throws(
    () => resolveStampMode({ FORCE_STAMP: "1" }),
    /requires RUN_STAMP=1/,
  );
  assert.throws(
    () => resolveStampMode({ RUN_STAMP: "1", SKIP_STAMP: "1" }),
    /mutually exclusive/,
  );
  assert.throws(
    () => resolveStampMode({ RUN_STAMP: "true" }),
    /must be exactly 1/,
  );
});

test("stamp moderation freshness mirrors the default liveness window with landing headroom", () => {
  const now = 10_000_000n;
  const fresh = assertModerationFreshForStamp(
    {
      enabled: true,
      livenessWindowSecs: 0,
      updatedAt: now - 60n,
    },
    now,
    { minimumReviewedUpdatedAt: now - 120n },
  );
  assert.equal(
    fresh.effectiveWindowSecs,
    DEFAULT_MODERATION_LIVENESS_WINDOW_SECS,
  );
  assert.ok(fresh.remainingSecs > 300n);

  assert.throws(
    () =>
      assertModerationFreshForStamp(
        {
          enabled: true,
          livenessWindowSecs: 86_400,
          updatedAt: now - 86_200n,
        },
        now,
      ),
    /only 200s remaining.*heartbeat first/,
  );
  assert.throws(
    () =>
      assertModerationFreshForStamp(
        { enabled: true, livenessWindowSecs: 86_400, updatedAt: now - 10n },
        now,
        { minimumReviewedUpdatedAt: now },
      ),
    /regressed below reviewed/,
  );
  assert.throws(
    () =>
      assertModerationFreshForStamp(
        { enabled: true, livenessWindowSecs: 86_400, updatedAt: now + 1n },
        now,
      ),
    /ahead of chain Clock/,
  );
});

test("disabled moderation does not apply deadman freshness but remains review-bound", () => {
  const result = assertModerationFreshForStamp(
    { enabled: false, livenessWindowSecs: 86_400, updatedAt: 1_000n },
    1_000_000n,
    { minimumReviewedUpdatedAt: 1_000n },
  );
  assert.equal(result.enforced, false);
  assert.equal(result.remainingSecs, 0n);
});

test("boundary digest helpers reject noncanonical approvals", () => {
  assert.equal(
    accountDataSha256({ data: Buffer.from("reviewed") }),
    "e4f934f321eb76c9bf8b5103e0a0d9afe72d6e62ace3d3ea849790619bf7487a",
  );
  assert.equal(canonicalSha256("AA".repeat(32)), "aa".repeat(32));
  assert.throws(() => canonicalSha256("abc"), /64 hexadecimal/);
  assert.throws(() => accountDataSha256(null), /missing or malformed/);
  assert.deepEqual(sha256DigestBytes("0a".repeat(32)), new Array(32).fill(10));
});

test("PLAN simulation bytes are unsigned, versioned, and non-broadcastable", async () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: recipient,
    lamports: 1,
  });
  const built = buildNonBroadcastableSimulationTransaction({
    feePayer: payer,
    instructions: [instruction],
  });
  assert.ok(built instanceof VersionedTransaction);
  assert.ok(built.signatures.length > 0);
  assert.ok(
    built.signatures.every((signature) =>
      Buffer.from(signature).every((byte) => byte === 0),
    ),
  );

  let observed;
  const response = { value: { err: null, logs: [] } };
  const connection = {
    async simulateTransaction(transaction, config) {
      observed = { transaction, config };
      return response;
    },
  };
  assert.equal(
    await simulateNonBroadcastableInstructions(connection, {
      feePayer: payer,
      instructions: [instruction],
    }),
    response,
  );
  assert.ok(observed.transaction instanceof VersionedTransaction);
  assert.deepEqual(observed.config, {
    commitment: "confirmed",
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  assert.ok(
    observed.transaction.signatures.every((signature) =>
      Buffer.from(signature).every((byte) => byte === 0),
    ),
  );
});
