#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base58PublicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const defaultGeneratedIdlPath = path.join(
  rootDir,
  "packages/protocol/src/generated/agenc_coordination.json",
);
const cachedProgramCatalogPromises = new Map();

const scenarioDefinitions = [
  {
    id: "DV-01",
    title: "Bid lifecycle roundtrip",
    instructionPath: ["initialize_bid_book", "create_bid", "update_bid", "cancel_bid"],
    requiredAccountLabels: [
      "task",
      "taskBidBook",
      "taskBid",
      "bidderMarketState",
      "bidderAuthority",
    ],
    minRemainingAccounts: 0,
  },
  {
    id: "DV-02",
    title: "Accept bid transitions task and book correctly",
    instructionPath: ["create_bid", "accept_bid"],
    requiredAccountLabels: [
      "task",
      "claim",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "workerAgent",
      "creatorAuthority",
    ],
    minRemainingAccounts: 0,
  },
  {
    id: "DV-03A",
    title: "Successful settlement via accept_task_result on a non-proof task",
    instructionPath: ["accept_bid", "accept_task_result"],
    requiredAccountLabels: [
      "task",
      "claim",
      "escrow",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidderAuthority",
      "workerAgent",
      "creatorAuthority",
      "treasuryAuthority",
    ],
    expectedRemainingAccounts: 4,
    recommendedFirst: true,
  },
  {
    id: "DV-03B",
    title: "Successful settlement via complete_task on a proof-dependent task",
    instructionPath: ["accept_bid", "complete_task"],
    requiredAccountLabels: [
      "task",
      "claim",
      "escrow",
      "parentTask",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidderAuthority",
      "workerAgent",
      "creatorAuthority",
      "treasuryAuthority",
    ],
    expectedRemainingAccounts: 5,
  },
  {
    id: "DV-03C",
    title: "Successful settlement via validate_task_result(approved)",
    instructionPath: ["accept_bid", "validate_task_result"],
    requiredAccountLabels: [
      "task",
      "claim",
      "escrow",
      "taskSubmission",
      "taskValidationConfig",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidderAuthority",
      "workerAgent",
      "creatorAuthority",
      "treasuryAuthority",
    ],
    expectedRemainingAccounts: 4,
  },
  {
    id: "DV-03D",
    title: "Successful settlement via auto_accept_task_result",
    instructionPath: ["accept_bid", "auto_accept_task_result"],
    requiredAccountLabels: [
      "task",
      "claim",
      "escrow",
      "taskSubmission",
      "taskValidationConfig",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidderAuthority",
      "workerAgent",
      "creatorAuthority",
      "treasuryAuthority",
    ],
    expectedRemainingAccounts: 4,
  },
  {
    id: "DV-03E",
    title: "Successful settlement via complete_task_private",
    instructionPath: ["accept_bid", "complete_task_private"],
    requiredAccountLabels: [
      "task",
      "claim",
      "escrow",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidderAuthority",
      "workerAgent",
      "creatorAuthority",
      "treasuryAuthority",
    ],
    expectedRemainingAccounts: 4,
  },
  {
    id: "DV-04A",
    title: "Rejection via reject_task_result reopens the bid book",
    instructionPath: ["accept_bid", "reject_task_result"],
    requiredAccountLabels: [
      "task",
      "claim",
      "taskSubmission",
      "taskValidationConfig",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "workerAgent",
    ],
    expectedRemainingAccounts: 3,
  },
  {
    id: "DV-04B",
    title: "Rejection via validate_task_result(rejected) reopens the bid book",
    instructionPath: ["accept_bid", "validate_task_result"],
    requiredAccountLabels: [
      "task",
      "claim",
      "taskSubmission",
      "taskValidationConfig",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "workerAgent",
    ],
    expectedRemainingAccounts: 3,
  },
  {
    id: "DV-05",
    title: "Claim expiry / no-show slash",
    instructionPath: ["accept_bid", "expire_claim"],
    requiredAccountLabels: [
      "task",
      "claim",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "bidMarketplaceConfig",
      "creatorAuthority",
      "rentRecipient",
      "workerAgent",
    ],
    expectedRemainingAccounts: 5,
  },
  {
    id: "DV-06A",
    title: "Task cancellation with no accepted bid",
    instructionPath: ["cancel_task"],
    requiredAccountLabels: ["task", "escrow", "taskBidBook", "creatorAuthority"],
    expectedRemainingAccounts: 1,
  },
  {
    id: "DV-06B",
    title: "Task cancellation with an accepted bid",
    instructionPath: ["cancel_task"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-07A",
    title: "Dispute resolution with refund",
    instructionPath: ["resolve_dispute"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "dispute",
      "workerClaim",
      "workerWallet",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-07B",
    title: "Dispute resolution with complete",
    instructionPath: ["resolve_dispute"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "dispute",
      "workerClaim",
      "workerWallet",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-07C",
    title: "Dispute resolution with split",
    instructionPath: ["resolve_dispute"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "dispute",
      "workerClaim",
      "workerWallet",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-08A",
    title: "Expired dispute with bond refund",
    instructionPath: ["expire_dispute"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "dispute",
      "workerClaim",
      "workerWallet",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-08B",
    title: "Expired dispute with bond slash",
    instructionPath: ["expire_dispute"],
    requiredAccountLabels: [
      "task",
      "escrow",
      "dispute",
      "workerClaim",
      "workerWallet",
      "taskBidBook",
      "acceptedBid",
      "bidderMarketState",
      "creatorAuthority",
    ],
    minRemainingAccounts: 3,
  },
  {
    id: "DV-09",
    title: "Residual non-accepted bid cleanup",
    instructionPath: ["expire_bid"],
    requiredAccountLabels: [
      "task",
      "taskBidBook",
      "taskBid",
      "bidderMarketState",
      "bidderAuthority",
    ],
    minRemainingAccounts: 0,
  },
];

const scenarioById = new Map(
  scenarioDefinitions.map((scenarioDefinition) => [scenarioDefinition.id, scenarioDefinition]),
);

function usage(exitCode = 0) {
  const message = [
    "Marketplace V2 devnet readiness harness",
    "",
    "Commands:",
    "  matrix",
    "    Print the supported scenario registry.",
    "",
    "  prepare --scenario <ID> --config <path> [--bundle-name <name>] [--idl <path>] [--program-id <pubkey>]",
    "    Create an artifact bundle and capture pre-state snapshots.",
    "",
    "  capture --bundle <path> [--signature <tx>]... [--idl <path>] [--program-id <pubkey>]",
    "    Capture post-state snapshots and write balance deltas for an existing bundle.",
    "",
    "  report [--artifacts-dir <path>]",
    "    Aggregate bundle verdicts into a readiness report for the Marketplace V2 matrix.",
    "",
    "Examples:",
    "  npm run devnet:marketplace:matrix",
    "  npm run devnet:marketplace:prepare -- --scenario DV-03A --config scripts/marketplace-devnet.config.example.json",
    "  npm run devnet:marketplace:capture -- --bundle artifacts/devnet-readiness/DV-03A/20260327T120000Z --signature <tx_sig>",
    "  node scripts/marketplace-devnet-readiness.mjs report",
  ].join("\n");
  const writer = exitCode === 0 ? console.log : console.error;
  writer(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage(0);
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const optionName = token.slice(2);
    const optionValue = rest[index + 1];
    if (!optionValue || optionValue.startsWith("--")) {
      throw new Error(`Missing value for --${optionName}`);
    }

    if (optionName === "signature") {
      options.signature = options.signature ?? [];
      options.signature.push(optionValue);
    } else {
      options[optionName] = optionValue;
    }
    index += 1;
  }

  return { command, options };
}

async function readJson(filePath) {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents);
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function timestampStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ensureScenarioDefinition(scenarioId) {
  const scenarioDefinition = scenarioById.get(scenarioId);
  if (!scenarioDefinition) {
    throw new Error(`Unknown scenario "${scenarioId}". Run the matrix command to list valid IDs.`);
  }
  return scenarioDefinition;
}

function resolvePath(candidatePath) {
  return path.isAbsolute(candidatePath) ? candidatePath : path.join(rootDir, candidatePath);
}

async function loadProgramCatalog(overrides = {}) {
  const resolvedIdlPath = resolvePath(overrides.idlPath ?? defaultGeneratedIdlPath);
  const programIdOverride = overrides.programId ?? null;
  const cacheKey = `${resolvedIdlPath}::${programIdOverride ?? ""}`;

  if (!cachedProgramCatalogPromises.has(cacheKey)) {
    cachedProgramCatalogPromises.set(cacheKey, (async () => {
      const idl = await readJson(resolvedIdlPath);
      const instructions = new Map(
        (idl.instructions ?? []).map((instruction) => [
          instruction.name,
          {
            name: instruction.name,
            discriminator: Uint8Array.from(instruction.discriminator ?? []),
            staticAccountCount: instruction.accounts?.length ?? 0,
          },
        ]),
      );

      return {
        idlPath: resolvedIdlPath,
        programId: programIdOverride ?? idl.address ?? idl.metadata?.address ?? null,
        instructions,
      };
    })());
  }

  return cachedProgramCatalogPromises.get(cacheKey);
}

function getTerminalInstructionName(scenarioPlan) {
  return (
    scenarioPlan.evidenceInstruction ??
    scenarioPlan.instructionPath?.[scenarioPlan.instructionPath.length - 1] ??
    null
  );
}

function decodeBase58(base58Value) {
  if (typeof base58Value !== "string" || base58Value.length === 0) {
    return new Uint8Array();
  }

  const decoded = [0];
  for (const character of base58Value) {
    const alphabetIndex = base58Alphabet.indexOf(character);
    if (alphabetIndex === -1) {
      throw new Error(`invalid base58 character "${character}"`);
    }

    let carry = alphabetIndex;
    for (let index = 0; index < decoded.length; index += 1) {
      carry += decoded[index] * 58;
      decoded[index] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      decoded.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeroCount = 0;
  while (leadingZeroCount < base58Value.length && base58Value[leadingZeroCount] === "1") {
    leadingZeroCount += 1;
  }

  const leadingZeros = new Array(leadingZeroCount).fill(0);
  return Uint8Array.from([...leadingZeros, ...decoded.reverse()]);
}

function byteArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function normalizePubkeyEntry(entry) {
  if (typeof entry === "string") {
    return entry;
  }

  if (entry && typeof entry.pubkey === "string") {
    return entry.pubkey;
  }

  return null;
}

function normalizeInstructionData(instruction) {
  if (typeof instruction?.data === "string") {
    return instruction.data;
  }

  if (Array.isArray(instruction?.data) && typeof instruction.data[0] === "string") {
    return instruction.data[0];
  }

  return null;
}

function resolveInstructionProgramId(instruction, resolvedAccountKeys) {
  if (typeof instruction?.programId === "string") {
    return instruction.programId;
  }

  if (typeof instruction?.programIdIndex === "number") {
    return resolvedAccountKeys[instruction.programIdIndex] ?? null;
  }

  return null;
}

function resolveInstructionAccounts(instruction, resolvedAccountKeys) {
  if (!Array.isArray(instruction?.accounts)) {
    return [];
  }

  return instruction.accounts.map((accountIndex) => {
    const numericIndex =
      typeof accountIndex === "number"
        ? accountIndex
        : typeof accountIndex === "string" && /^\d+$/.test(accountIndex)
          ? Number(accountIndex)
          : null;
    return numericIndex === null ? null : (resolvedAccountKeys[numericIndex] ?? null);
  });
}

function getResolvedAccountKeys(transactionRecord) {
  const message = transactionRecord.transaction?.message ?? {};
  const staticKeys = (message.accountKeys ?? [])
    .map((entry) => normalizePubkeyEntry(entry))
    .filter(Boolean);
  const loadedAddresses = transactionRecord.meta?.loadedAddresses ?? {};

  return [
    ...staticKeys,
    ...(loadedAddresses.writable ?? []),
    ...(loadedAddresses.readonly ?? []),
  ];
}

export function buildInstructionOrderReport(capturedTransactions, scenarioPlan, programCatalog) {
  const searchedInstruction = getTerminalInstructionName(scenarioPlan);
  const expectedRemainingAccounts = (scenarioPlan.remainingAccounts ?? []).map(
    (remainingAccount) => remainingAccount.pubkey,
  );
  const instructionDefinition = searchedInstruction
    ? programCatalog.instructions.get(searchedInstruction) ?? null
    : null;

  const checks = (capturedTransactions.transactions ?? []).map((transactionRecord) => {
    const baseCheck = {
      signature: transactionRecord.signature,
      searchedInstruction,
      expectedRemainingAccounts,
    };

    if (!transactionRecord.found) {
      return {
        ...baseCheck,
        status: "transaction_not_found",
      };
    }

    if (!programCatalog.programId || !instructionDefinition) {
      return {
        ...baseCheck,
        status: "instruction_catalog_unavailable",
      };
    }

    const resolvedAccountKeys = getResolvedAccountKeys(transactionRecord);
    const instructions = transactionRecord.transaction?.message?.instructions ?? [];
    const matchedCandidates = [];

    for (const [instructionIndex, instruction] of instructions.entries()) {
      const resolvedProgramId = resolveInstructionProgramId(instruction, resolvedAccountKeys);
      if (resolvedProgramId !== programCatalog.programId) {
        continue;
      }

      const rawInstructionData = normalizeInstructionData(instruction);
      if (!rawInstructionData) {
        continue;
      }

      let decodedInstructionData;
      try {
        decodedInstructionData = decodeBase58(rawInstructionData);
      } catch {
        continue;
      }

      const discriminator = decodedInstructionData.slice(0, instructionDefinition.discriminator.length);
      if (!byteArraysEqual(discriminator, instructionDefinition.discriminator)) {
        continue;
      }

      const resolvedInstructionAccounts = resolveInstructionAccounts(instruction, resolvedAccountKeys);
      const observedRemainingAccounts = resolvedInstructionAccounts.slice(
        instructionDefinition.staticAccountCount,
      );
      const matchesExpectedOrder =
        observedRemainingAccounts.length === expectedRemainingAccounts.length &&
        observedRemainingAccounts.every(
          (pubkey, index) => pubkey === expectedRemainingAccounts[index],
        );

      matchedCandidates.push({
        instructionIndex,
        staticAccountCount: instructionDefinition.staticAccountCount,
        observedRemainingAccounts,
        staticAccounts: resolvedInstructionAccounts.slice(0, instructionDefinition.staticAccountCount),
        matchesExpectedOrder,
      });
    }

    if (matchedCandidates.length === 0) {
      return {
        ...baseCheck,
        status: "instruction_not_found",
      };
    }

    const firstMatch = matchedCandidates.find((candidate) => candidate.matchesExpectedOrder);
    if (firstMatch) {
      return {
        ...baseCheck,
        status: "match",
        ...firstMatch,
      };
    }

    return {
      ...baseCheck,
      status: "mismatch",
      candidateCount: matchedCandidates.length,
      candidates: matchedCandidates,
    };
  });

  const summary = checks.reduce(
    (running, check) => {
      running.total += 1;
      running[check.status] = (running[check.status] ?? 0) + 1;
      return running;
    },
    {
      total: 0,
      match: 0,
      mismatch: 0,
      instruction_not_found: 0,
      transaction_not_found: 0,
      instruction_catalog_unavailable: 0,
    },
  );

  return {
    capturedAt: new Date().toISOString(),
    programId: programCatalog.programId,
    searchedInstruction,
    expectedRemainingAccounts,
    checks,
    summary,
  };
}

export function buildEventSummary(capturedTransactions, scenarioPlan) {
  const searchedInstruction = getTerminalInstructionName(scenarioPlan);
  const transactions = capturedTransactions?.transactions ?? [];
  const perTransaction = transactions.map((transactionRecord) => {
    const logMessages = transactionRecord.meta?.logMessages ?? [];
    const invokedPrograms = [];
    let programLogCount = 0;
    let programDataCount = 0;

    for (const logMessage of logMessages) {
      const invokeMatch = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke/.exec(logMessage);
      if (invokeMatch) {
        invokedPrograms.push(invokeMatch[1]);
      }

      if (logMessage.startsWith("Program log:")) {
        programLogCount += 1;
      }

      if (logMessage.startsWith("Program data:")) {
        programDataCount += 1;
      }
    }

    return {
      signature: transactionRecord.signature,
      found: transactionRecord.found,
      searchedInstruction,
      err: transactionRecord.meta?.err ?? null,
      logLineCount: logMessages.length,
      programLogCount,
      programDataCount,
      invokedPrograms,
      logs: logMessages,
    };
  });

  const summary = perTransaction.reduce(
    (running, transactionSummary) => {
      running.total += 1;
      if (transactionSummary.found) {
        running.found += 1;
      }
      if (transactionSummary.err !== null) {
        running.errorCount += 1;
      }
      running.totalLogLines += transactionSummary.logLineCount;
      running.totalProgramLogs += transactionSummary.programLogCount;
      running.totalProgramData += transactionSummary.programDataCount;
      return running;
    },
    {
      total: 0,
      found: 0,
      errorCount: 0,
      totalLogLines: 0,
      totalProgramLogs: 0,
      totalProgramData: 0,
    },
  );

  return {
    capturedAt: new Date().toISOString(),
    searchedInstruction,
    summary,
    transactions: perTransaction,
  };
}

function countSnapshotStateChanges(balanceDelta) {
  const accountDeltas = balanceDelta?.accountDeltas ?? [];
  return accountDeltas.reduce(
    (running, accountDelta) => {
      if (accountDelta.deltaLamports !== 0) {
        running.changedLamports += 1;
      }
      if (!accountDelta.existedBefore && accountDelta.existsAfter) {
        running.createdAccounts += 1;
      }
      if (accountDelta.existedBefore && !accountDelta.existsAfter) {
        running.closedAccounts += 1;
      }
      return running;
    },
    {
      changedLamports: 0,
      createdAccounts: 0,
      closedAccounts: 0,
    },
  );
}

export function buildScenarioVerdict({
  scenarioPlan,
  balanceDelta,
  transactions,
  orderingCheck,
}) {
  const blockers = [];
  const warnings = [];
  const transactionList = transactions?.transactions ?? [];
  const snapshotChanges = countSnapshotStateChanges(balanceDelta);

  if (transactionList.length === 0) {
    blockers.push("No transaction signatures were supplied, so on-chain execution was not verified.");
  }

  const missingTransactions = transactionList.filter((transactionRecord) => !transactionRecord.found);
  if (missingTransactions.length > 0) {
    blockers.push(
      `${missingTransactions.length} transaction signature(s) were not found on the configured RPC endpoint.`,
    );
  }

  const failedTransactions = transactionList.filter(
    (transactionRecord) => transactionRecord.meta?.err !== null,
  );
  if (failedTransactions.length > 0) {
    blockers.push(
      `${failedTransactions.length} transaction(s) reported a non-null runtime error in transaction metadata.`,
    );
  }

  if (orderingCheck) {
    if ((orderingCheck.summary?.mismatch ?? 0) > 0) {
      blockers.push("Observed terminal instruction account ordering did not match the expected remaining-accounts suffix.");
    }
    if ((orderingCheck.summary?.instruction_not_found ?? 0) > 0) {
      blockers.push("The expected terminal instruction was not found in at least one supplied transaction.");
    }
    if ((orderingCheck.summary?.transaction_not_found ?? 0) > 0) {
      blockers.push("At least one supplied transaction could not be loaded for the ordering check.");
    }
    if ((orderingCheck.summary?.instruction_catalog_unavailable ?? 0) > 0) {
      blockers.push("The local instruction catalog was unavailable, so ordering validation could not complete.");
    }
  }

  if (snapshotChanges.changedLamports === 0) {
    warnings.push("No tracked accounts changed lamports between pre-state and post-state; verify the bundle points at the intended live accounts.");
  }

  if (snapshotChanges.createdAccounts === 0 && snapshotChanges.closedAccounts === 0) {
    warnings.push("No tracked accounts were created or closed; confirm the scenario reached a terminal state.");
  }

  const status = blockers.length > 0 ? "fail" : "pass";

  return {
    capturedAt: new Date().toISOString(),
    scenarioId: scenarioPlan.scenarioId,
    title: scenarioPlan.title,
    terminalInstruction: getTerminalInstructionName(scenarioPlan),
    status,
    blockers,
    warnings,
    metrics: {
      trackedAccounts: scenarioPlan.snapshotTargets?.length ?? 0,
      changedLamportAccounts: snapshotChanges.changedLamports,
      createdAccounts: snapshotChanges.createdAccounts,
      closedAccounts: snapshotChanges.closedAccounts,
      totalDeltaLamports: balanceDelta?.totals?.deltaLamports ?? 0,
      suppliedTransactionCount: transactionList.length,
      foundTransactionCount: transactionList.filter((transactionRecord) => transactionRecord.found).length,
      orderingMatches: orderingCheck?.summary?.match ?? 0,
      orderingMismatches: orderingCheck?.summary?.mismatch ?? 0,
    },
  };
}

function validatePubkeyShape(label, pubkey) {
  if (typeof pubkey !== "string" || pubkey.trim().length === 0) {
    return `${label} must be a non-empty string`;
  }

  if (pubkey.includes("<") || pubkey.includes(">")) {
    return `${label} still contains a placeholder value; replace it with a real devnet public key`;
  }

  if (!base58PublicKeyPattern.test(pubkey)) {
    return `${label} must look like a base58 Solana public key`;
  }

  return null;
}

function validateScenarioConfig(scenarioDefinition, scenarioConfig) {
  const accounts = scenarioConfig.accounts ?? {};
  const errors = [];

  if (!scenarioConfig.accounts || typeof scenarioConfig.accounts !== "object") {
    errors.push("accounts must be an object");
  }

  if (scenarioConfig.remainingAccounts && !Array.isArray(scenarioConfig.remainingAccounts)) {
    errors.push("remainingAccounts must be an array");
  }

  for (const label of scenarioDefinition.requiredAccountLabels) {
    if (!accounts[label]) {
      errors.push(`missing required account label "${label}"`);
    }
  }

  for (const [label, pubkey] of Object.entries(accounts)) {
    const validationError = validatePubkeyShape(`accounts.${label}`, pubkey);
    if (validationError) {
      errors.push(validationError);
    }
  }

  for (const [index, pubkey] of (scenarioConfig.remainingAccounts ?? []).entries()) {
    const validationError = validatePubkeyShape(`remainingAccounts[${index}]`, pubkey);
    if (validationError) {
      errors.push(validationError);
    }
  }

  if (scenarioDefinition.expectedRemainingAccounts !== undefined) {
    const count = scenarioConfig.remainingAccounts?.length ?? 0;
    if (count !== scenarioDefinition.expectedRemainingAccounts) {
      errors.push(
        `expected ${scenarioDefinition.expectedRemainingAccounts} remaining accounts, received ${count}`,
      );
    }
  }

  if (scenarioDefinition.minRemainingAccounts !== undefined) {
    const count = scenarioConfig.remainingAccounts?.length ?? 0;
    if (count < scenarioDefinition.minRemainingAccounts) {
      errors.push(
        `expected at least ${scenarioDefinition.minRemainingAccounts} remaining accounts, received ${count}`,
      );
    }
  }

  return errors;
}

function buildSnapshotTargets(scenarioDefinition, scenarioConfig) {
  const accounts = scenarioConfig.accounts ?? {};
  const seen = new Set();
  const targets = [];

  const pushTarget = (label, pubkey, source) => {
    if (!pubkey || seen.has(pubkey)) {
      return;
    }
    seen.add(pubkey);
    targets.push({ label, pubkey, source });
  };

  for (const label of scenarioDefinition.requiredAccountLabels) {
    pushTarget(label, accounts[label], "accounts");
  }

  for (const [label, pubkey] of Object.entries(accounts)) {
    pushTarget(label, pubkey, "accounts");
  }

  for (const [index, pubkey] of (scenarioConfig.remainingAccounts ?? []).entries()) {
    pushTarget(`remainingAccounts[${index}]`, pubkey, "remainingAccounts");
  }

  return targets;
}

function buildScenarioPlan(scenarioDefinition, scenarioConfig) {
  return {
    scenarioId: scenarioDefinition.id,
    title: scenarioDefinition.title,
    recommendedFirst: Boolean(scenarioDefinition.recommendedFirst),
    instructionPath:
      scenarioConfig.orderedInstructionList ?? scenarioDefinition.instructionPath,
    evidenceInstruction:
      scenarioConfig.evidenceInstruction ??
      scenarioConfig.orderedInstructionList?.[scenarioConfig.orderedInstructionList.length - 1] ??
      scenarioDefinition.instructionPath?.[scenarioDefinition.instructionPath.length - 1] ??
      null,
    notes: scenarioConfig.notes ?? null,
    expectedRemainingAccounts:
      scenarioDefinition.expectedRemainingAccounts ?? null,
    minRemainingAccounts: scenarioDefinition.minRemainingAccounts ?? null,
    requiredAccountLabels: scenarioDefinition.requiredAccountLabels,
    accounts: scenarioConfig.accounts ?? {},
    remainingAccounts: (scenarioConfig.remainingAccounts ?? []).map((pubkey, index) => ({
      index,
      pubkey,
    })),
    snapshotTargets: buildSnapshotTargets(scenarioDefinition, scenarioConfig),
  };
}

async function loadHarnessInput(configPath, scenarioId) {
  const resolvedConfigPath = resolvePath(configPath);
  const config = await readJson(resolvedConfigPath);
  const scenarioDefinition = ensureScenarioDefinition(scenarioId);
  const scenarioConfig = config.scenarios?.[scenarioId];

  if (!scenarioConfig) {
    throw new Error(`Scenario "${scenarioId}" is missing from ${resolvedConfigPath}.`);
  }

  const validationErrors = validateScenarioConfig(scenarioDefinition, scenarioConfig);
  if (validationErrors.length > 0) {
    throw new Error(
      `Scenario "${scenarioId}" config is invalid:\n- ${validationErrors.join("\n- ")}`,
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? config.rpcUrl;
  if (!rpcUrl) {
    throw new Error(
      `Missing rpcUrl in ${resolvedConfigPath}. Set "rpcUrl" in the config or export SOLANA_RPC_URL.`,
    );
  }

  const idlPath = resolvePath(config.idlPath ?? defaultGeneratedIdlPath);
  const programId = config.programId ?? null;

  if (programId && !base58PublicKeyPattern.test(programId)) {
    throw new Error(`Invalid programId in ${resolvedConfigPath}: ${programId}`);
  }

  return {
    resolvedConfigPath,
    rpcUrl,
    commitment: config.commitment ?? "confirmed",
    artifactDir: config.defaultArtifactDir ?? "artifacts/devnet-readiness",
    idlPath,
    programId,
    scenarioPlan: buildScenarioPlan(scenarioDefinition, scenarioConfig),
  };
}

async function rpcRequest(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`RPC error: ${payload.error.message}`);
  }

  return payload.result;
}

async function captureSnapshots(rpcUrl, commitment, snapshotTargets) {
  const pubkeys = snapshotTargets.map((target) => target.pubkey);
  const result = await rpcRequest(rpcUrl, "getMultipleAccounts", [
    pubkeys,
    { commitment, encoding: "base64" },
  ]);

  const accounts = snapshotTargets.map((target, index) => {
    const value = result.value[index];
    if (!value) {
      return {
        ...target,
        exists: false,
      };
    }

    const [dataBase64] = value.data;
    const dataLength = Buffer.from(dataBase64, "base64").length;

    return {
      ...target,
      exists: true,
      lamports: value.lamports,
      owner: value.owner,
      executable: value.executable,
      rentEpoch: value.rentEpoch,
      space: value.space ?? dataLength,
      dataLength,
      dataBase64,
    };
  });

  return {
    capturedAt: new Date().toISOString(),
    rpcUrl,
    commitment,
    slot: result.context.slot,
    accounts,
  };
}

function mapSnapshotByPubkey(snapshot) {
  return new Map(snapshot.accounts.map((account) => [account.pubkey, account]));
}

function buildBalanceDelta(preSnapshot, postSnapshot) {
  const preByPubkey = mapSnapshotByPubkey(preSnapshot);
  const postByPubkey = mapSnapshotByPubkey(postSnapshot);
  const orderedPubkeys = preSnapshot.accounts.map((account) => account.pubkey);

  const accountDeltas = orderedPubkeys.map((pubkey) => {
    const preAccount = preByPubkey.get(pubkey) ?? null;
    const postAccount = postByPubkey.get(pubkey) ?? null;
    const preLamports = preAccount?.lamports ?? 0;
    const postLamports = postAccount?.lamports ?? 0;

    return {
      label: preAccount?.label ?? postAccount?.label ?? pubkey,
      pubkey,
      existedBefore: Boolean(preAccount?.exists),
      existsAfter: Boolean(postAccount?.exists),
      preLamports,
      postLamports,
      deltaLamports: postLamports - preLamports,
    };
  });

  const totals = accountDeltas.reduce(
    (running, accountDelta) => ({
      preLamports: running.preLamports + accountDelta.preLamports,
      postLamports: running.postLamports + accountDelta.postLamports,
      deltaLamports: running.deltaLamports + accountDelta.deltaLamports,
    }),
    { preLamports: 0, postLamports: 0, deltaLamports: 0 },
  );

  return {
    capturedAt: new Date().toISOString(),
    preSlot: preSnapshot.slot,
    postSlot: postSnapshot.slot,
    accountDeltas,
    totals,
  };
}

function buildBundleDirectory(baseArtifactDir, scenarioId, bundleName) {
  const resolvedBase = resolvePath(baseArtifactDir);
  return path.join(
    resolvedBase,
    scenarioId,
    bundleName || timestampStamp(),
  );
}

async function captureTransactions(rpcUrl, commitment, signatures) {
  const transactions = [];

  for (const signature of signatures) {
    const result = await rpcRequest(rpcUrl, "getTransaction", [
      signature,
      {
        commitment,
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      },
    ]);

    transactions.push({
      signature,
      found: Boolean(result),
      slot: result?.slot ?? null,
      blockTime: result?.blockTime ?? null,
      version: result?.version ?? null,
      meta: result?.meta
        ? {
            err: result.meta.err ?? null,
            fee: result.meta.fee ?? null,
            preBalances: result.meta.preBalances ?? [],
            postBalances: result.meta.postBalances ?? [],
            logMessages: result.meta.logMessages ?? [],
          }
        : null,
      transaction: result?.transaction ?? null,
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    rpcUrl,
    commitment,
    transactions,
  };
}

async function walkDirectories(startDir) {
  const discovered = [];
  const queue = [startDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    let entries;

    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    discovered.push(currentDir);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(currentDir, entry.name));
      }
    }
  }

  return discovered;
}

async function walkFiles(startDir) {
  const discovered = [];
  const queue = [startDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    let entries;

    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        discovered.push(entryPath);
      }
    }
  }

  return discovered;
}

async function loadBundleRecord(bundleDir) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  const verdictPath = path.join(bundleDir, "verdict.json");

  try {
    const [manifest, verdict] = await Promise.all([
      readJson(manifestPath),
      readJson(verdictPath),
    ]);

    return {
      bundleDir,
      manifest,
      verdict,
    };
  } catch {
    return null;
  }
}

async function loadScenarioRunRecord(filePath) {
  if (!filePath.endsWith(".json")) {
    return null;
  }

  try {
    const scenarioRun = await readJson(filePath);
    const scenarioId = scenarioRun.scenarioId ?? null;
    if (!scenarioId || !scenarioById.has(scenarioId)) {
      return null;
    }

    const warnings = Array.isArray(scenarioRun.warnings) ? [...scenarioRun.warnings] : [];
    if (scenarioRun.finalStates?.taskSubmissionStatus === "[object Object]") {
      warnings.push(
        "Scenario artifact serialized taskSubmissionStatus as [object Object]; treat that field as cosmetic.",
      );
    }

    return {
      bundleDir: filePath,
      manifest: {
        scenarioId,
        createdAt: scenarioRun.createdAt ?? null,
      },
      verdict: {
        scenarioId,
        status: "pass",
        capturedAt: scenarioRun.createdAt ?? null,
        blockers: [],
        warnings,
        metrics: {
          evidenceSource: "scenario-run-artifact",
          artifactPath: filePath,
          remainingAccountCount: Array.isArray(scenarioRun.remainingAccounts)
            ? scenarioRun.remainingAccounts.length
            : 0,
          captureSignatureCount: Array.isArray(scenarioRun.captureSignatures)
            ? scenarioRun.captureSignatures.length
            : 0,
          finalStates: scenarioRun.finalStates ?? null,
          notes: Array.isArray(scenarioRun.notes) ? scenarioRun.notes : [],
        },
      },
    };
  } catch {
    return null;
  }
}

async function loadBaselineRecords(filePath) {
  let baseline;

  try {
    baseline = await readJson(filePath);
  } catch {
    return [];
  }

  return (baseline.scenarios ?? [])
    .map((scenario) => {
      const scenarioId = scenario.scenarioId ?? null;
      if (!scenarioId || !scenarioById.has(scenarioId)) {
        return null;
      }

      return {
        bundleDir: scenario.bundleDir ?? null,
        manifest: {
          scenarioId,
          createdAt: scenario.capturedAt ?? baseline.generatedAt ?? null,
        },
        verdict: {
          scenarioId,
          status: scenario.status ?? "unknown",
          capturedAt: scenario.capturedAt ?? baseline.generatedAt ?? null,
          blockers: scenario.blockers ?? [],
          warnings: scenario.warnings ?? [],
          metrics: scenario.metrics ?? null,
        },
      };
    })
    .filter(Boolean);
}

function compareBundleRecency(leftBundle, rightBundle) {
  const leftTimestamp = Date.parse(
    leftBundle.verdict?.capturedAt ?? leftBundle.manifest?.capturedAt ?? leftBundle.manifest?.createdAt ?? 0,
  );
  const rightTimestamp = Date.parse(
    rightBundle.verdict?.capturedAt ?? rightBundle.manifest?.capturedAt ?? rightBundle.manifest?.createdAt ?? 0,
  );

  return rightTimestamp - leftTimestamp;
}

export function buildReadinessReport(bundleRecords) {
  const latestByScenario = new Map();

  for (const bundleRecord of bundleRecords) {
    const scenarioId = bundleRecord.manifest?.scenarioId ?? bundleRecord.verdict?.scenarioId ?? null;
    if (!scenarioId) {
      continue;
    }

    const existing = latestByScenario.get(scenarioId);
    if (!existing || compareBundleRecency(bundleRecord, existing) < 0) {
      latestByScenario.set(scenarioId, bundleRecord);
    }
  }

  const scenarios = scenarioDefinitions.map((scenarioDefinition) => {
    const latestBundle = latestByScenario.get(scenarioDefinition.id) ?? null;
    if (!latestBundle) {
      return {
        scenarioId: scenarioDefinition.id,
        title: scenarioDefinition.title,
        recommendedFirst: Boolean(scenarioDefinition.recommendedFirst),
        status: "not_run",
        bundleDir: null,
        capturedAt: null,
        blockers: ["No captured bundle found for this scenario."],
        warnings: [],
      };
    }

    return {
      scenarioId: scenarioDefinition.id,
      title: scenarioDefinition.title,
      recommendedFirst: Boolean(scenarioDefinition.recommendedFirst),
      status: latestBundle.verdict?.status ?? "unknown",
      bundleDir: latestBundle.bundleDir,
      capturedAt:
        latestBundle.verdict?.capturedAt ??
        latestBundle.manifest?.capturedAt ??
        latestBundle.manifest?.createdAt ??
        null,
      blockers: latestBundle.verdict?.blockers ?? [],
      warnings: latestBundle.verdict?.warnings ?? [],
      metrics: latestBundle.verdict?.metrics ?? null,
    };
  });

  const summary = scenarios.reduce(
    (running, scenario) => {
      running.total += 1;
      running[scenario.status] = (running[scenario.status] ?? 0) + 1;
      return running;
    },
    {
      total: 0,
      pass: 0,
      fail: 0,
      not_run: 0,
      unknown: 0,
    },
  );

  const status = summary.pass === scenarioDefinitions.length ? "green" : "red";
  const openBlockers = scenarios.flatMap((scenario) =>
    (scenario.blockers ?? []).map((blocker) => ({
      scenarioId: scenario.scenarioId,
      blocker,
    })),
  );

  return {
    capturedAt: new Date().toISOString(),
    status,
    summary,
    scenarios,
    openBlockers,
  };
}

async function runMatrix() {
  const lines = scenarioDefinitions.map((scenarioDefinition) => {
    const marker = scenarioDefinition.recommendedFirst ? " *" : "";
    return `${scenarioDefinition.id}${marker}  ${scenarioDefinition.title}`;
  });

  console.log(lines.join("\n"));
  console.log("");
  console.log("* recommended first scenario");
}

async function runPrepare(options) {
  if (!options.scenario || !options.config) {
    throw new Error("prepare requires --scenario and --config");
  }

  const harnessInput = await loadHarnessInput(options.config, options.scenario);
  const programCatalog = await loadProgramCatalog({
    idlPath: options.idl ?? harnessInput.idlPath,
    programId: options["program-id"] ?? harnessInput.programId,
  });
  const bundleDir = buildBundleDirectory(
    harnessInput.artifactDir,
    harnessInput.scenarioPlan.scenarioId,
    options["bundle-name"],
  );

  const preState = await captureSnapshots(
    harnessInput.rpcUrl,
    harnessInput.commitment,
    harnessInput.scenarioPlan.snapshotTargets,
  );

  await mkdir(bundleDir, { recursive: true });

  const manifest = {
    scenarioId: harnessInput.scenarioPlan.scenarioId,
    title: harnessInput.scenarioPlan.title,
    createdAt: new Date().toISOString(),
    configPath: harnessInput.resolvedConfigPath,
    rpcUrl: harnessInput.rpcUrl,
    commitment: harnessInput.commitment,
    idlPath: programCatalog.idlPath,
    programId: programCatalog.programId,
    bundleDir,
    phasesCaptured: ["pre"],
  };

  await writeJson(path.join(bundleDir, "manifest.json"), manifest);
  await writeJson(path.join(bundleDir, "scenario-plan.json"), harnessInput.scenarioPlan);
  await writeJson(path.join(bundleDir, "remaining-accounts.json"), {
    capturedAt: new Date().toISOString(),
    scenarioId: harnessInput.scenarioPlan.scenarioId,
    remainingAccounts: harnessInput.scenarioPlan.remainingAccounts,
  });
  await writeJson(path.join(bundleDir, "pre-state.json"), preState);

  console.log(`Prepared bundle: ${bundleDir}`);
  console.log(`Scenario: ${harnessInput.scenarioPlan.scenarioId} ${harnessInput.scenarioPlan.title}`);
  console.log(`Tracked accounts: ${harnessInput.scenarioPlan.snapshotTargets.length}`);
  console.log("Next:");
  console.log(`  1. Execute the scenario transactions on devnet.`);
  console.log(
    `  2. Run: npm run devnet:marketplace:capture -- --bundle ${bundleDir} [--signature <tx_sig>]...`,
  );
}

async function runCapture(options) {
  if (!options.bundle) {
    throw new Error("capture requires --bundle");
  }

  const bundleDir = resolvePath(options.bundle);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const scenarioPlanPath = path.join(bundleDir, "scenario-plan.json");
  const preStatePath = path.join(bundleDir, "pre-state.json");

  const manifest = await readJson(manifestPath);
  const scenarioPlan = await readJson(scenarioPlanPath);
  const preState = await readJson(preStatePath);
  const postState = await captureSnapshots(
    manifest.rpcUrl,
    manifest.commitment,
    scenarioPlan.snapshotTargets,
  );
  const balanceDelta = buildBalanceDelta(preState, postState);
  let transactions = null;
  let orderingCheck = null;
  let eventSummary = null;

  manifest.capturedAt = new Date().toISOString();
  manifest.phasesCaptured = Array.from(new Set([...(manifest.phasesCaptured ?? []), "post"]));

  await writeJson(path.join(bundleDir, "post-state.json"), postState);
  await writeJson(path.join(bundleDir, "balance-delta.json"), balanceDelta);
  if (options.signature && options.signature.length > 0) {
    transactions = await captureTransactions(
      manifest.rpcUrl,
      manifest.commitment,
      options.signature,
    );
    await writeJson(path.join(bundleDir, "transactions.json"), transactions);
    manifest.phasesCaptured.push("transactions");

    const programCatalog = await loadProgramCatalog({
      idlPath: options.idl ?? manifest.idlPath,
      programId: options["program-id"] ?? manifest.programId,
    });
    orderingCheck = buildInstructionOrderReport(
      transactions,
      scenarioPlan,
      programCatalog,
    );
    await writeJson(path.join(bundleDir, "ordering-check.json"), orderingCheck);
    manifest.phasesCaptured.push("ordering");

    eventSummary = buildEventSummary(transactions, scenarioPlan);
    await writeJson(path.join(bundleDir, "event-summary.json"), eventSummary);
    manifest.phasesCaptured.push("event-summary");

    console.log(
      `Ordering checks: ${orderingCheck.summary.match} match, ${orderingCheck.summary.mismatch} mismatch, ${orderingCheck.summary.instruction_not_found} instruction-not-found`,
    );
  }
  const verdict = buildScenarioVerdict({
    scenarioPlan,
    balanceDelta,
    transactions,
    orderingCheck,
  });
  await writeJson(path.join(bundleDir, "verdict.json"), verdict);
  manifest.phasesCaptured.push("verdict");
  manifest.phasesCaptured = Array.from(new Set(manifest.phasesCaptured));
  await writeJson(manifestPath, manifest);

  console.log(`Captured post-state for bundle: ${bundleDir}`);
  console.log(`Total tracked lamport delta: ${balanceDelta.totals.deltaLamports}`);
  console.log(`Verdict: ${verdict.status}`);
  console.log("Largest deltas:");
  for (const accountDelta of balanceDelta.accountDeltas
    .slice()
    .sort((left, right) => Math.abs(right.deltaLamports) - Math.abs(left.deltaLamports))
    .slice(0, 5)) {
    console.log(
      `  ${accountDelta.label}: ${accountDelta.deltaLamports} lamports (${accountDelta.pubkey})`,
    );
  }
}

async function runReport(options) {
  const artifactsDir = resolvePath(options["artifacts-dir"] ?? "artifacts/devnet-readiness");
  const directories = await walkDirectories(artifactsDir);
  const bundleRecords = (
    await Promise.all(directories.map((directoryPath) => loadBundleRecord(directoryPath)))
  ).filter(Boolean);
  const scenarioRunRecords = (
    await Promise.all(
      (
        await walkFiles(path.join(artifactsDir, "scenario-runs"))
      ).map((filePath) => loadScenarioRunRecord(filePath)),
    )
  ).filter(Boolean);
  const baselineRecords = await loadBaselineRecords(
    path.join(artifactsDir, "readiness-baseline.json"),
  );
  const report = buildReadinessReport([
    ...baselineRecords,
    ...bundleRecords,
    ...scenarioRunRecords,
  ]);
  const reportPath = path.join(artifactsDir, "readiness-report.json");

  await mkdir(artifactsDir, { recursive: true });
  await writeJson(reportPath, report);

  console.log(`Readiness report: ${reportPath}`);
  console.log(`Status: ${report.status}`);
  console.log(
    `Scenarios: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.not_run} not-run`,
  );

  if (report.openBlockers.length > 0) {
    console.log("Open blockers:");
    for (const blocker of report.openBlockers.slice(0, 10)) {
      console.log(`  ${blocker.scenarioId}: ${blocker.blocker}`);
    }
  }
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));

    if (command === "matrix") {
      await runMatrix();
      return;
    }

    if (command === "prepare") {
      await runPrepare(options);
      return;
    }

    if (command === "capture") {
      await runCapture(options);
      return;
    }

    if (command === "report") {
      await runReport(options);
      return;
    }

    throw new Error(`Unknown command "${command}"`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage(1);
  }
}

const directExecutionUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (import.meta.url === directExecutionUrl) {
  await main();
}
