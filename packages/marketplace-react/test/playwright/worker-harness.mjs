/**
 * worker-harness.mjs — the Node-side scaffolding for the A3 checkout e2e.
 *
 * The browser drives only the BUYER half of the hire flow (the part a real
 * storefront visitor does through `HireCheckoutModal` / `useHire` /
 * `useSubmissionReview`): hire a listing, then accept the submitted result.
 * The WORKER half (moderate the task, publish its job spec, claim, submit a
 * result) has no React hook in the A2 inventory — a real worker agent does it
 * off the storefront — so it runs here in Node against the same live validator,
 * reusing the localnet seeder/moderator keys and the already-seeded provider
 * agent as the worker.
 *
 * This mirrors EXACTLY the scaffolding the litesvm hooks e2e
 * (test/hooks/hooks-e2e.e2e.test.tsx) performs around the buyer hooks, but
 * against the real solana-test-validator booted by test/sandbox-up.mjs.
 *
 * Flow for one humanless (CreatorReview-pinned) task:
 *   1. moderator.recordTaskModeration(task, jobSpecHash)   [CLEAN attestation]
 *   2. buyer.setTaskJobSpec(task, jobSpecHash, jobSpecUri) [creator-signed]
 *   3. worker.claimTaskWithJobSpec(task)
 *   4. worker.submitTaskResult(task, proofHash, resultData) -> PendingValidation
 *
 * After this returns, the browser's `useSubmissionReview().accept(...)` settles
 * the escrow to the worker and the task reaches Completed.
 */
import { readFile } from "node:fs/promises";
import {
  createMarketplaceClient,
  facade,
  getServiceListingDecoder,
  getTaskDecoder,
} from "@tetsuo-ai/marketplace-sdk";

const CLEAN = {
  status: 0, // CLEAN
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32),
  scannerHash: new Uint8Array(32),
  expiresAt: 0n, // never expires
};

/** Load a kit KeyPairSigner from a solana-keygen JSON keypair file. */
export async function loadKeypairSigner(kit, keyPath) {
  const bytes = Uint8Array.from(JSON.parse(await readFile(keyPath, "utf8")));
  return kit.createKeyPairSignerFromBytes(bytes);
}

/** Decode the ServiceListing at `listingAddr` from the live RPC. */
export async function fetchListing(rpc, kit, listingAddr) {
  const info = await rpc
    .getAccountInfo(kit.address(String(listingAddr)), { encoding: "base64" })
    .send();
  if (!info.value) throw new Error(`listing ${listingAddr} not found on chain`);
  const bytes = Uint8Array.from(Buffer.from(info.value.data[0], "base64"));
  return getServiceListingDecoder().decode(bytes);
}

/** Decode the Task at `taskAddr`, or null when absent. */
export async function fetchTask(rpc, kit, taskAddr) {
  const info = await rpc
    .getAccountInfo(kit.address(String(taskAddr)), { encoding: "base64" })
    .send();
  if (!info.value) return null;
  const bytes = Uint8Array.from(Buffer.from(info.value.data[0], "base64"));
  return getTaskDecoder().decode(bytes);
}

/**
 * Run the worker-side scaffolding to take a freshly-hired (Open) humanless task
 * all the way to PendingValidation, ready for the buyer's accept.
 *
 * @param {{
 *   kit: any,
 *   rpcUrl: string,
 *   taskPda: string,
 *   workerAgentPda: string,
 *   seederKeyPath: string,
 *   moderatorKeyPath: string,
 *   buyerSigner: any,
 * }} params
 *   - `kit`: the @solana/kit module
 *   - `rpcUrl`: live validator RPC
 *   - `taskPda`: the hired task PDA (from the browser hire)
 *   - `workerAgentPda`: a registered provider agent PDA (the worker)
 *   - `seederKeyPath`: keypair file that is the provider authority
 *   - `moderatorKeyPath`: keypair file that is the moderation authority
 *   - `buyerSigner`: the task creator's kit signer (to set the job spec)
 * @returns {Promise<{ workerAuthority: string, workerAgent: string }>}
 */
export async function completeWorkerSide(params) {
  const { kit, rpcUrl, taskPda, workerAgentPda, seederKeyPath, moderatorKeyPath } =
    params;
  const rpc = kit.createSolanaRpc(rpcUrl);

  const seeder = await loadKeypairSigner(kit, seederKeyPath); // provider authority
  const moderator = await loadKeypairSigner(kit, moderatorKeyPath);

  // Build clients over the kit RPC WITHOUT rpcSubscriptions so confirmation uses
  // getSignatureStatuses polling (not a ws:// channel) — required under the
  // jsdom fallback test, harmless for the Playwright global-setup (Node) path.
  const workerClient = createMarketplaceClient({ rpc, signer: seeder });
  const moderatorClient = createMarketplaceClient({ rpc, signer: moderator });

  // The buyer (creator) is the task's on-chain authority. We need a creator
  // signer to set the job spec — but the buyer is the BROWSER's embedded wallet.
  // To keep the scaffolding self-contained, the browser exports the buyer's
  // secret key into the harness via params (tests-only); see global-setup.
  if (!params.buyerSigner) {
    throw new Error("completeWorkerSide requires params.buyerSigner (creator)");
  }
  const buyer = params.buyerSigner;
  const buyerClient = createMarketplaceClient({ rpc, signer: buyer });

  const jobSpecHash = new Uint8Array(32).fill(0xab);
  const jobSpecUri = "agenc://job-spec/sha256/e2e-checkout";

  // 1) moderator attests the task CLEAN (fail-closed gate).
  await moderatorClient.send([
    await facade.recordTaskModeration({
      moderator,
      task: kit.address(String(taskPda)),
      jobSpecHash,
      ...CLEAN,
    }),
  ]);

  // 2) buyer (creator) publishes the job spec.
  await buyerClient.send([
    await facade.setTaskJobSpec({
      task: kit.address(String(taskPda)),
      creator: buyer,
      jobSpecHash,
      jobSpecUri,
    }),
  ]);

  // 3) worker claims the task.
  await workerClient.claimTaskWithJobSpec({
    task: kit.address(String(taskPda)),
    worker: kit.address(String(workerAgentPda)),
    authority: seeder,
  });

  // 4) worker submits a result -> PendingValidation.
  await workerClient.submitTaskResult({
    task: kit.address(String(taskPda)),
    worker: kit.address(String(workerAgentPda)),
    authority: seeder,
    proofHash: new Uint8Array(32).fill(0x66),
    resultData: new Uint8Array(64).fill(0x09),
  });

  return {
    workerAuthority: String(seeder.address),
    workerAgent: String(workerAgentPda),
  };
}
