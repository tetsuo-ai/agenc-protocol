// Compiled-program regressions for terminal BidExclusive settlement.
//
// The accepted-bid accounts are a suffix of remaining_accounts:
//   complete: [dependency parent?] + [book, bid, bidder state, bidder authority]
//   reject:   [Proof parent?]      + [book, bid, bidder state]
//   no-show:  [Proof parent?]      + [book, bid, bidder state, creator]
//
// Every assertion below executes the production SBF loaded by harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc,
  arr,
  pda,
  id32,
  makeProgram,
  send,
  expectOk,
  decode,
  isClosed,
  freshWorld,
  configureTestMultisig,
  seatTestAuthorityResolver,
  moderationBlockPda,
  BN,
  Keypair,
  SystemProgram,
} from "./harness.mjs";
import {
  createPublishedTaskFixture as createPublishedTask,
  createActiveBidFixture,
} from "./bid-fixture.mjs";

const TX_FEE = 5_000n;

function accountLamports(svm, address) {
  return svm.getBalance(address);
}

function taskClaimGeneration(task) {
  let generation = 0n;
  for (let index = 10; index >= 3; index -= 1) {
    generation = (generation << 8n) | BigInt(task._reserved[index] ?? 0);
  }
  return generation;
}

function bidSettlementSuffix(w, b, terminal) {
  const suffix = [
    { pubkey: b.bidBook, isSigner: false, isWritable: true },
    { pubkey: b.bid, isSigner: false, isWritable: true },
    { pubkey: b.bidderMarket, isSigner: false, isWritable: true },
  ];
  if (terminal === "complete") {
    suffix.push({
      pubkey: w.provider.publicKey,
      isSigner: false,
      isWritable: true,
    });
  } else if (terminal === "no-show") {
    suffix.push({
      pubkey: w.buyer.publicKey,
      isSigner: false,
      isWritable: true,
    });
  }
  return suffix;
}

function withDependencyPrefix(parentTask, suffix) {
  return parentTask
    ? [{ pubkey: parentTask, isSigner: false, isWritable: false }, ...suffix]
    : suffix;
}

async function completeAutoTask(w, taskFixture, remainingAccounts = []) {
  const { task, escrow, jobSpec, jobHash } = taskFixture;
  const [claim] = pda([
    enc("claim"),
    task.toBuffer(),
    w.providerAgent.toBuffer(),
  ]);
  let claimBuilder = w.providerProg.methods.claimTaskWithJobSpec().accounts({
    task,
    taskJobSpec: jobSpec,
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
    legacyListing: null,
    moderationBlock: moderationBlockPda(jobHash)[0],
    claim,
    protocolConfig: w.protocolPda,
    worker: w.providerAgent,
    authority: w.provider.publicKey,
    systemProgram: SystemProgram.programId,
  });
  if (remainingAccounts.length > 0)
    claimBuilder = claimBuilder.remainingAccounts(remainingAccounts);
  expectOk(
    send(w.svm, await claimBuilder.instruction(), [w.provider]),
    "parent:claim",
  );

  let completeBuilder = w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({
      task,
      claim,
      escrow,
      creator: w.buyer.publicKey,
      worker: w.providerAgent,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      hireRecord: pda([enc("hire"), task.toBuffer()])[0],
      operator: null,
      referrer: null,
      creatorCompletionBond: pda([
        enc("completion_bond"),
        task.toBuffer(),
        w.buyer.publicKey.toBuffer(),
      ])[0],
      workerCompletionBond: pda([
        enc("completion_bond"),
        task.toBuffer(),
        w.provider.publicKey.toBuffer(),
      ])[0],
    });
  if (remainingAccounts.length > 0) {
    completeBuilder = completeBuilder.remainingAccounts(remainingAccounts);
  }
  expectOk(
    send(w.svm, await completeBuilder.instruction(), [w.provider]),
    "parent:complete",
  );
  return claim;
}

async function settleParent(w) {
  const parent = await createPublishedTask(w, {
    budget: 1_000_000,
    taskType: 0,
    tag: "accepted-bid-parent",
  });
  await completeAutoTask(w, parent);
  assert.ok(decode(w.svm, "Task", parent.task).status.Completed !== undefined);
  return parent.task;
}

async function configureCreatorReview(w, task, reviewWindow = 3_600) {
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .configureTaskValidation(1, new BN(reviewWindow), 0, null)
        .accounts({
          task,
          taskValidationConfig: validation,
          taskAttestorConfig: attestor,
          protocolConfig: w.protocolPda,
          hireRecord: pda([enc("hire"), task.toBuffer()])[0],
          creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    "bid:configure-creator-review",
  );
  return validation;
}

async function configureExternalAttestation(w, task, attestor) {
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestorConfig] = pda([enc("task_attestor"), task.toBuffer()]);
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .configureTaskValidation(3, new BN(0), 0, attestor)
        .accounts({
          task,
          taskValidationConfig: validation,
          taskAttestorConfig: attestorConfig,
          protocolConfig: w.protocolPda,
          hireRecord: pda([enc("hire"), task.toBuffer()])[0],
          creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    "bid:configure-external-attestation",
  );
  return { validation, attestorConfig };
}

async function setupAcceptedBid(
  w,
  {
    budget = 4_000_000,
    bidPrice = 2_400_000,
    minBond = 400_000,
    noShowSlashBps = 0,
    parentTask = null,
    dependencyType = 0,
    creatorReview = false,
    reviewWindow = 3_600,
    externalAttestor = null,
    referrer = null,
    referrerFeeBps = 0,
    tag = "accepted-bid",
  } = {},
) {
  const taskFixture = await createPublishedTask(w, {
    budget,
    taskType: 3,
    parentTask,
    dependencyType,
    referrer,
    referrerFeeBps,
    tag,
  });
  let validation = null;
  let attestorConfig = null;
  if (creatorReview) {
    validation = await configureCreatorReview(
      w,
      taskFixture.task,
      reviewWindow,
    );
  } else if (externalAttestor) {
    ({ validation, attestorConfig } = await configureExternalAttestation(
      w,
      taskFixture.task,
      externalAttestor,
    ));
  }
  const bidFixture = await createActiveBidFixture(w, taskFixture, {
    bidPrice,
    minBond,
    noShowSlashBps,
    tag,
  });
  const {
    task,
    jobSpec,
    jobHash,
    bidBook,
    bid,
    bidderMarket,
    claim,
    storedBid,
  } = bidFixture;
  assert.equal(
    storedBid.requested_reward_lamports.toString(),
    String(bidPrice),
  );
  assert.equal(storedBid.accepted_no_show_slash_bps, noShowSlashBps);
  let acceptBuilder = w.buyerProg.methods
    .acceptBid(arr(bidFixture.bidTermsHash))
    .accounts({
      task,
      claim,
      protocolConfig: w.protocolPda,
      bidBook,
      bid,
      bidderMarketState: bidderMarket,
      bidder: w.providerAgent,
      taskJobSpec: jobSpec,
      moderationBlock: moderationBlockPda(jobHash)[0],
      creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    });
  if (parentTask) {
    acceptBuilder = acceptBuilder.remainingAccounts([
      { pubkey: parentTask, isSigner: false, isWritable: false },
    ]);
  }
  expectOk(
    send(w.svm, await acceptBuilder.instruction(), [w.buyer]),
    `${tag}:accept-bid`,
  );
  assert.equal(
    taskClaimGeneration(decode(w.svm, "Task", task)),
    1n,
    `${tag}: accepted-bid TaskClaim creation advances claim_generation`,
  );

  return {
    ...bidFixture,
    validation,
    attestorConfig,
  };
}

async function submitAcceptedBid(w, b, label = "bid:submit") {
  const [submission] = pda([enc("task_submission"), b.claim.toBuffer()]);
  const result = Buffer.alloc(64);
  result.set(crypto.randomBytes(32));
  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .submitTaskResult(arr(id32()), arr(result))
        .accounts({
          task: b.task,
          claim: b.claim,
          taskValidationConfig: b.validation,
          taskSubmission: submission,
          protocolConfig: w.protocolPda,
          worker: w.providerAgent,
          authority: w.provider.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.provider],
    ),
    label,
  );
  return submission;
}

function emptyCompletionBond(task, authority) {
  return pda([
    enc("completion_bond"),
    task.toBuffer(),
    authority.toBuffer(),
  ])[0];
}

function snapshotCompletion(w, b, submission = null) {
  const task = decode(w.svm, "Task", b.task);
  const worker = decode(w.svm, "AgentRegistration", w.providerAgent);
  const protocol = decode(w.svm, "ProtocolConfig", w.protocolPda);
  const feeBps = effectiveProtocolFeeBps(task, worker);
  const protocolFee = (BigInt(b.bidPrice) * BigInt(feeBps)) / 10_000n;
  return {
    provider: accountLamports(w.svm, w.provider.publicKey),
    creator: accountLamports(w.svm, w.buyer.publicKey),
    treasury: accountLamports(w.svm, w.admin.publicKey),
    bid: accountLamports(w.svm, b.bid),
    claim: accountLamports(w.svm, b.claim),
    submission: submission ? accountLamports(w.svm, submission) : 0n,
    escrow: accountLamports(w.svm, b.escrow),
    protocol,
    worker,
    protocolFee,
    workerReward: BigInt(b.bidPrice) - protocolFee,
  };
}

function assertCompletedBidSettlement(
  w,
  b,
  before,
  { submission = null, providerFee = 0n, creatorFee = 0n, label },
) {
  assert.ok(
    decode(w.svm, "Task", b.task).status.Completed !== undefined,
    `${label}: task Completed`,
  );
  assert.ok(isClosed(w.svm, b.claim), `${label}: claim closed`);
  assert.ok(isClosed(w.svm, b.bid), `${label}: accepted bid closed`);
  assert.ok(isClosed(w.svm, b.escrow), `${label}: escrow closed`);
  if (submission)
    assert.ok(isClosed(w.svm, submission), `${label}: submission closed`);

  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - before.provider,
    before.workerReward +
      before.bid +
      before.claim +
      before.submission -
      providerFee,
    `${label}: worker receives contract reward and every worker-funded account refund`,
  );
  assert.equal(
    accountLamports(w.svm, w.admin.publicKey) - before.treasury,
    before.protocolFee,
    `${label}: treasury receives the bid-price protocol fee`,
  );
  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - before.creator,
    before.escrow - BigInt(b.bidPrice) - creatorFee,
    `${label}: creator recovers unused budget and escrow rent`,
  );

  const protocolAfter = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(
    BigInt(protocolAfter.total_value_distributed.toString()) -
      BigInt(before.protocol.total_value_distributed.toString()),
    BigInt(b.bidPrice),
    `${label}: volume records the accepted contract price`,
  );
  const workerAfter = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(
    BigInt(workerAfter.total_earned.toString()) -
      BigInt(before.worker.total_earned.toString()),
    before.workerReward,
    `${label}: worker earnings record the net bid-price reward`,
  );
  assertBidBookDisposition(w, b, "Closed", label);
}

function assertBidBookDisposition(w, b, state, label) {
  const book = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.ok(book.state[state] !== undefined, `${label}: bid book ${state}`);
  assert.equal(book.active_bids, 0, `${label}: book active count released`);
  assert.equal(
    decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count,
    0,
    `${label}: bidder active count released`,
  );
}

function effectiveProtocolFeeBps(task, worker) {
  const reputation = worker.reputation;
  const discount =
    reputation >= 9_500
      ? 15
      : reputation >= 9_000
        ? 10
        : reputation >= 8_000
          ? 5
          : 0;
  return task.protocol_fee_bps === 0
    ? 0
    : Math.max(1, task.protocol_fee_bps - discount);
}

async function completeAcceptedBid(w, b) {
  let builder = w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({
      task: b.task,
      claim: b.claim,
      escrow: b.escrow,
      creator: w.buyer.publicKey,
      worker: w.providerAgent,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      hireRecord: pda([enc("hire"), b.task.toBuffer()])[0],
      operator: null,
      referrer: null,
      creatorCompletionBond: pda([
        enc("completion_bond"),
        b.task.toBuffer(),
        w.buyer.publicKey.toBuffer(),
      ])[0],
      workerCompletionBond: pda([
        enc("completion_bond"),
        b.task.toBuffer(),
        w.provider.publicKey.toBuffer(),
      ])[0],
    });
  builder = builder.remainingAccounts(
    withDependencyPrefix(b.parentTask, bidSettlementSuffix(w, b, "complete")),
  );
  return send(w.svm, await builder.instruction(), [w.provider]);
}

function completionAccounts(w, b, submission) {
  return {
    task: b.task,
    claim: b.claim,
    escrow: b.escrow,
    taskValidationConfig: b.validation,
    taskSubmission: submission,
    worker: w.providerAgent,
    protocolConfig: w.protocolPda,
    treasury: w.admin.publicKey,
    creator: w.buyer.publicKey,
    workerAuthority: w.provider.publicKey,
    hireRecord: pda([enc("hire"), b.task.toBuffer()])[0],
    operator: null,
    referrer: null,
    creatorCompletionBond: emptyCompletionBond(b.task, w.buyer.publicKey),
    workerCompletionBond: emptyCompletionBond(b.task, w.provider.publicKey),
    tokenEscrowAta: null,
    workerTokenAccount: null,
    treasuryTokenAccount: null,
    rewardMint: null,
    tokenProgram: null,
    systemProgram: SystemProgram.programId,
  };
}

async function acceptSubmittedBid(w, b, submission) {
  const builder = w.buyerProg.methods
    .acceptTaskResult()
    .accounts(completionAccounts(w, b, submission))
    .remainingAccounts(
      withDependencyPrefix(b.parentTask, bidSettlementSuffix(w, b, "complete")),
    );
  return send(w.svm, await builder.instruction(), [w.buyer]);
}

async function autoAcceptSubmittedBid(w, b, submission, crank) {
  const builder = makeProgram(crank)
    .methods.autoAcceptTaskResult()
    .accounts({
      ...completionAccounts(w, b, submission),
      authority: crank.publicKey,
    })
    .remainingAccounts(
      withDependencyPrefix(b.parentTask, bidSettlementSuffix(w, b, "complete")),
    );
  return send(w.svm, await builder.instruction(), [crank]);
}

async function validateSubmittedBid(w, b, submission, reviewer, approved) {
  const vote = pda([
    enc("task_validation_vote"),
    submission.toBuffer(),
    reviewer.publicKey.toBuffer(),
  ])[0];
  const terminal = approved ? "complete" : "reject";
  const builder = makeProgram(reviewer)
    .methods.validateTaskResult(approved)
    .accounts({
      task: b.task,
      claim: b.claim,
      escrow: b.escrow,
      taskValidationConfig: b.validation,
      taskAttestorConfig: b.attestorConfig,
      taskSubmission: submission,
      taskValidationVote: vote,
      worker: w.providerAgent,
      protocolConfig: w.protocolPda,
      validatorAgent: null,
      treasury: w.admin.publicKey,
      creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey,
      reviewer: reviewer.publicKey,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      systemProgram: SystemProgram.programId,
      creatorCompletionBond: emptyCompletionBond(b.task, w.buyer.publicKey),
      workerCompletionBond: emptyCompletionBond(b.task, w.provider.publicKey),
    })
    .remainingAccounts(
      withDependencyPrefix(b.parentTask, bidSettlementSuffix(w, b, terminal)),
    );
  return {
    vote,
    result: send(w.svm, await builder.instruction(), [reviewer]),
  };
}

async function initiateAcceptedBidDispute(w, b, resolutionType, label) {
  const disputeId = id32();
  const dispute = pda([enc("dispute"), Buffer.from(disputeId)])[0];
  const rateLimit = pda([
    enc("authority_rate_limit"),
    w.buyer.publicKey.toBuffer(),
  ])[0];
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .initiateDispute(
          arr(disputeId),
          arr(decode(w.svm, "Task", b.task).task_id),
          arr(Buffer.alloc(32, 7)),
          resolutionType,
          "accepted bid settlement evidence",
        )
        .accounts({
          dispute,
          task: b.task,
          agent: w.buyerAgent,
          authorityRateLimit: rateLimit,
          protocolConfig: w.protocolPda,
          initiatorClaim: null,
          workerAgent: w.providerAgent,
          workerClaim: b.claim,
          taskSubmission: null,
          authority: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    label,
  );
  return dispute;
}

function disputeAccounts(w, b, dispute) {
  return {
    dispute,
    task: b.task,
    escrow: b.escrow,
    protocolConfig: w.protocolPda,
    creator: w.buyer.publicKey,
    workerClaim: b.claim,
    worker: w.providerAgent,
    workerWallet: w.provider.publicKey,
    hireRecord: pda([enc("hire"), b.task.toBuffer()])[0],
    disputeOperator: null,
    disputeReferrer: null,
    tokenEscrowAta: null,
    creatorTokenAccount: null,
    workerTokenAccountAta: null,
    rewardMint: null,
    tokenProgram: null,
    creatorCompletionBond: emptyCompletionBond(b.task, w.buyer.publicKey),
    workerCompletionBond: emptyCompletionBond(b.task, w.provider.publicKey),
    taskSubmission: pda([enc("task_submission"), b.claim.toBuffer()])[0],
    taskValidationConfig: null,
  };
}

test("accepted BidExclusive completion pays the bid price for every dependency offset", async (t) => {
  for (const variant of [
    { name: "independent suffix", dependencyType: 0 },
    { name: "Data parent prefix + suffix", dependencyType: 1 },
    { name: "Ordering parent prefix + suffix", dependencyType: 2 },
    { name: "Proof parent prefix + suffix", dependencyType: 3 },
  ]) {
    await t.test(variant.name, async () => {
      const w = await freshWorld({ moderationEnabled: true });
      const parentTask =
        variant.dependencyType === 0 ? null : await settleParent(w);
      const b = await setupAcceptedBid(w, {
        parentTask,
        dependencyType: variant.dependencyType,
        tag: `accepted-bid-complete-${variant.dependencyType}`,
      });
      const before = snapshotCompletion(w, b);

      expectOk(await completeAcceptedBid(w, b), `${variant.name}:complete`);
      assertCompletedBidSettlement(w, b, before, {
        providerFee: TX_FEE,
        label: variant.name,
      });
      assert.notEqual(
        b.bidPrice,
        b.budget,
        "regression fixture keeps bid price below budget",
      );
    });
  }
});

test("accept_task_result settles an accepted Data-dependent bid at the contract price", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 1,
    creatorReview: true,
    tag: "accepted-bid-creator-accept-data",
  });
  const submission = await submitAcceptedBid(w, b);
  const before = snapshotCompletion(w, b, submission);

  expectOk(await acceptSubmittedBid(w, b, submission), "bid:creator-accept");

  assertCompletedBidSettlement(w, b, before, {
    submission,
    creatorFee: TX_FEE,
    label: "accept_task_result/Data",
  });
});

test("auto_accept_task_result settles an accepted Ordering-dependent bid permissionlessly", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 2,
    creatorReview: true,
    reviewWindow: 60,
    tag: "accepted-bid-auto-accept-ordering",
  });
  const submission = await submitAcceptedBid(w, b);
  const reviewDeadline = decode(
    w.svm,
    "TaskSubmission",
    submission,
  ).review_deadline_at;
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(reviewDeadline.toString()) + 1n;
  w.svm.setClock(clock);
  w.svm.expireBlockhash();

  const crank = Keypair.generate();
  w.svm.airdrop(crank.publicKey, 10_000_000_000n);
  const before = snapshotCompletion(w, b, submission);
  expectOk(
    await autoAcceptSubmittedBid(w, b, submission, crank),
    "bid:permissionless-auto-accept",
  );

  assertCompletedBidSettlement(w, b, before, {
    submission,
    label: "auto_accept_task_result/Ordering",
  });
});

test("CreatorReview rejection reopens the book and refunds the accepted bid bond in full", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 3,
    creatorReview: true,
    tag: "accepted-bid-reject-proof",
  });
  const submission = await submitAcceptedBid(w, b, "bid:submit-for-rejection");

  const providerBefore = accountLamports(w.svm, w.provider.publicKey);
  const bidBalance = accountLamports(w.svm, b.bid);
  const claimBalance = accountLamports(w.svm, b.claim);
  const submissionBalance = accountLamports(w.svm, submission);
  const escrowBefore = accountLamports(w.svm, b.escrow);
  const workerBond = pda([
    enc("completion_bond"),
    b.task.toBuffer(),
    w.provider.publicKey.toBuffer(),
  ])[0];
  let rejectBuilder = w.buyerProg.methods
    .rejectTaskResult(arr(id32()))
    .accounts({
      task: b.task,
      claim: b.claim,
      taskValidationConfig: b.validation,
      taskSubmission: submission,
      worker: w.providerAgent,
      protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey,
      agentStats: null,
      systemProgram: null,
      workerCompletionBond: workerBond,
    });
  rejectBuilder = rejectBuilder.remainingAccounts(
    withDependencyPrefix(parentTask, bidSettlementSuffix(w, b, "reject")),
  );
  expectOk(
    send(w.svm, await rejectBuilder.instruction(), [w.buyer]),
    "bid:reject-result",
  );

  assert.ok(isClosed(w.svm, b.bid), "rejected accepted bid is closed");
  assert.ok(isClosed(w.svm, b.claim), "rejected claim is closed");
  assert.ok(isClosed(w.svm, submission), "rejected submission is closed");
  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - providerBefore,
    bidBalance + claimBalance + submissionBalance,
    "worker receives every bid/claim/submission lamport; no bid-bond slash on rejection",
  );
  assert.equal(
    accountLamports(w.svm, b.escrow),
    escrowBefore,
    "rejection does not spend task principal",
  );

  const book = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.ok(
    book.state.Open !== undefined,
    "book reopens after creator rejection",
  );
  assert.equal(
    book.accepted_bid,
    null,
    "reopened book clears the dead accepted-bid pointer",
  );
  assert.equal(book.active_bids, 0);
  assert.equal(
    decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count,
    0,
  );
  const task = decode(w.svm, "Task", b.task);
  assert.ok(task.status.Open !== undefined, "task returns to Open");
  assert.equal(task.current_workers, 0);
});

test("validate_task_result settles both external-attestation outcomes with a Proof prefix", async (t) => {
  for (const approved of [true, false]) {
    await t.test(
      approved ? "attestor approval" : "attestor rejection",
      async () => {
        const w = await freshWorld({ moderationEnabled: true });
        const reviewer = Keypair.generate();
        w.svm.airdrop(reviewer.publicKey, 10_000_000_000n);
        const parentTask = await settleParent(w);
        const b = await setupAcceptedBid(w, {
          parentTask,
          dependencyType: 3,
          externalAttestor: reviewer.publicKey,
          tag: `accepted-bid-attestation-${approved ? "approve" : "reject"}`,
        });
        const submission = await submitAcceptedBid(w, b);
        const before = snapshotCompletion(w, b, submission);

        const { vote, result } = await validateSubmittedBid(
          w,
          b,
          submission,
          reviewer,
          approved,
        );
        expectOk(result, `bid:attestor-${approved ? "approve" : "reject"}`);
        assert.ok(
          isClosed(w.svm, vote),
          "one-reviewer attestation vote rent is returned",
        );

        if (approved) {
          assertCompletedBidSettlement(w, b, before, {
            submission,
            label: "validate_task_result/approve/Proof",
          });
          return;
        }

        assert.ok(
          isClosed(w.svm, b.bid),
          "attestor rejection closes/refunds the accepted bid",
        );
        assert.ok(
          isClosed(w.svm, b.claim),
          "attestor rejection closes/refunds the claim",
        );
        assert.ok(
          !isClosed(w.svm, submission),
          "rejected submission remains as round history",
        );
        assert.equal(
          accountLamports(w.svm, w.provider.publicKey) - before.provider,
          before.bid + before.claim,
          "rejected worker receives bid and claim refunds but not live submission rent",
        );
        assert.equal(
          accountLamports(w.svm, b.escrow),
          before.escrow,
          "attestor rejection leaves all task principal available for a later bid round",
        );
        assert.equal(
          accountLamports(w.svm, w.buyer.publicKey) - before.creator,
          0n,
          "attestor rejection does not move creator principal",
        );
        assert.equal(
          accountLamports(w.svm, w.admin.publicKey) - before.treasury,
          0n,
          "attestor rejection does not charge a protocol fee",
        );
        const task = decode(w.svm, "Task", b.task);
        assert.ok(
          task.status.Open !== undefined,
          "attestor rejection reopens the task",
        );
        assert.equal(
          task.current_workers,
          0,
          "attestor rejection releases the worker slot",
        );
        const book = decode(w.svm, "TaskBidBook", b.bidBook);
        assert.equal(
          book.accepted_bid,
          null,
          "reopened book clears the accepted pointer",
        );
        assertBidBookDisposition(
          w,
          b,
          "Open",
          "validate_task_result/reject/Proof",
        );
      },
    );
  }
});

test("cancel_task closes an accepted Proof-dependent no-show and applies only the snapshotted bid slash", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const noShowSlashBps = 2_500;
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 3,
    minBond: 400_000,
    noShowSlashBps,
    tag: "accepted-bid-cancel-proof",
  });
  const taskBefore = decode(w.svm, "Task", b.task);
  const acceptedBid = decode(w.svm, "TaskBid", b.bid);
  const slash =
    (BigInt(acceptedBid.bond_lamports.toString()) * BigInt(noShowSlashBps)) /
    10_000n;
  const before = snapshotCompletion(w, b);

  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(taskBefore.deadline.toString()) + 1n;
  w.svm.setClock(clock);
  w.svm.expireBlockhash();

  const remaining = [
    { pubkey: parentTask, isSigner: false, isWritable: false },
    { pubkey: b.claim, isSigner: false, isWritable: true },
    { pubkey: w.providerAgent, isSigner: false, isWritable: true },
    { pubkey: w.provider.publicKey, isSigner: false, isWritable: true },
    ...bidSettlementSuffix(w, b, "reject"),
  ];
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .cancelTask()
        .accounts({
          task: b.task,
          escrow: b.escrow,
          authority: w.buyer.publicKey,
          protocolConfig: w.protocolPda,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          creatorTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
          creatorCompletionBond: emptyCompletionBond(b.task, w.buyer.publicKey),
          workerCompletionBond: emptyCompletionBond(
            b.task,
            w.provider.publicKey,
          ),
          workerBondAuthority: w.provider.publicKey,
          creatorAgent: null,
          agentStats: null,
          treasury: null,
        })
        .remainingAccounts(remaining)
        .instruction(),
      [w.buyer],
    ),
    "bid:cancel-proof-no-show",
  );

  assert.ok(
    decode(w.svm, "Task", b.task).status.Cancelled !== undefined,
    "cancel: task Cancelled",
  );
  assert.ok(isClosed(w.svm, b.escrow), "cancel: escrow closed to creator");
  assert.ok(isClosed(w.svm, b.claim), "cancel: claim closed to worker");
  assert.ok(isClosed(w.svm, b.bid), "cancel: accepted bid closed to bidder");
  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - before.creator,
    before.escrow + slash - TX_FEE,
    "cancel: creator receives escrow plus exact bid slash, less its tx fee",
  );
  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - before.provider,
    before.bid + before.claim - slash,
    "cancel: bidder receives claim rent and the unslashed bid balance",
  );
  assert.equal(
    accountLamports(w.svm, w.admin.publicKey) - before.treasury,
    0n,
    "cancel: treasury receives none of the task or bid principal",
  );
  assertBidBookDisposition(w, b, "Closed", "cancel_task/Proof");
});

test("resolve_dispute Complete pays only the accepted bid price and refunds its bond", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const directApprovals = await configureTestMultisig(w);
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 2,
    tag: "accepted-bid-resolve-complete",
  });
  const dispute = await initiateAcceptedBidDispute(
    w,
    b,
    1,
    "bid:initiate-complete-dispute",
  );
  const before = snapshotCompletion(w, b);

  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin)
        .methods.resolveDispute(
          true,
          arr(Buffer.alloc(32, 9)),
          "agenc://ruling/accepted-bid-complete",
        )
        .accounts({
          ...disputeAccounts(w, b, dispute),
          authority: w.admin.publicKey,
          resolverAssignment: null,
          agentStats: null,
          systemProgram: SystemProgram.programId,
          treasuryTokenAccount: null,
          bondTreasury: w.admin.publicKey,
        })
        .remainingAccounts([
          { pubkey: parentTask, isSigner: false, isWritable: false },
          ...bidSettlementSuffix(w, b, "reject"),
          ...directApprovals.remainingAccounts,
        ])
        .instruction(),
      directApprovals.approvers,
    ),
    "bid:resolve-complete-direct-authority-threshold",
  );

  assert.ok(
    decode(w.svm, "Task", b.task).status.Completed !== undefined,
    "resolve: task Completed",
  );
  assert.ok(
    decode(w.svm, "Dispute", dispute).status.Resolved !== undefined,
    "resolve: dispute Resolved",
  );
  assert.ok(isClosed(w.svm, b.escrow), "resolve: escrow closed");
  assert.ok(isClosed(w.svm, b.claim), "resolve: claim closed");
  assert.ok(isClosed(w.svm, b.bid), "resolve: accepted bid closed");
  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - before.provider,
    BigInt(b.bidPrice) + before.bid + before.claim,
    "resolve: worker receives exact contract price plus bid/claim refunds",
  );
  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - before.creator,
    before.escrow - BigInt(b.bidPrice),
    "resolve: creator recovers all uncommitted budget and escrow rent",
  );
  assert.equal(
    accountLamports(w.svm, w.admin.publicKey) - before.treasury,
    -TX_FEE * BigInt(directApprovals.approvers.length),
    "resolve: dispute Complete takes no protocol fee; authority pays only the threshold-signed tx fee",
  );
  const protocolAfter = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(
    BigInt(protocolAfter.total_value_distributed.toString()) -
      BigInt(before.protocol.total_value_distributed.toString()),
    BigInt(b.bidPrice),
    "resolve: volume records only the accepted contract price",
  );
  const workerAfter = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(
    BigInt(workerAfter.tasks_completed.toString()) -
      BigInt(before.worker.tasks_completed.toString()),
    1n,
    "resolve: Complete records one worker completion",
  );
  assert.equal(
    BigInt(workerAfter.total_earned.toString()) -
      BigInt(before.worker.total_earned.toString()),
    BigInt(b.bidPrice),
    "resolve: SOL earnings record the exact accepted contract payout",
  );
  assertBidBookDisposition(w, b, "Closed", "resolve_dispute/Ordering");
});

test("resolve_dispute Split conserves an odd accepted-bid price and is telemetry-neutral", async () => {
  const budget = 5_000_009;
  const bidPrice = 3_000_003;
  const referrerFeeBps = 333;
  const referrer = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true });
  const authorityResolver = await seatTestAuthorityResolver(w);
  w.svm.airdrop(referrer.publicKey, 1_000_000_000n);

  const b = await setupAcceptedBid(w, {
    budget,
    bidPrice,
    referrer: referrer.publicKey,
    referrerFeeBps,
    tag: "accepted-bid-resolve-split",
  });
  const taskBefore = decode(w.svm, "Task", b.task);
  assert.equal(
    taskBefore.operator.toBuffer().equals(Buffer.alloc(32)),
    true,
    "Split: a direct BidExclusive task has no operator leg",
  );
  assert.equal(taskBefore.operator_fee_bps, 0, "Split: operator fee is absent");
  assert.equal(
    taskBefore.referrer.toBase58(),
    referrer.publicKey.toBase58(),
    "Split: referrer payee was snapshotted by create_task",
  );
  assert.equal(
    taskBefore.referrer_fee_bps,
    referrerFeeBps,
    "Split: referrer bps snapshotted",
  );
  assert.ok(
    taskBefore.protocol_fee_bps > 0,
    "Split: fixture would charge a protocol fee normally",
  );

  const dispute = await initiateAcceptedBidDispute(
    w,
    b,
    2,
    "bid:initiate-split-dispute",
  );
  const agentStats = pda([enc("agent_stats"), w.providerAgent.toBuffer()])[0];
  assert.ok(
    isClosed(w.svm, agentStats),
    "Split: worker AgentStats starts absent",
  );
  const before = snapshotCompletion(w, b);
  const referrerBefore = accountLamports(w.svm, referrer.publicKey);

  const workerGross = BigInt(bidPrice) / 2n;
  const creatorContractShare = BigInt(bidPrice) - workerGross;
  const referrerFee = (workerGross * BigInt(referrerFeeBps)) / 10_000n;
  const workerNet = workerGross - referrerFee;
  const unusedBudget = BigInt(budget) - BigInt(bidPrice);
  const escrowRent = before.escrow - BigInt(budget);
  assert.equal(
    creatorContractShare + workerNet + referrerFee,
    BigInt(bidPrice),
    "Split: odd contract price is fully conserved before execution",
  );

  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin)
        .methods.resolveDispute(
          true,
          arr(Buffer.alloc(32, 9)),
          "agenc://ruling/accepted-bid-split",
        )
        .accounts({
          ...disputeAccounts(w, b, dispute),
          authority: w.admin.publicKey,
          resolverAssignment: authorityResolver,
          agentStats,
          disputeReferrer: referrer.publicKey,
          systemProgram: SystemProgram.programId,
          treasuryTokenAccount: null,
          bondTreasury: w.admin.publicKey,
        })
        .remainingAccounts(bidSettlementSuffix(w, b, "reject"))
        .instruction(),
      [w.admin],
    ),
    "bid:resolve-split",
  );

  const taskAfter = decode(w.svm, "Task", b.task);
  assert.ok(taskAfter.status.Cancelled !== undefined, "Split: task Cancelled");
  assert.equal(
    taskAfter.current_workers,
    0,
    "Split: task worker slot released",
  );
  assert.equal(
    taskAfter._reserved[2],
    0,
    "Split: no worker slash remains pending",
  );
  assert.ok(
    decode(w.svm, "Dispute", dispute).status.Resolved !== undefined,
    "Split: dispute Resolved",
  );
  assert.ok(isClosed(w.svm, b.escrow), "Split: escrow closed");
  assert.ok(isClosed(w.svm, b.claim), "Split: worker claim closed");
  assert.ok(
    isClosed(w.svm, b.bid),
    "Split: accepted bid closed and bond refunded",
  );
  assertBidBookDisposition(w, b, "Closed", "resolve_dispute/Split");

  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - before.provider,
    workerNet + before.bid + before.claim,
    "Split: worker receives its exact net half plus bid/claim refunds",
  );
  assert.equal(
    accountLamports(w.svm, referrer.publicKey) - referrerBefore,
    referrerFee,
    "Split: referrer receives its exact fee carved from the worker half",
  );
  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - before.creator,
    creatorContractShare + unusedBudget + escrowRent,
    "Split: creator receives the rounded-up half, unused budget, and escrow rent",
  );
  assert.equal(
    creatorContractShare + unusedBudget + workerNet + referrerFee,
    BigInt(budget),
    "Split: every principal lamport is assigned exactly once",
  );

  const agentStatsRent = accountLamports(w.svm, agentStats);
  assert.ok(agentStatsRent > 0n, "Split: supplied telemetry PDA was allocated");
  assert.equal(
    accountLamports(w.svm, w.admin.publicKey) - before.treasury,
    -TX_FEE - agentStatsRent,
    "Split: treasury receives no protocol fee; resolver pays only tx and telemetry rent",
  );
  const protocolAfter = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(
    BigInt(protocolAfter.total_value_distributed.toString()),
    BigInt(before.protocol.total_value_distributed.toString()),
    "Split: neutral ruling does not record completion volume",
  );

  const workerAfter = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(
    workerAfter.tasks_completed.toString(),
    before.worker.tasks_completed.toString(),
    "Split: completion count is neutral",
  );
  assert.equal(
    workerAfter.total_earned.toString(),
    before.worker.total_earned.toString(),
    "Split: completion earnings telemetry is neutral",
  );
  assert.equal(
    workerAfter.reputation,
    before.worker.reputation,
    "Split: reputation is neutral",
  );
  assert.equal(
    workerAfter.active_tasks,
    before.worker.active_tasks - 1,
    "Split: worker active-task counter released exactly once",
  );
  assert.equal(
    workerAfter.disputes_as_defendant,
    0,
    "Split: defendant liability released",
  );

  const statsAfter = decode(w.svm, "AgentStats", agentStats);
  assert.equal(
    statsAfter.agent.toBuffer().equals(Buffer.alloc(32)),
    true,
    "Split: supplied AgentStats remains untouched rather than recording an outcome",
  );
  assert.equal(
    statsAfter.disputes_won.toString(),
    "0",
    "Split: disputes_won remains neutral",
  );
  assert.equal(
    statsAfter.disputes_lost.toString(),
    "0",
    "Split: disputes_lost remains neutral",
  );
});

test("expire_dispute refunds principal and applies the evidence-bound accepted-bid no-show slash", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const noShowSlashBps = 2_500;
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 3,
    minBond: 400_000,
    noShowSlashBps,
    tag: "accepted-bid-expire-dispute-proof",
  });
  const dispute = await initiateAcceptedBidDispute(
    w,
    b,
    0,
    "bid:initiate-expiring-dispute",
  );
  const acceptedBid = decode(w.svm, "TaskBid", b.bid);
  const slash =
    (BigInt(acceptedBid.bond_lamports.toString()) * BigInt(noShowSlashBps)) /
    10_000n;
  const before = snapshotCompletion(w, b);

  const disputeState = decode(w.svm, "Dispute", dispute);
  const claimState = decode(w.svm, "TaskClaim", b.claim);
  const clock = w.svm.getClock();
  clock.unixTimestamp =
    BigInt(
      Math.max(
        Number(disputeState.voting_deadline) + 120,
        Number(claimState.expires_at),
      ),
    ) + 1n;
  w.svm.setClock(clock);
  w.svm.expireBlockhash();

  const crank = Keypair.generate();
  w.svm.airdrop(crank.publicKey, 10_000_000_000n);
  expectOk(
    send(
      w.svm,
      await makeProgram(crank)
        .methods.expireDispute()
        .accounts({
          ...disputeAccounts(w, b, dispute),
          authority: crank.publicKey,
        })
        .remainingAccounts([
          { pubkey: parentTask, isSigner: false, isWritable: false },
          ...bidSettlementSuffix(w, b, "reject"),
        ])
        .instruction(),
      [crank],
    ),
    "bid:expire-dispute",
  );

  assert.ok(
    decode(w.svm, "Task", b.task).status.Cancelled !== undefined,
    "expiry: task Cancelled",
  );
  assert.ok(
    decode(w.svm, "Dispute", dispute).status.Expired !== undefined,
    "expiry: dispute Expired",
  );
  assert.ok(isClosed(w.svm, b.escrow), "expiry: escrow closed to creator");
  assert.ok(isClosed(w.svm, b.claim), "expiry: claim closed to worker");
  assert.ok(isClosed(w.svm, b.bid), "expiry: accepted bid closed");
  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - before.creator,
    before.escrow + slash,
    "expiry: creator receives all escrow and only the snapshotted bid slash",
  );
  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - before.provider,
    before.bid + before.claim - slash,
    "expiry: bidder receives claim rent and unslashed bid balance",
  );
  assert.equal(
    accountLamports(w.svm, w.admin.publicKey) - before.treasury,
    0n,
    "expiry: treasury receives none of unresolved task or bid principal",
  );
  assertBidBookDisposition(w, b, "Closed", "expire_dispute/Proof");
});

test("accepted-bid no-show applies only the snapshotted partial slash, then closes/refunds the bid", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const noShowSlashBps = 2_500;
  const parentTask = await settleParent(w);
  const b = await setupAcceptedBid(w, {
    parentTask,
    dependencyType: 3,
    minBond: 400_000,
    noShowSlashBps,
    tag: "accepted-bid-no-show-proof",
  });
  const acceptedBid = decode(w.svm, "TaskBid", b.bid);
  const bond = BigInt(acceptedBid.bond_lamports.toString());
  const slash = (bond * BigInt(noShowSlashBps)) / 10_000n;
  assert.equal(bond, 400_000n, "fixture carries an enforced bid bond");

  const claim = decode(w.svm, "TaskClaim", b.claim);
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(claim.expires_at.toString()) + 61n;
  w.svm.setClock(clock);
  w.svm.expireBlockhash();

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, 10_000_000_000n);
  const providerBefore = accountLamports(w.svm, w.provider.publicKey);
  const creatorBefore = accountLamports(w.svm, w.buyer.publicKey);
  const bidBalance = accountLamports(w.svm, b.bid);
  const claimBalance = accountLamports(w.svm, b.claim);
  let expireBuilder = makeProgram(cleaner).methods.expireClaim().accounts({
    authority: cleaner.publicKey,
    task: b.task,
    escrow: b.escrow,
    claim: b.claim,
    worker: w.providerAgent,
    protocolConfig: w.protocolPda,
    taskValidationConfig: null,
    taskSubmission: null,
    rentRecipient: w.provider.publicKey,
    workerCompletionBond: null,
    bondCreator: null,
    agentStats: null,
    treasury: null,
    systemProgram: SystemProgram.programId,
  });
  expireBuilder = expireBuilder.remainingAccounts(
    withDependencyPrefix(parentTask, bidSettlementSuffix(w, b, "no-show")),
  );
  expectOk(
    send(w.svm, await expireBuilder.instruction(), [cleaner]),
    "bid:expire-no-show",
  );

  assert.equal(
    accountLamports(w.svm, w.buyer.publicKey) - creatorBefore,
    slash,
    "creator receives exactly the accepted bid's snapshotted no-show slash",
  );
  assert.equal(
    accountLamports(w.svm, w.provider.publicKey) - providerBefore,
    bidBalance + claimBalance - slash,
    "bidder receives bid rent + unslashed bond remainder + claim rent",
  );
  assert.ok(
    isClosed(w.svm, b.bid),
    "no-show bid is closed after one disposition",
  );
  assert.ok(isClosed(w.svm, b.claim), "expired claim is closed");

  const book = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.ok(book.state.Open !== undefined, "book reopens after no-show");
  assert.equal(book.accepted_bid, null);
  assert.equal(book.active_bids, 0);
  assert.equal(
    decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count,
    0,
  );
  const task = decode(w.svm, "Task", b.task);
  assert.ok(
    task.status.Open !== undefined,
    "task reopens for another bid round",
  );
  assert.equal(task.current_workers, 0);
});
