import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { address } from "@solana/kit";
import { findClaimPda, getTaskClaimDecoder, getTaskClaimDiscriminatorBytes } from "@tetsuo-ai/marketplace-sdk";
import { childDigest, childPolicyCriterion } from "../src/child-hire.js";
import { DEFAULT_SELLER_TERMS } from "../src/client/seller-terms.js";
import type { ChildHirePolicy, ChildHireRequest } from "../src/client/child-hire.js";
import { readHireableListing, readProgramAccount } from "../src/market.js";
import { CENT, eventually, startWorld, REVIEW_ALLOWANCE } from "./harness.js";

export interface ChildFixtureOptions {
  cap?: string;
  returnBeforeSecs?: number;
  criteria?: string[];
  prepareCriteria?(
    world: Awaited<ReturnType<typeof startWorld>>,
    request: ChildHireRequest,
    seller: string,
    supplier: string,
  ): Promise<string[]>;
  privateInputs?: boolean;
  world?: Parameters<typeof startWorld>[0];
}
export async function openParentFixture(options: ChildFixtureOptions = {}, openWorld = startWorld) {
  const room = mkdtempSync(join(tmpdir(), "child-room-"));
  const finish = join(room, "finish");
  const wait =
    "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.stdout.write('Parent result');}},50)";
  // The practice catalog predates fulfilment metadata. Feed its read adapter the
  // verified metadata projection that C publishes and E accepts on the combined wallet.
  const catalogue = new Map<string, object>();
  const world = await openWorld({
    config: { reviewWindowSecs: 60n },
    ...options.world,
    earn: {
      executor: {
        argv: [process.execPath, "-e", wait, finish, "{prompt}"],
        mode: "sandboxed",
        envAllowlist: [],
        timeoutMs: 60_000,
      },
      pollIntervalMs: 150,
      serviceRefreshMs: 300,
      ...options.world?.earn,
    },
    services(services, sandbox) {
      const base = options.world?.services?.(services, sandbox) ?? services;
      return {
        ...base,
        async listServices(filters) {
          return (await base.listServices(filters)).map((row) => {
            const fulfilment = catalogue.get(row.listing);
            return fulfilment ? { ...row, details: "ready" as const, fulfilment } : row;
          });
        },
      };
    },
  });
  const { wallet, sandbox } = world;
  const seller = await wallet.createAgent("Selling studio");
  const buyer = await wallet.createAgent("Parent buyer");
  for (const agent of [seller, buyer]) {
    await wallet.setPolicy(agent.id, {
      askAboveCents: 1000,
      refill: { ...REVIEW_ALLOWANCE, perDayCents: 10000 },
    });
    await wallet.fundAgent(agent.id, { lamports: String(5000n * CENT) });
  }
  const offer = {
    name: "Studio report",
    summary: "A finished report with one supplier.",
    price: { usdCents: 100 },
    terms: { ...DEFAULT_SELLER_TERMS, deliverySecs: 36000 },
  };
  const initial = await wallet.quoteEarn(seller.id, offer);
  await wallet.setOffer(seller.id, offer, undefined, initial.quoteId);
  const startup = await wallet.quoteEarn(seller.id, undefined, undefined, 1);
  await wallet.setEarn(seller.id, true, 1, startup.quoteId);
  const listing = await eventually(async () => {
    await wallet.tick();
    return (await wallet.overview()).agents.find((a) => a.id === seller.id)?.earn.offer?.listing;
  });
  const supplier = await sandbox.addService({
    name: "Short report",
    category: "writing",
    summary: "A short report",
    deliverySecs: 600,
    priceLamports: 20n * CENT,
    replyPrefix: "Supplier result",
    picture: true,
  });
  const policy: ChildHirePolicy = {
    allowedListings: [supplier],
    maxDebitLamports: options.cap ?? "100000000",
    returnBeforeSecs: options.returnBeforeSecs ?? 10,
    reviewWindowSecs: 5,
    sharing: options.privateInputs ? "buyer-approved-input" : "public-brief",
  };
  await wallet.childHires.setPolicy(seller.id, listing, policy);
  const worker = (await readHireableListing(sandbox.chain, address(listing))).providerAgent;
  const request: ChildHireRequest = {
    listing: supplier,
    brief: "Supply the short report.",
    outputs: ["text", "postcard.png"],
  };
  const extra = options.prepareCriteria
    ? await options.prepareCriteria(world, request, seller.address, supplier)
    : [];
  const digest = childDigest(policy);
  const integrated = typeof Reflect.get(wallet, "postListingMessage") === "function";
  const requirement = extra.find((row) => row.startsWith("Private input handoff v1: "));
  catalogue.set(listing, {
    privateInputs: !!requirement,
    supplier: { version: 1, payingSeller: seller.address, policy, digest },
  });
  catalogue.set(supplier, { privateInputs: true });
  const parentPurchase = await wallet.hire({
    agentId: buyer.id,
    listing,
    request: "Prepare the complete report.",
    acceptance: [
      ...(options.criteria ?? []),
      ...(integrated ? extra.filter((row) => row !== requirement) : [childPolicyCriterion(policy), ...extra]),
    ],
    ...(integrated && {
      childPolicyDigest: digest,
      ...(requirement && { privateCommitment: requirement.slice("Private input handoff v1: ".length) }),
    }),
  });
  if (parentPurchase.approval) await wallet.decideApproval(parentPurchase.approval.id, true);
  const job = await wallet.getJob(parentPurchase.job.id, true);
  assert.ok(job.status === "waiting" || job.status === "working");
  const [claimPda] = await findClaimPda({
    task: address(job.task!),
    bidder: worker,
  });
  const claim = await eventually(async () =>
    readProgramAccount(sandbox.chain, claimPda, getTaskClaimDiscriminatorBytes(), (b) =>
      getTaskClaimDecoder().decode(b),
    ),
  );
  const grant = {
    sellerAgentId: seller.id,
    parentTask: job.task!,
    claimedAt: String(claim.claimedAt),
    roomId: "f".repeat(64),
  };
  return {
    world,
    room,
    grant,
    request,
    seller,
    buyer,
    job,
    finish,
    policy,
    listing,
  };
}
