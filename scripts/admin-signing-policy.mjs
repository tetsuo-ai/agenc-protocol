import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { simulateNonBroadcastableInstructions } from "./mainnet-release-boundary.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const idl = JSON.parse(
  readFileSync(
    new URL("../artifacts/anchor/idl/agenc_coordination.json", import.meta.url),
  ),
);
const names = new Map(
  idl.instructions.map((ix) => [
    Buffer.from(ix.discriminator).toString("hex"),
    ix.name,
  ]),
);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const MAX_REVIEW_AGE_MS = 30_000;
const issuedReviews = new WeakMap();

function inspect(transaction, latest, signerPublicKeys) {
  if (!(transaction instanceof Transaction))
    throw new Error(
      "admin signing requires locally built legacy instructions; imported/versioned transactions are not accepted",
    );
  if (transaction.nonceInfo)
    throw new Error("durable-nonce admin signing is forbidden");
  if (transaction.signatures.some(({ signature }) => signature !== null))
    throw new Error("pre-signed admin transactions are forbidden");
  if (
    !latest ||
    !Number.isSafeInteger(latest.lastValidBlockHeight) ||
    transaction.recentBlockhash !== latest.blockhash ||
    transaction.lastValidBlockHeight !== latest.lastValidBlockHeight
  )
    throw new Error(
      "admin transaction does not use the freshly fetched blockhash lifetime",
    );
  new PublicKey(latest.blockhash);
  const signers = signerPublicKeys.map((key) => new PublicKey(key).toBase58());
  if (
    !transaction.feePayer ||
    !signers.includes(transaction.feePayer.toBase58())
  )
    throw new Error("admin fee payer must be a local signer");
  if (new Set(signers).size !== signers.length)
    throw new Error("duplicate local signers");
  if (transaction.instructions.length === 0)
    throw new Error("admin transaction has no instructions");
  const instructions = transaction.instructions.map((ix) => {
    const data = Buffer.from(ix.data);
    if (
      ix.programId.equals(SystemProgram.programId) &&
      data.length >= 4 &&
      data.readUInt32LE(0) === 4
    )
      throw new Error(
        "AdvanceNonceAccount is forbidden at every admin instruction position",
      );
    let name;
    if (ix.programId.toBase58() === idl.address) {
      name = names.get(data.subarray(0, 8).toString("hex"));
      if (!name)
        throw new Error(
          "admin instruction is absent from the reviewed canonical IDL",
        );
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const sizes = new Map([
        [1, 5],
        [2, 5],
        [3, 9],
        [4, 5],
      ]);
      if (sizes.get(data[0]) !== data.length || ix.keys.length !== 0)
        throw new Error("malformed compute-budget instruction");
      name = `compute_budget_${data[0]}`;
    } else throw new Error("unreviewed outer program in admin transaction");
    for (const account of ix.keys)
      if (account.isSigner && !signers.includes(account.pubkey.toBase58()))
        throw new Error(
          "admin instruction requires an unavailable local signer",
        );
    return {
      name,
      program: ix.programId.toBase58(),
      dataHex: data.toString("hex"),
      accounts: ix.keys.map((a) => ({
        address: a.pubkey.toBase58(),
        signer: a.isSigner,
        writable: a.isWritable,
      })),
    };
  });
  const message = transaction.serializeMessage();
  const required = transaction
    .compileMessage()
    .accountKeys.slice(
      0,
      transaction.compileMessage().header.numRequiredSignatures,
    )
    .map((key) => key.toBase58());
  if (signers.some((key) => !required.includes(key)))
    throw new Error("unexpected extra local signer");
  return {
    messageSha256: sha(message),
    instructions,
    feePayer: transaction.feePayer.toBase58(),
    signers: [...signers].sort(),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

/** Simulate zero-signature bytes before any authority signature is created. */
export async function reviewFreshAdminTransaction({
  connection,
  transaction,
  latest,
  signerPublicKeys,
  minContextSlot = 0,
}) {
  const startedAt = Date.now();
  const inspected = inspect(transaction, latest, signerPublicKeys);
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
    throw new Error("invalid admin review context slot");
  const simulation = await simulateNonBroadcastableInstructions(connection, {
    feePayer: transaction.feePayer,
    // Snapshot data/metas so an asynchronous mutation cannot alter the simulated intent.
    instructions: transaction.instructions.map((ix) => ({
      ...ix,
      data: Buffer.from(ix.data),
      keys: ix.keys.map((key) => ({ ...key })),
    })),
    commitment: "confirmed",
    minContextSlot,
  });
  if (
    !simulation?.context ||
    !Number.isSafeInteger(simulation.context.slot) ||
    simulation.context.slot < minContextSlot
  )
    throw new Error("admin simulation context is missing or stale");
  if (simulation.value.err)
    throw new Error(
      `unsigned admin simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  const blockHeight = await connection.getBlockHeight({
    commitment: "confirmed",
    minContextSlot: simulation.context.slot,
  });
  if (
    !Number.isSafeInteger(blockHeight) ||
    blockHeight > latest.lastValidBlockHeight
  )
    throw new Error("fresh admin blockhash has expired");
  const valid = await connection.isBlockhashValid(latest.blockhash, {
    commitment: "confirmed",
    minContextSlot: simulation.context.slot,
  });
  if (valid?.value !== true)
    throw new Error("admin blockhash is no longer valid");
  const review = Object.freeze({
    ...inspected,
    contextSlot: simulation.context.slot,
    startedAt,
    simulationUnits: simulation.value.unitsConsumed ?? null,
  });
  issuedReviews.set(review, structuredClone(review));
  assertReviewedAdminTransaction(transaction, review, signerPublicKeys);
  return review;
}

/** Synchronous final check: call immediately before local signing, after all RPC gates. */
export function assertReviewedAdminTransaction(
  transaction,
  review,
  signerPublicKeys,
) {
  const issued = review && issuedReviews.get(review);
  if (!issued) throw new Error("admin review was not issued by this process");
  if (
    Date.now() - issued.startedAt > MAX_REVIEW_AGE_MS ||
    Date.now() < issued.startedAt
  )
    throw new Error(
      "admin review expired; rebuild and simulate a fresh transaction",
    );
  const current = inspect(transaction, issued, signerPublicKeys);
  if (
    current.messageSha256 !== issued.messageSha256 ||
    JSON.stringify(current.signers) !== JSON.stringify(issued.signers)
  )
    throw new Error("admin message or signer set changed after review");
  return review.messageSha256;
}
