import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertReviewedAdminTransaction,
  reviewFreshAdminTransaction,
} from "./admin-signing-policy.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");
const programId = new PublicKey("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
function fixture() {
  const signer = Keypair.generate();
  const latest = {
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1000,
  };
  const data = Buffer.concat([
    createHash("sha256")
      .update("global:update_launch_controls")
      .digest()
      .subarray(0, 8),
    Buffer.from([1, 0, 5, 0]),
  ]);
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    ...latest,
  }).add(
    new TransactionInstruction({
      programId,
      data,
      keys: [
        {
          pubkey: Keypair.generate().publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ],
    }),
  );
  let simulation;
  const connection = {
    async simulateTransaction(tx, config) {
      simulation = { tx, config };
      return { context: { slot: 99 }, value: { err: null } };
    },
    async getBlockHeight() {
      return 100;
    },
    async isBlockhashValid() {
      return { value: true };
    },
  };
  const input = {
    connection,
    transaction,
    latest,
    signerPublicKeys: [signer.publicKey],
    minContextSlot: 90,
  };
  return { signer, input, simulation: () => simulation };
}

test("review simulates zero-signature bytes and binds the exact fresh message/signer set", async () => {
  const { input, simulation } = fixture();
  const review = await reviewFreshAdminTransaction(input);
  assert.equal(
    assertReviewedAdminTransaction(
      input.transaction,
      review,
      input.signerPublicKeys,
    ),
    review.messageSha256,
  );
  assert.equal(review.instructions[0].name, "update_launch_controls");
  assert.equal(simulation().config.sigVerify, false);
  assert.equal(simulation().config.replaceRecentBlockhash, true);
  assert.equal(simulation().config.minContextSlot, 90);
  assert.ok(
    simulation().tx.signatures.every((s) =>
      Buffer.from(s).every((byte) => byte === 0),
    ),
  );
  assert.equal(
    simulation().tx.message.recentBlockhash,
    PublicKey.default.toBase58(),
  );
  assert.throws(
    () =>
      assertReviewedAdminTransaction(
        input.transaction,
        { ...review },
        input.signerPublicKeys,
      ),
    /not issued/,
  );
  input.transaction.instructions[0].data[8] = 0;
  assert.throws(
    () =>
      assertReviewedAdminTransaction(
        input.transaction,
        review,
        input.signerPublicKeys,
      ),
    /changed/,
  );
});

test("durable nonce metadata and AdvanceNonceAccount at every position are refused before RPC", async () => {
  for (const position of [0, 1]) {
    const { input } = fixture();
    input.connection.simulateTransaction = () => {
      throw new Error("must not reach RPC");
    };
    const nonce = SystemProgram.nonceAdvance({
      noncePubkey: Keypair.generate().publicKey,
      authorizedPubkey: input.signerPublicKeys[0],
    });
    input.transaction.instructions.splice(position, 0, nonce);
    await assert.rejects(
      reviewFreshAdminTransaction(input),
      /AdvanceNonceAccount/,
    );
  }
  const { input } = fixture();
  input.transaction.nonceInfo = {
    nonce: input.latest.blockhash,
    nonceInstruction: SystemProgram.nonceAdvance({
      noncePubkey: Keypair.generate().publicKey,
      authorizedPubkey: input.signerPublicKeys[0],
    }),
  };
  await assert.rejects(reviewFreshAdminTransaction(input), /durable-nonce/);
});

test("pre-signed, unknown-program, stale-blockhash, missing-signer and unreviewed instructions fail closed", async () => {
  const signed = fixture();
  signed.input.transaction.sign(signed.signer);
  await assert.rejects(reviewFreshAdminTransaction(signed.input), /pre-signed/);
  const unknown = fixture();
  unknown.input.transaction.instructions[0].programId =
    Keypair.generate().publicKey;
  await assert.rejects(
    reviewFreshAdminTransaction(unknown.input),
    /unreviewed outer program/,
  );
  const stale = fixture();
  stale.input.transaction.recentBlockhash =
    Keypair.generate().publicKey.toBase58();
  await assert.rejects(
    reviewFreshAdminTransaction(stale.input),
    /freshly fetched/,
  );
  const unavailable = fixture();
  unavailable.input.transaction.instructions[0].keys.push({
    pubkey: Keypair.generate().publicKey,
    isSigner: true,
    isWritable: false,
  });
  await assert.rejects(
    reviewFreshAdminTransaction(unavailable.input),
    /unavailable/,
  );
  const invalid = fixture();
  invalid.input.transaction.instructions[0].data = Buffer.alloc(8);
  await assert.rejects(
    reviewFreshAdminTransaction(invalid.input),
    /canonical IDL/,
  );
});

test("failed/stale simulation, expired blockhash and changes during review cannot reach signing", async () => {
  const failed = fixture();
  failed.input.connection.simulateTransaction = async () => ({
    context: { slot: 99 },
    value: { err: { InstructionError: [0, "InvalidArgument"] } },
  });
  await assert.rejects(
    reviewFreshAdminTransaction(failed.input),
    /simulation failed/,
  );
  const stale = fixture();
  stale.input.minContextSlot = 100;
  await assert.rejects(
    reviewFreshAdminTransaction(stale.input),
    /context is missing or stale/,
  );
  const expired = fixture();
  expired.input.connection.getBlockHeight = async () => 1001;
  await assert.rejects(reviewFreshAdminTransaction(expired.input), /expired/);
  const invalid = fixture();
  invalid.input.connection.isBlockhashValid = async () => ({ value: false });
  await assert.rejects(
    reviewFreshAdminTransaction(invalid.input),
    /no longer valid/,
  );
  const raced = fixture();
  const simulate = raced.input.connection.simulateTransaction;
  raced.input.connection.simulateTransaction = async (...args) => {
    raced.input.transaction.instructions[0].data[8] = 0;
    return simulate(...args);
  };
  await assert.rejects(
    reviewFreshAdminTransaction(raced.input),
    /changed after review/,
  );
});

test("review has a bounded lifetime and a changed signer set invalidates the receipt", async (t) => {
  const { input } = fixture();
  const review = await reviewFreshAdminTransaction(input);
  assert.throws(
    () =>
      assertReviewedAdminTransaction(input.transaction, review, [
        ...input.signerPublicKeys,
        Keypair.generate().publicKey,
      ]),
    /extra local signer/,
  );
  t.mock.method(Date, "now", () => review.startedAt + 30_001);
  assert.throws(
    () =>
      assertReviewedAdminTransaction(
        input.transaction,
        review,
        input.signerPublicKeys,
      ),
    /expired/,
  );
});
