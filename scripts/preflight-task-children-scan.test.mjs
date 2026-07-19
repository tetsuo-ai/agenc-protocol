import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
} from "./preflight-dispute-scan.mjs";
import {
  classifyTaskChildOrphan,
  scanTaskChildren,
} from "./preflight-task-children-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey, SystemProgram } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function validationFixture(task, creator) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_validation"), task.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(105);
  disc("TaskValidationConfig").copy(data);
  task.toBuffer().copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data[72] = 1;
  data.writeBigInt64LE(86_400n, 73);
  data.writeBigInt64LE(100n, 81);
  data.writeBigInt64LE(100n, 89);
  data[97] = bump;
  return { address, data, lamports: 1_500_000 };
}

function bondFixture(task, party, amount) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("completion_bond"), task.toBuffer(), party.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(139);
  disc("CompletionBond").copy(data);
  task.toBuffer().copy(data, 8);
  party.toBuffer().copy(data, 40);
  data[72] = 1;
  data.writeBigUInt64LE(amount, 73);
  data[81] = 0;
  data.writeBigInt64LE(100n, 82);
  data[90] = bump;
  return { address, data, lamports: Number(amount + 1_500_000n) };
}

function taskFixture(marker = 41) {
  const taskId = Buffer.alloc(32, marker);
  const creator = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(1_000n, 176);
  data[184] = 1;
  data[186] = 0;
  data[187] = 0;
  data[310] = bump;
  data[313] = 0;
  data[314] = 0;
  data.writeUInt16LE(0, 315);
  data[317] = 0;
  return { address, data };
}

function taskBidFixture(task, bidder, bidderAuthority, amount) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), task.toBuffer(), bidder.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(252);
  disc("TaskBid").copy(data);
  task.toBuffer().copy(data, 8);
  bidder.toBuffer().copy(data, 72);
  bidderAuthority.toBuffer().copy(data, 104);
  data[240] = 2;
  data.writeBigUInt64LE(amount, 241);
  data[249] = bump;
  data.writeUInt16LE(1_000, 250);
  return { address, data, lamports: Number(amount + 2_000_000n) };
}

function claimFixture(task, worker, rewardPaid = 500n) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), task.toBuffer(), worker.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(203);
  disc("TaskClaim").copy(data);
  task.toBuffer().copy(data, 8);
  worker.toBuffer().copy(data, 40);
  // The old buggy decoder read these result_data bytes as the bool fields.
  data[184] = 0xff;
  data[185] = 0xff;
  // Exact post-discriminator TaskClaim tail offsets.
  data[192] = 1;
  data[193] = 1;
  data.writeBigUInt64LE(rewardPaid, 194);
  data[202] = bump;
  return { address, data, lamports: 1_500_000 };
}

function moderationFixture(task, creator, moderator) {
  const hash = Buffer.alloc(32, 77);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task_moderation_v2"),
      task.toBuffer(),
      hash,
      moderator.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(234);
  disc("TaskModeration").copy(data);
  task.toBuffer().copy(data, 8);
  creator.toBuffer().copy(data, 40);
  hash.copy(data, 72);
  data[104] = 1;
  data[105] = 25;
  moderator.toBuffer().copy(data, 194);
  data[226] = bump;
  return { address, data, lamports: 1_500_000 };
}

function submissionFixture(task, worker, marker = 70, status = 2, submittedAt = 200n) {
  const claim = new PublicKey(Buffer.alloc(32, marker));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_submission"), claim.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(273);
  disc("TaskSubmission").copy(data);
  task.toBuffer().copy(data, 8);
  claim.toBuffer().copy(data, 40);
  worker.toBuffer().copy(data, 72);
  data[104] = status;
  data.writeBigInt64LE(submittedAt, 203);
  data[267] = bump;
  return { address, data, lamports: 2_000_000 };
}

function validationVoteFixture(submission, reviewer, marker = 83) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task_validation_vote"),
      submission.toBuffer(),
      reviewer.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(121);
  disc("TaskValidationVote").copy(data);
  submission.toBuffer().copy(data, 8);
  reviewer.toBuffer().copy(data, 40);
  new PublicKey(Buffer.alloc(32, marker)).toBuffer().copy(data, 72);
  data.writeUInt16LE(4, 104);
  data[106] = 1;
  data.writeBigInt64LE(123n, 107);
  data[115] = bump;
  return { address, data, lamports: 1_500_000 };
}

function agentFixture(marker = 71, retired = false, registeredAt = 100n) {
  const agentId = Buffer.alloc(32, marker);
  const authority = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(566);
  disc("AgentRegistration").copy(data);
  agentId.copy(data, 8);
  authority.toBuffer().copy(data, 40);
  data[80] = retired ? 0 : 1;
  let offset = 81;
  const endpoint = Buffer.from("https://worker.invalid", "utf8");
  data.writeUInt32LE(endpoint.length, offset);
  endpoint.copy(data, offset + 4);
  offset += 4 + endpoint.length;
  const metadata = Buffer.from("agenc://agent", "utf8");
  data.writeUInt32LE(metadata.length, offset);
  metadata.copy(data, offset + 4);
  offset += 4 + metadata.length;
  data.writeBigInt64LE(registeredAt, offset);
  data[offset + 44] = bump;
  if (retired) Buffer.from("RETD", "ascii").copy(data, offset + 89);
  return { address, authority, data };
}

function jobSpecFixture(task, creator, bidLocked = true) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_job_spec"), task.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(388);
  disc("TaskJobSpec").copy(data);
  task.toBuffer().copy(data, 8);
  creator.toBuffer().copy(data, 40);
  Buffer.alloc(32, 73).copy(data, 72);
  const uri = Buffer.from("agenc://job-spec/locked", "utf8");
  data.writeUInt32LE(uri.length, 104);
  uri.copy(data, 108);
  const end = 108 + uri.length;
  data[end + 16] = bump;
  data[end + 17] = bidLocked ? 1 : 0;
  return { address, data, lamports: 2_000_000 };
}

function connectionWith(accounts, extraAccounts = new Map()) {
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      return accounts
        .filter((item) => item.data.subarray(0, 8).equals(wanted))
        .map((item) => ({
          pubkey: item.address,
          account: {
            owner: item.owner ?? PROGRAM_ID,
            data: item.data,
            lamports: item.lamports,
            executable: item.executable ?? false,
          },
        }));
    },
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => extraAccounts.get(address.toBase58()) ?? null),
  };
}

test("orphan risk classifier separates rent from active/principal state", () => {
  assert.equal(
    classifyTaskChildOrphan({ active: false, principal: 0n }),
    "rent-only",
  );
  assert.equal(
    classifyTaskChildOrphan({ active: true, principal: 0n }),
    "active-or-principal",
  );
  assert.equal(
    classifyTaskChildOrphan({ active: false, principal: 1n }),
    "active-or-principal",
  );
});

test("inventories rent-only orphan configs but blocks orphaned bond principal", async () => {
  const task = new PublicKey(Buffer.alloc(32, 51));
  const creator = new PublicKey(Buffer.alloc(32, 52));
  const party = new PublicKey(Buffer.alloc(32, 53));
  const validation = validationFixture(task, creator);
  const bond = bondFixture(task, party, 2_000_000n);
  const result = await scanTaskChildren(connectionWith([validation, bond]));

  assert.equal(result.orphanCount, 2);
  assert.equal(result.rentOnlyOrphanCount, 1);
  assert.equal(
    result.families.TaskValidationConfig.rentOnlyOrphanCount,
    1,
  );
  assert.equal(result.families.CompletionBond.blockingOrphanCount, 1);
  assert.equal(result.liveCompletionBondCount, 1);
  assert.equal(result.liveCompletionBondPrincipal, 2_000_000n);
  assert.equal(
    result.families.TaskValidationConfig.orphans[0].payer.toBase58(),
    creator.toBase58(),
  );
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "orphaned-active-or-principal-child",
    ),
  );
});

test("aggregates live CompletionBond principal even while its Task parent exists", async () => {
  const task = taskFixture();
  const party = new PublicKey(Buffer.alloc(32, 43));
  const bond = bondFixture(task.address, party, 7_000n);
  const extra = new Map([[task.address.toBase58(), {
    owner: PROGRAM_ID,
    data: task.data,
    lamports: 2_000_000,
    executable: false,
  }]]);
  const result = await scanTaskChildren(connectionWith([bond], extra));

  assert.equal(result.families.CompletionBond.orphanCount, 0);
  assert.equal(result.liveCompletionBondCount, 1);
  assert.equal(result.liveCompletionBondPrincipal, 7_000n);
  assert.deepEqual(result.blockers, []);
});

test("decodes the append-only 252-byte BoundActive TaskBid principal", async () => {
  const task = new PublicKey(Buffer.alloc(32, 83));
  const bidder = new PublicKey(Buffer.alloc(32, 84));
  const bidderAuthority = new PublicKey(Buffer.alloc(32, 85));
  const bid = taskBidFixture(task, bidder, bidderAuthority, 5_000n);
  const result = await scanTaskChildren(connectionWith([bid]));

  assert.equal(result.families.TaskBid.orphanCount, 1);
  assert.equal(result.families.TaskBid.blockingOrphanCount, 1);
  assert.match(
    result.families.TaskBid.orphans[0].state,
    /state=2 .*accepted_no_show_slash_bps=1000/,
  );
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "orphaned-active-or-principal-child",
    ),
  );
  assert.ok(
    !result.blockers.some((item) => item.kind === "invalid-child-layout"),
  );
});

test("decodes exact TaskClaim tail offsets without treating paid rewards as principal", async () => {
  const task = new PublicKey(Buffer.alloc(32, 54));
  const worker = new PublicKey(Buffer.alloc(32, 55));
  const claim = claimFixture(task, worker);
  const result = await scanTaskChildren(connectionWith([claim]));

  assert.equal(result.families.TaskClaim.orphanCount, 1);
  assert.equal(result.families.TaskClaim.rentOnlyOrphanCount, 1);
  assert.equal(result.families.TaskClaim.blockingOrphanCount, 0);
  const orphan = result.families.TaskClaim.orphans[0];
  assert.equal(orphan.payer.toBase58(), worker.toBase58());
  assert.match(orphan.payerField, /close recipient; original payer not stored/);
  assert.match(orphan.state, /historical_reward_paid=500/);
  assert.deepEqual(result.blockers, []);
});

test("attributes TaskModeration rent to its stored moderator, not the creator", async () => {
  const task = new PublicKey(Buffer.alloc(32, 56));
  const creator = new PublicKey(Buffer.alloc(32, 57));
  const moderator = new PublicKey(Buffer.alloc(32, 58));
  const moderation = moderationFixture(task, creator, moderator);
  const result = await scanTaskChildren(connectionWith([moderation]));

  assert.equal(result.families.TaskModeration.rentOnlyOrphanCount, 1);
  const orphan = result.families.TaskModeration.orphans[0];
  assert.equal(orphan.payerField, "moderator");
  assert.equal(orphan.payer.toBase58(), moderator.toBase58());
  assert.notEqual(orphan.payer.toBase58(), creator.toBase58());
  assert.deepEqual(result.blockers, []);
});

test("accepts the live TaskJobSpec bid-lock carve-out", async () => {
  const task = new PublicKey(Buffer.alloc(32, 66));
  const creator = new PublicKey(Buffer.alloc(32, 67));
  const jobSpec = jobSpecFixture(task, creator, true);
  const result = await scanTaskChildren(connectionWith([jobSpec]));
  assert.equal(result.families.TaskJobSpec.rentOnlyOrphanCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("counts recoverable live/tombstoned submission identities separately from unavailable identities", async () => {
  const liveAgent = agentFixture(71, false);
  const retiredAgent = agentFixture(74, true);
  const missingAgent = new PublicKey(Buffer.alloc(32, 77));
  const clonedAgent = agentFixture(76, false, 200n);
  const liveSubmission = submissionFixture(
    new PublicKey(Buffer.alloc(32, 78)),
    liveAgent.address,
    80,
  );
  const retiredSubmission = submissionFixture(
    new PublicKey(Buffer.alloc(32, 79)),
    retiredAgent.address,
    81,
  );
  const unavailableSubmission = submissionFixture(
    new PublicKey(Buffer.alloc(32, 80)),
    missingAgent,
    82,
  );
  const clonedSubmission = submissionFixture(
    new PublicKey(Buffer.alloc(32, 81)),
    clonedAgent.address,
    83,
  );
  const extra = new Map([
    [liveAgent.address.toBase58(), {
      owner: PROGRAM_ID,
      data: liveAgent.data,
      lamports: 3_000_000,
      executable: false,
    }],
    [retiredAgent.address.toBase58(), {
      owner: PROGRAM_ID,
      data: retiredAgent.data,
      lamports: 3_000_000,
      executable: false,
    }],
    [clonedAgent.address.toBase58(), {
      owner: PROGRAM_ID,
      data: clonedAgent.data,
      lamports: 3_000_000,
      executable: false,
    }],
    // A one-lamport dust transfer does not make an empty system-owned Agent PDA
    // identity-continuous; it remains the authenticated treasury-recovery shape.
    [missingAgent.toBase58(), {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 1,
      executable: false,
    }],
  ]);
  const result = await scanTaskChildren(
    connectionWith(
      [liveSubmission, retiredSubmission, unavailableSubmission, clonedSubmission],
      extra,
    ),
  );
  assert.equal(result.orphanSubmissionRecoverableCount, 2);
  assert.equal(result.orphanSubmissionTreasuryRecoveryCount, 2);
  assert.equal(
    result.families.TaskSubmission.recoverableWorkerIdentityCount,
    2,
  );
  assert.equal(
    result.families.TaskSubmission.treasuryRecoveryIdentityCount,
    2,
  );
  const recoverable = result.families.TaskSubmission.orphans.filter(
    (item) => item.recovery === "recoverable-worker-identity",
  );
  assert.equal(recoverable[0].payer.toBase58(), liveAgent.authority.toBase58());
  assert.equal(recoverable[1].workerIdentityRetired, true);
  const discontinuous = result.families.TaskSubmission.orphans.find(
    (item) => item.worker.equals(clonedAgent.address),
  );
  assert.equal(discontinuous.recovery, "recoverable-protocol-treasury");
  assert.match(discontinuous.recoveryDetail, /registered_at=200 submitted_at=200/);
  const dusted = result.families.TaskSubmission.orphans.find(
    (item) => item.worker.equals(missingAgent),
  );
  assert.equal(dusted.recovery, "recoverable-protocol-treasury");
  assert.match(dusted.recoveryDetail, /system-owned empty/);
  assert.deepEqual(result.blockers, []);
});

test("treats a vote with a live canonical TaskSubmission as non-orphan", async () => {
  const task = new PublicKey(Buffer.alloc(32, 86));
  const worker = new PublicKey(Buffer.alloc(32, 87));
  const reviewer = new PublicKey(Buffer.alloc(32, 88));
  const submission = submissionFixture(task, worker, 89);
  const vote = validationVoteFixture(submission.address, reviewer);
  const extra = new Map([
    [submission.address.toBase58(), {
      owner: PROGRAM_ID,
      data: submission.data,
      lamports: submission.lamports,
      executable: false,
    }],
  ]);

  const result = await scanTaskChildren(connectionWith([vote], extra));

  assert.equal(result.families.TaskValidationVote.accountCount, 1);
  assert.equal(result.families.TaskValidationVote.orphanCount, 0);
  assert.equal(result.accountCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("inventories an orphan validation vote as reviewer-reclaimable rent", async () => {
  const submission = new PublicKey(Buffer.alloc(32, 90));
  const reviewer = new PublicKey(Buffer.alloc(32, 91));
  const vote = validationVoteFixture(submission, reviewer);

  const result = await scanTaskChildren(connectionWith([vote]));

  const summary = result.families.TaskValidationVote;
  assert.equal(summary.orphanCount, 1);
  assert.equal(summary.rentOnlyOrphanCount, 1);
  assert.equal(summary.blockingOrphanCount, 0);
  assert.equal(summary.orphans[0].submission.toBase58(), submission.toBase58());
  assert.equal(summary.orphans[0].payer.toBase58(), reviewer.toBase58());
  assert.equal(summary.orphans[0].payerField, "reviewer");
  assert.deepEqual(result.blockers, []);
});

test("a prefunded empty submission PDA cannot dust-DoS vote inventory", async () => {
  const submission = new PublicKey(Buffer.alloc(32, 98));
  const reviewer = new PublicKey(Buffer.alloc(32, 99));
  const vote = validationVoteFixture(submission, reviewer);
  const extra = new Map([
    [submission.toBase58(), {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 1,
      executable: false,
    }],
  ]);

  const result = await scanTaskChildren(connectionWith([vote], extra));

  assert.equal(result.families.TaskValidationVote.rentOnlyOrphanCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("fails closed on malformed vote PDA/layout and invalid submission binding", async () => {
  const task = new PublicKey(Buffer.alloc(32, 92));
  const worker = new PublicKey(Buffer.alloc(32, 93));
  const reviewer = new PublicKey(Buffer.alloc(32, 94));
  const submission = submissionFixture(task, worker, 95);

  const badPda = validationVoteFixture(submission.address, reviewer);
  badPda.address = new PublicKey(Buffer.alloc(32, 96));
  let result = await scanTaskChildren(connectionWith([badPda]));
  assert.ok(
    result.blockers.some(
      (item) =>
        item.family === "TaskValidationVote" &&
        item.kind === "invalid-child-pda",
    ),
  );

  const badLayout = validationVoteFixture(submission.address, reviewer);
  badLayout.data[116] = 1;
  result = await scanTaskChildren(connectionWith([badLayout]));
  assert.ok(
    result.blockers.some(
      (item) =>
        item.family === "TaskValidationVote" &&
        item.kind === "invalid-child-layout" &&
        /reserved bytes are nonzero/.test(item.detail),
    ),
  );

  const vote = validationVoteFixture(submission.address, reviewer);
  const extra = new Map([
    [submission.address.toBase58(), {
      owner: new PublicKey(Buffer.alloc(32, 97)),
      data: submission.data,
      lamports: submission.lamports,
      executable: false,
    }],
  ]);
  result = await scanTaskChildren(connectionWith([vote], extra));
  assert.ok(
    result.blockers.some(
      (item) =>
        item.family === "TaskValidationVote" &&
        item.kind === "invalid-child-submission-binding",
    ),
  );
});

test("fails closed on child owner and canonical-PDA ambiguity", async () => {
  const task = new PublicKey(Buffer.alloc(32, 61));
  const creator = new PublicKey(Buffer.alloc(32, 62));
  const badOwner = validationFixture(task, creator);
  badOwner.owner = new PublicKey(Buffer.alloc(32, 63));
  let result = await scanTaskChildren(connectionWith([badOwner]));
  assert.ok(result.blockers.some((item) => item.kind === "invalid-child-owner"));

  const badPda = validationFixture(task, creator);
  badPda.address = new PublicKey(Buffer.alloc(32, 64));
  result = await scanTaskChildren(connectionWith([badPda]));
  assert.ok(result.blockers.some((item) => item.kind === "invalid-child-pda"));

  const moderator = new PublicKey(Buffer.alloc(32, 65));
  const badReserved = moderationFixture(task, creator, moderator);
  badReserved.data[227] = 1;
  result = await scanTaskChildren(connectionWith([badReserved]));
  assert.ok(
    result.blockers.some(
      (item) =>
        item.kind === "invalid-child-layout" &&
        /reserved bytes are nonzero/.test(item.detail),
    ),
  );
});

test("refuses non-mainnet before enumerating child families", async () => {
  let enumerated = false;
  await assert.rejects(
    scanTaskChildren({
      getGenesisHash: async () => "devnet",
      getProgramAccounts: async () => {
        enumerated = true;
        return [];
      },
    }),
    /wrong cluster genesis/,
  );
  assert.equal(enumerated, false);
});
