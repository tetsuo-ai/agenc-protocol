// REAL on-chain execution of the P1.2 hardened-open-roster surface through the
// SDK facade: permissionless attestor registration (bond deposit), a roster
// attestor recording a v2 moderator-keyed attestation, the creator consuming it
// through set_task_job_spec's roster path (`moderatorIsAttestor`), the two-step
// bonded exit (request -> cooldown -> finalize with full refund), and the
// multisig-gated BLOCK floor (set_moderation_block hard-rejects a pin, clear
// re-opens it). Runs the actual compiled program in litesvm — real signatures,
// decoded on-chain state.
import { describe, it, expect } from "vitest";
import { lamports, type Address, type KeyPairSigner } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import {
  facade,
  findModerationAttestorPda,
  findModerationBlockPda,
  findProtocolConfigPda,
  findTaskJobSpecPda,
  getModerationAttestorDecoder,
  getModerationBlockDecoder,
  getProtocolConfigEncoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  accountData,
  send,
} from "./harness.js";

// Hardcoded program constants (P1.2 spec §4.2/§4.5 — deliberately NOT config dials).
const REGISTRATION_BOND_LAMPORTS = 250_000_000n; // 0.25 SOL
const ATTESTOR_EXIT_COOLDOWN = 604_800n; // 7 days

function bal(svm: LiteSVM, addr: Address): bigint {
  const b = svm.getBalance(addr);
  if (b === null) throw new Error(`no balance for ${addr}`);
  return b;
}

function advanceClockBy(svm: LiteSVM, seconds: bigint): void {
  const clock = svm.getClock();
  clock.unixTimestamp = clock.unixTimestamp + seconds;
  svm.setClock(clock);
}

/**
 * Re-seed ProtocolConfig with a REAL 2-of-3 multisig (the harness default seeds
 * threshold 0, which `require_multisig_threshold` rejects). Mirrors the harness
 * `seedProtocolConfig` field-for-field otherwise.
 */
async function seedProtocolConfigWithMultisig(
  svm: LiteSVM,
  admin: Address,
  owners: [Address, Address, Address],
): Promise<Address> {
  const [pda, bump] = await findProtocolConfigPda();
  const DEFAULT_ADDR = "11111111111111111111111111111111" as Address;
  const data = getProtocolConfigEncoder().encode({
    authority: admin,
    treasury: admin,
    disputeThreshold: 50,
    protocolFeeBps: 100,
    minArbiterStake: 0n,
    minAgentStake: 0n,
    maxClaimDuration: 604800n,
    maxDisputeDuration: 604800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: 2,
    multisigOwnersLen: 3,
    taskCreationCooldown: 0n,
    maxTasksPer24h: 0,
    disputeInitiationCooldown: 0n,
    maxDisputesPer24h: 0,
    minStakeForDispute: 0n,
    slashPercentage: 50,
    stateUpdateCooldown: 0n,
    votingPeriod: 86400n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused: false,
    disabledTaskTypeMask: 0,
    surfaceRevision: 1,
    multisigOwners: [...owners, DEFAULT_ADDR, DEFAULT_ADDR],
  });
  svm.setAccount({
    address: pda,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
  return pda;
}

/** Register an agent + create an Auto task; returns the task PDA. */
async function createOpenTask(
  svm: LiteSVM,
  creator: KeyPairSigner,
  salt: number,
): Promise<Address> {
  const agentId = new Uint8Array(32).fill(salt);
  await send(svm, creator, [
    await facade.registerAgent({
      authority: creator,
      agentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  const [creatorAgent] = await facade.findAgentPda({ agentId });
  const taskId = new Uint8Array(32).fill(salt + 1);
  const now = svm.getClock().unixTimestamp;
  await send(svm, creator, [
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 1n,
      description: new Uint8Array(64).fill(salt + 2, 0, 32),
      rewardAmount: 1_000_000n,
      maxWorkers: 1,
      deadline: now + 3600n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    }),
  ]);
  const [task] = await facade.findTaskPda({ creator: creator.address, taskId });
  return task;
}

const CLEAN = {
  status: 0,
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32).fill(1),
  scannerHash: new Uint8Array(32).fill(2),
  expiresAt: 0n,
} as const;

describe("e2e: P1.2 open roster — register, attest, consume, bonded exit", () => {
  it("drives self-registration -> v2 roster attestation -> setTaskJobSpec roster path -> exit refund on-chain", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm); // global moderation authority (NOT the roster attestor)
    const attestor = await fundedSigner(svm); // permissionless self-registrant
    const creator = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    // 1) PERMISSIONLESS self-registration: no authority signature anywhere; the
    //    attestor pays rent + the 0.25 SOL bond onto its own roster PDA.
    const attestorBalBeforeRegister = bal(svm, attestor.address);
    await send(svm, attestor, [
      await facade.registerModerationAttestor({ attestor }),
    ]);
    const [rosterPda] = await findModerationAttestorPda({
      attestor: attestor.address,
    });
    const entry = getModerationAttestorDecoder().decode(
      accountData(svm, rosterPda)!,
    );
    expect(entry.attestor).toBe(attestor.address);
    expect(entry.assignedBy).toBe(attestor.address); // self-registered marker
    expect(entry.bondLamports).toBe(REGISTRATION_BOND_LAMPORTS);
    expect(entry.exitAt).toBe(0n);
    expect(entry.registeredAt).toBeGreaterThan(0n);
    expect(bal(svm, rosterPda)).toBeGreaterThanOrEqual(
      REGISTRATION_BOND_LAMPORTS,
    );
    expect(
      attestorBalBeforeRegister - bal(svm, attestor.address),
    ).toBeGreaterThanOrEqual(REGISTRATION_BOND_LAMPORTS);

    // 2) The roster attestor records a CLEAN v2 (moderator-keyed) task attestation.
    //    Non-global-authority moderators must present their roster entry.
    const task = await createOpenTask(svm, creator, 30);
    const jobSpecHash = new Uint8Array(32).fill(33);
    await send(svm, attestor, [
      await facade.recordTaskModeration({
        moderator: attestor,
        task,
        jobSpecHash,
        moderationAttestor: rosterPda,
        ...CLEAN,
      }),
    ]);

    // 3) The creator consumes that attestation through the ROSTER path:
    //    moderator = the attestor, moderatorIsAttestor derives the roster PDA.
    await send(svm, creator, [
      await facade.setTaskJobSpec({
        task,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/open-roster",
        moderator: attestor.address,
        moderatorIsAttestor: true,
      }),
    ]);
    const [taskJobSpec] = await findTaskJobSpecPda({ task });
    expect(accountData(svm, taskJobSpec)).not.toBeNull();

    // 4) request_attestor_exit: exitAt set, and the record gate turns fail-closed
    //    IMMEDIATELY (the exit window closes at request, not finalize).
    await send(svm, attestor, [await facade.requestAttestorExit({ attestor })]);
    const exiting = getModerationAttestorDecoder().decode(
      accountData(svm, rosterPda)!,
    );
    expect(exiting.exitAt).toBeGreaterThan(0n);

    const task2 = await createOpenTask(svm, creator, 40);
    await expect(
      send(svm, attestor, [
        await facade.recordTaskModeration({
          moderator: attestor,
          task: task2,
          jobSpecHash: new Uint8Array(32).fill(44),
          moderationAttestor: rosterPda,
          ...CLEAN,
        }),
      ]),
    ).rejects.toThrow(/AttestorExiting|6313/);

    // 5) finalize before the cooldown elapses -> rejected.
    await expect(
      send(svm, attestor, [await facade.finalizeAttestorExit({ attestor })]),
    ).rejects.toThrow(/AttestorExitCooldownActive|6312/);

    // 6) after the 7-day cooldown: the PDA closes and ALL lamports (rent + bond)
    //    come back to the attestor — the non-confiscatable refund.
    advanceClockBy(svm, ATTESTOR_EXIT_COOLDOWN + 1n);
    svm.expireBlockhash(); // the retry is byte-identical to the rejected attempt
    const balBeforeFinalize = bal(svm, attestor.address);
    await send(svm, attestor, [
      await facade.finalizeAttestorExit({ attestor }),
    ]);
    expect(accountData(svm, rosterPda)).toBeNull();
    // Delta = rent + bond - tx fee, so strictly more than the bond alone.
    expect(bal(svm, attestor.address) - balBeforeFinalize).toBeGreaterThan(
      REGISTRATION_BOND_LAMPORTS,
    );
  });
});

describe("e2e: P1.2 BLOCK floor — multisig set/clear hard-gates set_task_job_spec", () => {
  it("blocks a CLEAN-attested hash at the pin gate, then clears and re-opens it", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const co1 = await fundedSigner(svm);
    const co2 = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    // Real 2-of-3 multisig config — the BLOCK floor setters require it.
    await seedProtocolConfigWithMultisig(svm, admin.address, [
      admin.address,
      co1.address,
      co2.address,
    ]);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    // A task with a CLEAN global-authority attestation — everything the ALLOW
    // gate wants is in place, so only the BLOCK floor can reject the pin.
    const task = await createOpenTask(svm, creator, 50);
    const jobSpecHash = new Uint8Array(32).fill(55);
    await send(svm, modAuth, [
      await facade.recordTaskModeration({
        moderator: modAuth,
        task,
        jobSpecHash,
        ...CLEAN,
      }),
    ]);

    // 1) set_moderation_block (2-of-3 co-signers via remaining accounts).
    const rationaleHash = new Uint8Array(32).fill(56);
    await send(svm, admin, [
      await facade.setModerationBlock({
        authority: admin,
        multisigSigners: [co1, co2],
        contentHash: jobSpecHash,
        rationaleHash,
        rationaleUri: "ipfs://takedown-rationale",
      }),
    ]);
    const [blockPda] = await findModerationBlockPda({
      contentHash: jobSpecHash,
    });
    const block = getModerationBlockDecoder().decode(
      accountData(svm, blockPda)!,
    );
    expect(Array.from(block.contentHash)).toEqual(Array.from(jobSpecHash));
    expect(Array.from(block.rationaleHash)).toEqual(Array.from(rationaleHash));
    expect(block.rationaleUri).toBe("ipfs://takedown-rationale");

    // 2) the pin hard-rejects DESPITE the CLEAN attestation (BLOCK beats ALLOW).
    await expect(
      send(svm, creator, [
        await facade.setTaskJobSpec({
          task,
          creator,
          jobSpecHash,
          jobSpecUri: "agenc://job-spec/sha256/blocked",
          moderator: modAuth.address,
        }),
      ]),
    ).rejects.toThrow(/ContentBlocked|6315/);

    // 3) clear_moderation_block (same multisig convention): the account stays
    //    open as audit trail, but the gate re-opens.
    await send(svm, admin, [
      await facade.clearModerationBlock({
        authority: admin,
        multisigSigners: [co1, co2],
        contentHash: jobSpecHash,
      }),
    ]);
    expect(accountData(svm, blockPda)).not.toBeNull(); // audit trail kept

    svm.expireBlockhash(); // identical-bytes dedupe guard before re-sending
    await send(svm, creator, [
      await facade.setTaskJobSpec({
        task,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/blocked",
        moderator: modAuth.address,
      }),
    ]);
    const [taskJobSpec] = await findTaskJobSpecPda({ task });
    expect(accountData(svm, taskJobSpec)).not.toBeNull();
  });
});
