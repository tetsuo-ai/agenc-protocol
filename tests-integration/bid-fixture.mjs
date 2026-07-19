import crypto from "node:crypto";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, decode,
  injectBidMarketplace,
  taskModV2Pda, moderationBlockPda,
  BN, SystemProgram,
} from "./harness.mjs";
import { calculateBidTermsHash } from "../scripts/preflight-bid-contract-scan.mjs";

async function sendOk(svm, builder, signers, label) {
  expectOk(send(svm, await builder.instruction(), signers), label);
}

export async function createPublishedTaskFixture(
  w,
  {
    budget = 4_000_000,
    taskType = 3,
    parentTask = null,
    dependencyType = 0,
    publishJobSpec = true,
    referrer = null,
    referrerFeeBps = 0,
    tag = "bid",
    jobUri = `agenc://job-spec/sha256/${tag}`,
  } = {},
) {
  if (parentTask && (referrer !== null || referrerFeeBps !== 0)) {
    throw new Error("dependent-task fixtures do not support referral terms");
  }
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const description = Buffer.alloc(64);
  description.set(crypto.randomBytes(32));

  const commonAccounts = {
    task,
    escrow,
    protocolConfig: w.protocolPda,
    creatorAgent: w.buyerAgent,
    authorityRateLimit: rateLimit,
    authority: w.buyer.publicKey,
    creator: w.buyer.publicKey,
    systemProgram: SystemProgram.programId,
    rewardMint: null,
    creatorTokenAccount: null,
    tokenEscrowAta: null,
    tokenProgram: null,
    associatedTokenProgram: null,
  };

  const createBuilder = parentTask
    ? w.buyerProg.methods
        .createDependentTask(
          arr(taskId),
          new BN(1),
          arr(description),
          new BN(budget),
          1,
          new BN(now + 3_600),
          taskType,
          null,
          dependencyType,
          0,
          null,
        )
        .accounts({ ...commonAccounts, parentTask })
    : w.buyerProg.methods
        .createTask(
          arr(taskId),
          new BN(1),
          arr(description),
          new BN(budget),
          1,
          new BN(now + 3_600),
          taskType,
          null,
          0,
          null,
          referrer,
          referrerFeeBps,
        )
        .accounts(commonAccounts);
  await sendOk(
    w.svm,
    createBuilder,
    [w.buyer],
    `${tag}:${parentTask ? "create-dependent-task" : "create-task"}`,
  );

  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  if (!publishJobSpec) {
    return {
      task,
      escrow,
      jobSpec,
      jobHash: null,
      now,
      budget,
      reward: budget,
      parentTask,
      referrer,
      referrerFeeBps,
    };
  }

  const jobHash = id32();
  const [taskModeration] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  await sendOk(
    w.svm,
    makeProgram(w.modAuth).methods
      .recordTaskModeration(
        arr(jobHash),
        0,
        0,
        new BN(0),
        arr(Buffer.alloc(32, 1)),
        arr(Buffer.alloc(32, 2)),
        new BN(0),
      )
      .accounts({
        moderationConfig: w.modCfg,
        task,
        taskModeration,
        moderator: w.modAuth.publicKey,
        moderationAttestor: null,
        systemProgram: SystemProgram.programId,
      }),
    [w.modAuth],
    `${tag}:moderate`,
  );
  await sendOk(
    w.svm,
    w.buyerProg.methods.setTaskJobSpec(arr(jobHash), jobUri, w.modAuth.publicKey).accounts({
      protocolConfig: w.protocolPda,
      task,
      moderationConfig: w.modCfg,
      taskModeration,
      moderationAttestor: null,
      moderationBlock: moderationBlockPda(jobHash)[0],
      taskJobSpec: jobSpec,
      creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    }),
    [w.buyer],
    `${tag}:publish`,
  );

  return {
    task,
    escrow,
    jobSpec,
    jobHash,
    now,
    budget,
    reward: budget,
    parentTask,
    referrer,
    referrerFeeBps,
  };
}

async function setNoShowSlashSnapshot(w, bidMarketplace, bps) {
  const account = w.svm.getAccount(bidMarketplace);
  const config = coder.accounts.decode("BidMarketplaceConfig", Buffer.from(account.data));
  config.accepted_no_show_slash_bps = bps;
  const data = await coder.accounts.encode("BidMarketplaceConfig", config);
  w.svm.setAccount(bidMarketplace, {
    lamports: Number(account.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

export async function createActiveBidFixture(
  w,
  taskFixture,
  {
    bidPrice = taskFixture.budget,
    minBond = 100_000,
    bidExpiresIn = 1_800,
    noShowSlashBps,
    tag = "bid",
  } = {},
) {
  const { task, jobSpec, jobHash } = taskFixture;
  if (!jobHash) throw new Error("an active bid fixture requires a published job spec");

  const bidMarketplace = await injectBidMarketplace(w.svm, w.admin, { minBond });
  if (noShowSlashBps !== undefined) {
    await setNoShowSlashSnapshot(w, bidMarketplace, noShowSlashBps);
  }
  const [bidBook] = pda([enc("bid_book"), task.toBuffer()]);
  await sendOk(
    w.svm,
    w.buyerProg.methods.initializeBidBook(0, 0, 0, 0, 0).accounts({
      task,
      taskJobSpec: jobSpec,
      bidBook,
      protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    }),
    [w.buyer],
    `${tag}:initialize-book`,
  );

  const lockedJobSpec = decode(w.svm, "TaskJobSpec", jobSpec);
  const [bid] = pda([enc("bid"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [bidderMarket] = pda([enc("bidder_market"), w.providerAgent.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  await sendOk(
    w.svm,
    w.providerProg.methods
      .createBid(
        new BN(bidPrice),
        900,
        5_000,
        arr(Buffer.alloc(32, 4)),
        arr(Buffer.alloc(32, 5)),
        new BN(now + bidExpiresIn),
        arr(jobHash),
        lockedJobSpec.updated_at,
      )
      .accounts({
        protocolConfig: w.protocolPda,
        bidMarketplace,
        task,
        taskJobSpec: jobSpec,
        bidBook,
        bid,
        bidderMarketState: bidderMarket,
        bidder: w.providerAgent,
        authority: w.provider.publicKey,
        systemProgram: SystemProgram.programId,
      }),
    [w.provider],
    `${tag}:create-bid`,
  );

  const storedBid = decode(w.svm, "TaskBid", bid);
  const bidTermsHash = calculateBidTermsHash(
    task,
    bid,
    {
      task: storedBid.task,
      bidBook: storedBid.bid_book,
      bidder: storedBid.bidder,
      bidderAuthority: storedBid.bidder_authority,
      requestedReward: BigInt(storedBid.requested_reward_lamports.toString()),
      etaSeconds: storedBid.eta_seconds,
      confidenceBps: storedBid.confidence_bps,
      reputationSnapshotBps: storedBid.reputation_snapshot_bps,
      qualityGuaranteeHash: Buffer.from(storedBid.quality_guarantee_hash),
      metadataHash: Buffer.from(storedBid.metadata_hash),
      expiresAt: BigInt(storedBid.expires_at.toString()),
      createdAt: BigInt(storedBid.created_at.toString()),
      updatedAt: BigInt(storedBid.updated_at.toString()),
      bondLamports: BigInt(storedBid.bond_lamports.toString()),
      acceptedNoShowSlashBps: storedBid.accepted_no_show_slash_bps,
    },
    {
      jobSpecHash: Buffer.from(lockedJobSpec.job_spec_hash),
      updatedAt: BigInt(lockedJobSpec.updated_at.toString()),
    },
  );
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  return {
    ...taskFixture,
    bidMarketplace,
    bidMarket: bidMarketplace,
    bidBook,
    bid,
    bidderMarket,
    claim,
    bidPrice,
    minBond,
    bidExpiresIn,
    now,
    jobSpecUpdatedAt: lockedJobSpec.updated_at,
    storedBid,
    bidTermsHash,
  };
}

export async function setupBidExclusiveFixture(
  w,
  {
    budget = 4_000_000,
    bidPrice = budget,
    minBond = 100_000,
    bidExpiresIn = 1_800,
    noShowSlashBps,
    parentTask = null,
    dependencyType = 0,
    publishJobSpec = true,
    tag = "bid",
    jobUri,
  } = {},
) {
  const taskFixture = await createPublishedTaskFixture(w, {
    budget,
    taskType: 3,
    parentTask,
    dependencyType,
    publishJobSpec,
    tag,
    ...(jobUri === undefined ? {} : { jobUri }),
  });
  if (!publishJobSpec) return taskFixture;
  return createActiveBidFixture(w, taskFixture, {
    bidPrice,
    minBond,
    bidExpiresIn,
    noShowSlashBps,
    tag,
  });
}
