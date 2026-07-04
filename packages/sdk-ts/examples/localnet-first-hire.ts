// Localnet first hire — the fresh-clone, faucet-to-settled-result story
// (PLAN.md P2.4 / WP-D4: the sandbox on-ramp defaults to a stack you can
// actually run).
//
// This is a REAL, COMPILING example (checked by `npm run examples:check`)
// that BROADCASTS REAL TRANSACTIONS against the documented one-command
// localnet stack — the SDK's shipped sandbox default. The same file drives
// public devnet through the environment seam once devnet is redeployed +
// seeded (the nightly test runs it with `cluster: "devnet"`).
//
// ## How to run, from a fresh clone (all paths repo-root relative)
//
//   1. anchor build                                # compile the program (once)
//   2. (cd packages/sdk-ts && npm install && npm run build)
//   3. node scripts/localnet-up.mjs                # validator + program + configs
//   4. node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs
//      # no flags needed: it picks up .localnet/env.json automatically and
//      # writes the seeded fixtures to .localnet/fixtures.json
//   5. (cd packages/sdk-ts && npx tsx examples/localnet-first-hire.ts)
//
// No environment variables are needed: this example auto-discovers the
// canonical `.localnet/env.json` the stack writes (cluster, RPC endpoints,
// optional attestor URL, fixtures path, moderator keypair path). Every value
// can still be overridden — explicit options beat the `AGENC_SANDBOX_*`
// environment variables, which beat the env file, which beats the shipped
// defaults.
//
// What it does, end to end, with nothing but the local faucet:
//   1. createSandboxClient() x2 — throwaway keys, 2 SOL airdrops (one client
//      plays the BUYER, one the PROVIDER; both sides are needed because a
//      hired task can only be claimed/settled by the listing's provider).
//   2. Fixture rot-check — decode a seeded fixtures listing on-chain and
//      verify it is still Active at the published address/price. (The seeded
//      providers' keys are held by the seeding operator, so the settlement
//      below runs on a fresh listing this process controls; hiring a fixture
//      listing works exactly the same way.)
//   3. Provider registers an agent + creates an Active listing, and the
//      listing is attested CLEAN — via the HTTP auto-attestor when one is
//      configured, otherwise directly with the localnet moderator keypair
//      (the same fallback the seeder uses; no extra service required).
//   4. Buyer runs `hireAndActivate` — the blessed open-SDK hire
//      orchestration (WP-D6): hire_from_listing_humanless → host/moderate
//      the buyer-specific job spec (attested CLEAN the same way) →
//      set_task_job_spec. After this the task is claimable.
//   5. Provider claims (waitForTaskStatus -> InProgress) and submits the
//      result; the buyer accepts it (humanless-hired tasks force
//      CreatorReview validation, so settlement is the Task Validation V2
//      submit -> accept flow), and we waitForTaskStatus -> Completed.
//
// LOCALNET/DEVNET ONLY. Throwaway keys. Never real funds.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase64Encoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  createMarketplaceClient,
  facade,
  findAgentPda,
  findHireRecordPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskModerationPda,
  getModerationConfigDecoder,
  getProtocolConfigDecoder,
  getServiceListingDecoder,
  hireAndActivate,
  ListingState,
  TaskStatus,
  waitForTaskStatus,
} from "../src/index.js";
import { descriptionHash, randomId32 } from "../src/values/index.js";
import {
  createSandboxClient,
  requestSandboxAttestation,
  resolveSandboxEnvironment,
  sandboxListings,
  SandboxAirdropError,
  type SandboxClient,
  type SandboxCluster,
  type SandboxEnvironment,
  type SandboxFixtures,
  type SandboxRpc,
} from "../src/sandbox/index.js";

// eslint-disable-next-line no-console
const log = (...parts: unknown[]): void => console.log(...parts);

/** Canonical env file the localnet stack writes (repo root, gitignored). */
const DEFAULT_ENV_FILE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.localnet/env.json",
);

const NOT_SEEDED_MESSAGE = [
  "localnet-first-hire: the resolved sandbox is NOT seeded yet, so this",
  "example did not broadcast anything.",
  "",
  "The resolved fixtures have seeded: false. Seed the localnet stack first",
  "(all commands from the repo root):",
  "",
  "  node scripts/localnet-up.mjs",
  "  node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs",
  "",
  "The seeder picks up .localnet/env.json automatically and writes the",
  "seeded fixtures to .localnet/fixtures.json; re-running this example then",
  "finds both through the same env file. (For devnet, the SHIPPED fixtures",
  "stay unseeded until a public devnet seeding run ships in a release.)",
].join("\n");

/** The subset of `.localnet/env.json` this example consumes. */
interface LocalnetEnvFile {
  cluster?: string;
  rpcUrl?: string;
  rpcSubscriptionsUrl?: string;
  attestorUrl?: string | null;
  fixturesPath?: string | null;
  keypairs?: { moderator?: string } | null;
}

/** Options for {@link runFirstHire} (all optional). */
export interface RunFirstHireOptions {
  /** Throw (instead of returning early) when fixtures are unseeded — the nightly uses this. */
  requireSeeded?: boolean;
  /** Override the target cluster (beats AGENC_SANDBOX_CLUSTER and the env file). */
  cluster?: SandboxCluster;
  /** Override the HTTP RPC endpoint (beats AGENC_SANDBOX_RPC_URL). */
  rpcUrl?: string;
  /** Override the WebSocket endpoint (beats AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL). */
  rpcSubscriptionsUrl?: string;
  /** Override the P2.3 attestor endpoint (beats AGENC_SANDBOX_ATTESTOR_URL). */
  attestorUrl?: string;
  /** Override the sandbox fixtures (beats AGENC_SANDBOX_FIXTURES). */
  fixtures?: SandboxFixtures;
  /**
   * Path to a moderation-authority keypair JSON used to record CLEAN
   * attestations directly when no attestor endpoint is configured (beats the
   * env file's `keypairs.moderator`).
   */
  moderatorKeypairPath?: string;
  /** Override the env-file path (default: the canonical `.localnet/env.json`). */
  envFilePath?: string;
}

/** Read a non-empty env var (mirrors the seam's trimming rules). */
function envVar(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Load + minimally validate the `.localnet/env.json` convention file. */
async function loadEnvFile(filePath: string): Promise<LocalnetEnvFile> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`env file ${filePath} is not a JSON object`);
  }
  return parsed as LocalnetEnvFile;
}

/** Load a fixtures JSON file (the seeder's `.localnet/fixtures.json`). */
async function loadFixturesFile(filePath: string): Promise<SandboxFixtures> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { seeded?: unknown }).seeded !== "boolean" ||
    !Array.isArray((parsed as { listings?: unknown }).listings)
  ) {
    throw new Error(
      `fixtures file ${filePath} does not look like a SandboxFixtures object ` +
        `— re-run the seeder (scripts/seed-devnet-sandbox.mjs)`,
    );
  }
  return parsed as SandboxFixtures;
}

/** Load a Solana keypair JSON (64-byte array) as a kit signer. */
async function loadKeypairSigner(filePath: string): Promise<KeyPairSigner> {
  const bytes = Uint8Array.from(
    JSON.parse(await readFile(filePath, "utf8")) as number[],
  );
  return await createKeyPairSignerFromBytes(bytes);
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

/** Lowercase hex of a 32-byte hash (for URIs and logs). */
function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Short backoff before the single airdrop retry (shared CI runner IPs hit
 * the public faucet's rate limits — one 429 must not turn the nightly red). */
const AIRDROP_RETRY_BACKOFF_MS = 5_000;

/** createSandboxClient with ONE airdrop retry after a short backoff, and a
 * friendlier failure when the faucet keeps rate-limiting. */
async function fundedSandboxClient(
  label: string,
  environment: SandboxEnvironment,
): Promise<SandboxClient> {
  // One signer across both attempts: if the first airdrop was accepted but
  // landed late, the retry's balance wait picks it up instead of burning a
  // second faucet grant.
  const signer = await generateKeyPairSigner();
  const maxAttempts = 2; // initial try + ONE retry
  for (let attempt = 1; ; attempt += 1) {
    try {
      const sandbox = await createSandboxClient({
        rpcUrl: environment.rpcUrl,
        rpcSubscriptionsUrl: environment.rpcSubscriptionsUrl,
        signer,
      });
      log(`${label}: throwaway signer ${sandbox.signer.address} funded with ${environment.cluster} SOL`);
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
 * Drive the full sandbox hire: faucet -> register -> list -> attest ->
 * hireAndActivate -> claim -> settle. Returns the task PDA on success.
 */
export async function runFirstHire(
  options: RunFirstHireOptions = {},
): Promise<Address | undefined> {
  // ---- 0) the environment seam, env-file aware ----
  // Per-field precedence: explicit options > AGENC_SANDBOX_* env vars >
  // .localnet/env.json > shipped defaults. The env file only fills fields no
  // option/env var already sets (the seam itself gives options > env vars),
  // and it is ignored entirely when an explicit cluster disagrees with it —
  // e.g. the devnet nightly must never inherit localnet endpoints.
  const envFilePath = options.envFilePath ?? DEFAULT_ENV_FILE_PATH;
  let envFile: LocalnetEnvFile | null = null;
  if (existsSync(envFilePath)) {
    envFile = await loadEnvFile(envFilePath);
    const explicitCluster = options.cluster ?? envVar("AGENC_SANDBOX_CLUSTER");
    if (
      explicitCluster !== undefined &&
      envFile.cluster !== undefined &&
      explicitCluster !== envFile.cluster
    ) {
      log(
        `env file ${envFilePath} targets cluster ${envFile.cluster}; ` +
          `ignoring it for this explicit ${explicitCluster} run`,
      );
      envFile = null;
    } else {
      log(`env file: ${envFilePath} (cluster ${envFile.cluster ?? "unset"})`);
    }
  }

  // Env-file fixtures: only when nothing above it names fixtures.
  let fixtures = options.fixtures;
  if (
    fixtures === undefined &&
    envVar("AGENC_SANDBOX_FIXTURES") === undefined &&
    typeof envFile?.fixturesPath === "string" &&
    existsSync(envFile.fixturesPath)
  ) {
    fixtures = await loadFixturesFile(envFile.fixturesPath);
  }

  const environment = await resolveSandboxEnvironment({
    cluster:
      options.cluster ??
      (envVar("AGENC_SANDBOX_CLUSTER") === undefined
        ? (envFile?.cluster as SandboxCluster | undefined)
        : undefined),
    rpcUrl:
      options.rpcUrl ??
      (envVar("AGENC_SANDBOX_RPC_URL") === undefined
        ? envFile?.rpcUrl
        : undefined),
    rpcSubscriptionsUrl:
      options.rpcSubscriptionsUrl ??
      (envVar("AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL") === undefined
        ? envFile?.rpcSubscriptionsUrl
        : undefined),
    attestorUrl:
      options.attestorUrl ??
      (envVar("AGENC_SANDBOX_ATTESTOR_URL") === undefined
        ? (envFile?.attestorUrl ?? undefined)
        : undefined),
    fixtures,
  });
  log(`environment: cluster ${environment.cluster}, rpc ${environment.rpcUrl}`);

  // ---- 0b) seeded-fixtures guard: inert until the resolved sandbox exists --
  if (!environment.fixtures.seeded) {
    if (options.requireSeeded) {
      throw new Error(NOT_SEEDED_MESSAGE);
    }
    log(NOT_SEEDED_MESSAGE);
    return undefined;
  }

  // ---- 1) two funded throwaway actors (buyer + provider) ----
  const buyer = await fundedSandboxClient("buyer", environment);
  const provider = await fundedSandboxClient("provider", environment);
  const rpc = buyer.rpc;

  // ---- 2) fixture rot-check: the published listing must still be live ----
  const fixture = sandboxListings(environment.fixtures)[0]!;
  const fixtureBytes = await fetchAccountBytes(rpc, fixture.address);
  if (fixtureBytes === null) {
    throw new Error(
      `sandbox fixture listing ${fixture.address} ("${fixture.name}") is gone ` +
        `on ${environment.cluster} — the sandbox has rotted; re-run ` +
        `scripts/seed-devnet-sandbox.mjs (it picks up .localnet/env.json ` +
        `automatically for a localnet stack)`,
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

  // ---- 2b) protocol config: register_agent enforces stake_amount >=
  // min_agent_stake (the initialize_protocol floor is 0.001 SOL, so a 0n
  // stake fails with InsufficientStake on any properly initialized cluster),
  // and complete_task later pays the protocol fee to the on-chain treasury.
  const [protocolConfigPda] = await findProtocolConfigPda();
  const configBytes = await fetchAccountBytes(rpc, protocolConfigPda);
  if (configBytes === null) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda} not found on ${environment.cluster} ` +
        `— the program is not initialized (localnet: did scripts/localnet-up.mjs ` +
        `finish its config-init step? devnet: did the P2.2 redeploy run?)`,
    );
  }
  const protocolConfig = getProtocolConfigDecoder().decode(configBytes);
  const stakeAmount = protocolConfig.minAgentStake;
  const treasury = protocolConfig.treasury;
  log(`protocol: minAgentStake ${stakeAmount} lamports, treasury ${treasury}`);

  // P1.2: consumption gates (hire + set_task_job_spec) take an explicit
  // `moderator` argument — the pubkey whose attestations this flow consumes.
  // Both attestation paths below record as the GLOBAL moderation authority,
  // so read it once from the on-chain ModerationConfig.
  const [moderationConfigPda] = await findModerationConfigPda();
  const moderationConfigBytes = await fetchAccountBytes(rpc, moderationConfigPda);
  if (moderationConfigBytes === null) {
    throw new Error(
      `ModerationConfig ${moderationConfigPda} not found on ${environment.cluster} ` +
        `— the moderation gate is not configured (re-run the cluster init step)`,
    );
  }
  const moderator = getModerationConfigDecoder().decode(
    moderationConfigBytes,
  ).moderationAuthority;
  log(`moderation: global moderation authority ${moderator}`);

  // ---- 2c) the attestation strategy: HTTP attestor when configured,
  // otherwise the moderator keypair directly (the localnet stack's
  // no-extra-service path — the same fallback the seeder uses).
  const moderatorKeypairPath =
    options.moderatorKeypairPath ?? envFile?.keypairs?.moderator;
  let attest: (
    kind: "listing" | "task",
    address: Address,
    specHash: Uint8Array,
  ) => Promise<void>;
  if (environment.attestorUrl !== null) {
    const attestorUrl = environment.attestorUrl;
    log(`attestation: via HTTP attestor ${attestorUrl}`);
    attest = async (kind, address, specHash) => {
      await requestSandboxAttestation({
        kind,
        address,
        specHash,
        endpoint: attestorUrl,
      });
    };
  } else if (moderatorKeypairPath !== undefined) {
    const moderatorSigner = await loadKeypairSigner(moderatorKeypairPath);
    if (moderatorSigner.address !== moderator) {
      throw new Error(
        `moderator keypair ${moderatorKeypairPath} (${moderatorSigner.address}) ` +
          `is not the on-chain global moderation authority (${moderator}) — ` +
          `its attestations would not pass the fail-closed hire gate. ` +
          `Re-run the localnet stack, or point the example at the right key.`,
      );
    }
    const moderatorClient = createMarketplaceClient({
      rpcUrl: environment.rpcUrl,
      signer: moderatorSigner,
    });
    log(`attestation: directly via moderator keypair ${moderatorSigner.address}`);
    const clean = {
      status: 0, // CLEAN
      riskScore: 0,
      categoryMask: 0n,
      policyHash: new Uint8Array(32),
      scannerHash: new Uint8Array(32),
      expiresAt: 0n,
    } as const;
    attest = async (kind, address, specHash) => {
      await moderatorClient.send([
        kind === "listing"
          ? await facade.recordListingModeration({
              moderator: moderatorSigner,
              listing: address,
              jobSpecHash: specHash,
              ...clean,
            })
          : await facade.recordTaskModeration({
              moderator: moderatorSigner,
              task: address,
              jobSpecHash: specHash,
              ...clean,
            }),
      ]);
    };
  } else {
    throw new Error(
      "no attestation path available: no attestor endpoint is configured " +
        "(attestorUrl / AGENC_SANDBOX_ATTESTOR_URL) and no moderator keypair " +
        "was found (env file keypairs.moderator / the moderatorKeypairPath " +
        "option). On localnet, run scripts/localnet-up.mjs so " +
        ".localnet/env.json exists.",
    );
  }

  // ---- 3) provider registers an agent + lists a service ----
  const providerAgentId = randomId32();
  await provider.client.registerAgent({
    authority: provider.signer,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "https://example.invalid/localnet-first-hire/provider",
    metadataUri: null,
    stakeAmount,
  });
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

  const listingId = randomId32();
  const price = 1_000_000n; // 0.001 sandbox SOL
  const listingSpecHash = await descriptionHash(
    "localnet-first-hire example listing: respond with a haiku about escrow",
  );
  await provider.client.createServiceListing({
    providerAgent,
    authority: provider.signer,
    listingId,
    name: "Localnet First Hire",
    category: "other",
    tags: ["sandbox", "example"],
    specHash: listingSpecHash,
    specUri: `agenc://job-spec/sha256/${hex(listingSpecHash)}`,
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

  // ---- 4) CLEAN listing attestation (the fail-closed hire gate) ----
  await attest("listing", listing, listingSpecHash);
  const [listingModeration] = await facade.findListingModerationPda({
    listing,
    jobSpecHash: listingSpecHash,
    moderator, // P1.2: v2 records are moderator-keyed
  });
  await waitForAccount(rpc, listingModeration, "ListingModeration");
  log("attestation: listing moderation recorded CLEAN");

  // ---- 5) buyer hires + activates through the blessed orchestration ----
  // hireAndActivate (WP-D6) drives hire_from_listing_humanless (no buyer
  // agent registration needed), the host/moderate callback, and
  // set_task_job_spec in one call — the same flow every open-SDK consumer
  // uses. The callback "hosts" the job spec at a hash-derived URI and
  // attests it CLEAN through the strategy above.
  const jobSpecHash = await descriptionHash(
    "localnet-first-hire example job spec: one haiku about escrow, plain text",
  );
  const jobSpecUri = `agenc://job-spec/sha256/${hex(jobSpecHash)}`;
  const taskId = randomId32();
  const result = await hireAndActivate(buyer.client, {
    hire: {
      listing,
      taskId,
      expectedPrice: price,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash,
      moderator, // P1.2: the attestation author the hire gate consumes
    },
    jobSpec: { instructions: "one haiku about escrow, plain text" },
    hostAndModerateJobSpec: async (host) => {
      await attest("task", host.taskPda, jobSpecHash);
      const [taskModeration] = await findTaskModerationPda({
        task: host.taskPda,
        jobSpecHash,
        moderator, // P1.2: v2 records are moderator-keyed
      });
      await waitForAccount(rpc, taskModeration, "TaskModeration");
      return {
        jobSpecHash,
        jobSpecUri,
        moderationAttested: true,
        moderator, // whose record the publish gate consumes
      };
    },
    onPhase: (phase) => log(`hireAndActivate: ${phase}`),
  });
  const task = result.taskPda;
  log(`buyer: hired + activated -> task ${task} (hire sig ${result.hireSignature})`);

  // ---- 6) provider claims + submits; buyer accepts (Task Validation V2) ----
  // Humanless-hired tasks force CreatorReview validation, so settlement is
  // submit_task_result (worker) -> accept_task_result (creator) — the
  // direct-pay complete_task path is refused with
  // ManualValidationRequiresReviewFlow.
  await provider.client.claimTaskWithJobSpec({
    task,
    worker: providerAgent,
    authority: provider.signer,
  });
  await waitForTaskStatus(rpc, task, TaskStatus.InProgress, {
    timeoutMs: 90_000,
  });
  log("provider: claimed (task InProgress)");

  await provider.client.submitTaskResult({
    task,
    worker: providerAgent,
    authority: provider.signer,
    proofHash: await descriptionHash("localnet-first-hire example result"),
    resultData: null, // optional 64-byte inline payload; the proof hash suffices here
  });
  await waitForTaskStatus(rpc, task, TaskStatus.PendingValidation, {
    timeoutMs: 90_000,
  });
  log("provider: submitted result (task PendingValidation)");

  // accept_task_result settles the escrow: worker payout + the protocol fee
  // to the on-chain treasury (read from ProtocolConfig in step 2b).
  const [hireRecord] = await findHireRecordPda({ task });
  const acceptResult = await buyer.client.acceptTaskResult({
    task,
    worker: providerAgent,
    creator: buyer.signer,
    treasury,
    workerAuthority: provider.signer.address,
    hireRecord,
  });
  await waitForTaskStatus(rpc, task, TaskStatus.Completed, {
    timeoutMs: 90_000,
  });
  log(`buyer: accepted — escrow settled (sig ${acceptResult.signature})`);
  log(
    environment.cluster === "devnet"
      ? `done — faucet to settled result on devnet. Task: ` +
          `https://explorer.solana.com/address/${task}?cluster=devnet`
      : `done — faucet to settled result on ${environment.cluster}. Task: ${task}`,
  );
  return task;
}

// Run when invoked directly (e.g. `npx tsx examples/localnet-first-hire.ts`).
// Guarded so importing `runFirstHire` (the nightly test does) never
// auto-runs it.
if (import.meta.url === `file://${process.argv[1]}`) {
  runFirstHire().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
