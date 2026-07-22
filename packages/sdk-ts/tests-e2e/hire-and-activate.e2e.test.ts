// REAL on-chain execution of the WP-D6 open-SDK hire orchestration:
// `hireAndActivate()` drives hire_from_listing_humanless -> the caller's
// host/moderate callback -> set_task_job_spec through a MarketplaceClient
// against the actual compiled program in litesvm — real signatures, decoded
// on-chain state, and a provider CLAIM at the end proving the task is
// genuinely claimable with zero kit code involved.
import { describe, expect, it } from "vitest";
import {
  address,
  lamports,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  AGENC_COORDINATION_ERROR__HIRED_TASK_JOB_SPEC_MISMATCH,
  AGENC_COORDINATION_ERROR__INVALID_HIRE_RECORD,
  HIRE_FROM_LISTING_DISCRIMINATOR,
  HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR,
  SET_TASK_JOB_SPEC_DISCRIMINATOR,
  facade,
  findAgentPda,
  findHireRecordPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findTaskJobSpecPda,
  getHireRecordDecoder,
  getHireRecordEncoder,
  getTaskDecoder,
  getTaskEncoder,
  hireAndActivate,
  TaskStatus,
} from "../src/index.js";
import { AgencError, createMarketplaceClient } from "../src/client/index.js";
import { createLiteSvmTransport } from "./litesvm-transport.js";
import {
  accountData,
  freshSvm,
  fundedSigner,
  seedModerationConfig,
  seedProtocolConfig,
  send,
} from "./harness.js";

async function moderationBlockFor(contentHash: Uint8Array) {
  return (await findModerationBlockPda({ contentHash }))[0];
}

const CLEAN = {
  status: 0,
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32).fill(1),
  scannerHash: new Uint8Array(32).fill(2),
  expiresAt: 0n,
} as const;

async function listedService(input: {
  svm: ReturnType<typeof freshSvm>;
  provider: Awaited<ReturnType<typeof fundedSigner>>;
  moderatorSign: (
    listing: Awaited<ReturnType<typeof facade.findListingPda>>[0],
    specHash: Uint8Array,
  ) => Promise<void>;
}) {
  const providerAgentId = new Uint8Array(32).fill(11);
  await send(input.svm, input.provider, [
    await facade.registerAgent({
      authority: input.provider,
      agentId: providerAgentId,
      capabilities: 1n,
      endpoint: "http://provider.test",
      metadataUri: null,
      stakeAmount: 0n,
    }),
  ]);
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });
  const listingId = new Uint8Array(32).fill(33);
  const listingSpecHash = new Uint8Array(32).fill(7);
  const price = 1_000_000n;
  await send(input.svm, input.provider, [
    await facade.createServiceListing({
      providerAgent,
      authority: input.provider,
      listingId,
      name: new Uint8Array(32).fill(1),
      category: new Uint8Array(32).fill(2),
      tags: new Uint8Array(64).fill(3),
      specHash: listingSpecHash,
      specUri: "agenc://job-spec/sha256/listing",
      price,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    }),
  ]);
  const [listing] = await facade.findListingPda({ providerAgent, listingId });
  await input.moderatorSign(listing, listingSpecHash);
  return { providerAgent, listing, listingSpecHash, price };
}

describe("e2e: hireAndActivate — the open-SDK hire orchestration", () => {
  it("hires, hosts+moderates, activates, and the provider claims — through one call", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const moderator = await fundedSigner(svm); // global moderation authority
    const provider = await fundedSigner(svm);
    const buyer = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, moderator.address, true);

    const { providerAgent, listing, listingSpecHash, price } =
      await listedService({
        svm,
        provider,
        moderatorSign: async (listingPda, specHash) => {
          await send(svm, moderator, [
            await facade.recordListingModeration({
              moderator,
              listing: listingPda,
              jobSpecHash: specHash,
              ...CLEAN,
            }),
          ]);
        },
      });

    const transport = createLiteSvmTransport(svm);
    const buyerClient = createMarketplaceClient({ transport, signer: buyer });

    const taskId = new Uint8Array(32).fill(44);
    const jobSpecHash = new Uint8Array(32).fill(55);
    const jobSpecUri = "agenc://job-spec/sha256/buyer-task";
    const phases: string[] = [];

    const result = await hireAndActivate(buyerClient, {
      hire: {
        listing,
        providerAgent,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash,
        taskJobSpecHash: jobSpecHash,
        moderator: moderator.address,
      },
      jobSpec: { instructions: "do the thing" },
      // The host callback stands in for the attestation service: it "hosts"
      // the spec (fixed URI here) and records the on-chain CLEAN attestation,
      // returning the moderator whose record the publish gate consumes —
      // exactly the WP-C1 response contract.
      hostAndModerateJobSpec: async (host) => {
        expect(host.taskId).toStrictEqual(taskId);
        expect(host.taskId).not.toBe(taskId);
        expect(host.listing).toBe(listing);
        expect(host.hireSignature.length).toBeGreaterThan(0);
        await send(svm, moderator, [
          await facade.recordTaskModeration({
            moderator,
            task: host.taskPda,
            jobSpecHash,
            ...CLEAN,
          }),
        ]);
        return {
          jobSpecHash,
          jobSpecUri,
          moderationAttested: true,
          moderator: moderator.address,
        };
      },
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(["hiring", "moderating", "activating"]);
    expect(result.hireSignature.length).toBeGreaterThan(0);
    expect(result.activationSignature.length).toBeGreaterThan(0);
    expect(result.jobSpecUri).toBe(jobSpecUri);

    // Hire really happened: Task + HireRecord exist on-chain.
    const task = getTaskDecoder().decode(accountData(svm, result.taskPda)!);
    expect(task.creator).toBe(buyer.address);
    const [hireRecord] = await findHireRecordPda({ task: result.taskPda });
    expect(accountData(svm, hireRecord)).not.toBeNull();

    // Activation really happened: the job-spec pin account exists.
    const [taskJobSpec] = await findTaskJobSpecPda({ task: result.taskPda });
    expect(accountData(svm, taskJobSpec)).not.toBeNull();

    // The claim gate is the real proof of "claimable": the provider claims
    // the activated task and it transitions to InProgress.
    const providerClient = createMarketplaceClient({
      transport,
      signer: provider,
    });
    await providerClient.claimTaskWithJobSpec({
      task: result.taskPda,
      worker: providerAgent,
      authority: provider,
      moderationBlock: await moderationBlockFor(jobSpecHash),
      jobSpecHash,
    });
    expect(
      getTaskDecoder().decode(accountData(svm, result.taskPda)!).status,
    ).toBe(TaskStatus.InProgress);
  });

  it("consumes a ROSTER attestor's records end-to-end via the RPC-free switches", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const modAuth = await fundedSigner(svm); // global authority (NOT used)
    const attestor = await fundedSigner(svm); // permissionless roster attestor
    const provider = await fundedSigner(svm);
    const buyer = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, modAuth.address, true);

    // Permissionless self-registration (0.25 SOL bond).
    await send(svm, attestor, [
      await facade.registerModerationAttestor({ attestor }),
    ]);
    const [rosterPda] = await findModerationAttestorPda({
      attestor: attestor.address,
    });

    const { providerAgent, listing, listingSpecHash, price } =
      await listedService({
        svm,
        provider,
        moderatorSign: async (listingPda, specHash) => {
          await send(svm, attestor, [
            await facade.recordListingModeration({
              moderator: attestor,
              listing: listingPda,
              jobSpecHash: specHash,
              moderationAttestor: rosterPda,
              ...CLEAN,
            }),
          ]);
        },
      });

    const transport = createLiteSvmTransport(svm);
    const buyerClient = createMarketplaceClient({ transport, signer: buyer });
    const taskId = new Uint8Array(32).fill(77);
    const jobSpecHash = new Uint8Array(32).fill(88);

    const result = await hireAndActivate(buyerClient, {
      hire: {
        listing,
        providerAgent,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash,
        taskJobSpecHash: jobSpecHash,
        moderator: attestor.address,
        moderatorIsAttestor: true,
      },
      jobSpec: null,
      hostAndModerateJobSpec: async (host) => {
        await send(svm, attestor, [
          await facade.recordTaskModeration({
            moderator: attestor,
            task: host.taskPda,
            jobSpecHash,
            moderationAttestor: rosterPda,
            ...CLEAN,
          }),
        ]);
        return {
          jobSpecHash,
          jobSpecUri: "agenc://job-spec/sha256/roster-task",
          moderationAttested: true,
          moderator: attestor.address,
        };
      },
      activation: { moderatorIsAttestor: true },
    });

    const [taskJobSpec] = await findTaskJobSpecPda({ task: result.taskPda });
    expect(accountData(svm, taskJobSpec)).not.toBeNull();

    const providerClient = createMarketplaceClient({
      transport,
      signer: provider,
    });
    await providerClient.claimTaskWithJobSpec({
      task: result.taskPda,
      worker: providerAgent,
      authority: provider,
      moderationBlock: await moderationBlockFor(jobSpecHash),
      jobSpecHash,
    });
    expect(
      getTaskDecoder().decode(accountData(svm, result.taskPda)!).status,
    ).toBe(TaskStatus.InProgress);
  });

  it("fails closed when moderation is not attested — hire lands, activation is never signed", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    const moderator = await fundedSigner(svm);
    const provider = await fundedSigner(svm);
    const buyer = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);
    await seedModerationConfig(svm, admin.address, moderator.address, true);

    const { providerAgent, listing, listingSpecHash, price } = await listedService({
      svm,
      provider,
      moderatorSign: async (listingPda, specHash) => {
        await send(svm, moderator, [
          await facade.recordListingModeration({
            moderator,
            listing: listingPda,
            jobSpecHash: specHash,
            ...CLEAN,
          }),
        ]);
      },
    });

    const transport = createLiteSvmTransport(svm);
    const buyerClient = createMarketplaceClient({ transport, signer: buyer });
    const taskId = new Uint8Array(32).fill(99);
    const taskJobSpecHash = new Uint8Array(32).fill(1);

    await expect(
      hireAndActivate(buyerClient, {
        hire: {
          listing,
          providerAgent,
          taskId,
          expectedPrice: price,
          expectedVersion: 1n,
          reviewWindowSecs: 3600n,
          listingSpecHash,
          taskJobSpecHash,
          moderator: moderator.address,
        },
        jobSpec: null,
        hostAndModerateJobSpec: async () => ({
          jobSpecHash: taskJobSpecHash,
          jobSpecUri: "agenc://job-spec/sha256/x",
          moderationAttested: false,
          moderator: moderator.address,
        }),
      }),
    ).rejects.toThrow(/moderation was not attested/i);

    // The hire itself landed (escrow is safe machinery), but NO activation
    // was signed: the job-spec pin account must not exist.
    const [task] = await facade.findTaskPda({
      creator: buyer.address,
      taskId,
    });
    expect(accountData(svm, task)).not.toBeNull();
    const [taskJobSpec] = await findTaskJobSpecPda({ task });
    expect(accountData(svm, taskJobSpec)).toBeNull();
  });
});

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

async function expectProgramError(
  operation: Promise<unknown>,
  code: number,
): Promise<AgencError> {
  const error = await operation.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(AgencError);
  expect((error as AgencError).code).toBe(code);
  return error as AgencError;
}

async function hiredCommitmentFixture(
  committedHash: Uint8Array,
  options: { deferHire?: boolean } = {},
) {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  const moderator = await fundedSigner(svm);
  const provider = await fundedSigner(svm);
  const buyer = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address);
  await seedModerationConfig(svm, admin.address, moderator.address, true);
  const { providerAgent, listing, listingSpecHash, price } =
    await listedService({
      svm,
      provider,
      moderatorSign: async (listingPda, specHash) => {
        await send(svm, moderator, [
          await facade.recordListingModeration({
            moderator,
            listing: listingPda,
            jobSpecHash: specHash,
            ...CLEAN,
          }),
        ]);
      },
    });
  const taskId = crypto.getRandomValues(new Uint8Array(32));
  const buyerClient = createMarketplaceClient({
    transport: createLiteSvmTransport(svm),
    signer: buyer,
  });
  const hireInput = {
    listing,
    providerAgent,
    creator: buyer,
    taskId,
    expectedPrice: price,
    expectedVersion: 1n,
    reviewWindowSecs: 3600n,
    listingSpecHash,
    taskJobSpecHash: committedHash,
    moderator: moderator.address,
  } as const;
  if (!options.deferHire) {
    await buyerClient.hireFromListingHumanless(hireInput);
  }
  const [task] = await facade.findTaskPda({ creator: buyer.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  const [taskJobSpec] = await findTaskJobSpecPda({ task });
  return {
    svm,
    moderator,
    provider,
    providerAgent,
    buyer,
    buyerClient,
    hireInput,
    listing,
    task,
    hireRecord,
    taskJobSpec,
  };
}

async function attestTask(input: {
  svm: ReturnType<typeof freshSvm>;
  moderator: Awaited<ReturnType<typeof fundedSigner>>;
  task: Address;
  jobSpecHash: Uint8Array;
}) {
  await send(input.svm, input.moderator, [
    await facade.recordTaskModeration({
      moderator: input.moderator,
      task: input.task,
      jobSpecHash: input.jobSpecHash,
      ...CLEAN,
    }),
  ]);
}

function replaceProgramAccountData(
  svm: ReturnType<typeof freshSvm>,
  account: Address,
  data: ReadonlyUint8Array,
) {
  const current = svm.getAccount(account);
  if (!current?.exists) throw new Error(`missing test account ${account}`);
  svm.setAccount({
    address: account,
    data: Uint8Array.from(data),
    executable: false,
    lamports: current.lamports,
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    space: BigInt(data.byteLength),
  });
}

async function directCommitmentFixture() {
  const svm = freshSvm();
  const admin = await fundedSigner(svm);
  const moderator = await fundedSigner(svm);
  const buyer = await fundedSigner(svm);
  await seedProtocolConfig(svm, admin.address);
  await seedModerationConfig(svm, admin.address, moderator.address, true);
  const taskId = crypto.getRandomValues(new Uint8Array(32));
  const jobSpecHash = new Uint8Array(32).fill(0x51);
  const description = new Uint8Array(64);
  description.set(new Uint8Array(32).fill(0x41));
  await send(svm, buyer, [
    await facade.createTaskHumanless({
      creator: buyer,
      taskId,
      requiredCapabilities: 1n,
      description,
      rewardAmount: 1_000_000n,
      deadline: svm.getClock().unixTimestamp + 3600n,
      minReputation: 0,
      reviewWindowSecs: 3600n,
    }),
  ]);
  const [task] = await facade.findTaskPda({ creator: buyer.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  const [taskJobSpec] = await findTaskJobSpecPda({ task });
  await attestTask({ svm, moderator, task, jobSpecHash });
  const buyerClient = createMarketplaceClient({
    transport: createLiteSvmTransport(svm),
    signer: buyer,
  });
  return {
    svm,
    moderator,
    buyer,
    buyerClient,
    task,
    hireRecord,
    taskJobSpec,
    jobSpecHash,
  };
}

async function activateFixture(
  fixture: Awaited<ReturnType<typeof directCommitmentFixture>>,
  hireRecord = fixture.hireRecord,
) {
  return fixture.buyerClient.setTaskJobSpec({
    task: fixture.task,
    creator: fixture.buyer,
    jobSpecHash: fixture.jobSpecHash,
    jobSpecUri: "agenc://job-spec/sha256/commitment-test",
    moderator: fixture.moderator.address,
    hireRecord,
  });
}

describe("e2e: revision-5 hired job-spec commitment", () => {
  it("uses a flag-day registered-hire discriminator: revision-4 wire fails before funding", async () => {
    const fixture = await hiredCommitmentFixture(
      new Uint8Array(32).fill(0x5f),
      { deferHire: true },
    );
    const buyerAgentId = crypto.getRandomValues(new Uint8Array(32));
    await send(fixture.svm, fixture.buyer, [
      await facade.registerAgent({
        authority: fixture.buyer,
        agentId: buyerAgentId,
        capabilities: 1n,
        endpoint: "http://registered-buyer.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [creatorAgent] = await findAgentPda({ agentId: buyerAgentId });
    const ix = await facade.hireFromListing({
      listing: fixture.listing,
      providerAgent: fixture.providerAgent,
      creatorAgent,
      authority: fixture.buyer,
      creator: fixture.buyer,
      taskId: fixture.hireInput.taskId,
      expectedPrice: fixture.hireInput.expectedPrice,
      expectedVersion: fixture.hireInput.expectedVersion,
      listingSpecHash: fixture.hireInput.listingSpecHash,
      taskJobSpecHash: fixture.hireInput.taskJobSpecHash,
      moderator: fixture.hireInput.moderator,
    });
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(
      Array.from(HIRE_FROM_LISTING_DISCRIMINATOR),
    );

    const revision4Data = Uint8Array.from(ix.data);
    revision4Data.set([174, 225, 81, 68, 172, 19, 97, 194], 0);
    await expect(
      send(fixture.svm, fixture.buyer, [{ ...ix, data: revision4Data }]),
    ).rejects.toThrow(/InstructionFallbackNotFound/);
    expect(accountData(fixture.svm, fixture.task)).toBeNull();

    await expect(send(fixture.svm, fixture.buyer, [ix])).resolves.toBeDefined();
    expect(accountData(fixture.svm, fixture.task)).not.toBeNull();
  });

  it("uses a flag-day hire discriminator: old wire fails, v2 wire funds exactly once", async () => {
    const fixture = await hiredCommitmentFixture(
      new Uint8Array(32).fill(0x60),
      { deferHire: true },
    );
    const ix = await facade.hireFromListingHumanless(fixture.hireInput);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(
      Array.from(HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR),
    );
    const oldData = Uint8Array.from(ix.data);
    oldData.set([90, 142, 39, 225, 150, 161, 217, 49], 0);
    await expect(
      send(fixture.svm, fixture.buyer, [{ ...ix, data: oldData }]),
    ).rejects.toThrow(/InstructionFallbackNotFound/);
    expect(accountData(fixture.svm, fixture.task)).toBeNull();

    await expect(send(fixture.svm, fixture.buyer, [ix])).resolves.toBeDefined();
    expect(accountData(fixture.svm, fixture.task)).not.toBeNull();
  });

  it("uses a flag-day set discriminator: legacy wire cannot bypass the HireRecord proof", async () => {
    const fixture = await directCommitmentFixture();
    const ix = await facade.setTaskJobSpec({
      task: fixture.task,
      creator: fixture.buyer,
      jobSpecHash: fixture.jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/discriminator-boundary",
      moderator: fixture.moderator.address,
    });
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(
      Array.from(SET_TASK_JOB_SPEC_DISCRIMINATOR),
    );
    const oldData = Uint8Array.from(ix.data);
    oldData.set([134, 102, 102, 86, 31, 164, 202, 193], 0);
    await expect(
      send(fixture.svm, fixture.buyer, [{ ...ix, data: oldData }]),
    ).rejects.toThrow(/InstructionFallbackNotFound/);
    expect(accountData(fixture.svm, fixture.taskJobSpec)).toBeNull();

    await expect(send(fixture.svm, fixture.buyer, [ix])).resolves.toBeDefined();
    expect(accountData(fixture.svm, fixture.taskJobSpec)).not.toBeNull();
  });

  it("rejects a moderated hash different from the one committed before escrow funding", async () => {
    const committedHash = new Uint8Array(32).fill(0x61);
    const movedHash = new Uint8Array(32).fill(0x62);
    const fixture = await hiredCommitmentFixture(committedHash);
    await attestTask({ ...fixture, jobSpecHash: movedHash });

    await expectProgramError(
      fixture.buyerClient.setTaskJobSpec({
        task: fixture.task,
        creator: fixture.buyer,
        jobSpecHash: movedHash,
        jobSpecUri: "agenc://job-spec/sha256/substituted",
        moderator: fixture.moderator.address,
      }),
      AGENC_COORDINATION_ERROR__HIRED_TASK_JOB_SPEC_MISMATCH,
    );
    expect(accountData(fixture.svm, fixture.taskJobSpec)).toBeNull();

    await attestTask({ ...fixture, jobSpecHash: committedHash });
    await expect(
      fixture.buyerClient.setTaskJobSpec({
        task: fixture.task,
        creator: fixture.buyer,
        jobSpecHash: committedHash,
        jobSpecUri: "agenc://job-spec/sha256/committed",
        moderator: fixture.moderator.address,
      }),
    ).resolves.toMatchObject({ signature: expect.any(String) });
  });

  it("rejects activation of a revision-4 hire with no buyer-specific commitment", async () => {
    const committedHash = new Uint8Array(32).fill(0x63);
    const legacyPublishedHash = new Uint8Array(32).fill(0x64);
    const fixture = await hiredCommitmentFixture(committedHash);
    const task = getTaskDecoder().decode(accountData(fixture.svm, fixture.task)!);
    const description = new Uint8Array(task.description);
    description.fill(0, 32);
    replaceProgramAccountData(
      fixture.svm,
      fixture.task,
      getTaskEncoder().encode({ ...task, description }),
    );
    await attestTask({ ...fixture, jobSpecHash: legacyPublishedHash });

    await expectProgramError(
      fixture.buyerClient.setTaskJobSpec({
        task: fixture.task,
        creator: fixture.buyer,
        jobSpecHash: legacyPublishedHash,
        jobSpecUri: "agenc://job-spec/sha256/legacy-funded",
        moderator: fixture.moderator.address,
      }),
      AGENC_COORDINATION_ERROR__HIRED_TASK_JOB_SPEC_MISMATCH,
    );
    expect(accountData(fixture.svm, fixture.taskJobSpec)).toBeNull();
  });

  it("rejects a new claim on a legacy Open hire even when its old job-spec pointer already exists", async () => {
    const committedHash = new Uint8Array(32).fill(0x66);
    const fixture = await hiredCommitmentFixture(committedHash);
    await attestTask({ ...fixture, jobSpecHash: committedHash });
    await expect(
      fixture.buyerClient.setTaskJobSpec({
        task: fixture.task,
        creator: fixture.buyer,
        jobSpecHash: committedHash,
        jobSpecUri: "agenc://job-spec/sha256/pre-upgrade-pinned",
        moderator: fixture.moderator.address,
      }),
    ).resolves.toMatchObject({ signature: expect.any(String) });

    // Recreate the deployed rev4 account shape: no second-half commitment and
    // no designated-provider carve-out. The existing TaskJobSpec remains.
    const task = getTaskDecoder().decode(accountData(fixture.svm, fixture.task)!);
    const description = new Uint8Array(task.description);
    description.fill(0, 32);
    replaceProgramAccountData(
      fixture.svm,
      fixture.task,
      getTaskEncoder().encode({ ...task, description }),
    );
    const hire = getHireRecordDecoder().decode(
      accountData(fixture.svm, fixture.hireRecord)!,
    );
    replaceProgramAccountData(
      fixture.svm,
      fixture.hireRecord,
      getHireRecordEncoder().encode({
        ...hire,
        designatedProvider: SYSTEM_PROGRAM,
      }),
    );

    const providerClient = createMarketplaceClient({
      transport: createLiteSvmTransport(fixture.svm),
      signer: fixture.provider,
    });
    await expectProgramError(
      providerClient.claimTaskWithJobSpec({
        task: fixture.task,
        worker: fixture.providerAgent,
        authority: fixture.provider,
        legacyListing: fixture.listing,
        moderationBlock: await moderationBlockFor(committedHash),
        jobSpecHash: committedHash,
      }),
      AGENC_COORDINATION_ERROR__HIRED_TASK_JOB_SPEC_MISMATCH,
    );
    expect(
      getTaskDecoder().decode(accountData(fixture.svm, fixture.task)!).status,
    ).toBe(TaskStatus.Open);
  });

  it("rejects a canonical HireRecord whose stored bump was tampered", async () => {
    const committedHash = new Uint8Array(32).fill(0x65);
    const fixture = await hiredCommitmentFixture(committedHash);
    const hire = getHireRecordDecoder().decode(
      accountData(fixture.svm, fixture.hireRecord)!,
    );
    replaceProgramAccountData(
      fixture.svm,
      fixture.hireRecord,
      getHireRecordEncoder().encode({ ...hire, bump: hire.bump ^ 1 }),
    );
    await attestTask({ ...fixture, jobSpecHash: committedHash });
    await expectProgramError(
      fixture.buyerClient.setTaskJobSpec({
        task: fixture.task,
        creator: fixture.buyer,
        jobSpecHash: committedHash,
        jobSpecUri: "agenc://job-spec/sha256/bad-bump",
        moderator: fixture.moderator.address,
      }),
      AGENC_COORDINATION_ERROR__INVALID_HIRE_RECORD,
    );
  });

  it("accepts the empty canonical system account for a direct task", async () => {
    const fixture = await directCommitmentFixture();
    await expect(activateFixture(fixture)).resolves.toMatchObject({
      signature: expect.any(String),
    });
  });

  it("rejects a noncanonical hire account override", async () => {
    const fixture = await directCommitmentFixture();
    await expect(
      activateFixture(fixture, fixture.moderator.address),
    ).rejects.toBeInstanceOf(AgencError);
  });

  it("rejects nonempty data at the canonical system-owned direct-task slot", async () => {
    const fixture = await directCommitmentFixture();
    fixture.svm.setAccount({
      address: fixture.hireRecord,
      data: Uint8Array.of(1),
      executable: false,
      lamports: lamports(1n),
      programAddress: SYSTEM_PROGRAM,
      space: 1n,
    });
    await expect(activateFixture(fixture)).rejects.toBeInstanceOf(AgencError);
  });

  it("rejects a foreign-owned canonical direct-task slot", async () => {
    const fixture = await directCommitmentFixture();
    fixture.svm.setAccount({
      address: fixture.hireRecord,
      data: new Uint8Array(),
      executable: false,
      lamports: lamports(1n),
      programAddress: fixture.moderator.address,
      space: 0n,
    });
    await expect(activateFixture(fixture)).rejects.toBeInstanceOf(AgencError);
  });

  it("rejects malformed program-owned data at the canonical hire slot", async () => {
    const fixture = await directCommitmentFixture();
    fixture.svm.setAccount({
      address: fixture.hireRecord,
      data: new Uint8Array(16).fill(7),
      executable: false,
      lamports: lamports(1_000_000n),
      programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
      space: 16n,
    });
    await expect(activateFixture(fixture)).rejects.toBeInstanceOf(AgencError);
  });
});
