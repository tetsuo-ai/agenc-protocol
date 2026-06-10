// Devnet first hire — the faucet-to-settled-result story (PLAN.md P2.4).
//
// This is a REAL, COMPILING example (checked by `npm run examples:check`)
// that BROADCASTS REAL DEVNET TRANSACTIONS when run after the devnet
// full-surface redeploy (P2.2) + sandbox seeding. Until then it exits early
// with a friendly explanation: SANDBOX_FIXTURES ships `seeded: false`, and
// the runtime guard below refuses to touch the network in that state.
//
// What it does, end to end, with nothing but the public faucet:
//   1. createSandboxClient() x2 — throwaway keys, devnet RPC, 2 SOL airdrops
//      (one client plays the BUYER, one the PROVIDER; both sides are needed
//      because a hired task can only be claimed/settled by the listing's
//      provider agent).
//   2. Fixture rot-check — decode a seeded SANDBOX_FIXTURES listing on-chain
//      and verify it is still Active at the published address/price. (The
//      seeded providers' keys are held by the seeding operator, so the
//      settlement below runs on a fresh listing this process controls;
//      hiring a fixture listing works exactly the same way.)
//   3. Provider registers an agent + creates an Active listing.
//   4. requestSandboxAttestation("listing") — the P2.3 auto-attestor records
//      CLEAN moderation so the fail-closed hire gate passes.
//   5. Buyer registers an agent + hireFromListing — task + escrow + hire
//      record minted in one instruction.
//   6. requestSandboxAttestation("task") + setTaskJobSpec — claim is gated on
//      both.
//   7. Provider claims (waitForTaskStatus -> InProgress), then settles via
//      complete_task (the direct-pay path hired tasks use — mirrors the
//      client e2e settlement recipe), and we waitForTaskStatus -> Completed.
//
// DEVNET ONLY. Throwaway keys. Never real funds.
//
// Run it (post-deploy) through vitest — same path the nightly workflow uses:
//   SANDBOX_NIGHTLY=1 npx vitest run tests-e2e/devnet-nightly.test.ts
// or directly with a TS runner if you have one: `npx tsx examples/devnet-first-hire.ts`.
import {
  generateKeyPairSigner,
  getBase64Encoder,
  type Address,
} from "@solana/kit";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findProtocolConfigPda,
  findTaskModerationPda,
  findTaskPda,
  getProtocolConfigDecoder,
  getServiceListingDecoder,
  ListingState,
  TaskStatus,
  waitForTaskStatus,
} from "../src/index.js";
import { descriptionHash, randomId32 } from "../src/values/index.js";
import {
  createSandboxClient,
  requestSandboxAttestation,
  SANDBOX_FIXTURES,
  sandboxListings,
  SandboxAirdropError,
  type SandboxClient,
  type SandboxRpc,
} from "../src/sandbox/index.js";

// eslint-disable-next-line no-console
const log = (...parts: unknown[]): void => console.log(...parts);

const NOT_SEEDED_MESSAGE = [
  "devnet-first-hire: the devnet sandbox is NOT seeded yet, so this example",
  "did not broadcast anything.",
  "",
  "SANDBOX_FIXTURES.seeded is false in this build: the devnet full-surface",
  "redeploy (PLAN.md P2.2) and the seeding run (scripts/seed-devnet-sandbox.mjs)",
  "have not happened yet, or you are on a pre-seeding SDK release.",
  "",
  "Once seeded, re-run and this example will drive a real faucet-to-settled",
  "hire on devnet. Nothing to do right now — this is expected today.",
].join("\n");

/** Options for {@link runDevnetFirstHire} (all optional). */
export interface RunDevnetFirstHireOptions {
  /** Throw (instead of returning early) when fixtures are unseeded — the nightly uses this. */
  requireSeeded?: boolean;
  /** Override the devnet HTTP RPC endpoint. */
  rpcUrl?: string;
  /** Override the devnet WebSocket endpoint. */
  rpcSubscriptionsUrl?: string;
  /** Override the P2.3 attestor endpoint. */
  attestorUrl?: string;
}

/** Fetch + decode raw account bytes via the sandbox rpc (base64 path). */
async function fetchAccountBytes(
  rpc: SandboxRpc,
  address: Address,
): Promise<Uint8Array | null> {
  const { value } = await rpc
    .getAccountInfo(address, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (value === null) return null;
  return new Uint8Array(getBase64Encoder().encode(value.data[0]));
}

/** Poll until an account exists (moderation PDAs land seconds after attest). */
async function waitForAccount(
  rpc: SandboxRpc,
  address: Address,
  what: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await fetchAccountBytes(rpc, address)) !== null) return;
    if (Date.now() >= deadline) {
      throw new Error(`${what} (${address}) did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/** Short backoff before the single airdrop retry (shared CI runner IPs hit
 * the public faucet's rate limits — one 429 must not turn the nightly red). */
const AIRDROP_RETRY_BACKOFF_MS = 5_000;

/** createSandboxClient with ONE airdrop retry after a short backoff, and a
 * friendlier failure when the faucet keeps rate-limiting. */
async function fundedSandboxClient(
  label: string,
  options: RunDevnetFirstHireOptions,
): Promise<SandboxClient> {
  // One signer across both attempts: if the first airdrop was accepted but
  // landed late, the retry's balance wait picks it up instead of burning a
  // second faucet grant.
  const signer = await generateKeyPairSigner();
  const maxAttempts = 2; // initial try + ONE retry
  for (let attempt = 1; ; attempt += 1) {
    try {
      const sandbox = await createSandboxClient({
        rpcUrl: options.rpcUrl,
        rpcSubscriptionsUrl: options.rpcSubscriptionsUrl,
        signer,
      });
      log(`${label}: throwaway signer ${sandbox.signer.address} funded with devnet SOL`);
      return sandbox;
    } catch (error) {
      if (error instanceof SandboxAirdropError) {
        log(
          `${label}: airdrop attempt ${attempt}/${maxAttempts} failed for ` +
            `${error.address} — ${error.message}`,
        );
        if (attempt < maxAttempts) {
          log(`${label}: retrying once after ${AIRDROP_RETRY_BACKOFF_MS}ms backoff`);
          await new Promise((resolve) =>
            setTimeout(resolve, AIRDROP_RETRY_BACKOFF_MS),
          );
          continue;
        }
      }
      throw error;
    }
  }
}

/**
 * Drive the full devnet sandbox hire: faucet -> register -> list -> attest ->
 * hire -> attest -> claim -> settle. Returns the task PDA on success.
 */
export async function runDevnetFirstHire(
  options: RunDevnetFirstHireOptions = {},
): Promise<Address | undefined> {
  // ---- 0) seeded-fixtures guard: inert until the devnet sandbox exists ----
  if (!SANDBOX_FIXTURES.seeded) {
    if (options.requireSeeded) {
      throw new Error(NOT_SEEDED_MESSAGE);
    }
    log(NOT_SEEDED_MESSAGE);
    return undefined;
  }

  // ---- 1) two funded throwaway actors (buyer + provider) ----
  const buyer = await fundedSandboxClient("buyer", options);
  const provider = await fundedSandboxClient("provider", options);
  const rpc = buyer.rpc;

  // ---- 2) fixture rot-check: the published listing must still be live ----
  const fixture = sandboxListings()[0]!;
  const fixtureBytes = await fetchAccountBytes(rpc, fixture.address);
  if (fixtureBytes === null) {
    throw new Error(
      `sandbox fixture listing ${fixture.address} ("${fixture.name}") is gone ` +
        `on devnet — the sandbox has rotted; re-run scripts/seed-devnet-sandbox.mjs`,
    );
  }
  const fixtureListing = getServiceListingDecoder().decode(fixtureBytes);
  if (fixtureListing.state !== ListingState.Active) {
    throw new Error(
      `sandbox fixture listing ${fixture.address} is no longer Active ` +
        `(state ${ListingState[fixtureListing.state]}) — re-seed the sandbox`,
    );
  }
  if (fixtureListing.price !== BigInt(fixture.priceLamports)) {
    throw new Error(
      `sandbox fixture listing ${fixture.address} price drifted: on-chain ` +
        `${fixtureListing.price}, fixtures say ${fixture.priceLamports} — re-seed`,
    );
  }
  log(`fixtures: "${fixture.name}" is Active at ${fixture.address} (${fixture.priceLamports} lamports)`);

  // ---- 3) provider registers an agent + lists a service ----
  const providerAgentId = randomId32();
  await provider.client.registerAgent({
    authority: provider.signer,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "https://example.invalid/devnet-first-hire/provider",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

  const listingId = randomId32();
  const price = 1_000_000n; // 0.001 devnet SOL
  const listingSpecHash = await descriptionHash(
    "devnet-first-hire example listing: respond with a haiku about escrow",
  );
  await provider.client.createServiceListing({
    providerAgent,
    authority: provider.signer,
    listingId,
    name: "Devnet First Hire",
    category: "other",
    tags: ["sandbox", "example"],
    specHash: listingSpecHash,
    specUri: "agenc://job-spec/sha256/devnet-first-hire",
    price,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  const [listing] = await facade.findListingPda({ providerAgent, listingId });
  log(`provider: listed ${listing}`);

  // ---- 4) CLEAN listing attestation via the P2.3 auto-attestor ----
  await requestSandboxAttestation({
    kind: "listing",
    address: listing,
    specHash: listingSpecHash,
    endpoint: options.attestorUrl,
  });
  const [listingModeration] = await facade.findListingModerationPda({
    listing,
    jobSpecHash: listingSpecHash,
  });
  await waitForAccount(rpc, listingModeration, "ListingModeration");
  log("attestor: listing moderation recorded CLEAN");

  // ---- 5) buyer registers an agent and hires the listing ----
  const buyerAgentId = randomId32();
  await buyer.client.registerAgent({
    authority: buyer.signer,
    agentId: buyerAgentId,
    capabilities: 1n,
    endpoint: "https://example.invalid/devnet-first-hire/buyer",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

  const taskId = randomId32();
  const hireResult = await buyer.client.hireFromListing({
    listing,
    creatorAgent: buyerAgent,
    authority: buyer.signer,
    creator: buyer.signer,
    taskId,
    expectedPrice: price,
    expectedVersion: 1n,
    listingSpecHash,
  });
  const [task] = await findTaskPda({ creator: buyer.signer.address, taskId });
  log(`buyer: hired -> task ${task} (sig ${hireResult.signature})`);

  // ---- 6) CLEAN task attestation + job-spec pin (claim is gated on both) ----
  const jobSpecHash = await descriptionHash(
    "devnet-first-hire example job spec: one haiku about escrow, plain text",
  );
  await requestSandboxAttestation({
    kind: "task",
    address: task,
    specHash: jobSpecHash,
    endpoint: options.attestorUrl,
  });
  const [taskModeration] = await findTaskModerationPda({ task, jobSpecHash });
  await waitForAccount(rpc, taskModeration, "TaskModeration");
  await buyer.client.send([
    await facade.setTaskJobSpec({
      task,
      creator: buyer.signer,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/devnet-first-hire",
    }),
  ]);
  log("buyer: task moderation + job spec pinned");

  // ---- 7) provider claims and settles (direct-pay path for hired tasks) ----
  await provider.client.claimTaskWithJobSpec({
    task,
    worker: providerAgent,
    authority: provider.signer,
  });
  await waitForTaskStatus(rpc, task, TaskStatus.InProgress, {
    timeoutMs: 90_000,
  });
  log("provider: claimed (task InProgress)");

  // complete_task pays the protocol fee to the on-chain treasury — read it.
  const [protocolConfigPda] = await findProtocolConfigPda();
  const configBytes = await fetchAccountBytes(rpc, protocolConfigPda);
  if (configBytes === null) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda} not found on devnet — the program ` +
        `is not initialized (did the P2.2 redeploy run?)`,
    );
  }
  const treasury = getProtocolConfigDecoder().decode(configBytes).treasury;

  const [hireRecord] = await findHireRecordPda({ task });
  const completeResult = await provider.client.send([
    await facade.completeTask({
      task,
      creator: buyer.signer.address,
      worker: providerAgent,
      treasury,
      authority: provider.signer,
      hireRecord,
      proofHash: await descriptionHash("devnet-first-hire example result"),
      resultData: null,
    }),
  ]);
  await waitForTaskStatus(rpc, task, TaskStatus.Completed, {
    timeoutMs: 90_000,
  });
  log(`provider: settled (sig ${completeResult.signature})`);
  log(
    `done — faucet to settled result on devnet. Task: ` +
      `https://explorer.solana.com/address/${task}?cluster=devnet`,
  );
  return task;
}

// Run when invoked directly (e.g. `tsx examples/devnet-first-hire.ts`).
// Guarded so importing `runDevnetFirstHire` (the nightly test does) never
// auto-runs it.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDevnetFirstHire().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
