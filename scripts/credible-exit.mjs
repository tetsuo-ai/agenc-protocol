#!/usr/bin/env node
// credible-exit.mjs — PROVE "the operator vanishes and it still works" (PLAN.md P8.6).
//
// Executes an end-to-end hire -> settle cycle with ZERO tetsuo-ai HOSTED
// dependencies, against whatever RPC the env file points at (localnet by
// default — i.e. bring-your-own RPC). It is the runtime half of the
// credible-exit trust artifact documented in docs/CREDIBLE_EXIT.md.
//
// The four hosted dependencies an embedder might fear, and how this script
// dispenses with each:
//   (a) OWN RPC ............. uses env.rpcUrl (the localnet validator here =
//                            bring-your-own RPC). No marketplace-managed proxy.
//   (b) reads WITHOUT the .. discovery uses the SDK gPA path
//       hosted indexer        (listActiveListings / listOpenTasks /
//                            listPinnedJobSpecTasks) straight against the RPC —
//                            no hosted listings indexer, no explorer API.
//   (c) moderation WITHOUT .. registers the operator's OWN moderation attestor
//       the hosted attestor    via the P6.8 registry (assign_moderation_attestor)
//                            and records CLEAN moderation signed by that
//                            self-chosen key. No HTTP attestor service is
//                            contacted (env.attestorUrl is ignored on purpose).
//   (d) artifacts on self- .. the job-spec/result "artifacts" are committed as a
//       chosen storage         hash of a LOCAL file on disk (file:// URI), not
//                            uploaded to marketplace.agenc.tech.
// Settlement (escrow -> claim -> complete -> worker paid + protocol fee) is
// entirely on-chain via the public @tetsuo-ai/marketplace-sdk.
//
// This is the LOCALNET execution. The devnet run is deploy-gated/[HUMAN]; the
// localnet stack runs the REAL full-surface program at the REAL program id, so
// every instruction and SDK call here is identical to devnet/mainnet.
//
// Prereqs: node scripts/localnet-up.mjs is up (writes .localnet/env.json);
// the full-surface .so + built SDK dist exist (the up script checks both).
// This script does NOT need the seeder or any attestor process.
//
// Usage:
//   node scripts/credible-exit.mjs [--env-file <path>] [--json]
//
//   --env-file <p>   environment file (default <repo>/.localnet/env.json)
//   --json           emit a machine-readable proof record to stdout (the human
//                    transcript still goes to stderr)
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_FILE = path.join(ROOT, ".localnet", "env.json");
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const LAMPORTS_PER_SOL = 1_000_000_000n;
const AIRDROP = 5n * LAMPORTS_PER_SOL;

// --- tiny CLI -------------------------------------------------------------
function parseArgs(argv) {
  const args = { envFile: DEFAULT_ENV_FILE, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--env-file") {
      if (!argv[i + 1]) throw new Error("--env-file requires a path");
      args.envFile = path.resolve(argv[++i]);
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "credible-exit — prove a hire->settle cycle with zero hosted deps\n" +
          "USAGE: node scripts/credible-exit.mjs [--env-file <path>] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// The human transcript goes to stderr so --json keeps stdout clean.
const log = (...p) => process.stderr.write(`${p.join(" ")}\n`);
function fail(message) {
  process.stderr.write(`\ncredible-exit: ERROR: ${message}\n`);
  process.exit(1);
}

// descriptionHash(s) = sha256(utf8(NFC(s))) — the SDK's on-chain hash
// convention (packages/sdk-ts/src/values/hash.ts), reimplemented with WebCrypto
// so this script depends on nothing but the public SDK + node builtins.
async function descriptionHash(input) {
  const bytes = new TextEncoder().encode(input.normalize("NFC"));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}
// randomId32() — 32 CSPRNG bytes (packages/sdk-ts/src/values/random.ts).
function randomId32() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}
const hex = (u8) => Buffer.from(u8).toString("hex");

async function airdropTo(rpc, kit, address, lamports) {
  await rpc.requestAirdrop(address, kit.lamports(lamports)).send();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getBalance(address).send();
    if (BigInt(value) >= lamports) return BigInt(value);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`airdrop to ${address} did not land within 30s`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---------------------------------------------------------- env + SDK
  let env;
  try {
    env = JSON.parse(await readFile(args.envFile, "utf8"));
  } catch (e) {
    fail(
      `could not read env file ${args.envFile}: ${e.message}\n` +
        `  Boot the stack first: node scripts/localnet-up.mjs`,
    );
  }
  if (!env.rpcUrl || !env.programId) {
    fail(`env file ${args.envFile} is missing rpcUrl/programId`);
  }
  const kit = await import("@solana/kit");
  const sdk = await import(pathToFileURL(SDK_DIST).href).catch((e) =>
    fail(`could not import built SDK at ${SDK_DIST}: ${e.message}\n  Build it: cd packages/sdk-ts && npm run build`),
  );
  if (sdk.AGENC_COORDINATION_PROGRAM_ADDRESS !== env.programId) {
    fail(`SDK program ${sdk.AGENC_COORDINATION_PROGRAM_ADDRESS} != env ${env.programId}`);
  }

  const rpc = kit.createSolanaRpc(env.rpcUrl);
  if ((await rpc.getHealth().send()) !== "ok") {
    fail(`RPC ${env.rpcUrl} is not healthy — is the validator up?`);
  }

  log("=".repeat(72));
  log("AgenC credible-exit walkthrough (P8.6): hire -> settle, ZERO hosted deps");
  log("=".repeat(72));
  log(`(a) OWN RPC          : ${env.rpcUrl}  [cluster=${env.cluster}]`);
  log(`    program          : ${env.programId} (real id, upgradeable)`);
  log(`    hosted indexer    : NOT USED (discovery via SDK gPA path)`);
  log(`    hosted attestor   : NOT USED (own P6.8 attestor; env.attestorUrl=${env.attestorUrl})`);
  log(`    hosted storage    : NOT USED (artifacts are local file:// hashes)`);
  log("");

  const proof = {
    artifact: "P8.6 credible-exit",
    executedAt: new Date().toISOString(),
    cluster: env.cluster,
    rpcUrl: env.rpcUrl,
    programId: env.programId,
    hostedDependenciesUsed: [],
    signatures: {},
    accounts: {},
  };

  // The protocol authority key (held locally) is the only pre-existing actor we
  // reuse — on a real deploy this is the human operator's own upgrade/authority
  // key, NOT a tetsuo-hosted service. It is needed ONLY to register the
  // operator's own attestor on the P6.8 roster (assign_moderation_attestor is
  // authority-gated). The buyer, provider, and attestor below are all fresh
  // throwaway keys this process generates.
  if (!env.keypairs?.authority) {
    fail("env.keypairs.authority is required (the operator's own protocol authority key)");
  }
  const authoritySigner = await kit.createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(await readFile(env.keypairs.authority, "utf8"))),
  );

  // ------------------------------------------------- read the protocol config
  // via a plain RPC fetch through the public SDK decoder (no hosted API).
  const [protocolConfigPda] = await sdk.findProtocolConfigPda();
  const protocol = await sdk.fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (!protocol.exists) fail(`ProtocolConfig ${protocolConfigPda} not found — run localnet-up`);
  const stakeAmount = protocol.data.minAgentStake;
  const treasury = protocol.data.treasury;
  log(`ProtocolConfig: minAgentStake=${stakeAmount} treasury=${treasury} feeBps=${protocol.data.protocolFeeBps}`);

  const [moderationConfigPda] = await sdk.findModerationConfigPda();
  const moderation = await sdk.fetchMaybeModerationConfig(rpc, moderationConfigPda);
  if (!moderation.exists) fail(`ModerationConfig ${moderationConfigPda} not found — run localnet-up`);
  log(`ModerationConfig: authority=${moderation.data.authority} moderationAuthority=${moderation.data.moderationAuthority} enabled=${moderation.data.enabled}`);
  if (moderation.data.authority !== authoritySigner.address) {
    fail(
      `assign_moderation_attestor requires the signer == ModerationConfig.authority\n` +
        `  config.authority=${moderation.data.authority} but loaded authority key=${authoritySigner.address}`,
    );
  }
  log("");

  // The operator's OWN moderation_authority key. On a self-hosted deploy this is
  // the key the operator passed to `configure_task_moderation` — they hold it,
  // not tetsuo. On localnet that key is .localnet/keys/moderator.json. The
  // fail-closed CONSUMPTION gates (hire_from_listing / set_task_job_spec) honor
  // ONLY attestations recorded by THIS key (see the P6.8 boundary note below),
  // so the credible-exit moderation story is: the operator runs their own
  // moderation_authority and signs CLEAN locally — no hosted attestor service.
  if (!env.keypairs?.moderator) {
    fail("env.keypairs.moderator is required (the operator's own moderation_authority key)");
  }
  const moderatorSigner = await kit.createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(await readFile(env.keypairs.moderator, "utf8"))),
  );
  if (moderatorSigner.address !== moderation.data.moderationAuthority) {
    fail(
      `loaded moderator key ${moderatorSigner.address} != ` +
        `ModerationConfig.moderationAuthority ${moderation.data.moderationAuthority}`,
    );
  }
  const moderatorClient = sdk.createMarketplaceClient({ rpcUrl: env.rpcUrl, signer: moderatorSigner });

  // ============================================================= STEP 1
  // (c) Register the operator's OWN moderation attestor (P6.8 registry MECHANISM).
  // This proves the registry works WITHOUT any tetsuo hosted attestor service: a
  // fresh key the operator controls is added to the on-chain roster and can
  // WRITE moderation attestations.
  //
  // HONEST BOUNDARY (documented in docs/CREDIBLE_EXIT.md): the P6.8 roster widens
  // who can *record* an attestation, but the fail-closed *consumption* gates
  // (hire_from_listing / set_task_job_spec) currently require
  // `moderation.moderator == moderation_config.moderation_authority` — i.e. only
  // an attestation written by the SINGLE global moderation_authority key unlocks
  // a hire/claim. A delegated roster attestor's record does NOT yet satisfy the
  // hire gate. So the credible-exit moderation independence rests on the operator
  // holding the moderation_authority key (which they do on a self-hosted deploy),
  // not on the roster. We demonstrate BOTH below and assert the boundary.
  log("STEP 1  register OWN moderation attestor (P6.8 registry) — no hosted attestor");
  const ownAttestor = await kit.generateKeyPairSigner();
  await airdropTo(rpc, kit, ownAttestor.address, AIRDROP); // pays its own tx fees
  const authorityClient = sdk.createMarketplaceClient({ rpcUrl: env.rpcUrl, signer: authoritySigner });
  const [attestorRosterPda] = await sdk.facade.findModerationAttestorPda({ attestor: ownAttestor.address });

  const existingRoster = await rpc.getAccountInfo(attestorRosterPda, { encoding: "base64" }).send();
  if (existingRoster.value) {
    log(`   roster entry already exists at ${attestorRosterPda} (converging)`);
  } else {
    const assignSig = await authorityClient.send([
      await sdk.facade.assignModerationAttestor({
        authority: authoritySigner,
        attestor: ownAttestor.address,
      }),
    ]);
    proof.signatures.assignModerationAttestor = assignSig.signature;
    log(`   assigned attestor ${ownAttestor.address}`);
    log(`   roster PDA ${attestorRosterPda}  sig ${assignSig.signature}`);
  }
  proof.accounts.ownAttestor = ownAttestor.address;
  proof.accounts.attestorRoster = attestorRosterPda;
  proof.accounts.moderationAuthority = moderatorSigner.address;
  log(`   moderation_authority (consumption-gate key, operator-held): ${moderatorSigner.address}`);
  log("");

  // Two funded throwaway actors. A hired task can only be claimed/settled by the
  // listing's provider agent, so we need both a BUYER client and a PROVIDER.
  const buyer = await kit.generateKeyPairSigner();
  const provider = await kit.generateKeyPairSigner();
  await airdropTo(rpc, kit, buyer.address, AIRDROP);
  await airdropTo(rpc, kit, provider.address, AIRDROP);
  const buyerClient = sdk.createMarketplaceClient({ rpcUrl: env.rpcUrl, signer: buyer });
  const providerClient = sdk.createMarketplaceClient({ rpcUrl: env.rpcUrl, signer: provider });
  const attestorClient = sdk.createMarketplaceClient({ rpcUrl: env.rpcUrl, signer: ownAttestor });
  log(`actors: buyer=${buyer.address} provider=${provider.address}`);
  log("");

  // ============================================================= STEP 2
  // Provider registers an agent and creates a listing. (d) The listing's spec
  // is committed as the hash of a LOCAL file — self-chosen storage, file:// URI.
  log("STEP 2  provider registers agent + lists a service (artifact = LOCAL file)");
  const workDir = await mkdtemp(path.join(tmpdir(), "agenc-credible-exit-"));
  const listingSpecPath = path.join(workDir, "listing-spec.txt");
  const listingSpecText =
    "AgenC credible-exit listing spec\nDeliverable: reverse a string and return it. Self-hosted artifact.\n";
  await writeFile(listingSpecPath, listingSpecText);
  const listingSpecUri = pathToFileURL(listingSpecPath).href; // file:// — NOT marketplace.agenc.tech
  const listingSpecHash = await descriptionHash(listingSpecText);

  const providerAgentId = randomId32();
  await providerClient.registerAgent({
    authority: provider,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "https://operator.example/credible-exit/provider",
    metadataUri: null,
    stakeAmount,
  });
  const [providerAgent] = await sdk.findAgentPda({ agentId: providerAgentId });

  const listingId = randomId32();
  const price = 1_000_000n; // 0.001 SOL
  await providerClient.createServiceListing({
    providerAgent,
    authority: provider,
    listingId,
    name: "Credible Exit Service",
    category: "other",
    tags: ["credible-exit", "self-hosted"],
    specHash: listingSpecHash,
    specUri: listingSpecUri,
    price,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  const [listing] = await sdk.facade.findListingPda({ providerAgent, listingId });
  proof.accounts.listing = listing;
  proof.accounts.providerAgent = providerAgent;
  log(`   provider agent ${providerAgent}`);
  log(`   listing        ${listing}`);
  log(`   spec artifact  ${listingSpecUri}  (sha256 ${hex(listingSpecHash).slice(0, 16)}…)`);
  log("");

  // ============================================================= STEP 3
  // (b) DISCOVERY VIA gPA — find the listing with NO hosted indexer. The SDK
  // listActiveListings(rpc, ...) issues getProgramAccounts straight against the
  // bring-your-own RPC and decodes on the client.
  log("STEP 3  discover the listing via SDK gPA reads (NO hosted indexer)");
  const activeListings = await sdk.listActiveListings(rpc, { provider: providerAgent });
  const found = activeListings.find(({ address }) => address === listing);
  if (!found) fail(`gPA listActiveListings did not return the just-created listing ${listing}`);
  log(`   listActiveListings(rpc) -> ${activeListings.length} Active listing(s); ours present`);
  log(`   decoded price=${found.account.price} state=${found.account.state} (gPA, not hosted)`);
  log("");

  // ============================================================= STEP 4
  // (c) Self-attest the listing CLEAN with the operator's OWN
  // moderation_authority key (NOT a hosted attestor service). The hire-time
  // consumption gate honors ONLY an attestation written by this key (see STEP 1
  // boundary note), so this is the attestation that actually unlocks the hire.
  log("STEP 4  attest listing CLEAN with OWN moderation_authority (NO hosted attestor)");
  const cleanArgs = {
    status: 0, // CLEAN
    riskScore: 0,
    categoryMask: 0n,
    policyHash: new Uint8Array(32), // operator's own (empty) policy commitment
    scannerHash: new Uint8Array(32),
    expiresAt: 0n,
  };
  const listingAttestSig = await moderatorClient.send([
    await sdk.facade.recordListingModeration({
      moderator: moderatorSigner, // the operator's own moderation_authority signs
      listing,
      jobSpecHash: listingSpecHash,
      ...cleanArgs,
    }),
  ]);
  proof.signatures.recordListingModeration = listingAttestSig.signature;
  const [listingModeration] = await sdk.facade.findListingModerationPda({
    listing,
    jobSpecHash: listingSpecHash,
  });
  const lmod = await sdk.fetchMaybeListingModeration(rpc, listingModeration);
  if (!lmod.exists || lmod.data.status !== 0) {
    fail(`ListingModeration ${listingModeration} not CLEAN after self-attest`);
  }
  proof.accounts.listingModeration = listingModeration;
  log(`   recordListingModeration signed by OWN moderation_authority`);
  log(`   ListingModeration ${listingModeration} status=CLEAN  sig ${listingAttestSig.signature}`);
  log("");

  // ----- P6.8 boundary demonstration (HONEST): the own ROSTER attestor CAN
  // WRITE a moderation record (registry mechanism works with no hosted service),
  // but the hire/claim CONSUMPTION gates do NOT honor it — only the
  // moderation_authority's record above does. We prove the write succeeds on a
  // throwaway listing-spec hash (a different PDA, so it never collides with the
  // consumed attestation), then note that this record could not unlock a hire.
  const rosterDemoHash = await descriptionHash("p6.8 roster-attestor write demonstration");
  const rosterDemoSig = await attestorClient.send([
    await sdk.facade.recordListingModeration({
      moderator: ownAttestor, // the P6.8 ROSTER attestor signs
      moderationAttestor: attestorRosterPda, // roster entry authorizes the WRITE
      listing,
      jobSpecHash: rosterDemoHash,
      ...cleanArgs,
    }),
  ]);
  proof.signatures.rosterAttestorWriteDemo = rosterDemoSig.signature;
  log(`   [P6.8] roster attestor WROTE a record (sig ${rosterDemoSig.signature.slice(0, 12)}…)`);
  log(`   [P6.8] but consumption gates honor only moderation_authority — boundary noted`);
  log("");

  // ============================================================= STEP 5
  // Buyer registers + hires from the listing. Escrow + task + hire record minted
  // in one on-chain instruction.
  log("STEP 5  buyer registers + hires from listing (escrow funded on-chain)");
  const buyerAgentId = randomId32();
  await buyerClient.registerAgent({
    authority: buyer,
    agentId: buyerAgentId,
    capabilities: 1n,
    endpoint: "https://operator.example/credible-exit/buyer",
    metadataUri: null,
    stakeAmount,
  });
  const [buyerAgent] = await sdk.findAgentPda({ agentId: buyerAgentId });

  const taskId = randomId32();
  const hireResult = await buyerClient.hireFromListing({
    listing,
    creatorAgent: buyerAgent,
    authority: buyer,
    creator: buyer,
    taskId,
    expectedPrice: price,
    expectedVersion: 1n,
    listingSpecHash,
  });
  const [task] = await sdk.findTaskPda({ creator: buyer.address, taskId });
  proof.signatures.hireFromListing = hireResult.signature;
  proof.accounts.task = task;
  proof.accounts.buyerAgent = buyerAgent;
  log(`   hired -> task ${task}`);
  log(`   hire sig ${hireResult.signature}`);
  log("");

  // ============================================================= STEP 6
  // (c)+(d) Attest the TASK CLEAN with the operator's OWN moderation_authority,
  // and pin the job-spec pointer to a LOCAL result artifact (file:// URI). Claim
  // is gated on both the task attestation and the pinned job spec — and, like
  // the hire gate, set_task_job_spec honors only the moderation_authority's
  // attestation.
  log("STEP 6  attest task CLEAN (OWN moderation_authority) + pin job-spec (LOCAL file)");
  const jobSpecPath = path.join(workDir, "job-spec.txt");
  const jobSpecText = "AgenC credible-exit job spec\nInput: \"escrow\" -> Output: \"worcse\". Plain text.\n";
  await writeFile(jobSpecPath, jobSpecText);
  const jobSpecUri = pathToFileURL(jobSpecPath).href;
  const jobSpecHash = await descriptionHash(jobSpecText);

  const taskAttestSig = await moderatorClient.send([
    await sdk.facade.recordTaskModeration({
      moderator: moderatorSigner,
      task,
      jobSpecHash,
      ...cleanArgs,
    }),
  ]);
  proof.signatures.recordTaskModeration = taskAttestSig.signature;
  const [taskModeration] = await sdk.findTaskModerationPda({ task, jobSpecHash });
  const tmod = await sdk.fetchMaybeTaskModeration(rpc, taskModeration);
  if (!tmod.exists || tmod.data.status !== 0) fail(`TaskModeration ${taskModeration} not CLEAN`);
  proof.accounts.taskModeration = taskModeration;

  const pinSig = await buyerClient.send([
    await sdk.facade.setTaskJobSpec({
      task,
      creator: buyer,
      jobSpecHash,
      jobSpecUri,
    }),
  ]);
  proof.signatures.setTaskJobSpec = pinSig.signature;
  log(`   TaskModeration ${taskModeration} status=CLEAN  sig ${taskAttestSig.signature}`);
  log(`   job spec pinned ${jobSpecUri}  sig ${pinSig.signature}`);
  log("");

  // ============================================================= STEP 6b
  // (b) Confirm the task is claimable purely from gPA reads — listOpenTasks +
  // listPinnedJobSpecTasks, the exact set a worker would discover with no
  // hosted indexer.
  log("STEP 6b verify task is claimable via gPA (listOpenTasks ∩ pinned specs)");
  const openTasks = await sdk.listOpenTasks(rpc, { creator: buyer.address });
  const pinned = await sdk.listPinnedJobSpecTasks(rpc);
  const claimable = openTasks.some(({ address }) => address === task) && pinned.has(task);
  if (!claimable) fail(`task ${task} not discoverable as claimable via gPA`);
  log(`   listOpenTasks(rpc) sees the task AND listPinnedJobSpecTasks(rpc) confirms a pinned spec`);
  log("");

  // ============================================================= STEP 7
  // Provider claims and settles. complete_task pays the worker + the protocol
  // fee to the on-chain treasury. We measure the real balance deltas as proof
  // the worker actually got paid.
  log("STEP 7  provider claims + completes — worker paid on-chain (escrow settled)");
  const providerBalBefore = BigInt((await rpc.getBalance(provider.address).send()).value);
  const treasuryBalBefore = BigInt((await rpc.getBalance(treasury).send()).value);

  await providerClient.claimTaskWithJobSpec({
    task,
    worker: providerAgent,
    authority: provider,
  });
  await sdk.waitForTaskStatus(rpc, task, sdk.TaskStatus.InProgress, { timeoutMs: 90_000 });
  log(`   provider claimed (task InProgress)`);

  const [hireRecord] = await sdk.findHireRecordPda({ task });
  const resultHash = await descriptionHash("worcse"); // the self-hosted result commitment
  const completeResult = await providerClient.send([
    await sdk.facade.completeTask({
      task,
      creator: buyer.address,
      worker: providerAgent,
      treasury,
      authority: provider,
      hireRecord,
      proofHash: resultHash,
      resultData: null,
    }),
  ]);
  await sdk.waitForTaskStatus(rpc, task, sdk.TaskStatus.Completed, { timeoutMs: 90_000 });
  proof.signatures.completeTask = completeResult.signature;
  log(`   provider completed  sig ${completeResult.signature}`);

  // -------------------------------------------------- on-chain final state
  const finalTask = await sdk.fetchMaybeTask(rpc, task);
  if (!finalTask.exists) fail(`task ${task} vanished after completion`);
  const status = finalTask.data.status;
  const reward = finalTask.data.rewardAmount;
  const providerBalAfter = BigInt((await rpc.getBalance(provider.address).send()).value);
  const treasuryBalAfter = BigInt((await rpc.getBalance(treasury).send()).value);
  const providerDelta = providerBalAfter - providerBalBefore;
  const treasuryDelta = treasuryBalAfter - treasuryBalBefore;
  const expectedFee = (reward * BigInt(protocol.data.protocolFeeBps)) / 10_000n;

  proof.finalState = {
    taskStatus: status, // 3 == Completed
    taskStatusName: sdk.TaskStatus[status] ?? String(status),
    rewardAmount: reward.toString(),
    providerLamportsDelta: providerDelta.toString(),
    treasuryLamportsDelta: treasuryDelta.toString(),
    protocolFeeBps: protocol.data.protocolFeeBps,
    expectedProtocolFee: expectedFee.toString(),
    treasuryFeeMatches: treasuryDelta === expectedFee,
    workerPaid: providerDelta > 0n,
  };

  if (status !== sdk.TaskStatus.Completed) fail(`task status ${status} != Completed`);
  if (treasuryDelta !== expectedFee) {
    fail(`treasury delta ${treasuryDelta} != expected protocol fee ${expectedFee}`);
  }
  if (providerDelta <= 0n) fail(`provider was not paid (delta ${providerDelta})`);

  log("");
  log("-".repeat(72));
  log(`RESULT: task ${task}`);
  log(`  status               = ${proof.finalState.taskStatusName} (on-chain)`);
  log(`  reward               = ${reward} lamports`);
  log(`  treasury delta       = ${treasuryDelta} lamports (= ${protocol.data.protocolFeeBps} bps fee, matches)`);
  log(`  provider net delta   = ${providerDelta} lamports (payout minus its own tx fees)`);
  log(`  worker paid          = YES`);
  log("-".repeat(72));
  log("");
  log("ZERO tetsuo-hosted dependencies used:");
  log(`  RPC      : own (${env.rpcUrl})`);
  log(`  reads    : SDK gPA (listActiveListings / listOpenTasks / listPinnedJobSpecTasks)`);
  log(`  moderation: own moderation_authority (${moderatorSigner.address}) + own P6.8`);
  log(`             roster attestor (${ownAttestor.address}); NO HTTP attestor service`);
  log(`  artifacts: local file:// (${workDir})`);
  log(`  settlement: on-chain escrow -> claim -> complete`);
  log("");
  log("credible-exit: PROVEN.");

  // Clean up the local artifact dir (its hashes are already committed on-chain).
  await rm(workDir, { recursive: true, force: true });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`\ncredible-exit: ERROR: ${error?.stack ?? error}\n`);
  process.exit(1);
});
