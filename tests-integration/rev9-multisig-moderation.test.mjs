// Revision 9 (G): no single key over all new work. Design: REV9-DESIGN.md sections 6
// and 11.6, plus open question 13 (decided yes).
//
// Turning moderation on or off and choosing the global moderator, suspending and
// unsuspending an agent, assigning and revoking a deputized moderation attestor,
// and changing the heartbeat window all need 2 of the 3 ProtocolConfig owners
// (co-signers in remaining accounts). A plain heartbeat keeps today's senders and
// adds any owner. A task creator cannot moderate its own task (refused when
// recorded and again at the publish gate), and a provider cannot moderate its
// own listing.
//
// Executes the COMPILED program; instructions are built from target/idl, so the
// fed99ab comparison sends today's wire for the same calls and each test fails
// for the reason its title gives.
//
// Run: node --test tests-integration/rev9-multisig-moderation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32, coder, PID,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, configureTestMultisig, approvalSigners, injectModerationConfig,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

const DAY = 86_400;
const attestorPda = (attestor) => pda([enc("moderation_attestor"), attestor.toBuffer()])[0];

async function configureIx(w, signer, moderationAuthority, enabled, approvals = null) {
  return makeProgram(signer).methods
    .configureTaskModeration(moderationAuthority, enabled)
    .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg, authority: signer.publicKey,
      systemProgram: SystemProgram.programId })
    .remainingAccounts(approvals ? approvals.remainingAccounts : [])
    .instruction();
}

async function suspendIx(w, method, signer, approvals = null) {
  return makeProgram(signer).methods[method]()
    .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: signer.publicKey })
    .remainingAccounts(approvals ? approvals.remainingAccounts : [])
    .instruction();
}

async function heartbeatIx(w, signer, window, { protocolConfig = null, approvals = null } = {}) {
  return makeProgram(signer).methods
    .moderationHeartbeat(window)
    .accounts({ moderationConfig: w.modCfg, authority: signer.publicKey, protocolConfig })
    .remainingAccounts(approvals ? approvals.remainingAccounts : [])
    .instruction();
}

async function assignIx(w, signer, attestor, approvals = null) {
  return makeProgram(signer).methods
    .assignModerationAttestor(attestor)
    .accounts({ moderationConfig: w.modCfg, moderationAttestor: attestorPda(attestor), authority: signer.publicKey,
      systemProgram: SystemProgram.programId, protocolConfig: w.protocolPda })
    .remainingAccounts(approvals ? approvals.remainingAccounts : [])
    .instruction();
}

async function revokeIx(w, signer, attestor, approvals = null) {
  return makeProgram(signer).methods
    .revokeModerationAttestor()
    .accounts({ moderationConfig: w.modCfg, moderationAttestor: attestorPda(attestor), authority: signer.publicKey,
      protocolConfig: w.protocolPda })
    .remainingAccounts(approvals ? approvals.remainingAccounts : [])
    .instruction();
}

async function createAuto(w) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const now = Number(w.svm.getClock().unixTimestamp);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow: pda([enc("escrow"), task.toBuffer()])[0], protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "mm:create_task");
  return task;
}

// ---------------------------------------------------------------------------
// 11.6 item 1. fed99ab: one signer configures moderation.
// ---------------------------------------------------------------------------
test("rev9 multisig: configure_task_moderation needs 2 of 3; one signer fails, even the protocol authority (fed99ab: one signer succeeds)", async () => {
  const w = await freshWorld({ moderationEnabled: false });
  const approvals = await configureTestMultisig(w);
  const newModerator = Keypair.generate().publicKey;
  expectFail(send(w.svm, await configureIx(w, w.admin, newModerator, true), [w.admin]),
    "MultisigNotEnoughSigners", "the protocol authority alone");
  assert.equal(decode(w.svm, "ModerationConfig", w.modCfg).enabled, false, "unchanged");

  // Any proposer with the threshold; the owners decide.
  const proposer = Keypair.generate();
  w.svm.airdrop(proposer.publicKey, 1_000_000_000n);
  expectOk(send(w.svm, await configureIx(w, proposer, newModerator, true, approvals), approvalSigners(approvals, proposer)),
    "2 of 3 configure");
  const config = decode(w.svm, "ModerationConfig", w.modCfg);
  assert.equal(config.enabled, true);
  assert.equal(config.moderation_authority.toBase58(), newModerator.toBase58());
  assert.equal(config.authority.toBase58(), w.admin.publicKey.toBase58(), "config authority stays the protocol authority");
});

// ---------------------------------------------------------------------------
// 11.6 item 2. fed99ab: the protocol authority suspends alone.
// ---------------------------------------------------------------------------
test("rev9 multisig: suspend_agent and unsuspend_agent need 2 of 3 (fed99ab: the protocol authority alone)", async () => {
  const w = await freshWorld({});
  const approvals = await configureTestMultisig(w);
  expectFail(send(w.svm, await suspendIx(w, "suspendAgent", w.admin), [w.admin]),
    "MultisigNotEnoughSigners", "one-signer suspend");
  expectOk(send(w.svm, await suspendIx(w, "suspendAgent", w.admin, approvals), approvalSigners(approvals, w.admin)),
    "2 of 3 suspend");
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Suspended !== undefined);
  expectFail(send(w.svm, await suspendIx(w, "unsuspendAgent", w.admin), [w.admin]),
    "MultisigNotEnoughSigners", "one-signer unsuspend");
  expectOk(send(w.svm, await suspendIx(w, "unsuspendAgent", w.admin, approvals), approvalSigners(approvals, w.admin)),
    "2 of 3 unsuspend");
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Inactive !== undefined);
});

// ---------------------------------------------------------------------------
// 11.6 items 3 and 4. fed99ab: the config authority retunes the window alone.
// ---------------------------------------------------------------------------
test("rev9 multisig: plain heartbeats keep their senders and add the owners; a window change needs 2 of 3 (fed99ab: no owner heartbeat, and the config authority changes the window alone)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const approvals = await configureTestMultisig(w);
  const owner2 = approvals.approvers[1];
  expectOk(send(w.svm, await heartbeatIx(w, w.modAuth, null), [w.modAuth]), "moderation authority heartbeat");
  expectOk(send(w.svm, await heartbeatIx(w, w.admin, null), [w.admin]), "config authority heartbeat");
  expectFail(send(w.svm, await heartbeatIx(w, owner2, null), [owner2]),
    "UnauthorizedModerationHeartbeat", "an owner needs the protocol config");
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await heartbeatIx(w, owner2, null, { protocolConfig: w.protocolPda }), [owner2]), "owner heartbeat");

  for (const signer of [w.admin, w.modAuth]) {
    expectFail(send(w.svm, await heartbeatIx(w, signer, 7 * DAY, { protocolConfig: w.protocolPda }), [signer]),
      "UnauthorizedModerationHeartbeat", "one-signer window change");
  }
  expectFail(send(w.svm, await heartbeatIx(w, w.admin, 7 * DAY, { approvals }), approvalSigners(approvals, w.admin)),
    "UnauthorizedModerationHeartbeat", "a window change without the protocol config");
  expectOk(send(w.svm, await heartbeatIx(w, w.admin, 7 * DAY, { protocolConfig: w.protocolPda, approvals }),
    approvalSigners(approvals, w.admin)), "2 of 3 window change");
  const config = decode(w.svm, "ModerationConfig", w.modCfg);
  assert.equal(Buffer.from(config._reserved.slice(0, 4)).readUInt32LE(0), 7 * DAY);
});

// ---------------------------------------------------------------------------
// 11.6 item 5. fed99ab: a creator who is a moderator records for its own task.
// ---------------------------------------------------------------------------
test("rev9 multisig: record_task_moderation by the task's creator fails with ModeratorIsTaskCreator (fed99ab: records)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const task = await createAuto(w);
  // The buyer becomes the global moderation authority.
  await injectModerationConfig(w.svm, w.admin, w.buyer, true);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.buyer.publicKey);
  expectFail(send(w.svm, await w.buyerProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.buyer.publicKey,
      moderationAttestor: null, systemProgram: SystemProgram.programId, rentPayer: w.buyer.publicKey })
    .instruction(), [w.buyer]), "ModeratorIsTaskCreator", "self-moderation");
  assert.ok(isClosed(w.svm, taskMod), "no record");
});

// ---------------------------------------------------------------------------
// 11.6 item 6. fed99ab: a creator-moderated record from before the upgrade publishes.
// ---------------------------------------------------------------------------
test("rev9 multisig: set_task_job_spec refuses an injected creator-moderated record (fed99ab: publishes)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const task = await createAuto(w);
  await injectModerationConfig(w.svm, w.admin, w.buyer, true);
  const jobHash = id32();
  const [taskMod, bump] = taskModV2Pda(task, jobHash, w.buyer.publicKey);
  const data = await coder.accounts.encode("TaskModeration", {
    task, creator: w.buyer.publicKey, job_spec_hash: arr(jobHash), status: 0, risk_score: 0,
    category_mask: new BN(0), policy_hash: arr(Buffer.alloc(32, 1)), scanner_hash: arr(Buffer.alloc(32, 2)),
    recorded_at: new BN(1), expires_at: new BN(0), moderator: w.buyer.publicKey, bump, _reserved: Array(7).fill(0),
  });
  w.svm.setAccount(taskMod, { lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))), data,
    owner: PID, executable: false, rentEpoch: 0 });
  const jobSpec = pda([enc("task_job_spec"), task.toBuffer()])[0];
  expectFail(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/self-moderated", w.buyer.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod,
      moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "ModeratorIsTaskCreator", "self-moderated record at the publish gate");
  assert.ok(isClosed(w.svm, jobSpec), "nothing published");
});

// ---------------------------------------------------------------------------
// Open question 13. fed99ab: a provider who is a moderator attests its own listing.
// ---------------------------------------------------------------------------
test("rev9 multisig: record_listing_moderation by the listing's provider fails with ModeratorIsListingProvider (fed99ab: records)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  await injectModerationConfig(w.svm, w.admin, w.provider, true);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.provider.publicKey);
  expectFail(send(w.svm, await w.providerProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
      moderator: w.provider.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "ModeratorIsListingProvider", "listing self-moderation");
  assert.ok(isClosed(w.svm, listingMod), "no record");
});

test("rev9 multisig: assigning and revoking a deputized attestor need 2 of 3; a bonded self-registered entry is never revoked (fed99ab: the moderation authority alone)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const approvals = await configureTestMultisig(w);
  const deputy = Keypair.generate().publicKey;
  expectFail(send(w.svm, await assignIx(w, w.admin, deputy), [w.admin]),
    "MultisigNotEnoughSigners", "one-signer assign");
  expectOk(send(w.svm, await assignIx(w, w.admin, deputy, approvals), approvalSigners(approvals, w.admin)),
    "2 of 3 assign");
  assert.equal(decode(w.svm, "ModerationAttestor", attestorPda(deputy)).assigned_by.toBase58(), w.admin.publicKey.toBase58());

  expectFail(send(w.svm, await revokeIx(w, w.admin, deputy), [w.admin]),
    "MultisigNotEnoughSigners", "one-signer revoke");
  // Another owner proposes the revoke; the entry's rent goes to the proposer.
  const owner2 = approvals.approvers[1];
  const rent = BigInt(w.svm.getBalance(attestorPda(deputy)));
  const before = BigInt(w.svm.getBalance(owner2.publicKey));
  expectOk(send(w.svm, await revokeIx(w, owner2, deputy, approvals), approvalSigners(approvals, owner2)),
    "2 of 3 revoke proposed by another owner");
  assert.ok(isClosed(w.svm, attestorPda(deputy)), "deputized entry closed");
  assert.equal(BigInt(w.svm.getBalance(owner2.publicKey)) - before, rent - 10_000n,
    "the proposer got the rent, less the two-signature fee");

  // A self-registered (bonded) attestor cannot be revoked, even by 2 of 3.
  const selfReg = Keypair.generate();
  w.svm.airdrop(selfReg.publicKey, 1_000_000_000n);
  expectOk(send(w.svm, await makeProgram(selfReg).methods
    .registerModerationAttestor()
    .accounts({ moderationAttestor: attestorPda(selfReg.publicKey), attestor: selfReg.publicKey,
      protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId })
    .instruction(), [selfReg]), "self-register");
  expectFail(send(w.svm, await revokeIx(w, w.admin, selfReg.publicKey, approvals), approvalSigners(approvals, w.admin)),
    "UnauthorizedAttestorRevocation", "a bonded entry");
  assert.ok(!isClosed(w.svm, attestorPda(selfReg.publicKey)), "the bonded entry stays");
});
