// REAL on-chain execution of the WP-D6 open-SDK hire orchestration:
// `hireAndActivate()` drives hire_from_listing_humanless -> the caller's
// host/moderate callback -> set_task_job_spec through a MarketplaceClient
// against the actual compiled program in litesvm — real signatures, decoded
// on-chain state, and a provider CLAIM at the end proving the task is
// genuinely claimable with zero kit code involved.
import { describe, expect, it } from "vitest";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findTaskJobSpecPda,
  getTaskDecoder,
  hireAndActivate,
  TaskStatus,
} from "../src/index.js";
import { createMarketplaceClient } from "../src/client/index.js";
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
        moderator: moderator.address,
      },
      jobSpec: { instructions: "do the thing" },
      // The host callback stands in for the attestation service: it "hosts"
      // the spec (fixed URI here) and records the on-chain CLEAN attestation,
      // returning the moderator whose record the publish gate consumes —
      // exactly the WP-C1 response contract.
      hostAndModerateJobSpec: async (host) => {
        expect(host.taskId).toBe(taskId);
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
          moderator: moderator.address,
        },
        jobSpec: null,
        hostAndModerateJobSpec: async () => ({
          jobSpecHash: new Uint8Array(32).fill(1),
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
