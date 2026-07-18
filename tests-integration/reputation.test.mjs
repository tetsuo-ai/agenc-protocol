// litesvm integration tests for the reputation subsystem of agenc-coordination:
//   - stake_reputation
//   - withdraw_reputation_stake
//   - delegate_reputation
//   - revoke_delegation
//
// Mirrors the style of marketplace.test.mjs and reuses the shared harness.
// Executes the COMPILED program (target/deploy/agenc_coordination.so).
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld,
  makeProgram,
  send,
  expectOk,
  expectFail,
  decode,
  isClosed,
  pda,
  enc,
  arr,
  id32,
  deregisterRemaining,
  warpSeconds,
  coder,
  PID,
  BN,
  Keypair,
  PublicKey,
  SystemProgram,
} from "./harness.mjs";

// REPUTATION_STAKING_COOLDOWN / MIN_DELEGATION_DURATION in the program (seconds).
const REPUTATION_STAKING_COOLDOWN = 604_800n;
const MIN_DELEGATION_DURATION = 604_800n;
const MIN_DELEGATION_AMOUNT = 100;
const MAX_REPUTATION = 10000;
// P6.7: fresh agents start at the probationary reputation, not the old max-neutral 5000.
const PROBATIONARY_REPUTATION = 3000;

// Register a fresh, standalone agent (its own authority keypair) into the world.
// Returns { kp, prog, agentPda }. Fresh agents start at PROBATIONARY_REPUTATION (3000,
// P6.7) and status = Active.
async function registerAgent(w, { capabilities = 1, fund = 100e9 } = {}) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(fund));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(agentId), new BN(capabilities), "http://agent.test", null, new BN(0))
        .accounts({
          agent: agentPda,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register fresh agent",
  );
  return { kp, prog, agentPda };
}

// Flip an agent's status field in place (decode -> mutate -> re-encode). The IDL
// preserves capitalized enum variant names ({Suspended:{}}), so keep that casing.
async function setAgentStatus(svm, agentPda, variant) {
  const acct = svm.getAccount(agentPda);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  agent.status = { [variant]: {} };
  const data = await coder.accounts.encode("AgentRegistration", agent);
  svm.setAccount(agentPda, {
    lamports: Number(acct.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

const repStakePda = (agentPda) => pda([enc("reputation_stake"), agentPda.toBuffer()])[0];
const delegationPda = (delegator, delegatee) =>
  pda([enc("reputation_delegation"), delegator.toBuffer(), delegatee.toBuffer()])[0];

const lamports = (svm, addr) => {
  const a = svm.getAccount(addr);
  return a ? BigInt(a.lamports) : 0n;
};

// ---------------------------------------------------------------------------
// stake_reputation
// ---------------------------------------------------------------------------

test("stake_reputation: stakes SOL, records staked_amount + lock, moves lamports", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);
  const amount = 5_000_000;

  const authBefore = lamports(w.svm, kp.publicKey);
  const stakeBefore = lamports(w.svm, stakePda); // 0 — account does not exist yet

  expectOk(
    send(
      w.svm,
      await prog.methods
        .stakeReputation(new BN(amount))
        .accounts({
          authority: kp.publicKey,
          agent: agentPda,
          reputationStake: stakePda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "stake_reputation",
  );

  // State: stake account now bound to agent with the staked amount + lock set.
  const stake = decode(w.svm, "ReputationStake", stakePda);
  assert.equal(stake.agent.toBase58(), agentPda.toBase58(), "stake.agent bound to agent");
  assert.equal(Number(stake.staked_amount), amount, "staked_amount recorded");
  const clk = w.svm.getClock();
  assert.equal(
    BigInt(stake.locked_until.toString()),
    clk.unixTimestamp + REPUTATION_STAKING_COOLDOWN,
    "locked_until = now + cooldown",
  );

  // Lamports: the staked amount lands on the PDA, and the payer drops by at least it.
  const stakeAfter = lamports(w.svm, stakePda);
  const authAfter = lamports(w.svm, kp.publicKey);
  assert.ok(stakeAfter >= stakeBefore + BigInt(amount), "PDA gained >= staked amount (incl. rent)");
  assert.ok(authBefore - authAfter >= BigInt(amount), "authority lost >= staked amount");
});

test("stake_reputation: second stake accumulates staked_amount", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);

  const stakeIx = async (amt) =>
    prog.methods
      .stakeReputation(new BN(amt))
      .accounts({
        authority: kp.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

  expectOk(send(w.svm, await stakeIx(3_000_000), [kp]), "stake #1");
  expectOk(send(w.svm, await stakeIx(2_000_000), [kp]), "stake #2");

  const stake = decode(w.svm, "ReputationStake", stakePda);
  assert.equal(Number(stake.staked_amount), 5_000_000, "staked_amount accumulated across calls");
});

test("deregister_agent: blocked while reputation stake is live; allowed after full withdrawal (audit: strand + re-registration theft)", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);

  expectOk(
    send(w.svm, await prog.methods.stakeReputation(new BN(4_000_000))
      .accounts({ authority: kp.publicKey, agent: agentPda, reputationStake: stakePda, systemProgram: SystemProgram.programId })
      .instruction(), [kp]),
    "stake",
  );

  const deregIx = async () => prog.methods.deregisterAgent()
    .accounts({ agent: agentPda, protocolConfig: w.protocolPda, reputationStake: stakePda, authority: kp.publicKey })
    .remainingAccounts(deregisterRemaining(agentPda))
    .instruction();

  // Revert-sensitive: with a live stake, deregistration is refused. Drop the
  // staked_amount == 0 guard in deregister_agent and this stops failing — re-opening the
  // stranded-SOL + re-registration-theft path the audit flagged.
  expectFail(send(w.svm, await deregIx(), [kp]), "ReputationStakeNotWithdrawn", "deregister blocked while staked");

  // Warp past the staking cooldown and withdraw the full stake.
  const clk = w.svm.getClock(); clk.unixTimestamp = clk.unixTimestamp + REPUTATION_STAKING_COOLDOWN + 1n; w.svm.setClock(clk);
  expectOk(
    send(w.svm, await prog.methods.withdrawReputationStake(new BN(4_000_000))
      .accounts({ authority: kp.publicKey, agent: agentPda, reputationStake: stakePda })
      .instruction(), [kp]),
    "withdraw full stake",
  );

  // With the stake withdrawn (staked_amount == 0), deregistration now succeeds.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await deregIx(), [kp]), "deregister after withdrawal");
  assert.ok(isClosed(w.svm, agentPda), "agent PDA closed");
});

test("stake_reputation: amount=0 rejected (ReputationStakeAmountTooLow)", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);

  const res = send(
    w.svm,
    await prog.methods
      .stakeReputation(new BN(0))
      .accounts({
        authority: kp.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [kp],
  );
  expectFail(res, "ReputationStakeAmountTooLow", "stake zero amount");
});

test("stake_reputation: wrong authority rejected (UnauthorizedAgent)", async () => {
  const w = await freshWorld();
  const { agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);

  // A different keypair tries to stake on someone else's agent.
  const intruder = Keypair.generate();
  w.svm.airdrop(intruder.publicKey, BigInt(100e9));
  const intruderProg = makeProgram(intruder);

  const res = send(
    w.svm,
    await intruderProg.methods
      .stakeReputation(new BN(1_000_000))
      .accounts({
        authority: intruder.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [intruder],
  );
  expectFail(res, "UnauthorizedAgent", "stake by non-authority");
});

test("stake_reputation: non-active agent rejected (ReputationAgentNotActive)", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);

  await setAgentStatus(w.svm, agentPda, "Suspended");

  const res = send(
    w.svm,
    await prog.methods
      .stakeReputation(new BN(1_000_000))
      .accounts({
        authority: kp.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [kp],
  );
  expectFail(res, "ReputationAgentNotActive", "stake on suspended agent");
});

// ---------------------------------------------------------------------------
// withdraw_reputation_stake
// ---------------------------------------------------------------------------

// Stake then warp past the cooldown — shared setup for withdraw tests.
async function setupStakedAgent(w, amount = 5_000_000) {
  const { kp, prog, agentPda } = await registerAgent(w);
  const stakePda = repStakePda(agentPda);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .stakeReputation(new BN(amount))
        .accounts({
          authority: kp.publicKey,
          agent: agentPda,
          reputationStake: stakePda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "stake for withdraw setup",
  );
  return { kp, prog, agentPda, stakePda };
}

test("withdraw_reputation_stake: after cooldown returns lamports + reduces staked_amount", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda, stakePda } = await setupStakedAgent(w, 5_000_000);

  // Warp past the staking cooldown so the lock has expired.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + REPUTATION_STAKING_COOLDOWN + 1n;
  w.svm.setClock(clk);

  const withdrawAmt = 2_000_000;
  const authBefore = lamports(w.svm, kp.publicKey);
  const pdaBefore = lamports(w.svm, stakePda);
  const stakedBefore = Number(decode(w.svm, "ReputationStake", stakePda).staked_amount);

  expectOk(
    send(
      w.svm,
      await prog.methods
        .withdrawReputationStake(new BN(withdrawAmt))
        .accounts({
          authority: kp.publicKey,
          agent: agentPda,
          reputationStake: stakePda,
        })
        .instruction(),
      [kp],
    ),
    "withdraw_reputation_stake",
  );

  const staked = decode(w.svm, "ReputationStake", stakePda);
  assert.equal(Number(staked.staked_amount), stakedBefore - withdrawAmt, "staked_amount reduced");

  const authAfter = lamports(w.svm, kp.publicKey);
  const pdaAfter = lamports(w.svm, stakePda);
  // The PDA-side movement is exact: it loses precisely the withdrawn amount.
  assert.equal(pdaBefore - pdaAfter, BigInt(withdrawAmt), "PDA lamports dropped by withdrawn amount");
  // The authority is also the fee payer, so its net gain is (withdrawn - tx fee).
  // Assert it gained nearly the full amount (within a small fee margin) and net-positive.
  const authGain = authAfter - authBefore;
  assert.ok(authGain > 0n, "authority net lamports increased");
  assert.ok(
    BigInt(withdrawAmt) - authGain <= 10_000n,
    `authority gained ~withdrawn amount (gain=${authGain}, withdrawn=${withdrawAmt})`,
  );
});

test("withdraw_reputation_stake: locked before cooldown rejected (ReputationStakeLocked)", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda, stakePda } = await setupStakedAgent(w, 5_000_000);

  // No time warp — locked_until is still in the future.
  const res = send(
    w.svm,
    await prog.methods
      .withdrawReputationStake(new BN(1_000_000))
      .accounts({
        authority: kp.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
      })
      .instruction(),
    [kp],
  );
  expectFail(res, "ReputationStakeLocked", "withdraw while locked");
});

test("withdraw_reputation_stake: over-balance rejected (ReputationStakeInsufficientBalance)", async () => {
  const w = await freshWorld();
  const { kp, prog, agentPda, stakePda } = await setupStakedAgent(w, 1_000_000);

  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + REPUTATION_STAKING_COOLDOWN + 1n;
  w.svm.setClock(clk);

  const res = send(
    w.svm,
    await prog.methods
      .withdrawReputationStake(new BN(5_000_000)) // more than the 1_000_000 staked
      .accounts({
        authority: kp.publicKey,
        agent: agentPda,
        reputationStake: stakePda,
      })
      .instruction(),
    [kp],
  );
  expectFail(res, "ReputationStakeInsufficientBalance", "withdraw more than staked");
});

// ---------------------------------------------------------------------------
// delegate_reputation
// ---------------------------------------------------------------------------

test("delegate_reputation: creates delegation account + debits delegator reputation", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  // The registration must be strictly older than the delegation (audit gate).
  warpSeconds(w.svm, 2);

  const repBefore = decode(w.svm, "AgentRegistration", delegator.agentPda).reputation; // 3000 (P6.7)
  const amount = 1000;

  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .delegateReputation(amount, new BN(0)) // expires_at = 0 (no expiry)
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegateeAgent: delegatee.agentPda,
          delegation: delPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "delegate_reputation",
  );

  const del = decode(w.svm, "ReputationDelegation", delPda);
  assert.equal(del.delegator.toBase58(), delegator.agentPda.toBase58(), "delegation.delegator set");
  assert.equal(del.delegatee.toBase58(), delegatee.agentPda.toBase58(), "delegation.delegatee set");
  assert.equal(del.amount, amount, "delegation.amount recorded");
  assert.equal(Number(del.expires_at), 0, "delegation.expires_at = 0 (no expiry)");

  const repAfter = decode(w.svm, "AgentRegistration", delegator.agentPda).reputation;
  assert.equal(repAfter, repBefore - amount, "delegator reputation debited by delegated amount");
});

test("delegate_reputation: self-delegation rejected (ReputationCannotDelegateSelf)", async () => {
  const w = await freshWorld();
  const a = await registerAgent(w);
  // delegatee == delegator -> account constraint fails before handler runs.
  const delPda = delegationPda(a.agentPda, a.agentPda);

  const res = send(
    w.svm,
    await a.prog.methods
      .delegateReputation(500, new BN(0))
      .accounts({
        authority: a.kp.publicKey,
        delegatorAgent: a.agentPda,
        delegateeAgent: a.agentPda,
        delegation: delPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [a.kp],
  );
  expectFail(res, "ReputationCannotDelegateSelf", "self delegation");
});

test("delegate_reputation: amount below minimum rejected (ReputationDelegationAmountInvalid)", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  warpSeconds(w.svm, 2); // registration-age gate (audit)

  const res = send(
    w.svm,
    await delegator.prog.methods
      .delegateReputation(MIN_DELEGATION_AMOUNT - 1, new BN(0)) // 99 < MIN(100)
      .accounts({
        authority: delegator.kp.publicKey,
        delegatorAgent: delegator.agentPda,
        delegateeAgent: delegatee.agentPda,
        delegation: delPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [delegator.kp],
  );
  expectFail(res, "ReputationDelegationAmountInvalid", "delegate below minimum");
});

test("delegate_reputation: past expiry rejected (ReputationDelegationExpired)", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  warpSeconds(w.svm, 2); // registration-age gate (audit)

  const past = w.svm.getClock().unixTimestamp - 100n; // in the past, non-zero

  const res = send(
    w.svm,
    await delegator.prog.methods
      .delegateReputation(500, new BN(past.toString()))
      .accounts({
        authority: delegator.kp.publicKey,
        delegatorAgent: delegator.agentPda,
        delegateeAgent: delegatee.agentPda,
        delegation: delPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [delegator.kp],
  );
  expectFail(res, "ReputationDelegationExpired", "delegate with past expiry");
});

// ---------------------------------------------------------------------------
// revoke_delegation
// ---------------------------------------------------------------------------

// Create an active delegation between two fresh agents.
async function setupDelegation(w, amount = 1000) {
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  warpSeconds(w.svm, 2); // registration-age gate (audit)
  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .delegateReputation(amount, new BN(0))
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegateeAgent: delegatee.agentPda,
          delegation: delPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "delegate for revoke setup",
  );
  return { delegator, delegatee, delPda, amount };
}

test("revoke_delegation: after min duration closes account + restores reputation", async () => {
  const w = await freshWorld();
  const { delegator, delPda, amount } = await setupDelegation(w, 1000);

  // P6.7: fresh agents now start at PROBATIONARY_REPUTATION (3000), not 5000, so after
  // delegating `amount` the delegator holds 3000 - amount.
  const repAfterDelegate = decode(w.svm, "AgentRegistration", delegator.agentPda).reputation; // 3000-1000
  assert.equal(
    repAfterDelegate,
    PROBATIONARY_REPUTATION - amount,
    "reputation debited on delegate (precondition)",
  );

  // Warp past the minimum delegation duration so revoke is allowed.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + MIN_DELEGATION_DURATION + 1n;
  w.svm.setClock(clk);

  const authBefore = lamports(w.svm, delegator.kp.publicKey);
  const rentReclaimed = lamports(w.svm, delPda); // closed -> refunded to authority

  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .revokeDelegation()
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegation: delPda,
        })
        .instruction(),
      [delegator.kp],
    ),
    "revoke_delegation",
  );

  // Account closed (close = authority).
  assert.ok(isClosed(w.svm, delPda), "delegation account closed");

  // Reputation restored back to the delegator.
  const repAfterRevoke = decode(w.svm, "AgentRegistration", delegator.agentPda).reputation;
  assert.equal(repAfterRevoke, repAfterDelegate + amount, "reputation restored on revoke");

  // Rent refunded to the authority (closed account lamports go to authority).
  const authAfter = lamports(w.svm, delegator.kp.publicKey);
  assert.ok(authAfter > authBefore, "authority reclaimed rent from closed account");
  assert.ok(rentReclaimed > 0n, "delegation account held rent before close");
});

test("revoke_delegation: before min duration rejected (DelegationCooldownNotElapsed)", async () => {
  const w = await freshWorld();
  const { delegator, delPda } = await setupDelegation(w, 1000);

  // No time warp — delegation is younger than MIN_DELEGATION_DURATION.
  const res = send(
    w.svm,
    await delegator.prog.methods
      .revokeDelegation()
      .accounts({
        authority: delegator.kp.publicKey,
        delegatorAgent: delegator.agentPda,
        delegation: delPda,
      })
      .instruction(),
    [delegator.kp],
  );
  expectFail(res, "DelegationCooldownNotElapsed", "revoke before cooldown elapsed");
});

test("revoke_delegation: wrong authority rejected (UnauthorizedAgent)", async () => {
  const w = await freshWorld();
  const { delegator, delPda } = await setupDelegation(w, 1000);

  // Warp past cooldown so the only thing wrong is the signer.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + MIN_DELEGATION_DURATION + 1n;
  w.svm.setClock(clk);

  const intruder = Keypair.generate();
  w.svm.airdrop(intruder.publicKey, BigInt(100e9));
  const intruderProg = makeProgram(intruder);

  const res = send(
    w.svm,
    await intruderProg.methods
      .revokeDelegation()
      .accounts({
        authority: intruder.publicKey,
        delegatorAgent: delegator.agentPda, // not the intruder's agent
        delegation: delPda,
      })
      .instruction(),
    [intruder],
  );
  expectFail(res, "UnauthorizedAgent", "revoke by non-authority");
});
