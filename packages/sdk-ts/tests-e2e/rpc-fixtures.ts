import type { Address, KeyPairSigner } from "@solana/kit";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness } from "./rpc-harness.js";

export type RpcHarness = Awaited<ReturnType<typeof localRpcHarness>>;

export async function rpcAgent(h: RpcHarness, suppliedSigner?: KeyPairSigner) {
  const signer = suppliedSigner ?? (await h.fundedSigner());
  const agentId = id32();
  const [agent] = await sdk.findAgentPda({ agentId });
  await h.send("register funded agent", signer, [
    await sdk.facade.registerAgent({
      authority: signer,
      agentId,
      capabilities: 1n,
      endpoint: "https://example.invalid/rpc-regression",
      metadataUri: null,
      stakeAmount: h.config.minAgentStake,
    }),
  ]);
  return { signer, agent, agentId };
}

export async function rpcListing(
  h: RpcHarness,
  provider: Awaited<ReturnType<typeof rpcAgent>>,
  { price = 1_000_000n, maxOpenJobs = 0 } = {},
) {
  const listingId = id32();
  const spec = id32();
  const [listing] = await sdk.findListingPda({
    providerAgent: provider.agent,
    listingId,
  });
  await h.send("create listing", provider.signer, [
    await sdk.facade.createServiceListing({
      providerAgent: provider.agent,
      authority: provider.signer,
      listingId,
      name: id32(),
      category: id32(),
      tags: new Uint8Array(64).fill(1),
      specHash: spec,
      specUri: "agenc://job-spec/rpc",
      price,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs,
      operator: null,
      operatorFeeBps: 0,
    }),
  ]);
  await h.send("CLEAN listing", h.moderator, [
    await sdk.facade.recordListingModeration({
      moderator: h.moderator,
      listing,
      jobSpecHash: spec,
      status: 0,
      riskScore: 0,
      categoryMask: 0n,
      policyHash: id32(),
      scannerHash: id32(),
      expiresAt: 0n,
    }),
  ]);
  return { listing, listingId, spec, price, provider };
}

export async function rpcPublish(
  h: RpcHarness,
  task: Address,
  creator: KeyPairSigner,
  jobSpecHash: Uint8Array,
) {
  await h.send("CLEAN task", h.moderator, [
    await sdk.facade.recordTaskModeration({
      task,
      moderator: h.moderator,
      jobSpecHash,
      status: 0,
      riskScore: 0,
      categoryMask: 0n,
      policyHash: id32(),
      scannerHash: id32(),
      expiresAt: 0n,
    }),
  ]);
  await h.send("publish task", creator, [
    await sdk.facade.setTaskJobSpec({
      task,
      creator,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/rpc",
      moderator: h.moderator.address,
    }),
  ]);
}
