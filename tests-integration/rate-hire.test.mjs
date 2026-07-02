// In-process litesvm integration tests for the P6.1 `rate_hire` instruction
// (camelCase method `rateHire`; account type `HireRating`).
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end and
// drives a full hire -> moderate -> publish -> claim -> complete lifecycle so the
// task reaches the terminal `Completed` state, then rates it. Mirrors the style of
// marketplace.test.mjs / listing-mod-dispute.test.mjs.
//
// REVERT-SENSITIVE INTENT — each negative test isolates exactly one guard added in
// programs/agenc-coordination/src/instructions/rate_hire.rs:
//   - "non-buyer"            -> the `buyer.key() == task.creator` require! (RatingNotBuyer)
//   - "double-rate"          -> the init-once ["hire_rating", task] PDA (second rate fails)
//   - "non-terminal task"    -> the `status == Completed` require! (TaskNotCompletedForRating)
//   - "score 0" / "score 6"  -> the `1..=5` require! (InvalidRatingScore)
// Removing the corresponding require! (or making the PDA non-init) flips the matching
// test from pass to fail. The positive test additionally proves the listing aggregate
// actually moved (total_rating += score, rating_count += 1) and the HireRating record
// was written with the buyer + score — so an aggregate write that silently no-ops
// would also be caught.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh before this test). It references the to-be-generated `rateHire`
// builder and `HireRating` account decoder by their naming-convention names.
//
// Run:  cd agenc-protocol && node --test tests-integration/rate-hire.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld,
  BN, SystemProgram, FailedTransactionMetadata,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Local helper: drive a listing hire all the way to a terminal Completed task.
// Mirrors marketplace.test.mjs's runHireSettlement (which is not exported). Uses a
// moderation-enabled world so the hire + job-spec gates pass. The buyer (w.buyer)
// signs the hire, so task.creator == w.buyer.publicKey (the recorded buyer).
// Returns { task, hireRecord, listing }.
// ---------------------------------------------------------------------------
async function hireToCompleted(w) {
  const modProg = makeProgram(w.modAuth);

  // 0) CLEAN ListingModeration so the hire passes the moderation gate.
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "rate-hire:record-listing-mod");
  }

  // 1) buyer hires the provider's listing -> Open task + escrow + HireRecord.
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .hireFromListing(arr(taskId), new BN(w.price), new BN(1), null, 0)
    .accounts({
      task, escrow, hireRecord, listing: w.listing, protocolConfig: w.protocolPda,
      moderationConfig: w.modCfg, listingModeration: listingMod, moderationAttestor: null,
      creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "rate-hire:hire");

  // 2) task moderation -> publish job spec -> worker claims.
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "rate-hire:task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "rate-hire:publish");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "rate-hire:claim");

  // Return BEFORE completion when the caller wants to test the non-terminal guard.
  return { task, escrow, claim, hireRecord, jobSpec, taskMod, listing: w.listing,
    complete: async () => {
      expectOk(send(w.svm, await w.providerProg.methods
        .completeTask(arr(id32()), null)
        .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
        .instruction(), [w.provider]), "rate-hire:complete");
    } };
}

/// Build a rate_hire instruction for the given signer/score.
async function rateHireIx(w, { task, listing, hireRecord, signer, score, reviewHash = null, reviewUri = "" }) {
  const [hireRating] = pda([enc("hire_rating"), task.toBuffer()]);
  const prog = makeProgram(signer);
  const ix = await prog.methods
    .rateHire(score, reviewHash, reviewUri)
    .accounts({
      task, hireRecord, listing, hireRating, protocolConfig: w.protocolPda,
      buyer: signer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, hireRating };
}

// ---------------------------------------------------------------------------
// Positive: the buyer rates a completed hire; listing aggregate + record update.
// ---------------------------------------------------------------------------
test("rate_hire: buyer rates a completed hire -> listing aggregate + HireRating record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const h = await hireToCompleted(w);
  await h.complete();

  const t = decode(w.svm, "Task", h.task);
  assert.ok(t.status.Completed !== undefined, `task should be Completed (got ${JSON.stringify(t.status)})`);

  const before = decode(w.svm, "ServiceListing", h.listing);

  const reviewHash = arr(crypto.randomBytes(32));
  const { ix, hireRating } = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord,
    signer: w.buyer, score: 3, reviewHash, reviewUri: "agenc://review/sha256/abc",
  });
  expectOk(send(w.svm, ix, [w.buyer]), "rate_hire by buyer");

  // Listing aggregate moved by exactly the score and one count.
  const after = decode(w.svm, "ServiceListing", h.listing);
  assert.equal(
    (BigInt(after.total_rating.toString()) - BigInt(before.total_rating.toString())).toString(),
    "3",
    "listing.total_rating += score",
  );
  assert.equal(
    after.rating_count - before.rating_count, 1,
    "listing.rating_count += 1",
  );

  // HireRating record written with the buyer + score + review pointer.
  const rec = decode(w.svm, "HireRating", hireRating);
  assert.ok(rec, "HireRating account exists");
  assert.equal(rec.score, 3, "stored score");
  assert.equal(rec.buyer.toBase58(), w.buyer.publicKey.toBase58(), "stored buyer == task creator");
  assert.equal(rec.task.toBase58(), h.task.toBase58(), "stored task");
  assert.equal(rec.listing.toBase58(), h.listing.toBase58(), "stored listing");
  assert.equal(rec.review_uri, "agenc://review/sha256/abc", "stored review_uri");
});

// ---------------------------------------------------------------------------
// Negative: a non-buyer signer cannot rate (RatingNotBuyer guard).
// ---------------------------------------------------------------------------
test("rate_hire: a non-buyer signer is rejected (RatingNotBuyer)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const h = await hireToCompleted(w);
  await h.complete();

  // The provider is a funded signer but NOT the recorded buyer (task.creator).
  const { ix } = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord,
    signer: w.provider, score: 4,
  });
  expectFail(send(w.svm, ix, [w.provider]), "RatingNotBuyer", "non-buyer rate");

  // Aggregate untouched.
  const l = decode(w.svm, "ServiceListing", h.listing);
  assert.equal(l.rating_count, 0, "rating_count unchanged after rejected rate");
});

// ---------------------------------------------------------------------------
// Negative: double-rating the same task fails (init-once ["hire_rating", task]).
// ---------------------------------------------------------------------------
test("rate_hire: a second rating on the same task is rejected (one rating per hire)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const h = await hireToCompleted(w);
  await h.complete();

  const first = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord, signer: w.buyer, score: 5,
  });
  expectOk(send(w.svm, first.ix, [w.buyer]), "first rate");

  // Second rate uses a DIFFERENT score so the tx bytes differ (avoids litesvm dedup);
  // the init-once hire_rating PDA already exists, so it must still fail.
  const second = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord, signer: w.buyer, score: 2,
  });
  const res = send(w.svm, second.ix, [w.buyer]);
  assert.ok(
    res instanceof FailedTransactionMetadata,
    "second rate_hire on the same task must fail (init-once hire_rating PDA already in use)",
  );

  // Aggregate moved exactly once.
  const l = decode(w.svm, "ServiceListing", h.listing);
  assert.equal(l.rating_count, 1, "exactly one rating counted");
  assert.equal(l.total_rating.toString(), "5", "only the first score counted");
});

// ---------------------------------------------------------------------------
// Negative: a non-terminal (still InProgress) task cannot be rated.
// ---------------------------------------------------------------------------
test("rate_hire: a non-completed task is rejected (TaskNotCompletedForRating)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // hireToCompleted stops just before complete(): the task is claimed (InProgress).
  const h = await hireToCompleted(w);

  const t = decode(w.svm, "Task", h.task);
  assert.ok(t.status.Completed === undefined, `task must NOT be Completed yet (got ${JSON.stringify(t.status)})`);

  const { ix } = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord, signer: w.buyer, score: 4,
  });
  expectFail(send(w.svm, ix, [w.buyer]), "TaskNotCompletedForRating", "rate non-terminal task");
});

// ---------------------------------------------------------------------------
// Negative: score out of [1,5] is rejected (InvalidRatingScore) on both edges.
// ---------------------------------------------------------------------------
test("rate_hire: score 0 and score 6 are rejected (InvalidRatingScore)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const h = await hireToCompleted(w);
  await h.complete();

  const zero = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord, signer: w.buyer, score: 0,
  });
  expectFail(send(w.svm, zero.ix, [w.buyer]), "InvalidRatingScore", "score 0");

  const six = await rateHireIx(w, {
    task: h.task, listing: h.listing, hireRecord: h.hireRecord, signer: w.buyer, score: 6,
  });
  expectFail(send(w.svm, six.ix, [w.buyer]), "InvalidRatingScore", "score 6");

  // No rating recorded after both rejections.
  const l = decode(w.svm, "ServiceListing", h.listing);
  assert.equal(l.rating_count, 0, "no rating recorded after out-of-range scores");
});
