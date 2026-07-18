// In-process litesvm integration tests for the agenc-coordination GOVERNANCE
// instructions: initialize_governance, create_proposal, vote_proposal,
// cancel_proposal. Executes the COMPILED program end-to-end.
//
// Setup reuses freshWorld() from the shared harness (real register_agent +
// create_service_listing, injected ProtocolConfig + ModerationConfig). The
// GovernanceConfig PDA is created via the real initialize_governance ix, using
// the protocol authority (w.admin).
//
// Run:  cd .. && node --test tests-integration/governance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  setMinArbiterStake, injectAgentStake,
  freshWorld,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Local helpers (marketplace.test.mjs helpers are NOT exported — inlined here).
// ---------------------------------------------------------------------------

const ZERO32 = arr(Buffer.alloc(32, 0));
const ZERO64 = arr(Buffer.alloc(64, 0));

// Initialize the GovernanceConfig PDA via the real instruction (protocol
// authority = w.admin). Returns the governance PDA.
async function initGovernance(
  w,
  {
    votingPeriod = 86_400,
    executionDelay = 0,
    quorumBps = 5000,
    approvalThresholdBps = 5000,
    minProposalStake = 1_000,
  } = {},
) {
  const [governance] = pda([enc("governance")]);
  const adminProg = makeProgram(w.admin);
  const res = send(
    w.svm,
    await adminProg.methods
      .initializeGovernance(
        new BN(votingPeriod),
        new BN(executionDelay),
        quorumBps,
        approvalThresholdBps,
        new BN(minProposalStake),
      )
      .accounts({
        governanceConfig: governance,
        protocolConfig: w.protocolPda,
        authority: w.admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.admin],
  );
  return { governance, res };
}

// Register a fresh marketplace agent (new wallet) and return its keypair, PDA,
// program handle. Mirrors freshWorld()'s register_agent calls.
async function registerAgent(w, { capabilities = 1 } = {}) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(agentId), new BN(capabilities), "http://gov.test", null, new BN(0))
        .accounts({
          agent,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register governance agent",
  );
  return { kp, agent, prog, agentId };
}

// Build (and send) a create_proposal ix for `proposer`. Defaults to a
// FeeChange proposal with a valid fee payload. Returns the proposal PDA + res.
async function createProposal(
  w,
  governance,
  { kp, agent, prog },
  {
    nonce = 1,
    proposalType = 1, // 1 = FeeChange
    titleHash = ZERO32,
    descriptionHash = ZERO32,
    payload = null,
    votingPeriod = 0,
  } = {},
) {
  // FeeChange payload: u16 LE fee_bps in first two bytes (<= MAX_PROTOCOL_FEE_BPS).
  let pl = payload;
  if (pl === null) {
    const buf = Buffer.alloc(64, 0);
    buf.writeUInt16LE(100, 0); // 100 bps — well within bounds
    pl = arr(buf);
  }
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  // PDA seed uses proposer.key() = the AgentRegistration PDA (not the wallet).
  const [proposal] = pda([enc("proposal"), agent.toBuffer(), nonceBuf]);
  const res = send(
    w.svm,
    await prog.methods
      .createProposal(
        new BN(nonce),
        proposalType,
        titleHash,
        descriptionHash,
        pl,
        new BN(votingPeriod),
      )
      .accounts({
        proposal,
        proposer: agent,
        protocolConfig: w.protocolPda,
        governanceConfig: governance,
        authority: kp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [kp],
  );
  return { proposal, res };
}

// Build (and send) a vote_proposal ix for `voter` on `proposal`.
async function voteProposal(w, proposal, { kp, agent, prog }, approve) {
  const [vote] = pda([
    enc("governance_vote"),
    proposal.toBuffer(),
    kp.publicKey.toBuffer(),
  ]);
  const res = send(
    w.svm,
    await prog.methods
      .voteProposal(approve)
      .accounts({
        proposal,
        vote,
        voter: agent,
        protocolConfig: w.protocolPda,
        authority: kp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [kp],
  );
  return { vote, res };
}

// ===========================================================================
// initialize_governance
// ===========================================================================

test("initialize_governance: creates GovernanceConfig with provided params", async () => {
  const w = await freshWorld({});
  const { governance, res } = await initGovernance(w, {
    votingPeriod: 86_400,
    executionDelay: 3_600,
    quorumBps: 4000,
    approvalThresholdBps: 6000,
    minProposalStake: 5_000,
  });
  expectOk(res, "initialize_governance");

  const g = decode(w.svm, "GovernanceConfig", governance);
  assert.equal(g.authority.toBase58(), w.admin.publicKey.toBase58(), "authority == protocol authority");
  assert.equal(g.voting_period.toString(), "86400", "voting_period stored");
  assert.equal(g.execution_delay.toString(), "3600", "execution_delay stored");
  assert.equal(g.quorum_bps, 4000, "quorum_bps stored");
  assert.equal(g.approval_threshold_bps, 6000, "approval_threshold_bps stored");
  assert.equal(g.min_proposal_stake.toString(), "5000", "min_proposal_stake stored");
  assert.equal(g.total_proposals.toString(), "0", "total_proposals starts 0");
});

test("initialize_governance: non-authority signer is rejected (UnauthorizedAgent)", async () => {
  const w = await freshWorld({});
  // buyer is a funded keypair but NOT the protocol authority.
  const [governance] = pda([enc("governance")]);
  const res = send(
    w.svm,
    await w.buyerProg.methods
      .initializeGovernance(new BN(86_400), new BN(0), 5000, 5000, new BN(1_000))
      .accounts({
        governanceConfig: governance,
        protocolConfig: w.protocolPda,
        authority: w.buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.buyer],
  );
  expectFail(res, "UnauthorizedAgent", "non-authority init rejected");
});

test("initialize_governance: invalid quorum (0 bps) is rejected (InvalidGovernanceParam)", async () => {
  const w = await freshWorld({});
  const [governance] = pda([enc("governance")]);
  const res = send(
    w.svm,
    await makeProgram(w.admin).methods
      .initializeGovernance(new BN(86_400), new BN(0), 0, 5000, new BN(1_000))
      .accounts({
        governanceConfig: governance,
        protocolConfig: w.protocolPda,
        authority: w.admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.admin],
  );
  expectFail(res, "InvalidGovernanceParam", "quorum 0 rejected");
});

// ===========================================================================
// create_proposal
// ===========================================================================

test("create_proposal: mints an Active proposal + bumps governance counter", async () => {
  const w = await freshWorld({});
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000); // >= min_proposal_stake

  const { proposal, res } = await createProposal(w, governance, proposer, { nonce: 7 });
  expectOk(res, "create_proposal");

  const p = decode(w.svm, "Proposal", proposal);
  assert.equal(p.proposer.toBase58(), proposer.agent.toBase58(), "proposal.proposer == agent PDA");
  assert.equal(p.proposer_authority.toBase58(), proposer.kp.publicKey.toBase58(), "proposer_authority == wallet");
  assert.equal(p.nonce.toString(), "7", "nonce stored");
  assert.ok(p.proposal_type.FeeChange !== undefined, "proposal_type == FeeChange");
  assert.ok(p.status.Active !== undefined, "proposal starts Active");
  assert.equal(p.votes_for.toString(), "0", "no votes yet");
  assert.equal(p.total_voters, 0, "no voters yet");
  assert.ok(p.quorum.toString() !== "0", "quorum computed (> 0)");

  const g = decode(w.svm, "GovernanceConfig", governance);
  assert.equal(g.total_proposals.toString(), "1", "governance.total_proposals incremented");
});

test("create_proposal: insufficient proposer stake is rejected (ProposalInsufficientStake)", async () => {
  const w = await freshWorld({});
  const { governance } = await initGovernance(w, { minProposalStake: 1_000_000 });
  const proposer = await registerAgent(w);
  // stake left at registration default (0) — below min_proposal_stake.
  const { res } = await createProposal(w, governance, proposer, { nonce: 11 });
  expectFail(res, "ProposalInsufficientStake", "low-stake proposer rejected");
});

test("create_proposal: invalid proposal_type is rejected (InvalidProposalType)", async () => {
  const w = await freshWorld({});
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { res } = await createProposal(w, governance, proposer, {
    nonce: 13,
    proposalType: 9, // not a valid ProposalType variant (0..3)
    payload: ZERO64,
  });
  expectFail(res, "InvalidProposalType", "bad proposal_type rejected");
});

test("create_proposal: a custom voting period is floored at the governance default (audit: no snap votes)", async () => {
  const w = await freshWorld({});
  // Governance default = 86_400 (1 day); the program's MAX_VOTING_PERIOD = 604_800.
  const { governance } = await initGovernance(w, { votingPeriod: 86_400, minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);

  // votingPeriod = 1s — a snap vote that closes before the electorate can react
  // (a mainnet proposal already ran at 600s). Revert-sensitive: pre-fix the
  // deadline lands created_at + 1; post-fix it is floored UP to the default.
  const { proposal, res } = await createProposal(w, governance, proposer, { nonce: 17, votingPeriod: 1 });
  expectOk(res, "create proposal with a tiny custom voting period");
  const p = decode(w.svm, "Proposal", proposal);
  assert.equal(
    BigInt(p.voting_deadline.toString()) - BigInt(p.created_at.toString()),
    86_400n,
    "custom period floored at the governance default (pre-fix: 1s snap vote)",
  );

  // The MAX_VOTING_PERIOD cap still binds above it (floor must not defeat the cap).
  const { proposal: capped, res: cappedRes } = await createProposal(w, governance, proposer, { nonce: 19, votingPeriod: 999_999_999 });
  expectOk(cappedRes, "create proposal with an oversized custom voting period");
  const cp = decode(w.svm, "Proposal", capped);
  assert.equal(
    BigInt(cp.voting_deadline.toString()) - BigInt(cp.created_at.toString()),
    604_800n,
    "custom period still capped at MAX_VOTING_PERIOD",
  );
});

// ===========================================================================
// vote_proposal
// ===========================================================================

test("vote_proposal: records a weighted vote + updates proposal tallies", async () => {
  const w = await freshWorld({});
  // Give arbiter/voter stake real weight (max_vote_weight = min_arbiter_stake * 10).
  await setMinArbiterStake(w.svm, 1_000_000);
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });

  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { proposal } = await createProposal(w, governance, proposer, { nonce: 21 });

  // A separate voter with stake casts an approval vote.
  const voter = await registerAgent(w);
  await injectAgentStake(w.svm, voter.agent, 2_000_000);
  const { vote, res } = await voteProposal(w, proposal, voter, true);
  expectOk(res, "vote_proposal");

  const v = decode(w.svm, "GovernanceVote", vote);
  assert.equal(v.proposal.toBase58(), proposal.toBase58(), "vote.proposal wired");
  assert.equal(v.voter.toBase58(), voter.agent.toBase58(), "vote.voter == voter agent");
  assert.equal(v.approved, true, "vote recorded as approval");
  assert.ok(v.vote_weight.toString() !== "0", "vote carries non-zero weight");

  const p = decode(w.svm, "Proposal", proposal);
  assert.equal(p.total_voters, 1, "proposal.total_voters incremented");
  assert.equal(p.votes_for.toString(), v.vote_weight.toString(), "votes_for == recorded weight");
  assert.equal(p.votes_against.toString(), "0", "no against votes");
});

test("vote_proposal: voting after the deadline is rejected (ProposalVotingEnded)", async () => {
  const w = await freshWorld({});
  await setMinArbiterStake(w.svm, 1_000_000);
  const { governance } = await initGovernance(w, { votingPeriod: 86_400, minProposalStake: 1_000 });

  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { proposal } = await createProposal(w, governance, proposer, { nonce: 31 });

  // Warp past the voting deadline.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 86_400n + 100n;
  w.svm.setClock(clk);

  const voter = await registerAgent(w);
  await injectAgentStake(w.svm, voter.agent, 2_000_000);
  const { res } = await voteProposal(w, proposal, voter, true);
  expectFail(res, "ProposalVotingEnded", "vote after deadline rejected");
});

// ===========================================================================
// cancel_proposal
// ===========================================================================

test("cancel_proposal: proposer cancels an un-voted proposal -> Cancelled", async () => {
  const w = await freshWorld({});
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { proposal } = await createProposal(w, governance, proposer, { nonce: 41 });

  const res = send(
    w.svm,
    await proposer.prog.methods
      .cancelProposal()
      .accounts({ proposal, authority: proposer.kp.publicKey })
      .instruction(),
    [proposer.kp],
  );
  expectOk(res, "cancel_proposal");

  const p = decode(w.svm, "Proposal", proposal);
  assert.ok(p.status.Cancelled !== undefined, "proposal status == Cancelled");
  assert.ok(p.executed_at.toString() !== "0", "executed_at (cancel timestamp) set");
});

test("cancel_proposal: non-proposer cannot cancel (ProposalUnauthorizedCancel)", async () => {
  const w = await freshWorld({});
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { proposal } = await createProposal(w, governance, proposer, { nonce: 51 });

  // A stranger wallet (not the proposer authority) attempts to cancel.
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  const res = send(
    w.svm,
    await makeProgram(stranger).methods
      .cancelProposal()
      .accounts({ proposal, authority: stranger.publicKey })
      .instruction(),
    [stranger],
  );
  expectFail(res, "ProposalUnauthorizedCancel", "stranger cancel rejected");
});

test("cancel_proposal: cannot cancel after a vote is cast (ProposalVotingEnded)", async () => {
  const w = await freshWorld({});
  await setMinArbiterStake(w.svm, 1_000_000);
  const { governance } = await initGovernance(w, { minProposalStake: 1_000 });
  const proposer = await registerAgent(w);
  await injectAgentStake(w.svm, proposer.agent, 10_000);
  const { proposal } = await createProposal(w, governance, proposer, { nonce: 61 });

  // Cast one vote so total_voters > 0.
  const voter = await registerAgent(w);
  await injectAgentStake(w.svm, voter.agent, 2_000_000);
  expectOk((await voteProposal(w, proposal, voter, true)).res, "vote before cancel");

  const res = send(
    w.svm,
    await proposer.prog.methods
      .cancelProposal()
      .accounts({ proposal, authority: proposer.kp.publicKey })
      .instruction(),
    [proposer.kp],
  );
  expectFail(res, "ProposalVotingEnded", "cancel after vote rejected");
});
