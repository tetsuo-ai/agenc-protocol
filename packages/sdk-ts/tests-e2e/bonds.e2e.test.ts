import { describe, it, expect } from "vitest";
import {
  facade,
  fetchTaskGuarantee,
  findCompletionBondPda,
  getCompletionBondDecoder,
  getTaskDecoder,
  TaskStatus,
} from "../src/index.js";
import { GpaSimulator } from "./gpa-sim.js";
import type { Address, KeyPairSigner } from "@solana/kit";
import { LiteSVM } from "litesvm";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
  accountData,
} from "./harness.js";

// REAL on-chain execution of the completion-bond lifecycle. Each test drives the
// COMPILED program in litesvm with SDK-built (@solana/kit) instructions and real
// signatures, then decodes the resulting on-chain CompletionBond / Task accounts
// with the SDK's own decoders. This is a faithful @solana/kit port of the
// web3.js/anchor bond tests in tests-integration/marketplace.test.mjs:
//   - "creator + worker each post a 25% bond into distinct PDAs"
//   - "a clean completion refunds BOTH bonds to their posters"
//   - "cancel refunds the creator bond on an Open task"
//   - "reclaim_completion_bond recovers a bond stranded by an omitted account"
//
// Bonds require an Auto task (constraint_hash == 0) that is claimed and settled via
// complete_task. The flow is: register creator+worker agents -> create_task ->
// record_task_moderation (CLEAN) -> set_task_job_spec -> claim_task_with_job_spec.
// Then bonds are posted (InProgress) and settled (complete / cancel / reclaim).
//
// NOT portable via the current SDK facade: the expire_claim no-show forfeit. The
// generated expireClaim builder ALWAYS derives + includes the optional
// task_validation_config AND task_submission accounts; a pure no-show (InProgress,
// no submission, Auto = no validation config) has neither account on-chain, and
// Anchor rejects the passed-but-uninitialized optional accounts
// (AccountNotInitialized, 0xbc4). The cancel-on-Open test below proves the same
// bond-settlement-on-close edge through a path the facade can express.

const REWARD = 4_000_000n;
const BOND = (REWARD * 2500n) / 10_000n; // symmetric 25% bond (BOND_BPS=2500)

/** Lamport balance as a non-null bigint (litesvm getBalance returns Lamports | null). */
function bal(svm: LiteSVM, addr: Address): bigint {
  const b = svm.getBalance(addr);
  if (b === null) throw new Error(`no balance for ${addr}`);
  return b;
}

interface BondWorld {
  svm: LiteSVM;
  admin: KeyPairSigner;
  moderator: KeyPairSigner;
  creator: KeyPairSigner;
  worker: KeyPairSigner;
  workerAgent: Address;
  task: Address;
  jobSpecHash: Uint8Array;
}

/**
 * Build a fresh world driven entirely through SDK facade instructions, leaving an
 * Auto task in InProgress (claimed) — the exact state where bonds are posted.
 * Mirrors runAutoSettlement(stopBeforeComplete) from the reference harness.
 */
async function claimedAutoTask(salt: number): Promise<BondWorld> {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  const moderator = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address);
  await seedModerationConfig(svm, admin.address, moderator.address, true);

  const creator = await fundedSigner(svm);
  const worker = await fundedSigner(svm);

  // 1) register creator + worker agents (claim's `worker` is the AgentRegistration PDA;
  //    create_task's `creatorAgent` is the creator's AgentRegistration PDA).
  const creatorAgentId = new Uint8Array(32).fill(salt);
  const workerAgentId = new Uint8Array(32).fill(salt + 1);
  await send(svm, creator, [
    await facade.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  const [creatorAgent] = await facade.findAgentPda({ agentId: creatorAgentId });
  await send(svm, worker, [
    await facade.registerAgent({
      authority: worker,
      agentId: workerAgentId,
      capabilities: 1n,
      endpoint: "http://worker.test",
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  const [workerAgent] = await facade.findAgentPda({ agentId: workerAgentId });

  // 2) create an Auto task (constraintHash null => complete_task settlement path).
  const taskId = new Uint8Array(32).fill(salt + 2);
  const description = new Uint8Array(64).fill(salt + 3, 0, 32);
  const now = svm.getClock().unixTimestamp;
  await send(svm, creator, [
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 1n,
      description,
      rewardAmount: REWARD,
      maxWorkers: 1,
      deadline: now + 3600n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    }),
  ]);
  const [task] = await facade.findTaskPda({
    creator: creator.address,
    taskId,
  });

  // 3) moderator records a CLEAN attestation for (task, jobSpecHash).
  const jobSpecHash = new Uint8Array(32).fill(salt + 4);
  await send(svm, moderator, [
    await facade.recordTaskModeration({
      moderator,
      task,
      jobSpecHash,
      status: 0, // CLEAN
      riskScore: 0,
      categoryMask: 0n,
      policyHash: new Uint8Array(32).fill(1),
      scannerHash: new Uint8Array(32).fill(2),
      expiresAt: 0n,
    }),
  ]);

  // 4) creator pins (publishes) the job spec (moderation-gated). P1.2: the creator
  //    names the moderator whose v2 record the gate consumes (the global authority).
  await send(svm, creator, [
    await facade.setTaskJobSpec({
      creator,
      task,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/bond-e2e",
      moderator: moderator.address,
    }),
  ]);

  // 5) worker claims the published task -> InProgress.
  await send(svm, worker, [
    await facade.claimTaskWithJobSpec({
      authority: worker,
      worker: workerAgent,
      task,
    }),
  ]);

  return { svm, admin, moderator, creator, worker, workerAgent, task, jobSpecHash };
}

interface OpenWorld {
  svm: LiteSVM;
  admin: KeyPairSigner;
  creator: KeyPairSigner;
  task: Address;
  escrow: Address;
}

/**
 * Build a fresh world with an Open (unclaimed) Auto task — the state in which the
 * creator may post a bond and then cancel for a refund. No moderation / job-spec /
 * claim needed: cancel_task on an Open task only touches task + escrow + bond.
 */
async function openAutoTask(salt: number): Promise<OpenWorld> {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address);

  const creator = await fundedSigner(svm);
  const creatorAgentId = new Uint8Array(32).fill(salt);
  await send(svm, creator, [
    await facade.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  const [creatorAgent] = await facade.findAgentPda({ agentId: creatorAgentId });

  const taskId = new Uint8Array(32).fill(salt + 2);
  const description = new Uint8Array(64).fill(salt + 3, 0, 32);
  const now = svm.getClock().unixTimestamp;
  await send(svm, creator, [
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 1n,
      description,
      rewardAmount: REWARD,
      maxWorkers: 1,
      deadline: now + 3600n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    }),
  ]);
  const [task] = await facade.findTaskPda({ creator: creator.address, taskId });
  const [escrow] = await facade.findEscrowPda({ task });

  return { svm, admin, creator, task, escrow };
}

describe("e2e: completion-bond lifecycle executes on the real program", () => {
  it("creator + worker post 25% bonds into distinct on-chain PDAs", async () => {
    const w = await claimedAutoTask(10);

    // creator posts the role-0 bond; worker posts the role-1 bond. The bond PDA is
    // auto-derived from (task, signing wallet) by the facade.
    await send(w.svm, w.creator, [
      await facade.postCompletionBond({ authority: w.creator, task: w.task, role: 0 }),
    ]);
    await send(w.svm, w.worker, [
      await facade.postCompletionBond({ authority: w.worker, task: w.task, role: 1 }),
    ]);

    const [creatorBond] = await findCompletionBondPda({
      task: w.task,
      party: w.creator.address,
    });
    const [workerBond] = await findCompletionBondPda({
      task: w.task,
      party: w.worker.address,
    });

    // ON-CHAIN ASSERT: both bond accounts exist and decode with the SDK decoder.
    const cData = accountData(w.svm, creatorBond);
    const wData = accountData(w.svm, workerBond);
    expect(cData).not.toBeNull();
    expect(wData).not.toBeNull();

    const cb = getCompletionBondDecoder().decode(cData!);
    const wb = getCompletionBondDecoder().decode(wData!);
    expect(cb.role).toBe(0);
    expect(cb.party).toBe(w.creator.address);
    expect(cb.task).toBe(w.task);
    expect(cb.amount).toBe(BOND); // 25% of the 4,000,000 reward
    expect(cb.bondMint.__option).toBe("None"); // SOL bond (no mint) in v1
    expect(wb.role).toBe(1);
    expect(wb.party).toBe(w.worker.address);
    expect(wb.amount).toBe(BOND);

    // the bond PDA actually holds the principal (>= 1,000,000 lamports on top of rent).
    expect(bal(w.svm, creatorBond)).toBeGreaterThanOrEqual(BOND);
    expect(bal(w.svm, workerBond)).toBeGreaterThanOrEqual(BOND);
  });

  it("a clean completion refunds BOTH bonds to their posters (PDAs closed)", async () => {
    const w = await claimedAutoTask(20);

    await send(w.svm, w.creator, [
      await facade.postCompletionBond({ authority: w.creator, task: w.task, role: 0 }),
    ]);
    await send(w.svm, w.worker, [
      await facade.postCompletionBond({ authority: w.worker, task: w.task, role: 1 }),
    ]);

    const [creatorBond] = await findCompletionBondPda({
      task: w.task,
      party: w.creator.address,
    });
    const [workerBond] = await findCompletionBondPda({
      task: w.task,
      party: w.worker.address,
    });
    expect(accountData(w.svm, creatorBond)).not.toBeNull();
    expect(accountData(w.svm, workerBond)).not.toBeNull();

    const creatorBondLamports = bal(w.svm, creatorBond);
    const creatorBefore = bal(w.svm, w.creator.address);

    // worker completes on the direct-pay path, passing BOTH bonds so they settle.
    // hireRecord auto-derives to the empty ["hire", task] PDA (non-hired Auto task).
    await send(w.svm, w.worker, [
      await facade.completeTask({
        authority: w.worker,
        task: w.task,
        creator: w.creator.address,
        worker: w.workerAgent,
        treasury: w.admin.address,
        creatorCompletionBond: creatorBond,
        workerCompletionBond: workerBond,
        proofHash: new Uint8Array(32).fill(7),
        resultData: null,
      }),
    ]);

    // ON-CHAIN ASSERT: task reached Completed; both bonds refunded + closed.
    const taskData = accountData(w.svm, w.task);
    expect(taskData).not.toBeNull();
    expect(getTaskDecoder().decode(taskData!).status).toBe(TaskStatus.Completed);
    expect(accountData(w.svm, creatorBond)).toBeNull(); // closed
    expect(accountData(w.svm, workerBond)).toBeNull(); // closed

    // creator (not a signer here) gets back the full creator bond (rent + principal).
    const creatorDelta = bal(w.svm, w.creator.address) - creatorBefore;
    expect(creatorDelta).toBeGreaterThanOrEqual(creatorBondLamports);
  });

  it("cancel_task settles (refunds + closes) the creator bond on an Open task", async () => {
    // The other settlement edge of the bond lifecycle: a posted bond that is
    // unwound when the task is cancelled before any work. Mirrors the reference
    // "cancel refunds the creator bond on an Open task". (The no-show expire_claim
    // forfeit is recorded in blockers — the SDK builder cannot express it; see below.)
    const w = await openAutoTask(30);

    // creator posts the role-0 bond on the Open task.
    await send(w.svm, w.creator, [
      await facade.postCompletionBond({ authority: w.creator, task: w.task, role: 0 }),
    ]);
    const [creatorBond] = await findCompletionBondPda({
      task: w.task,
      party: w.creator.address,
    });
    const bondData = accountData(w.svm, creatorBond);
    expect(bondData).not.toBeNull();
    const decoded = getCompletionBondDecoder().decode(bondData!);
    expect(decoded.role).toBe(0);
    expect(decoded.amount).toBe(BOND);

    const creatorBefore = bal(w.svm, w.creator.address);
    const bondLamports = bal(w.svm, creatorBond);

    // creator cancels the Open task, passing the bond so settle_completion_bond
    // refunds + closes it (cancelTask only includes the bond when supplied).
    await send(w.svm, w.creator, [
      await facade.cancelTask({
        authority: w.creator,
        task: w.task,
        escrow: w.escrow,
        creatorCompletionBond: creatorBond,
      }),
    ]);

    // ON-CHAIN ASSERT: task Cancelled; bond refunded + closed; creator recovered it.
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(
      TaskStatus.Cancelled,
    );
    expect(accountData(w.svm, creatorBond)).toBeNull(); // refunded + closed
    // creator is the fee-payer; delta = bond (rent + principal) + escrow rent - tx fee.
    const creatorDelta = bal(w.svm, w.creator.address) - creatorBefore;
    expect(creatorDelta).toBeGreaterThan(bondLamports - 50_000n);
  });

  it("complete_task FORCE-settles the worker bond (audit F12: strand is structurally impossible)", async () => {
    // Audit F12: the completion-bond accounts on complete_task are now REQUIRED +
    // canonical-PDA-pinned, and the generated builder auto-derives them — so a worker bond
    // can NO LONGER be left live on a Completed task (which close_task would then strand).
    const w = await claimedAutoTask(40);

    await send(w.svm, w.worker, [
      await facade.postCompletionBond({ authority: w.worker, task: w.task, role: 1 }),
    ]);
    const [workerBond] = await findCompletionBondPda({
      task: w.task,
      party: w.worker.address,
    });
    expect(accountData(w.svm, workerBond)).not.toBeNull();
    const workerBefore = bal(w.svm, w.worker.address);
    const bondLamports = bal(w.svm, workerBond);

    // complete the task — the required worker bond is auto-derived + force-refunded.
    await send(w.svm, w.worker, [
      await facade.completeTask({
        authority: w.worker,
        task: w.task,
        creator: w.creator.address,
        worker: w.workerAgent,
        treasury: w.admin.address,
        proofHash: new Uint8Array(32).fill(9),
        resultData: null,
      }),
    ]);
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(
      TaskStatus.Completed,
    );

    // ON-CHAIN ASSERT: the bond was force-refunded at completion (NOT stranded), and the
    // worker recovered rent + principal. close_task can then never meet a live bond here.
    expect(accountData(w.svm, workerBond)).toBeNull();
    const workerDelta = bal(w.svm, w.worker.address) - workerBefore;
    expect(workerDelta).toBeGreaterThan(bondLamports - 50_000n);
  });

  it("fetchTaskGuarantee (WP-H3): guaranteed:true while the worker bond is live, resolved after settlement", async () => {
    // The Guaranteed Hire read helper against REAL on-chain state: post the
    // worker bond -> the task reads as guaranteed (decoded 25% amount + party),
    // settle via complete_task -> the bond PDA is closed and the same read
    // reports the guarantee resolved (guaranteed:false, no live bonds).
    const w = await claimedAutoTask(50);
    const gpa = new GpaSimulator(w.svm);
    const [workerBond] = await findCompletionBondPda({
      task: w.task,
      party: w.worker.address,
    });
    gpa.register(w.task, workerBond);

    // Before any bond: not guaranteed.
    const before = await fetchTaskGuarantee(gpa, w.task);
    expect(before.guaranteed).toBe(false);
    expect(before.workerBond).toBeNull();

    // Worker posts the role-1 bond -> guaranteed, with the on-chain 25% stake.
    await send(w.svm, w.worker, [
      await facade.postCompletionBond({ authority: w.worker, task: w.task, role: 1 }),
    ]);
    const live = await fetchTaskGuarantee(gpa, w.task);
    expect(live.guaranteed).toBe(true);
    expect(live.workerBond?.address).toBe(workerBond);
    expect(live.workerBond?.account.amount).toBe(BOND);
    expect(live.workerBond?.account.party).toBe(w.worker.address);
    expect(live.creatorBond).toBeNull();

    // Settlement (complete_task force-settles the bond) resolves the guarantee.
    await send(w.svm, w.worker, [
      await facade.completeTask({
        authority: w.worker,
        task: w.task,
        creator: w.creator.address,
        worker: w.workerAgent,
        treasury: w.admin.address,
        proofHash: new Uint8Array(32).fill(11),
        resultData: null,
      }),
    ]);
    expect(getTaskDecoder().decode(accountData(w.svm, w.task)!).status).toBe(
      TaskStatus.Completed,
    );
    const settled = await fetchTaskGuarantee(gpa, w.task);
    expect(settled.guaranteed).toBe(false);
    expect(settled.workerBond).toBeNull();
    expect(settled.creatorBond).toBeNull();
  });
});
