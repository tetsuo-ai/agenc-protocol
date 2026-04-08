#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as sdk from "../../agenc-sdk-validation-v2/dist/index.mjs";
import {
  SCENARIOS,
  buildRemoteProverConfig,
  buildRemoteProverConfigFromEnv,
  mergeProverHeaders,
  parsePositiveTimeoutMs,
  parseProverHeadersJson,
  scenarioNeedsArbiters,
} from "./marketplace-devnet-scenario-shared.mjs";
import {
  DEFAULT_AGENT_ENDPOINT,
  ensureBalance,
  ensureDistinctWallets,
  fixedUtf8Bytes,
  formatUnix,
  loadPrograms,
  randomBytes32,
  resolveIdlPath,
  sha256Bytes,
  waitUntilUnix,
} from "../../agenc-sdk-validation-v2/scripts/devnet-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DEFAULT_RPC_URL = process.env.AGENC_RPC_URL ?? sdk.DEVNET_RPC;
const DEFAULT_REWARD_LAMPORTS = 12_000_000n;
const DEFAULT_MAX_WAIT_SECONDS = Number(
  process.env.AGENC_MAX_WAIT_SECONDS ?? "900",
);
const DEFAULT_ARTIFACT_DIR = path.join(
  rootDir,
  "artifacts/devnet-readiness/scenario-runs",
);
const TASK_TYPE_BID_EXCLUSIVE = 3;
const CAP_COMPUTE = 1n;
const CAP_ARBITER = 1n << 7n;

function usage() {
  console.log(`Usage:
  CREATOR_WALLET=/path/to/creator.json \\
  WORKER_WALLET=/path/to/worker.json \\
  PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json \\
  AGENC_IDL_PATH=/absolute/path/to/agenc_coordination.json \\
  npm run devnet:marketplace:scenario -- --scenario DV-05

Dispute scenarios also require:
  ARBITER_A_WALLET=/path/to/arbiter-a.json
  ARBITER_B_WALLET=/path/to/arbiter-b.json
  ARBITER_C_WALLET=/path/to/arbiter-c.json

Optional flags:
  --artifact-dir <path>   Overrides the scenario artifact output directory
  --config <path>         Optional runner config (rpc/idl/wallet/prover defaults)
  --scenario <id>         One of ${Object.keys(SCENARIOS).join(", ")}
  --help                  Show this help

DV-03E prover configuration:
  AGENC_PROVER_ENDPOINT=https://prover.example.com
  AGENC_PROVER_API_KEY=<token>            Optional, sent as Authorization: Bearer <token>
  AGENC_PROVER_HEADERS_JSON='{"x-foo":"bar"}'
  AGENC_PROVER_TIMEOUT_MS=300000
`);
}

function parseArgs(argv) {
  const parsed = {
    scenario: null,
    artifactDir: null,
    config: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--scenario") {
      parsed.scenario = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--artifact-dir") {
      parsed.artifactDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--config") {
      parsed.config = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.scenario) {
    throw new Error("Missing --scenario.");
  }
  if (!SCENARIOS[parsed.scenario]) {
    throw new Error(
      `Unsupported scenario "${parsed.scenario}". Expected one of ${Object.keys(
        SCENARIOS,
      ).join(", ")}.`,
    );
  }

  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toBigIntValue(value) {
  return BigInt(value?.toString?.() ?? value);
}

function expandHome(value) {
  if (!value.startsWith("~/")) {
    return value;
  }
  return path.join(process.env.HOME ?? "", value.slice(2));
}

function resolveFromRoot(value) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.join(rootDir, expanded);
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function pickConfiguredValue(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim().length > 0) {
        return value.trim();
      }
      continue;
    }

    if (value != null) {
      return value;
    }
  }

  return null;
}

async function loadScenarioRunnerConfig(configPath) {
  if (!configPath) {
    return {
      config: null,
      scenarioRunner: {},
      resolvedConfigPath: null,
    };
  }

  const resolvedConfigPath = resolveFromRoot(configPath);
  const config = await readJsonFile(resolvedConfigPath);
  const scenarioRunner =
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    config.scenarioRunner &&
    typeof config.scenarioRunner === "object" &&
    !Array.isArray(config.scenarioRunner)
      ? config.scenarioRunner
      : {};

  return {
    config,
    scenarioRunner,
    resolvedConfigPath,
  };
}

function deriveScenarioArtifactDir(parsedArgs, runnerConfig) {
  const configuredDefaultArtifactDir =
    typeof runnerConfig.config?.defaultArtifactDir === "string"
      ? path.join(runnerConfig.config.defaultArtifactDir, "scenario-runs")
      : null;
  const artifactDir = pickConfiguredValue(
    parsedArgs.artifactDir,
    runnerConfig.scenarioRunner?.artifactDir,
    configuredDefaultArtifactDir,
    DEFAULT_ARTIFACT_DIR,
  );

  return resolveFromRoot(artifactDir);
}

function resolveWalletPath(envName, configuredValue, configLabel) {
  const walletPath = pickConfiguredValue(process.env[envName], configuredValue);
  if (!walletPath) {
    throw new Error(
      `Missing ${envName}. Set ${envName} or ${configLabel} in --config.`,
    );
  }

  return resolveFromRoot(walletPath);
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function generateNonZeroFieldElement() {
  let value = 0n;
  while (value === 0n) {
    value = sdk.generateSalt();
  }
  return value;
}

function derivePrivateSettlementSpendAccounts(programId, proofResult) {
  const [bindingSpend] = PublicKey.findProgramAddressSync(
    [Buffer.from("binding_spend"), Buffer.from(proofResult.bindingSeed)],
    programId,
  );
  const [nullifierSpend] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_spend"), Buffer.from(proofResult.nullifierSeed)],
    programId,
  );

  return {
    bindingSpend,
    nullifierSpend,
  };
}

async function sleepSeconds(seconds, label) {
  if (seconds <= 0) {
    return;
  }
  console.log(`[wait] ${label}: sleeping ${seconds}s`);
  await new Promise((resolve) => {
    setTimeout(resolve, (seconds + 1) * 1000);
  });
}

function createAgentId(...parts) {
  return sha256Bytes("validation-marketplace-scenario", ...parts, randomBytes32());
}

function base58(pubkey) {
  return pubkey.toBase58();
}

async function fetchRawProtocolConfig(program) {
  const protocolPda = sdk.deriveProtocolPda(program.programId);
  return program.account.protocolConfig.fetch(protocolPda);
}

async function fetchRawTask(program, taskPda) {
  return program.account.task.fetch(taskPda);
}

async function fetchRawClaim(program, claimPda) {
  return program.account.taskClaim.fetch(claimPda);
}

async function fetchRawTaskSubmission(program, submissionPda) {
  return program.account.taskSubmission.fetch(submissionPda);
}

async function fetchRawDispute(program, disputePda) {
  return program.account.dispute.fetch(disputePda);
}

async function maybeFetchAccount(fetcher) {
  try {
    return await fetcher();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Account does not exist") ||
      message.includes("could not find account")
    ) {
      return null;
    }
    throw error;
  }
}

async function registerAgentWithRole({
  connection,
  program,
  keypair,
  agentId,
  capabilities,
  endpointSuffix,
  metadataUri,
  stakeAmount,
}) {
  const result = await sdk.registerAgent(connection, program, keypair, {
    agentId,
    capabilities,
    endpoint: `${DEFAULT_AGENT_ENDPOINT}/${endpointSuffix}`,
    metadataUri,
    stakeAmount,
  });

  return {
    agentId,
    agentPda: result.agentPda,
    txSignature: result.txSignature,
  };
}

async function loadScenarioContext(parsedArgs) {
  const scenarioId = parsedArgs.scenario;
  const runnerConfig = await loadScenarioRunnerConfig(parsedArgs.config);
  const artifactDir = deriveScenarioArtifactDir(parsedArgs, runnerConfig);
  const rpcUrl = pickConfiguredValue(
    process.env.AGENC_RPC_URL,
    runnerConfig.scenarioRunner?.rpcUrl,
    runnerConfig.config?.rpcUrl,
    DEFAULT_RPC_URL,
  );
  const idlPath = resolveIdlPath(
    pickConfiguredValue(
      runnerConfig.scenarioRunner?.idlPath,
      runnerConfig.config?.idlPath,
      path.join(rootDir, "packages/protocol/src/generated/agenc_coordination.json"),
    ),
  );

  const configuredWallets = runnerConfig.scenarioRunner?.wallets ?? {};
  const creatorWalletPath = resolveWalletPath(
    "CREATOR_WALLET",
    configuredWallets.creator,
    "scenarioRunner.wallets.creator",
  );
  const workerWalletPath = resolveWalletPath(
    "WORKER_WALLET",
    configuredWallets.worker,
    "scenarioRunner.wallets.worker",
  );
  const authorityWalletPath = resolveWalletPath(
    "PROTOCOL_AUTHORITY_WALLET",
    configuredWallets.authority,
    "scenarioRunner.wallets.authority",
  );
  const needsArbiters = scenarioNeedsArbiters(scenarioId);
  const arbiterAWalletPath = needsArbiters
    ? resolveWalletPath(
        "ARBITER_A_WALLET",
        configuredWallets.arbiterA,
        "scenarioRunner.wallets.arbiterA",
      )
    : null;
  const arbiterBWalletPath = needsArbiters
    ? resolveWalletPath(
        "ARBITER_B_WALLET",
        configuredWallets.arbiterB,
        "scenarioRunner.wallets.arbiterB",
      )
    : null;
  const arbiterCWalletPath = needsArbiters
    ? resolveWalletPath(
        "ARBITER_C_WALLET",
        configuredWallets.arbiterC,
        "scenarioRunner.wallets.arbiterC",
      )
    : null;

  const { connection, keypairs, programs } = await loadPrograms({
    rpcUrl,
    idlPath,
    wallets: {
      creator: creatorWalletPath,
      worker: workerWalletPath,
      arbiterA: arbiterAWalletPath,
      arbiterB: arbiterBWalletPath,
      arbiterC: arbiterCWalletPath,
      authority: authorityWalletPath,
    },
  });

  ensureDistinctWallets(keypairs);

  const creatorProgram = programs.creator;
  const protocolConfig = await sdk.getProtocolConfig(creatorProgram);
  assert(protocolConfig, "Protocol config PDA could not be fetched from devnet.");
  assert(
    keypairs.authority.publicKey.equals(protocolConfig.authority),
    `PROTOCOL_AUTHORITY_WALLET ${base58(
      keypairs.authority.publicKey,
    )} does not match protocol authority ${base58(protocolConfig.authority)}.`,
  );

  const rawProtocolConfig = await fetchRawProtocolConfig(creatorProgram);
  const bidMarketplace = await sdk.getBidMarketplaceConfig(creatorProgram);
  assert(
    bidMarketplace,
    "Bid marketplace config is missing on the validation deployment.",
  );

  const creatorStake = toBigIntValue(protocolConfig.minAgentStake);
  const workerStake = toBigIntValue(protocolConfig.minAgentStake);
  const arbiterStake = toBigIntValue(
    rawProtocolConfig.minArbiterStake ?? rawProtocolConfig.minAgentStake,
  );
  const rewardLamports = DEFAULT_REWARD_LAMPORTS;
  const bidBondLamports = toBigIntValue(bidMarketplace.minBidBondLamports);
  const taskCreationCooldownSeconds = Number(
    toBigIntValue(rawProtocolConfig.taskCreationCooldown ?? 0),
  );
  const disputeCreationCooldownSeconds = Number(
    toBigIntValue(rawProtocolConfig.disputeInitiationCooldown ?? 0),
  );

  const balanceChecks = [
    ensureBalance(
      connection,
      "creator",
      keypairs.creator.publicKey,
      creatorStake + rewardLamports + 200_000_000n,
    ),
    ensureBalance(
      connection,
      "worker",
      keypairs.worker.publicKey,
      workerStake + bidBondLamports + 150_000_000n,
    ),
    ensureBalance(
      connection,
      "authority",
      keypairs.authority.publicKey,
      20_000_000n,
    ),
  ];

  if (needsArbiters) {
    balanceChecks.push(
      ensureBalance(
        connection,
        "arbiterA",
        keypairs.arbiterA.publicKey,
        arbiterStake + 100_000_000n,
      ),
      ensureBalance(
        connection,
        "arbiterB",
        keypairs.arbiterB.publicKey,
        arbiterStake + 100_000_000n,
      ),
      ensureBalance(
        connection,
        "arbiterC",
        keypairs.arbiterC.publicKey,
        arbiterStake + 100_000_000n,
      ),
    );
  }

  await Promise.all(balanceChecks);

  return {
    scenarioId,
    artifactDir,
    configPath: runnerConfig.resolvedConfigPath,
    rpcUrl,
    idlPath,
    connection,
    keypairs,
    programs,
    protocolConfig,
    rawProtocolConfig,
    bidMarketplace,
    rewardLamports,
    creatorStake,
    workerStake,
    arbiterStake,
    taskCreationCooldownSeconds,
    disputeCreationCooldownSeconds,
    scenarioRunnerConfig: runnerConfig.scenarioRunner,
    needsArbiters,
    maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
  };
}

async function registerParticipants(context) {
  const registrations = {};
  const txSignatures = {};
  const creatorAgentId = createAgentId(context.scenarioId, "creator");
  const workerAgentId = createAgentId(context.scenarioId, "worker");

  const creatorRegistration = await registerAgentWithRole({
    connection: context.connection,
    program: context.programs.creator,
    keypair: context.keypairs.creator,
    agentId: creatorAgentId,
    capabilities: CAP_COMPUTE,
    endpointSuffix: `${context.scenarioId.toLowerCase()}-creator`,
    metadataUri: `https://example.invalid/agenc/${context.scenarioId.toLowerCase()}/creator`,
    stakeAmount: context.creatorStake,
  });
  registrations.creator = creatorRegistration;
  txSignatures.registerCreator = creatorRegistration.txSignature;

  const workerRegistration = await registerAgentWithRole({
    connection: context.connection,
    program: context.programs.worker,
    keypair: context.keypairs.worker,
    agentId: workerAgentId,
    capabilities: CAP_COMPUTE,
    endpointSuffix: `${context.scenarioId.toLowerCase()}-worker`,
    metadataUri: `https://example.invalid/agenc/${context.scenarioId.toLowerCase()}/worker`,
    stakeAmount: context.workerStake,
  });
  registrations.worker = workerRegistration;
  txSignatures.registerWorker = workerRegistration.txSignature;

  if (context.needsArbiters) {
    const arbiterSpecs = [
      ["arbiterA", context.keypairs.arbiterA, context.programs.arbiterA],
      ["arbiterB", context.keypairs.arbiterB, context.programs.arbiterB],
      ["arbiterC", context.keypairs.arbiterC, context.programs.arbiterC],
    ];

    for (const [label, keypair, program] of arbiterSpecs) {
      const agentId = createAgentId(context.scenarioId, label);
      const registration = await registerAgentWithRole({
        connection: context.connection,
        program,
        keypair,
        agentId,
        capabilities: CAP_ARBITER,
        endpointSuffix: `${context.scenarioId.toLowerCase()}-${label}`,
        metadataUri: `https://example.invalid/agenc/${context.scenarioId.toLowerCase()}/${label}`,
        stakeAmount: context.arbiterStake,
      });
      registrations[label] = registration;
      txSignatures[`register${label[0].toUpperCase()}${label.slice(1)}`] =
        registration.txSignature;
    }
  }

  return { registrations, txSignatures };
}

async function createAcceptedBidFixture(context, registrations, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const taskId = options.taskId ?? randomBytes32();
  const taskDescription = fixedUtf8Bytes(
    options.taskDescription ?? `${context.scenarioId} accepted bid fixture`,
    64,
  );
  let parentTask = null;
  let createdTask;
  const taskDeadline = options.deadline ?? now + 1800;
  const useDependentTask = options.deadlineZero || options.forceDependentTask;

  if (useDependentTask) {
    // BidExclusive tasks still need deadline=0 to exercise the short claim-expiry
    // path, but create_task now rejects zero deadlines. A dependent task keeps the
    // fixture valid without changing on-chain code.
    parentTask = await sdk.createTask(
      context.connection,
      context.programs.creator,
      context.keypairs.creator,
      registrations.creator.agentId,
      {
        taskId: randomBytes32(),
        requiredCapabilities: CAP_COMPUTE,
        description: fixedUtf8Bytes(
          `${context.scenarioId} parent fixture`,
          64,
        ),
        rewardAmount: 1_000_000n,
        maxWorkers: 1,
        deadline: taskDeadline,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMint: null,
      },
    );
    await sleepSeconds(
      context.taskCreationCooldownSeconds,
      `${context.scenarioId} dependent-task creation cooldown`,
    );

    createdTask = await sdk.createDependentTask(
      context.connection,
      context.programs.creator,
      context.keypairs.creator,
      registrations.creator.agentId,
      parentTask.taskPda,
      {
        taskId,
        requiredCapabilities: CAP_COMPUTE,
        description: taskDescription,
        rewardAmount: context.rewardLamports,
        maxWorkers: 1,
        deadline: options.deadlineZero ? 0 : taskDeadline,
        taskType: TASK_TYPE_BID_EXCLUSIVE,
        constraintHash: options.constraintHash ?? null,
        dependencyType: 1,
        minReputation: 0,
        rewardMint: null,
      },
    );
  } else {
    createdTask = await sdk.createTask(
      context.connection,
      context.programs.creator,
      context.keypairs.creator,
      registrations.creator.agentId,
      {
        taskId,
        requiredCapabilities: CAP_COMPUTE,
        description: taskDescription,
        rewardAmount: context.rewardLamports,
        maxWorkers: 1,
        deadline: taskDeadline,
        taskType: TASK_TYPE_BID_EXCLUSIVE,
        constraintHash: options.constraintHash ?? null,
        minReputation: 0,
        rewardMint: null,
      },
    );
  }

  let taskValidationConfigPda = null;
  let taskSubmissionPda = null;
  let taskValidationTxSignature = null;
  let submitTaskResultTxSignature = null;

  if (options.workerCompleted) {
    const validationConfig = await sdk.configureTaskValidation(
      context.connection,
      context.programs.creator,
      context.keypairs.creator,
      createdTask.taskPda,
      {
        mode: sdk.TaskValidationMode.CreatorReview,
        reviewWindowSecs: 600,
      },
    );
    taskValidationConfigPda = validationConfig.taskValidationConfigPda;
    taskValidationTxSignature = validationConfig.txSignature;
  }

  const initializedBidBook = await sdk.initializeBidBook(
    context.connection,
    context.programs.creator,
    context.keypairs.creator,
    {
      taskPda: createdTask.taskPda,
      policy: sdk.BidBookMatchingPolicy.BestPrice,
    },
  );

  const createdBid = await sdk.createBid(
    context.connection,
    context.programs.worker,
    context.keypairs.worker,
    {
      taskPda: createdTask.taskPda,
      bidderAgentId: registrations.worker.agentId,
      requestedRewardLamports: context.rewardLamports,
      etaSeconds: 900,
      confidenceBps: 9000,
      qualityGuaranteeHash: sha256Bytes(context.scenarioId, "quality"),
      metadataHash: sha256Bytes(context.scenarioId, "metadata"),
      expiresAt: now + 600,
    },
  );

  const acceptedBid = await sdk.acceptBid(
    context.connection,
    context.programs.creator,
    context.keypairs.creator,
    {
      taskPda: createdTask.taskPda,
      bidderAgentPda: createdBid.bidderAgentPda,
    },
  );

  const taskAfterAccept = await sdk.getTask(
    context.programs.creator,
    createdTask.taskPda,
  );
  assert(taskAfterAccept, "Task is missing immediately after accept_bid.");
  assert(
    taskAfterAccept.state === sdk.TaskState.InProgress,
    `Task should be InProgress after accept_bid, received ${taskAfterAccept.state}.`,
  );

  const bidBookAfterAccept = await sdk.getBidBook(
    context.programs.creator,
    createdBid.bidBookPda,
  );
  assert(
    bidBookAfterAccept?.state === sdk.TaskBidBookLifecycleState.Accepted,
    "Bid book should be in Accepted state after accept_bid.",
  );

  if (options.workerCompleted) {

    const submitted = await sdk.submitTaskResult(
      context.connection,
      context.programs.worker,
      context.keypairs.worker,
      registrations.worker.agentId,
      createdTask.taskPda,
      {
        proofHash: sha256Bytes(context.scenarioId, "proof"),
        resultData: fixedUtf8Bytes(
          `${context.scenarioId} pending validation result`,
          64,
        ),
      },
    );
    taskSubmissionPda = submitted.taskSubmissionPda;
    submitTaskResultTxSignature = submitted.txSignature;

    const taskAfterSubmit = await sdk.getTask(
      context.programs.creator,
      createdTask.taskPda,
    );
    assert(taskAfterSubmit, "Task missing after submit_task_result.");
    assert(
      taskAfterSubmit.state === sdk.TaskState.PendingValidation,
      `Task should be PendingValidation after submit_task_result, received ${taskAfterSubmit.state}.`,
    );
  }

  return {
    taskId,
    parentTask,
    createdTask,
    initializedBidBook,
    createdBid,
    acceptedBid,
    taskValidationConfigPda,
    taskSubmissionPda,
    taskValidationTxSignature,
    submitTaskResultTxSignature,
  };
}

async function initiateDisputeFixture(
  context,
  registrations,
  acceptedBidFixture,
  resolutionType,
) {
  const disputeId = randomBytes32();
  const initiated = await sdk.initiateDispute(
    context.connection,
    context.programs.creator,
    context.keypairs.creator,
    registrations.creator.agentId,
    {
      disputeId,
      taskPda: acceptedBidFixture.createdTask.taskPda,
      taskId: acceptedBidFixture.taskId,
      evidenceHash: sha256Bytes(context.scenarioId, "evidence"),
      resolutionType,
      evidence: `${context.scenarioId} dispute fixture`,
      workerAgentPda: acceptedBidFixture.createdBid.bidderAgentPda,
      workerClaimPda: acceptedBidFixture.acceptedBid.claimPda,
      taskSubmissionPda: acceptedBidFixture.taskSubmissionPda,
    },
  );

  return { disputeId, initiated };
}

async function castApproveVotes(context, registrations, disputePda, taskPda, workerClaimPda, workerAgentPda) {
  const arbiterPairs = [];
  const voteTxSignatures = {};

  for (const [label, keypair, program, registration] of [
    [
      "arbiterA",
      context.keypairs.arbiterA,
      context.programs.arbiterA,
      registrations.arbiterA,
    ],
    [
      "arbiterB",
      context.keypairs.arbiterB,
      context.programs.arbiterB,
      registrations.arbiterB,
    ],
    [
      "arbiterC",
      context.keypairs.arbiterC,
      context.programs.arbiterC,
      registrations.arbiterC,
    ],
  ]) {
    const voted = await sdk.voteDispute(
      context.connection,
      program,
      keypair,
      registration.agentId,
      {
        disputePda,
        taskPda,
        approve: true,
        workerClaimPda,
        defendantAgentPda: workerAgentPda,
      },
    );
    arbiterPairs.push({
      votePda: voted.votePda,
      agentPda: registration.agentPda,
    });
    voteTxSignatures[`vote${label[0].toUpperCase()}${label.slice(1)}`] =
      voted.txSignature;
  }

  return { arbiterPairs, voteTxSignatures };
}

async function runDv05(context) {
  const { registrations, txSignatures } = await registerParticipants(context);
  const fixture = await createAcceptedBidFixture(context, registrations, {
    deadlineZero: true,
    workerCompleted: false,
  });

  const claimBeforeExpiry = await fetchRawClaim(
    context.programs.worker,
    fixture.acceptedBid.claimPda,
  );
  const ready = await waitUntilUnix(
    Number(claimBeforeExpiry.expiresAt),
    `${context.scenarioId} claim expiry`,
    context.maxWaitSeconds,
  );
  assert(
    ready,
    `Claim expiry would exceed max wait of ${context.maxWaitSeconds}s.`,
  );

  const expired = await sdk.expireClaim(
    context.connection,
    context.programs.worker,
    context.keypairs.worker,
    fixture.createdTask.taskPda,
    registrations.worker.agentId,
    context.keypairs.worker.publicKey,
    {
      bidMarketplaceSettlement: {
        bidMarketplace: sdk.deriveBidMarketplacePda(context.programs.worker.programId),
        bidBook: fixture.createdBid.bidBookPda,
        acceptedBid: fixture.createdBid.bidPda,
        bidderMarketState: fixture.createdBid.bidderMarketStatePda,
        creator: context.keypairs.creator.publicKey,
      },
    },
  );

  const [taskAfter, bidBookAfter, bidAfter, bidderStateAfter, claimAfter] =
    await Promise.all([
      sdk.getTask(context.programs.creator, fixture.createdTask.taskPda),
      sdk.getBidBook(context.programs.creator, fixture.createdBid.bidBookPda),
      sdk.getBid(context.programs.creator, fixture.createdBid.bidPda),
      sdk.getBidderMarketState(
        context.programs.creator,
        fixture.createdBid.bidderMarketStatePda,
      ),
      maybeFetchAccount(() =>
        fetchRawClaim(context.programs.creator, fixture.acceptedBid.claimPda),
      ),
    ]);

  assert(taskAfter, "Task missing after expire_claim.");
  assert(
    taskAfter.state === sdk.TaskState.Open,
    `Task should reopen after expire_claim, received ${taskAfter.state}.`,
  );
  assert(
    bidBookAfter?.state === sdk.TaskBidBookLifecycleState.Open,
    `Bid book should reopen after expire_claim, received ${bidBookAfter?.state}.`,
  );
  assert(bidAfter === null, "Accepted bid account should be closed after expire_claim.");
  assert(
    bidderStateAfter?.activeBidCount === 0,
    `Bidder active bid count should return to zero, received ${bidderStateAfter?.activeBidCount}.`,
  );
  assert(claimAfter === null, "Claim account should be closed after expire_claim.");

  const remainingAccounts = [
    sdk.deriveBidMarketplacePda(context.programs.creator.programId),
    fixture.createdBid.bidBookPda,
    fixture.createdBid.bidPda,
    fixture.createdBid.bidderMarketStatePda,
    context.keypairs.creator.publicKey,
  ];

  return {
    txSignatures: {
      ...txSignatures,
      ...(fixture.parentTask ? { createParentTask: fixture.parentTask.txSignature } : {}),
      createTask: fixture.createdTask.txSignature,
      initializeBidBook: fixture.initializedBidBook.txSignature,
      createBid: fixture.createdBid.txSignature,
      acceptBid: fixture.acceptedBid.txSignature,
      expireClaim: expired.txSignature,
    },
    accounts: {
      ...(fixture.parentTask ? { parentTask: fixture.parentTask.taskPda } : {}),
      task: fixture.createdTask.taskPda,
      claim: fixture.acceptedBid.claimPda,
      taskBidBook: fixture.createdBid.bidBookPda,
      acceptedBid: fixture.createdBid.bidPda,
      bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      bidMarketplaceConfig: sdk.deriveBidMarketplacePda(
        context.programs.creator.programId,
      ),
      creatorAuthority: context.keypairs.creator.publicKey,
      rentRecipient: context.keypairs.worker.publicKey,
      workerAgent: fixture.createdBid.bidderAgentPda,
    },
    remainingAccounts,
    finalStates: {
      taskState: taskAfter.state,
      bidBookState: bidBookAfter?.state ?? null,
      bidClosed: bidAfter === null,
      claimClosed: claimAfter === null,
      bidderActiveBidCount: bidderStateAfter?.activeBidCount ?? null,
      claimExpiresAt: Number(claimBeforeExpiry.expiresAt),
    },
    captureSignatures: [
      fixture.acceptedBid.txSignature,
      expired.txSignature,
    ],
    notes: [
      ...(fixture.parentTask
        ? [
            "DV-05 uses a dependent BidExclusive task with deadline=0 because create_task now rejects zero deadlines in this validation branch.",
          ]
        : []),
      `Claim expiry reached at ${formatUnix(Number(claimBeforeExpiry.expiresAt))}.`,
      "expire_claim was executed by the worker authority during the grace window to avoid an extra 60s wait.",
    ],
  };
}

async function runBidDisputeScenario(context, resolutionType) {
  const { registrations, txSignatures } = await registerParticipants(context);
  const fixture = await createAcceptedBidFixture(context, registrations, {
    deadlineZero: false,
    workerCompleted: false,
  });
  const disputeFixture = await initiateDisputeFixture(
    context,
    registrations,
    fixture,
    resolutionType,
  );
  const voted = await castApproveVotes(
    context,
    registrations,
    disputeFixture.initiated.disputePda,
    fixture.createdTask.taskPda,
    fixture.acceptedBid.claimPda,
    fixture.createdBid.bidderAgentPda,
  );

  const disputeBeforeResolution = await sdk.getDispute(
    context.programs.creator,
    disputeFixture.initiated.disputePda,
  );
  assert(disputeBeforeResolution, "Dispute missing after votes were cast.");
  const ready = await waitUntilUnix(
    disputeBeforeResolution.votingDeadline,
    `${context.scenarioId} voting deadline`,
    context.maxWaitSeconds,
  );
  assert(
    ready,
    `Dispute resolution would exceed max wait of ${context.maxWaitSeconds}s.`,
  );

  const resolved = await sdk.resolveDispute(
    context.connection,
    context.programs.authority,
    context.keypairs.authority,
    {
      disputePda: disputeFixture.initiated.disputePda,
      taskPda: fixture.createdTask.taskPda,
      creatorPubkey: context.keypairs.creator.publicKey,
      workerClaimPda: fixture.acceptedBid.claimPda,
      workerAgentPda: fixture.createdBid.bidderAgentPda,
      workerAuthority: context.keypairs.worker.publicKey,
      arbiterPairs: voted.arbiterPairs,
      acceptedBidSettlement: {
        bidBook: fixture.createdBid.bidBookPda,
        acceptedBid: fixture.createdBid.bidPda,
        bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      },
    },
  );

  const [taskAfter, disputeAfter, bidBookAfter, bidAfter] = await Promise.all([
    sdk.getTask(context.programs.creator, fixture.createdTask.taskPda),
    sdk.getDispute(
      context.programs.creator,
      disputeFixture.initiated.disputePda,
    ),
    sdk.getBidBook(context.programs.creator, fixture.createdBid.bidBookPda),
    sdk.getBid(context.programs.creator, fixture.createdBid.bidPda),
  ]);

  assert(taskAfter, "Task missing after resolve_dispute.");
  assert(disputeAfter, "Dispute missing after resolve_dispute.");
  assert(
    disputeAfter.status === sdk.DisputeStatus.Resolved,
    `Dispute should be Resolved, received ${disputeAfter.status}.`,
  );
  assert(
    bidBookAfter?.state === sdk.TaskBidBookLifecycleState.Closed,
    `Bid book should be Closed after resolve_dispute, received ${bidBookAfter?.state}.`,
  );
  assert(
    bidAfter === null,
    "Accepted bid account should be closed after resolve_dispute.",
  );

  const expectedTaskState =
    resolutionType === sdk.ResolutionType.Complete
      ? sdk.TaskState.Completed
      : sdk.TaskState.Cancelled;
  assert(
    taskAfter.state === expectedTaskState,
    `Task state mismatch after resolve_dispute. Expected ${expectedTaskState}, received ${taskAfter.state}.`,
  );

  const remainingAccounts = [
    ...voted.arbiterPairs.flatMap((pair) => [pair.votePda, pair.agentPda]),
    fixture.createdBid.bidBookPda,
    fixture.createdBid.bidPda,
    fixture.createdBid.bidderMarketStatePda,
  ];

  return {
    txSignatures: {
      ...txSignatures,
      createTask: fixture.createdTask.txSignature,
      initializeBidBook: fixture.initializedBidBook.txSignature,
      createBid: fixture.createdBid.txSignature,
      acceptBid: fixture.acceptedBid.txSignature,
      initiateDispute: disputeFixture.initiated.txSignature,
      ...voted.voteTxSignatures,
      resolveDispute: resolved.txSignature,
    },
    accounts: {
      task: fixture.createdTask.taskPda,
      escrow: sdk.deriveEscrowPda(
        fixture.createdTask.taskPda,
        context.programs.creator.programId,
      ),
      dispute: disputeFixture.initiated.disputePda,
      workerClaim: fixture.acceptedBid.claimPda,
      workerWallet: context.keypairs.worker.publicKey,
      taskBidBook: fixture.createdBid.bidBookPda,
      acceptedBid: fixture.createdBid.bidPda,
      bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      creatorAuthority: context.keypairs.creator.publicKey,
    },
    remainingAccounts,
    finalStates: {
      taskState: taskAfter.state,
      disputeStatus: disputeAfter.status,
      bidBookState: bidBookAfter?.state ?? null,
      bidClosed: bidAfter === null,
      votesFor: disputeAfter.votesFor.toString(),
      votesAgainst: disputeAfter.votesAgainst.toString(),
      votingDeadline: disputeBeforeResolution.votingDeadline,
    },
    captureSignatures: [
      fixture.acceptedBid.txSignature,
      disputeFixture.initiated.txSignature,
      ...Object.values(voted.voteTxSignatures),
      resolved.txSignature,
    ],
    notes: [
      `Voting deadline reached at ${formatUnix(disputeBeforeResolution.votingDeadline)}.`,
      `Resolution type ${resolutionType} was approved by all three arbiters.`,
    ],
  };
}

async function runExpiredDisputeScenario(context, { workerCompleted }) {
  const { registrations, txSignatures } = await registerParticipants(context);
  const fixture = await createAcceptedBidFixture(context, registrations, {
    deadlineZero: false,
    workerCompleted,
  });
  const disputeFixture = await initiateDisputeFixture(
    context,
    registrations,
    fixture,
    sdk.ResolutionType.Refund,
  );

  const disputeBeforeExpiry = await sdk.getDispute(
    context.programs.creator,
    disputeFixture.initiated.disputePda,
  );
  assert(disputeBeforeExpiry, "Dispute missing before expire_dispute wait.");
  const expireAt = disputeBeforeExpiry.votingDeadline + 120;
  const ready = await waitUntilUnix(
    expireAt,
    `${context.scenarioId} expire_dispute window`,
    context.maxWaitSeconds,
  );
  assert(
    ready,
    `Dispute expiry would exceed max wait of ${context.maxWaitSeconds}s.`,
  );

  const expired = await sdk.expireDispute(
    context.connection,
    context.programs.authority,
    context.keypairs.authority,
    {
      disputePda: disputeFixture.initiated.disputePda,
      taskPda: fixture.createdTask.taskPda,
      creatorPubkey: context.keypairs.creator.publicKey,
      workerClaimPda: fixture.acceptedBid.claimPda,
      workerAgentPda: fixture.createdBid.bidderAgentPda,
      workerAuthority: context.keypairs.worker.publicKey,
      acceptedBidSettlement: {
        bidBook: fixture.createdBid.bidBookPda,
        acceptedBid: fixture.createdBid.bidPda,
        bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      },
    },
  );

  const [taskAfter, disputeAfter, bidBookAfter, bidAfter, claimAfter] =
    await Promise.all([
      sdk.getTask(context.programs.creator, fixture.createdTask.taskPda),
      sdk.getDispute(
        context.programs.creator,
        disputeFixture.initiated.disputePda,
      ),
      sdk.getBidBook(context.programs.creator, fixture.createdBid.bidBookPda),
      sdk.getBid(context.programs.creator, fixture.createdBid.bidPda),
      maybeFetchAccount(() =>
        fetchRawClaim(context.programs.creator, fixture.acceptedBid.claimPda),
      ),
    ]);

  assert(taskAfter, "Task missing after expire_dispute.");
  assert(disputeAfter, "Dispute missing after expire_dispute.");
  assert(
    taskAfter.state === sdk.TaskState.Cancelled,
    `Task should be Cancelled after expire_dispute, received ${taskAfter.state}.`,
  );
  assert(
    disputeAfter.status === sdk.DisputeStatus.Expired,
    `Dispute should be Expired, received ${disputeAfter.status}.`,
  );
  assert(
    bidBookAfter?.state === sdk.TaskBidBookLifecycleState.Closed,
    `Bid book should be Closed after expire_dispute, received ${bidBookAfter?.state}.`,
  );
  assert(bidAfter === null, "Accepted bid account should be closed after expire_dispute.");
  assert(claimAfter === null, "Claim account should be closed after expire_dispute.");

  const remainingAccounts = [
    fixture.createdBid.bidBookPda,
    fixture.createdBid.bidPda,
    fixture.createdBid.bidderMarketStatePda,
  ];

  const finalStates = {
    taskState: taskAfter.state,
    disputeStatus: disputeAfter.status,
    bidBookState: bidBookAfter?.state ?? null,
    bidClosed: bidAfter === null,
    claimClosed: claimAfter === null,
    workerCompleted,
    votesFor: disputeAfter.votesFor.toString(),
    votesAgainst: disputeAfter.votesAgainst.toString(),
    votingDeadline: disputeBeforeExpiry.votingDeadline,
    expireEligibleAt: expireAt,
  };

  if (workerCompleted) {
    const submission = await fetchRawTaskSubmission(
      context.programs.creator,
      fixture.taskSubmissionPda,
    );
    finalStates.taskSubmissionStatus = submission.status?.toString?.() ?? null;
  }

  return {
    txSignatures: {
      ...txSignatures,
      createTask: fixture.createdTask.txSignature,
      initializeBidBook: fixture.initializedBidBook.txSignature,
      createBid: fixture.createdBid.txSignature,
      acceptBid: fixture.acceptedBid.txSignature,
      ...(fixture.taskValidationTxSignature
        ? { configureTaskValidation: fixture.taskValidationTxSignature }
        : {}),
      ...(fixture.submitTaskResultTxSignature
        ? { submitTaskResult: fixture.submitTaskResultTxSignature }
        : {}),
      initiateDispute: disputeFixture.initiated.txSignature,
      expireDispute: expired.txSignature,
    },
    accounts: {
      task: fixture.createdTask.taskPda,
      escrow: sdk.deriveEscrowPda(
        fixture.createdTask.taskPda,
        context.programs.creator.programId,
      ),
      dispute: disputeFixture.initiated.disputePda,
      workerClaim: fixture.acceptedBid.claimPda,
      workerWallet: context.keypairs.worker.publicKey,
      taskBidBook: fixture.createdBid.bidBookPda,
      acceptedBid: fixture.createdBid.bidPda,
      bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      creatorAuthority: context.keypairs.creator.publicKey,
    },
    remainingAccounts,
    finalStates,
    captureSignatures: [
      fixture.acceptedBid.txSignature,
      ...(fixture.submitTaskResultTxSignature
        ? [fixture.submitTaskResultTxSignature]
        : []),
      disputeFixture.initiated.txSignature,
      expired.txSignature,
    ],
    notes: [
      `Dispute became expire-eligible at ${formatUnix(expireAt)}.`,
      workerCompleted
        ? "Worker submission was created before the dispute and no arbiter votes were cast."
        : "No worker completion or arbiter votes were recorded before expire_dispute.",
    ],
  };
}

async function runDv03e(context) {
  const { registrations, txSignatures } = await registerParticipants(context);
  const proverConfig = buildRemoteProverConfig(
    context.scenarioRunnerConfig?.prover ?? {},
  );
  const taskId = randomBytes32();
  const taskPda = sdk.deriveTaskPda(
    context.keypairs.creator.publicKey,
    taskId,
    context.programs.creator.programId,
  );
  const output = [11n, 22n, 33n, 44n];
  const salt = generateNonZeroFieldElement();
  const agentSecret = generateNonZeroFieldElement();
  const expectedHashes = sdk.computeHashes(
    taskPda,
    context.keypairs.worker.publicKey,
    output,
    salt,
    agentSecret,
  );

  const fixture = await createAcceptedBidFixture(context, registrations, {
    taskId,
    taskDescription: `${context.scenarioId} private settlement fixture`,
    constraintHash: sdk.bigintToBytes32(expectedHashes.constraintHash),
    forceDependentTask: true,
  });

  const taskAfterAccept = await sdk.getTask(
    context.programs.creator,
    fixture.createdTask.taskPda,
  );
  assert(taskAfterAccept, "Private task missing immediately after accept_bid.");
  assert(
    taskAfterAccept.state === sdk.TaskState.InProgress,
    `Private task should be InProgress after accept_bid, received ${taskAfterAccept.state}.`,
  );
  assert(
    Buffer.from(taskAfterAccept.constraintHash ?? []).equals(
      sdk.bigintToBytes32(expectedHashes.constraintHash),
    ),
    "Task constraintHash did not persist the expected proof dependency hash.",
  );
  assert(fixture.parentTask, "DV-03E requires a dependent parent task.");

  const zkConfig = await sdk.getZkConfig(context.programs.creator);
  assert(zkConfig, "zkConfig account is missing on the validation deployment.");

  const proofGeneratedAtMs = Date.now();
  const proof = await sdk.generateProof(
    {
      taskPda: fixture.createdTask.taskPda,
      agentPubkey: context.keypairs.worker.publicKey,
      output,
      salt,
      agentSecret,
    },
    proverConfig,
  );
  const proofAccounts = derivePrivateSettlementSpendAccounts(
    context.programs.creator.programId,
    proof,
  );

  const completed = await sdk.completeTaskPrivateSafe(
    context.connection,
    context.programs.worker,
    context.keypairs.worker,
    registrations.worker.agentId,
    fixture.createdTask.taskPda,
    proof,
    {
      runProofSubmissionPreflight: true,
      proofGeneratedAtMs,
      parentTaskPda: fixture.parentTask.taskPda,
      acceptedBidSettlement: {
        bidBook: fixture.createdBid.bidBookPda,
        acceptedBid: fixture.createdBid.bidPda,
        bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      },
      bidderAuthority: context.keypairs.worker.publicKey,
    },
  );

  const [
    taskAfter,
    bidBookAfter,
    bidAfter,
    bidderStateAfter,
    claimAfter,
    bindingSpendAccount,
    nullifierSpendAccount,
  ] = await Promise.all([
    sdk.getTask(context.programs.creator, fixture.createdTask.taskPda),
    sdk.getBidBook(context.programs.creator, fixture.createdBid.bidBookPda),
    sdk.getBid(context.programs.creator, fixture.createdBid.bidPda),
    sdk.getBidderMarketState(
      context.programs.creator,
      fixture.createdBid.bidderMarketStatePda,
    ),
    maybeFetchAccount(() =>
      fetchRawClaim(context.programs.creator, fixture.acceptedBid.claimPda),
    ),
    context.connection.getAccountInfo(proofAccounts.bindingSpend, "confirmed"),
    context.connection.getAccountInfo(proofAccounts.nullifierSpend, "confirmed"),
  ]);

  assert(taskAfter, "Task missing after complete_task_private.");
  assert(
    taskAfter.state === sdk.TaskState.Completed,
    `Task should be Completed after complete_task_private, received ${taskAfter.state}.`,
  );
  assert(
    bidBookAfter?.state === sdk.TaskBidBookLifecycleState.Closed,
    `Bid book should be Closed after complete_task_private, received ${bidBookAfter?.state}.`,
  );
  assert(
    bidAfter === null,
    "Accepted bid account should be closed after complete_task_private.",
  );
  assert(
    bidderStateAfter?.activeBidCount === 0,
    `Bidder active bid count should return to zero, received ${bidderStateAfter?.activeBidCount}.`,
  );
  assert(claimAfter === null, "Claim account should be closed after complete_task_private.");
  assert(bindingSpendAccount, "Binding spend PDA was not created by complete_task_private.");
  assert(
    nullifierSpendAccount,
    "Nullifier spend PDA was not created by complete_task_private.",
  );

  const remainingAccounts = [
    fixture.parentTask.taskPda,
    fixture.createdBid.bidBookPda,
    fixture.createdBid.bidPda,
    fixture.createdBid.bidderMarketStatePda,
    context.keypairs.worker.publicKey,
  ];

  return {
    txSignatures: {
      ...txSignatures,
      createParentTask: fixture.parentTask.txSignature,
      createTask: fixture.createdTask.txSignature,
      initializeBidBook: fixture.initializedBidBook.txSignature,
      createBid: fixture.createdBid.txSignature,
      acceptBid: fixture.acceptedBid.txSignature,
      completeTaskPrivate: completed.txSignature,
    },
    accounts: {
      parentTask: fixture.parentTask.taskPda,
      task: fixture.createdTask.taskPda,
      claim: fixture.acceptedBid.claimPda,
      taskBidBook: fixture.createdBid.bidBookPda,
      acceptedBid: fixture.createdBid.bidPda,
      bidderMarketState: fixture.createdBid.bidderMarketStatePda,
      bidderAuthority: context.keypairs.worker.publicKey,
      workerAgent: fixture.createdBid.bidderAgentPda,
      bindingSpend: proofAccounts.bindingSpend,
      nullifierSpend: proofAccounts.nullifierSpend,
    },
    remainingAccounts,
    finalStates: {
      taskState: taskAfter.state,
      bidBookState: bidBookAfter?.state ?? null,
      bidClosed: bidAfter === null,
      claimClosed: claimAfter === null,
      bidderActiveBidCount: bidderStateAfter?.activeBidCount ?? null,
      bindingSpendCreated: bindingSpendAccount !== null,
      nullifierSpendCreated: nullifierSpendAccount !== null,
      activeImageId: Buffer.from(zkConfig.activeImageId).toString("hex"),
      proofImageId: Buffer.from(proof.imageId).toString("hex"),
      proofGenerationMs: proof.generationTime,
      preflightValid: completed.validationResult?.valid ?? null,
    },
    captureSignatures: [
      fixture.acceptedBid.txSignature,
      completed.txSignature,
    ],
    notes: [
      "DV-03E uses a proof-dependent BidExclusive task so the live devnet transaction proves the parent-task remaining-account offset.",
      "Remote prover authentication can come from AGENC_PROVER_API_KEY or scenarioRunner.prover.apiKeyEnvVar, and AGENC_PROVER_HEADERS_JSON overrides config-backed headers when present.",
      `Active zk image: ${Buffer.from(zkConfig.activeImageId).toString("hex")}.`,
      `Proof image: ${Buffer.from(proof.imageId).toString("hex")}.`,
    ],
  };
}

function buildHarnessScenario(context, result) {
  const scenarioDefinition = SCENARIOS[context.scenarioId];
  return {
    orderedInstructionList: scenarioDefinition.orderedInstructionList,
    evidenceInstruction: scenarioDefinition.evidenceInstruction,
    accounts: Object.fromEntries(
      Object.entries(result.accounts).map(([label, pubkey]) => [label, base58(pubkey)]),
    ),
    remainingAccounts: result.remainingAccounts.map((pubkey) => base58(pubkey)),
    notes: result.notes.join(" "),
  };
}

async function writeScenarioArtifact(context, result) {
  const scenarioDir = path.join(
    context.artifactDir,
    context.scenarioId,
  );
  await mkdir(scenarioDir, { recursive: true });
  const artifactPath = path.join(
    scenarioDir,
    `${timestampStamp()}.json`,
  );

  const captureCommand = [
    "npm run devnet:marketplace:capture --",
    `--bundle ${path.relative(rootDir, path.join(scenarioDir, path.basename(artifactPath, ".json")))}`,
    `--signature ${result.captureSignatures.join(" --signature ")}`,
    `--idl ${path.relative(rootDir, context.idlPath)}`,
    `--program-id ${base58(context.programs.creator.programId)}`,
  ].join(" ");

  const payload = {
    scenarioId: context.scenarioId,
    createdAt: new Date().toISOString(),
    rpcUrl: context.rpcUrl,
    idlPath: context.idlPath,
    configPath: context.configPath,
    programId: base58(context.programs.creator.programId),
    wallets: {
      creator: base58(context.keypairs.creator.publicKey),
      worker: base58(context.keypairs.worker.publicKey),
      authority: base58(context.keypairs.authority.publicKey),
      ...(context.needsArbiters
        ? {
            arbiterA: base58(context.keypairs.arbiterA.publicKey),
            arbiterB: base58(context.keypairs.arbiterB.publicKey),
            arbiterC: base58(context.keypairs.arbiterC.publicKey),
          }
        : {}),
    },
    txSignatures: result.txSignatures,
    captureSignatures: result.captureSignatures,
    accounts: Object.fromEntries(
      Object.entries(result.accounts).map(([label, pubkey]) => [label, base58(pubkey)]),
    ),
    remainingAccounts: result.remainingAccounts.map((pubkey) => base58(pubkey)),
    finalStates: result.finalStates,
    harnessScenario: buildHarnessScenario(context, result),
    captureCommand,
    notes: result.notes,
  };

  await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return artifactPath;
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const context = await loadScenarioContext(parsedArgs);

  console.log(`[config] scenario: ${context.scenarioId}`);
  console.log(`[config] rpc: ${context.rpcUrl}`);
  console.log(`[config] idl path: ${context.idlPath}`);
  if (context.configPath) {
    console.log(`[config] runner config: ${context.configPath}`);
  }
  console.log(`[config] program id: ${base58(context.programs.creator.programId)}`);
  console.log(`[config] artifact dir: ${context.artifactDir}`);
  console.log(
    `[config] validation timings: maxClaimDuration=${context.rawProtocolConfig.maxClaimDuration.toString()} votingPeriod=${context.rawProtocolConfig.votingPeriod.toString()} maxDisputeDuration=${context.rawProtocolConfig.maxDisputeDuration.toString()} taskCreationCooldown=${context.taskCreationCooldownSeconds} disputeCreationCooldown=${context.disputeCreationCooldownSeconds}`,
  );

  let result;
  switch (context.scenarioId) {
    case "DV-05":
      result = await runDv05(context);
      break;
    case "DV-07A":
      result = await runBidDisputeScenario(context, sdk.ResolutionType.Refund);
      break;
    case "DV-07B":
      result = await runBidDisputeScenario(context, sdk.ResolutionType.Complete);
      break;
    case "DV-07C":
      result = await runBidDisputeScenario(context, sdk.ResolutionType.Split);
      break;
    case "DV-08A":
      result = await runExpiredDisputeScenario(context, { workerCompleted: true });
      break;
    case "DV-08B":
      result = await runExpiredDisputeScenario(context, { workerCompleted: false });
      break;
    case "DV-03E":
      result = await runDv03e(context);
      break;
    default:
      throw new Error(`Unhandled scenario ${context.scenarioId}`);
  }

  const artifactPath = await writeScenarioArtifact(context, result);
  console.log(`[artifact] scenario result: ${artifactPath}`);
  console.log(
    `[result] ${context.scenarioId} final states: ${JSON.stringify(result.finalStates)}`,
  );
  console.log("[success] scenario run completed");
}

const executedAsScript =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedAsScript) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[failure] ${message}`);
    process.exitCode = 1;
  });
}

export {
  SCENARIOS,
  buildRemoteProverConfig,
  buildRemoteProverConfigFromEnv,
  derivePrivateSettlementSpendAccounts,
  generateNonZeroFieldElement,
  main,
  mergeProverHeaders,
  parsePositiveTimeoutMs,
  parseProverHeadersJson,
};
