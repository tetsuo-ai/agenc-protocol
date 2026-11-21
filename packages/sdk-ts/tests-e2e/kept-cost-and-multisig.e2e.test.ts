import { describe, it, expect } from "vitest";
import { lamports, type Address, type KeyPairSigner } from "@solana/kit";
import {
  facade,
  findAgentPda,
  findEscrowPda,
  getTaskEscrowEncoder,
  getTaskEscrowSize,
  findTaskPda,
  findTaskJobSpecPda,
  findTaskValidationConfigPda,
  findHireRecordPda,
  findModerationBlockPda,
  findModerationConfigPda,
  findModerationAttestorPda,
  findTaskModerationPda,
  getAgentRegistrationDecoder,
  getModerationConfigDecoder,
  getTaskModerationDecoder,
  getTaskMarkerSize,
  getTaskModerationSize,
  AgentStatus,
} from "../src/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
  accountData,
  readTaskAccount,
  PROGRAM,
} from "./harness.js";

// REAL on-chain execution of revision 9 C (close_task compaction and
// buyer-paid moderation rent) and G (2-of-3 moderation and suspension
// controls), driven by SDK-built instructions against the compiled program in
// litesvm. A separate `payer` pays every fee, so balance deltas are exact.

type Svm = ReturnType<typeof freshSvm>;
const DAY = 86_400n;

function lamportsOf(svm: Svm, account: Address): bigint {
  return svm.getBalance(account) ?? 0n;
}

function rent(svm: Svm, size: number): bigint {
  return svm.minimumBalanceForRentExemption(BigInt(size));
}

async function register(
  svm: Svm,
  authority: KeyPairSigner,
  fill: number,
): Promise<Address> {
  const agentId = new Uint8Array(32).fill(fill);
  await send(svm, authority, [
    await facade.registerAgent({
      authority,
      agentId,
      capabilities: 1n,
      endpoint: `http://agent-${fill}.test`,
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  return (await findAgentPda({ agentId }))[0];
}

describe("revision 9 C: close_task keeps only the marker", () => {
  it("returns the Task surplus and the buyer-paid moderation record to the creator", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const payer = await fundedSigner(svm);
    const stranger = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);
    const creator = await fundedSigner(svm);
    const worker = await fundedSigner(svm);
    const creatorAgent = await register(svm, creator, 11);
    const workerAgent = await register(svm, worker, 22);

    const taskId = new Uint8Array(32).fill(33);
    const create = async () =>
      facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: new Uint8Array(64).fill(7, 0, 32),
        rewardAmount: 100_000_000n,
        maxWorkers: 1,
        deadline: svm.getClock().unixTimestamp + 10n * DAY,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      });
    await send(svm, creator, [await create()]);
    const [task] = await findTaskPda({ creator: creator.address, taskId });
    const [hireRecord] = await findHireRecordPda({ task });
    await send(svm, creator, [
      await facade.configureTaskValidation({
        task,
        creator,
        hireRecord,
        mode: 1, // CreatorReview
        reviewWindowSecs: 3600n,
        validatorQuorum: 0,
        attestor: null,
      }),
    ]);

    const jobSpecHash = new Uint8Array(32).fill(44);
    const record = (rentPayer: KeyPairSigner) =>
      facade.recordTaskModeration({
        task,
        moderator: modAuth,
        rentPayer,
        jobSpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(1),
        scannerHash: new Uint8Array(32).fill(2),
        expiresAt: 0n,
      });
    // Only the task's creator or the moderator may pay the record's rent.
    await expect(send(svm, payer, [await record(stranger)])).rejects.toThrow(
      /InvalidModerationRentPayer/,
    );
    const creatorBeforeRecord = lamportsOf(svm, creator.address);
    await send(svm, payer, [await record(creator)]);
    const [moderationRecord] = await findTaskModerationPda({
      task,
      jobSpecHash,
      moderator: modAuth.address,
    });
    const recordRent = rent(svm, getTaskModerationSize());
    expect(creatorBeforeRecord - lamportsOf(svm, creator.address)).toBe(
      recordRent,
    );
    const decodedRecord = getTaskModerationDecoder().decode(
      accountData(svm, moderationRecord)!,
    );
    expect(decodedRecord.reserved[0]).toBe(1);
    expect(facade.taskModerationRentRecipient(decodedRecord)).toBe(
      creator.address,
    );

    await send(svm, creator, [
      await facade.setTaskJobSpec({
        task,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/kept-cost",
        moderator: modAuth.address,
      }),
    ]);
    await send(svm, payer, [
      await facade.claimTaskWithJobSpec({
        task,
        worker: workerAgent,
        authority: worker,
        moderationBlock: (
          await findModerationBlockPda({ contentHash: jobSpecHash })
        )[0],
        jobSpecHash,
      }),
    ]);
    await send(svm, payer, [
      await facade.submitTaskResult({
        task,
        worker: workerAgent,
        authority: worker,
        proofHash: new Uint8Array(32).fill(55),
        resultData: new Uint8Array(64).fill(9),
      }),
    ]);
    await send(svm, payer, [
      await facade.acceptTaskResult({
        task,
        worker: workerAgent,
        creator,
        treasury: admin.address,
        workerAuthority: worker.address,
      }),
    ]);

    const [validationConfig] = await findTaskValidationConfigPda({ task });
    const [jobSpec] = await findTaskJobSpecPda({ task });
    // Review R3-1: a settled escrow can outlive its task (mainnet holds two
    // such Completed SOL tasks). Put one back at the canonical address; the
    // default close passes that address and closes it to the creator.
    const [escrow, escrowBump] = await findEscrowPda({ task });
    expect(accountData(svm, escrow)).toBeNull();
    svm.setAccount({
      address: escrow,
      data: new Uint8Array(
        getTaskEscrowEncoder().encode({
          task,
          amount: 100_000_000n,
          distributed: 100_000_000n,
          isClosed: true,
          bump: escrowBump,
        }),
      ),
      executable: false,
      lamports: lamports(rent(svm, getTaskEscrowSize())),
      programAddress: PROGRAM,
      space: BigInt(getTaskEscrowSize()),
    });
    const taskLamports = lamportsOf(svm, task);
    const markerRent = rent(svm, getTaskMarkerSize());
    const children =
      lamportsOf(svm, validationConfig) +
      lamportsOf(svm, jobSpec) +
      lamportsOf(svm, moderationRecord) +
      lamportsOf(svm, escrow);
    expect(lamportsOf(svm, moderationRecord)).toBe(recordRent);
    const creatorBeforeClose = lamportsOf(svm, creator.address);
    await send(svm, payer, [
      await facade.closeTask({
        task,
        authority: creator,
        children: [
          { kind: "creatorFunded", account: validationConfig },
          {
            kind: "namedRecipient",
            account: moderationRecord,
            recipient: facade.taskModerationRentRecipient(decodedRecord),
          },
        ],
      }),
    ]);

    // Everything above the marker's rent came back, children included.
    expect(lamportsOf(svm, creator.address) - creatorBeforeClose).toBe(
      taskLamports - markerRent + children,
    );
    expect(lamportsOf(svm, task)).toBe(markerRent);
    expect(accountData(svm, task)).toHaveLength(56);
    expect(accountData(svm, moderationRecord)).toBeNull();
    expect(accountData(svm, validationConfig)).toBeNull();
    expect(accountData(svm, jobSpec)).toBeNull();
    expect(accountData(svm, escrow)).toBeNull();
    expect(readTaskAccount(svm, task)).toMatchObject({
      kind: "closed",
      status: "completed",
      endedLiveHire: false,
      marker: { creator: creator.address },
    });

    // A second close takes the marker path: nothing left, nothing moves.
    await send(svm, payer, [
      await facade.closeTask({ task, authority: creator, taskJobSpec: null }),
    ]);
    expect(lamportsOf(svm, task)).toBe(markerRent);
    // The marker keeps the task id from being reused and takes no new child.
    await expect(send(svm, creator, [await create()])).rejects.toThrow();
    await expect(send(svm, payer, [await record(modAuth)])).rejects.toThrow();
  });
});

describe("revision 9 G: one key no longer controls moderation or suspensions", () => {
  async function world() {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const ownerB = await fundedSigner(svm);
    const ownerC = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm);
    const payer = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address, {
      multisigOwners: [admin.address, ownerB.address, ownerC.address],
      multisigThreshold: 2,
    });
    await seedModerationConfig(svm, admin.address, modAuth.address, true);
    return { svm, admin, ownerB, ownerC, modAuth, payer };
  }

  it("turns moderation off and back on only with 2 of 3", async () => {
    const { svm, admin, ownerB, modAuth, payer } = await world();
    const [config] = await findModerationConfigPda();
    const configure = (enabled: boolean, signers: KeyPairSigner[]) =>
      facade.configureTaskModeration({
        authority: admin,
        moderationAuthority: modAuth.address,
        enabled,
        multisigSigners: signers,
      });
    await expect(
      send(svm, payer, [await configure(false, [admin])]),
    ).rejects.toThrow(/MultisigNotEnoughSigners/);
    expect(getModerationConfigDecoder().decode(accountData(svm, config)!).enabled).toBe(
      true,
    );
    await send(svm, payer, [await configure(false, [admin, ownerB])]);
    expect(getModerationConfigDecoder().decode(accountData(svm, config)!).enabled).toBe(
      false,
    );
    await send(svm, payer, [await configure(true, [admin, ownerB])]);
    expect(getModerationConfigDecoder().decode(accountData(svm, config)!).enabled).toBe(
      true,
    );
  });

  it("suspends and unsuspends an agent only with 2 of 3", async () => {
    const { svm, admin, ownerC, payer } = await world();
    const someone = await fundedSigner(svm);
    const agent = await register(svm, someone, 61);
    const status = () =>
      getAgentRegistrationDecoder().decode(accountData(svm, agent)!).status;
    await expect(
      send(svm, payer, [
        await facade.suspendAgent({
          agent,
          authority: admin,
          multisigSigners: [admin],
        }),
      ]),
    ).rejects.toThrow(/MultisigNotEnoughSigners/);
    expect(status()).toBe(AgentStatus.Active);
    await send(svm, payer, [
      await facade.suspendAgent({
        agent,
        authority: admin,
        multisigSigners: [admin, ownerC],
      }),
    ]);
    expect(status()).toBe(AgentStatus.Suspended);
    await expect(
      send(svm, payer, [
        await facade.unsuspendAgent({
          agent,
          authority: ownerC,
          multisigSigners: [ownerC],
        }),
      ]),
    ).rejects.toThrow(/MultisigNotEnoughSigners/);
    await send(svm, payer, [
      await facade.unsuspendAgent({
        agent,
        authority: ownerC,
        multisigSigners: [admin, ownerC],
      }),
    ]);
    // An unsuspended agent comes back Inactive.
    expect(status()).toBe(AgentStatus.Inactive);
  });

  it("takes a plain heartbeat from the moderation authority and an owner, and a window change only with 2 of 3", async () => {
    const { svm, admin, ownerB, modAuth, payer } = await world();
    const [config] = await findModerationConfigPda();
    const windowSecs = () => {
      const reserved = getModerationConfigDecoder().decode(
        accountData(svm, config)!,
      ).reserved;
      return new DataView(Uint8Array.from(reserved).buffer).getUint32(0, true);
    };
    await send(svm, payer, [
      await facade.moderationHeartbeat({
        authority: modAuth,
        newWindowSecs: null,
      }),
    ]);
    await send(svm, payer, [
      await facade.moderationHeartbeat({
        authority: ownerB,
        newWindowSecs: null,
      }),
    ]);
    await expect(
      send(svm, payer, [
        await facade.moderationHeartbeat({
          authority: admin,
          newWindowSecs: 172_800,
          multisigSigners: [admin],
        }),
      ]),
    ).rejects.toThrow(/UnauthorizedModerationHeartbeat/);
    await send(svm, payer, [
      await facade.moderationHeartbeat({
        authority: admin,
        newWindowSecs: 172_800,
        multisigSigners: [admin, ownerB],
      }),
    ]);
    expect(windowSecs()).toBe(172_800);
  });

  it("changes the attestor roster only with 2 of 3, and a revoke pays the proposer", async () => {
    const { svm, admin, ownerB, ownerC, payer } = await world();
    const attestor = await fundedSigner(svm);
    const [roster] = await findModerationAttestorPda({
      attestor: attestor.address,
    });
    await expect(
      send(svm, payer, [
        await facade.assignModerationAttestor({
          authority: admin,
          attestor: attestor.address,
          multisigSigners: [admin],
        }),
      ]),
    ).rejects.toThrow(/MultisigNotEnoughSigners/);
    await send(svm, payer, [
      await facade.assignModerationAttestor({
        authority: admin,
        attestor: attestor.address,
        multisigSigners: [admin, ownerB],
      }),
    ]);
    const rosterRent = lamportsOf(svm, roster);
    expect(rosterRent).toBeGreaterThan(0n);
    const proposerBefore = lamportsOf(svm, ownerC.address);
    await send(svm, payer, [
      await facade.revokeModerationAttestor({
        authority: ownerC,
        attestor: attestor.address,
        multisigSigners: [ownerB, ownerC],
      }),
    ]);
    expect(accountData(svm, roster)).toBeNull();
    expect(lamportsOf(svm, ownerC.address) - proposerBefore).toBe(rosterRent);
  });
});
