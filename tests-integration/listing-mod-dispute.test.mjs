// In-process litesvm integration tests for four agenc-coordination instructions:
//   - update_service_listing      (updateServiceListing)
//   - set_service_listing_state   (setServiceListingState)
//   - configure_task_moderation   (configureTaskModeration)
//   - cancel_dispute              (cancelDispute)
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
// Mirrors the style of marketplace.test.mjs. Helpers from that file are NOT exported,
// so the small amount of dispute setup we need is replicated locally here.
//
// Run:  cd agenc-protocol && node --test tests-integration/listing-mod-dispute.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// update_service_listing
// ---------------------------------------------------------------------------

test("update_service_listing: provider updates price/capabilities, bumps version", async () => {
  const w = await freshWorld({ price: 1_000_000 });

  const before = decode(w.svm, "ServiceListing", w.listing);
  assert.equal(before.version.toString(), "1", "listing starts at version 1");
  assert.equal(before.price.toString(), "1000000", "initial price");

  const newSpec = id32();
  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .updateServiceListing(
          new BN(2_500_000), // price
          arr(newSpec),      // spec_hash
          "agenc://job-spec/sha256/updated", // spec_uri
          arr(Buffer.alloc(64, 9)), // tags
          new BN(5),         // required_capabilities
          new BN(7200),      // default_deadline_secs
          42,                // max_open_jobs
          null,              // operator (leave unchanged via None)
          null,              // operator_fee_bps
        )
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "update listing",
  );

  const after = decode(w.svm, "ServiceListing", w.listing);
  assert.equal(after.price.toString(), "2500000", "price updated");
  assert.equal(after.required_capabilities.toString(), "5", "capabilities updated");
  assert.equal(after.default_deadline_secs.toString(), "7200", "deadline updated");
  assert.equal(after.max_open_jobs, 42, "max_open_jobs updated");
  assert.equal(
    Buffer.from(after.spec_hash).toString("hex"),
    Buffer.from(newSpec).toString("hex"),
    "spec_hash updated",
  );
  assert.equal(after.spec_uri, "agenc://job-spec/sha256/updated", "spec_uri updated");
  assert.equal(after.version.toString(), "2", "version bumped 1 -> 2");
});

test("update_service_listing: a non-authority cannot update the listing", async () => {
  const w = await freshWorld({ price: 1_000_000 });
  // The buyer is a valid registered agent but NOT the listing authority.
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .updateServiceListing(new BN(2_000_000), null, null, null, null, null, null, null, null)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.buyer.publicKey })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority update",
  );
  // unchanged
  assert.equal(decode(w.svm, "ServiceListing", w.listing).price.toString(), "1000000", "price unchanged after rejected update");
});

test("update_service_listing: price below MIN_SKILL_PRICE is rejected", async () => {
  const w = await freshWorld({ price: 1_000_000 });
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .updateServiceListing(new BN(500) /* < 1_000 MIN_SKILL_PRICE */, null, null, null, null, null, null, null, null)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "ListingPriceTooLow",
    "below-min price",
  );
});

// ---------------------------------------------------------------------------
// set_service_listing_state
// ---------------------------------------------------------------------------

test("set_service_listing_state: Active -> Paused -> Active flips listing.state", async () => {
  const w = await freshWorld({});
  const setState = async (n, label) =>
    expectOk(
      send(
        w.svm,
        await w.providerProg.methods
          .setServiceListingState(n)
          .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
          .instruction(),
        [w.provider],
      ),
      label,
    );

  assert.ok(decode(w.svm, "ServiceListing", w.listing).state.Active !== undefined, "starts Active");

  await setState(1, "pause");
  assert.ok(decode(w.svm, "ServiceListing", w.listing).state.Paused !== undefined, "now Paused");

  w.svm.expireBlockhash(); // avoid byte-identical dedupe vs. a possible later identical tx
  await setState(0, "reactivate");
  assert.ok(decode(w.svm, "ServiceListing", w.listing).state.Active !== undefined, "back to Active");
});

test("set_service_listing_state: Retired is terminal — no further transitions, and update is refused", async () => {
  const w = await freshWorld({});
  // Retire the listing (terminal).
  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .setServiceListingState(2)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "retire",
  );
  assert.ok(decode(w.svm, "ServiceListing", w.listing).state.Retired !== undefined, "listing Retired");

  // A retired listing cannot be reactivated.
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .setServiceListingState(0)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "ListingRetired",
    "reactivate a retired listing",
  );

  // A retired listing is immutable to update_service_listing as well.
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .updateServiceListing(new BN(2_000_000), null, null, null, null, null, null, null, null)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "ListingRetired",
    "update a retired listing",
  );
});

test("set_service_listing_state: a non-authority cannot change listing state", async () => {
  const w = await freshWorld({});
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .setServiceListingState(1)
        .accounts({ listing: w.listing, protocolConfig: w.protocolPda, authority: w.buyer.publicKey })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority state change",
  );
  assert.ok(decode(w.svm, "ServiceListing", w.listing).state.Active !== undefined, "state unchanged after rejected change");
});

// ---------------------------------------------------------------------------
// configure_task_moderation
// ---------------------------------------------------------------------------

test("configure_task_moderation: protocol authority sets moderation authority + enabled flag", async () => {
  // freshWorld injects a ModerationConfig (disabled, authority=admin). configure_task_moderation
  // is init_if_needed so it reuses the existing account and rewrites its fields.
  const w = await freshWorld({ moderationEnabled: false });
  const newModAuth = Keypair.generate();

  const before = decode(w.svm, "ModerationConfig", w.modCfg);
  assert.equal(before.enabled, false, "starts disabled");

  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .configureTaskModeration(newModAuth.publicKey, true)
        .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.admin],
    ),
    "configure moderation",
  );

  const after = decode(w.svm, "ModerationConfig", w.modCfg);
  assert.equal(after.enabled, true, "moderation enabled");
  assert.equal(after.moderation_authority.toBase58(), newModAuth.publicKey.toBase58(), "moderation_authority set");
  assert.equal(after.authority.toBase58(), w.admin.publicKey.toBase58(), "config authority == protocol authority");
});

test("configure_task_moderation: a non-protocol-authority is rejected", async () => {
  const w = await freshWorld({});
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  expectFail(
    send(
      w.svm,
      await makeProgram(stranger).methods
        .configureTaskModeration(stranger.publicKey, true)
        .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg, authority: stranger.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [stranger],
    ),
    "UnauthorizedAgent",
    "non-protocol-authority configure",
  );
  assert.equal(decode(w.svm, "ModerationConfig", w.modCfg).enabled, false, "config unchanged after rejected configure");
});

test("configure_task_moderation: a default (zero) moderation authority is rejected", async () => {
  const w = await freshWorld({});
  expectFail(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .configureTaskModeration(PublicKey.default, true)
        .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.admin],
    ),
    "InvalidTaskModerationAuthority",
    "zero moderation authority",
  );
});

// ---------------------------------------------------------------------------
// cancel_dispute
// ---------------------------------------------------------------------------

/// Replicate marketplace.test.mjs's hire -> claim -> initiate_dispute setup, stopping
/// with an Active dispute on a Disputed task (no votes cast). The provider (worker)
/// initiates, so dispute.initiator_authority == provider and dispute.defendant == providerAgent.
async function setupActiveDispute(w) {
  const modProg = makeProgram(w.modAuth);

  // record a CLEAN ListingModeration so the moderation-gated hire passes.
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "dispute:record-listing-mod");
  }

  // 1) buyer hires the provider listing -> Open task + escrow + HireRecord.
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "dispute:hire");

  // 2) moderate -> publish job spec -> worker claims.
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "dispute:task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "dispute:publish");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "dispute:claim");

  // 3) worker (provider) initiates a dispute on their claimed task.
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: rateLimit, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "dispute:initiate");

  assert.ok(decode(w.svm, "Task", task).status.Disputed !== undefined, "task is Disputed");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute is Active");
  assert.equal(decode(w.svm, "Dispute", dispute).total_voters, 0, "no votes cast yet");

  return { task, escrow, hireRecord, claim, dispute, defendant: w.providerAgent };
}

test("cancel_dispute: initiator cancels an Active (no-vote) dispute -> Cancelled, task back to InProgress", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const d = await setupActiveDispute(w);

  const defBefore = decode(w.svm, "AgentRegistration", d.defendant).disputes_as_defendant;

  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .cancelDispute()
        .accounts({ protocolConfig: w.protocolPda, dispute: d.dispute, task: d.task, authority: w.provider.publicKey })
        .remainingAccounts([{ pubkey: d.defendant, isSigner: false, isWritable: true }])
        .instruction(),
      [w.provider],
    ),
    "cancel dispute",
  );

  assert.ok(decode(w.svm, "Dispute", d.dispute).status.Cancelled !== undefined, "dispute is Cancelled");
  assert.ok(decode(w.svm, "Task", d.task).status.InProgress !== undefined, "task restored to InProgress");
  assert.equal(
    decode(w.svm, "AgentRegistration", d.defendant).disputes_as_defendant,
    defBefore - 1,
    "defendant dispute counter decremented",
  );
});

test("cancel_dispute: a non-initiator cannot cancel the dispute", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const d = await setupActiveDispute(w);

  // The buyer (creator) is a party to the task but NOT the dispute initiator.
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .cancelDispute()
        .accounts({ protocolConfig: w.protocolPda, dispute: d.dispute, task: d.task, authority: w.buyer.publicKey })
        .remainingAccounts([{ pubkey: d.defendant, isSigner: false, isWritable: true }])
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedResolver",
    "non-initiator cancel",
  );
  // dispute still Active (tx reverted)
  assert.ok(decode(w.svm, "Dispute", d.dispute).status.Active !== undefined, "dispute remains Active after rejected cancel");
});

test("cancel_dispute: cancelling an already-Cancelled dispute is rejected (DisputeNotActive)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const d = await setupActiveDispute(w);

  const buildCancel = async () =>
    w.providerProg.methods
      .cancelDispute()
      .accounts({ protocolConfig: w.protocolPda, dispute: d.dispute, task: d.task, authority: w.provider.publicKey })
      .remainingAccounts([{ pubkey: d.defendant, isSigner: false, isWritable: true }])
      .instruction();

  expectOk(send(w.svm, await buildCancel(), [w.provider]), "first cancel");
  assert.ok(decode(w.svm, "Dispute", d.dispute).status.Cancelled !== undefined, "dispute Cancelled after first cancel");

  // A second cancel hits the Active-only account constraint.
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await buildCancel(), [w.provider]), "DisputeNotActive", "double cancel");
});
