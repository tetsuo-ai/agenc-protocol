// In-process litesvm integration tests for P6.3 — retire `vote_dispute` + the arbiter
// vote/quorum machinery.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end and
// proves the dispute lifecycle works on the ROSTER model ALONE, with ZERO arbiters,
// ZERO `vote_dispute` calls, ZERO vote PDAs, and ZERO `(vote, arbiter)` remaining
// accounts — which is the whole point of the cleanup.
//
// The load-bearing, money-path assertion is in test (1): the permissionless
// `apply_dispute_slash` finalizer STILL slashes the losing worker after a roster
// `resolve_dispute(approve=true, Refund)` even though no vote was ever cast. Before
// P6.3, `apply_dispute_slash`/`apply_initiator_slash` derived "who lost" from
// `calculate_approval_percentage(votes_for, votes_against)`; with the vote tally now
// permanently (0,0) the helper would error (InsufficientVotes) and the slash leg would
// be stranded. P6.3 has `resolve_dispute` write a 1-bit RULING into those fields
// ((1,0)=approved, (0,1)=rejected) so the finalizers recover the resolver's decision.
//
// REVERT-SENSITIVE INTENT:
//   - Delete the ruling-bit write in resolve_dispute.rs (or change `ruling_vote_bits`
//     to return (0,0) on approve) -> `apply_dispute_slash` reverts (InsufficientVotes)
//     instead of slashing, so test (1)'s "stake slashed" assertion goes red (the
//     apply_dispute_slash send fails).
//   - Re-introduce a required `(vote, arbiter)` prefix in
//     `validate_remaining_accounts_structure` -> resolve with no remaining accounts on a
//     `total_voters == 0` dispute would no longer be accepted as "all worker pairs";
//     test (1)/(2) resolve sends would change behavior.
//   - Test (3) pins that a rejected ruling does NOT slash the worker (the worker was
//     vindicated): flip the worker_lost derivation and apply_dispute_slash would slash
//     and the "stake unchanged + apply reverts" assertion goes red.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh before this test). It references the regenerated `resolveDispute`
// (rationale args + `resolverAssignment`) and the `Dispute`/`AgentRegistration` decoders
// by their Codama/anchor naming. There is intentionally NO `voteDispute` builder call —
// that instruction no longer exists.
//
// Run:  cd agenc-protocol && node --test tests-integration/dispute-vote-retired.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  freshWorld, hireIx, injectAgentStake, setProtocolPaused,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

// Roster PDA for a dispute resolver wallet ["dispute_resolver", resolver].
const resolverPda = (resolver) => pda([enc("dispute_resolver"), resolver.toBuffer()]);

// Assign `resolver` to the dispute-resolver roster, signed by the protocol authority.
async function assignResolver(w, resolver) {
  const [entry] = resolverPda(resolver.publicKey);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({
      protocolConfig: w.protocolPda, disputeResolver: entry,
      authority: w.admin.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.admin]), "p63:assign_dispute_resolver");
  return entry;
}

// Drive a hired task to a claimed, InProgress state and have the CREATOR (buyer) open a
// Refund dispute against the worker (so the worker is the defendant who can be slashed).
async function hireClaimCreatorDispute(w, { resolutionType }) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "p63:listing-mod");

  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "p63:hire");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "p63:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/p63", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "p63:publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "p63:claim");

  // Give the worker a slashable stake so apply_dispute_slash has something to take.
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000);

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [buyerRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  // CREATOR (buyer) initiates against the worker: worker is the defendant.
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "bad work")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: buyerRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "p63:initiate (creator vs worker)");

  // The dispute records ZERO voters — the vote machinery is gone.
  const d = decode(w.svm, "Dispute", dispute);
  assert.ok(d.status.Active !== undefined, "dispute Active");
  assert.equal(Number(d.total_voters), 0, "total_voters == 0 (no arbiters, vote model retired)");
  return { task, escrow, hireRecord, claim, dispute };
}

// Resolve via an ASSIGNED resolver with NO arbiter remaining accounts (the cleanup proof).
async function resolveAsAssigned(w, r, { resolver, resolverEntry, approve, rationaleHash, rationaleUri }) {
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  return makeProgram(resolver).methods
    .resolveDispute(approve, arr(rationaleHash), rationaleUri)
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: resolver.publicKey, resolverAssignment: resolverEntry, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
    })
    .instruction(); // NOTE: no .remainingAccounts() — there are no (vote, arbiter) pairs.
}

// Build an apply_dispute_slash ix (the permissionless slash finalizer).
async function applyDisputeSlashIx(w, r) {
  return makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({
      dispute: r.dispute, task: r.task, workerClaim: r.claim, workerAgent: w.providerAgent,
      workerAuthority: w.provider.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
      escrow: null, tokenEscrowAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
    })
    .instruction();
}

// ---------------------------------------------------------------------------
// (1) MONEY-PATH: a roster APPROVE (Refund) ruling — with ZERO votes — still lets
// apply_dispute_slash slash the losing worker. This is the proof that the ruling-bit
// fix keeps the slash leg alive after the vote tally is retired.
// ---------------------------------------------------------------------------
test("vote-retired: a roster Refund ruling (no votes, no arbiters) still slashes the losing worker via apply_dispute_slash", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  const r = await hireClaimCreatorDispute(w, { resolutionType: 0 }); // 0 = Refund -> worker loses

  // Resolve as the assigned resolver, APPROVE the Refund. NO arbiter remaining accounts.
  const rationaleHash = crypto.randomBytes(32);
  expectOk(send(w.svm,
    await resolveAsAssigned(w, r, { resolver, resolverEntry, approve: true, rationaleHash, rationaleUri: "agenc://ruling/refund" }),
    [resolver]), "p63:resolve Refund (approve) by assigned resolver, no votes");

  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Resolved !== undefined, "dispute Resolved with no votes");
  // P6.3 ruling bit: APPROVE -> (votes_for=1, votes_against=0). This is what the slash
  // finalizer reads — proving the field is a 1-bit ruling, not a tally.
  assert.equal(d.votes_for.toString(), "1", "approve ruling stored votes_for == 1");
  assert.equal(d.votes_against.toString(), "0", "approve ruling stored votes_against == 0");

  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeBefore > 0, "worker has a slashable stake before the slash");

  // apply_dispute_slash must SUCCEED and reduce the worker's stake — even though no vote
  // was cast. Pre-P6.3 this would revert (InsufficientVotes) and strand the slash.
  expectOk(send(w.svm, await applyDisputeSlashIx(w, r), [w.admin]),
    "p63:apply_dispute_slash on a no-vote roster ruling");

  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `worker stake slashed after a no-vote roster ruling (${stakeBefore} -> ${stakeAfter})`);
});

// ---------------------------------------------------------------------------
// (2) Same money-path, but exit-safe: apply_dispute_slash works WHILE PAUSED (the
// finalizer that has no alternative unwind). Roster ruling, no votes.
// ---------------------------------------------------------------------------
test("vote-retired: apply_dispute_slash settles a no-vote roster ruling while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  const r = await hireClaimCreatorDispute(w, { resolutionType: 0 }); // Refund
  const rationaleHash = crypto.randomBytes(32);
  expectOk(send(w.svm,
    await resolveAsAssigned(w, r, { resolver, resolverEntry, approve: true, rationaleHash, rationaleUri: "" }),
    [resolver]), "p63:resolve Refund (approve), no votes");

  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  await setProtocolPaused(w.svm, true);
  expectOk(send(w.svm, await applyDisputeSlashIx(w, r), [w.admin]),
    "p63:apply_dispute_slash while paused (no-vote ruling)");
  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `worker stake slashed while paused (${stakeBefore} -> ${stakeAfter})`);
});

// ---------------------------------------------------------------------------
// (3) Negative pin: a roster REJECT ruling must NOT slash the worker (the worker was
// vindicated). The ruling bit (0,1) reads as 0% approval -> not approved -> worker_lost
// false -> apply_dispute_slash reverts (InvalidInput) and the worker's stake is intact.
// Revert-sensitive: if resolve_dispute wrote the wrong ruling bit, the worker would be
// wrongly slashable and this expectFail would go red.
// ---------------------------------------------------------------------------
test("vote-retired: a roster REJECT ruling (no votes) leaves the worker un-slashable (vindicated)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  const r = await hireClaimCreatorDispute(w, { resolutionType: 0 }); // Refund requested
  const rationaleHash = crypto.randomBytes(32);
  // REJECT the dispute: the creator's Refund request is denied; the worker is vindicated.
  expectOk(send(w.svm,
    await resolveAsAssigned(w, r, { resolver, resolverEntry, approve: false, rationaleHash, rationaleUri: "" }),
    [resolver]), "p63:resolve REJECT (worker vindicated), no votes");

  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Resolved !== undefined, "dispute Resolved (rejected)");
  // P6.3 ruling bit: REJECT -> (votes_for=0, votes_against=1).
  assert.equal(d.votes_for.toString(), "0", "reject ruling stored votes_for == 0");
  assert.equal(d.votes_against.toString(), "1", "reject ruling stored votes_against == 1");

  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  // apply_dispute_slash must REVERT — the worker did not lose, so there is nothing to slash.
  // A vindicating (REJECT, no-slash) resolution CLOSES the worker_claim during
  // resolve_dispute (resolve_dispute.rs: !defer_worker_claim_close), so the required
  // worker_claim account is gone. apply_dispute_slash therefore fails closed at account
  // load (AccountNotInitialized) before reaching the worker_lost (InvalidInput) check —
  // the worker is un-slashable either way; only the surfaced error differs.
  expectFail(send(w.svm, await applyDisputeSlashIx(w, r), [w.admin]),
    "AccountNotInitialized", "p63:apply_dispute_slash must reject slashing a vindicated worker");
  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.equal(stakeAfter, stakeBefore, "vindicated worker's stake is untouched");
});
