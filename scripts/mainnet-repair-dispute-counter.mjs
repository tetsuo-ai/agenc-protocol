#!/usr/bin/env node
// Reviewed incident recovery. PLAN simulates unsigned messages and sends nothing.
// PREPARE: PAYER_KEYPAIR, RPC_URL; revision-5 payload must still be live.
// REPAIR: AUTHORITY_KEYPAIR, COSIGNERS (comma-separated paths), RPC_URL,
// EXPECTED_IDL_SHA256, EXPECTED_SO_SHA256; approved revision-8 executable live.
// --phase prepare|repair [--execute --confirm <incident dispute>]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadDisputeCounterRepairRecord,
  validateDisputeCounterRepairRecord,
} from "./mainnet-upgrade.mjs";
import {
  PROGRAM_ID,
  MAINNET_GENESIS,
  decodeDispute,
  decodeAgentBinding,
  decodeTaskBinding,
  decodeClaimBinding,
  scanDisputes,
  redactRpcText,
} from "./preflight-dispute-scan.mjs";
import { MANUAL_VALIDATION_SENTINEL } from "./preflight-private-task-scan.mjs";
import {
  loadReviewedUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
  assertImmediatePreUpgradeSnapshot,
  assertApprovedExecutableSnapshot,
} from "./program-upgrade-authority-policy.mjs";
import {
  reviewFreshAdminTransaction,
  assertReviewedAdminTransaction,
} from "./admin-signing-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pk = (value) => new PublicKey(value);
const eq = (a, b) => pk(a).equals(pk(b));
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) =>
      typeof s === "string"
        ? Buffer.from(s)
        : s instanceof PublicKey
          ? s.toBuffer()
          : s,
    ),
    PROGRAM_ID,
  );
export const PROTOCOL_PDA = pda("protocol")[0];
export const repairReceiptPda = (incident) =>
  pda("dispute_counter_repair", pk(incident))[0];
const recordedDisputes = (record) => [
  record.incident,
  ...record.siblingDisputes,
];
const terminal = (dispute) =>
  [1, 2, 3].includes(dispute.status) && dispute.resolvedAt > 0n;
const observed = (disputes) =>
  disputes
    .map(
      (d) =>
        `${d.pubkey}:status=${d.status},tracked=${d.totalVoters === 255},finalized=${d.initiatorSlashApplied}`,
    )
    .join("; ");

export function parseRepairArgs(argv) {
  const result = {
    phase: "repair",
    execute: false,
    confirm: null,
    help: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`duplicate argument ${arg}`);
    seen.add(arg);
    if (arg === "--execute") result.execute = true;
    else if (arg === "--help") result.help = true;
    else if (arg === "--phase" || arg === "--confirm") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      result[arg.slice(2)] = value;
    } else
      throw new Error(
        `unknown argument ${arg}; key material is accepted only as env file paths`,
      );
  }
  if (!["prepare", "repair"].includes(result.phase))
    throw new Error("--phase must be prepare or repair");
  if (result.execute && !result.confirm)
    throw new Error("--execute requires --confirm <incident dispute>");
  if (result.confirm && !result.execute)
    throw new Error("--confirm requires --execute");
  return result;
}

// Same plain-array boundary as mainnet-migrate-sweep. No inline secrets or vaults.
function loadKeypair(filePath) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim() ||
    /^[\[{]/.test(filePath.trim())
  ) {
    throw new Error("keypair must be an explicitly configured file path");
  }
  const absolute = path.resolve(
    filePath.replace(/^~(?=$|\/)/, process.env.HOME),
  );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`cannot read keypair ${absolute}: ${error.message}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(
      `keypair ${absolute} must be a plain 64-byte JSON array; encrypted vault/object inputs are refused.`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export function assertRepairExecutableBinding({
  genesisHash,
  policy,
  snapshot,
  binaryBytes,
  expectedSoSha256,
}) {
  if (
    genesisHash !== MAINNET_GENESIS ||
    policy?.genesisHash !== MAINNET_GENESIS ||
    policy?.programId !== PROGRAM_ID.toBase58()
  ) {
    throw new Error(
      "repair executable policy must bind the pinned mainnet genesis and program",
    );
  }
  return assertApprovedExecutableSnapshot({
    genesisHash,
    policy,
    snapshot,
    binaryBytes,
    expectedSha256: expectedSoSha256,
  });
}

export function assertRepairIdlBinding(idlBytes, expectedIdlSha256) {
  const idl = JSON.parse(Buffer.from(idlBytes).toString("utf8"));
  if (idl.address !== PROGRAM_ID.toBase58())
    throw new Error("IDL program ID mismatch");
  if (
    !/^[0-9a-fA-F]{64}$/.test(expectedIdlSha256 ?? "") ||
    sha(idlBytes) !== expectedIdlSha256.toLowerCase()
  ) {
    throw new Error(
      "EXPECTED_IDL_SHA256 is required and must match the reviewed IDL",
    );
  }
  // The admin reviewer uses the committed canonical IDL, so bind to it too.
  const canonical = JSON.parse(
    readFileSync(
      path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json"),
      "utf8",
    ),
  );
  for (const name of [
    "repair_dispute_initiator_counter",
    "expire_dispute",
    "apply_initiator_slash",
  ]) {
    const instruction = idl.instructions.find((ix) => ix.name === name);
    if (
      !instruction ||
      JSON.stringify(instruction) !==
        JSON.stringify(canonical.instructions.find((ix) => ix.name === name))
    ) {
      throw new Error(`reviewed IDL ABI mismatch: ${name}`);
    }
  }
  return idl;
}

function requireProgramAccount(info, label) {
  if (
    !info ||
    info.lamports <= 0 ||
    info.executable ||
    !info.owner.equals(PROGRAM_ID)
  ) {
    throw new Error(`${label}: missing or invalid program-owned account`);
  }
  return info.data;
}
function assertPda(address, bump, ...seeds) {
  const [expected, expectedBump] = pda(...seeds);
  if (!eq(address, expected) || bump !== expectedBump)
    throw new Error(`invalid canonical PDA/bump: ${address}`);
}
async function readDecoded(connection, address, decoder, label) {
  return decoder(
    requireProgramAccount(
      await connection.getAccountInfo(pk(address), "confirmed"),
      label,
    ),
  );
}
export async function readRepairState({ connection, program, record }) {
  validateDisputeCounterRepairRecord(record);
  const config = await readDecoded(
    connection,
    PROTOCOL_PDA,
    (data) => program.coder.accounts.decode("protocolConfig", data),
    "ProtocolConfig",
  );
  assertPda(PROTOCOL_PDA, config.bump, "protocol");
  if (config.protocolPaused !== true)
    throw new Error("ProtocolConfig.protocol_paused must be true");
  const agent = await readDecoded(
    connection,
    record.initiatorAgent,
    decodeAgentBinding,
    "initiator agent",
  );
  assertPda(record.initiatorAgent, agent.bump, "agent", agent.agentId);
  const disputes = [];
  for (const item of recordedDisputes(record)) {
    const info = await connection.getAccountInfo(pk(item.dispute), "confirmed");
    const data = requireProgramAccount(info, "recorded dispute");
    const dispute = decodeDispute(data);
    assertPda(item.dispute, dispute.bump, "dispute", dispute.disputeId);
    if (
      !eq(dispute.task, item.task) ||
      !eq(dispute.initiator, record.initiatorAgent) ||
      !eq(dispute.defendant, record.initiatorAgent) ||
      !eq(dispute.initiatorAuthority, agent.authority) ||
      dispute.totalVoters !== 255 ||
      data[229] !== 0
    ) {
      throw new Error(
        `recorded worker-initiated dispute binding mismatch: ${item.dispute}`,
      );
    }
    if (
      item.claim &&
      !eq(item.claim, pda("claim", dispute.task, dispute.defendant)[0])
    ) {
      throw new Error(
        `recorded incident claim does not match the canonical defendant claim: ${item.dispute}`,
      );
    }
    disputes.push({ ...dispute, pubkey: pk(item.dispute) });
  }
  return { config, agent, disputes };
}

export function selectPendingDispute(record, disputes) {
  const allowed = recordedDisputes(record)
    .map((d) => d.dispute)
    .sort();
  const actual = disputes.map((d) => String(d.pubkey)).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(allowed) ||
    disputes.some(
      (d) =>
        !eq(d.initiator, record.initiatorAgent) ||
        d.totalVoters !== 255 ||
        !terminal(d),
    )
  ) {
    throw new Error(
      `repair needs the exact recorded terminal tracked disputes: ${observed(disputes)}`,
    );
  }
  const pending = disputes.filter((d) => !d.initiatorSlashApplied);
  if (pending.length !== 1)
    throw new Error(
      `repair needs exactly one unfinalized dispute: ${observed(disputes)}`,
    );
  return pending[0];
}

export function selectRepairOwners(config, authority, cosigners) {
  if (!eq(authority.publicKey, config.authority))
    throw new Error("AUTHORITY_KEYPAIR must equal ProtocolConfig.authority");
  const owners = config.multisigOwners
    .slice(0, config.multisigOwnersLen)
    .map(String);
  if (
    !Number.isInteger(config.multisigThreshold) ||
    config.multisigThreshold < 2 ||
    config.multisigThreshold > owners.length ||
    config.multisigOwnersLen > config.multisigOwners.length ||
    owners.some((owner) => owner === PublicKey.default.toBase58()) ||
    new Set(owners).size !== owners.length
  ) {
    throw new Error("invalid ProtocolConfig multisig threshold/owners");
  }
  const all = [authority, ...cosigners];
  if (new Set(all.map((s) => String(s.publicKey))).size !== all.length)
    throw new Error("duplicate supplied signer");
  if (cosigners.some((s) => !owners.includes(String(s.publicKey))))
    throw new Error("cosigner is not a current multisig owner");
  const ownerSigners = all.filter((s) => owners.includes(String(s.publicKey)));
  if (ownerSigners.length < config.multisigThreshold)
    throw new Error(
      `multisig needs ${config.multisigThreshold} distinct owners; supplied ${ownerSigners.length}`,
    );
  return ownerSigners.map((s) => ({
    pubkey: s.publicKey,
    isSigner: true,
    isWritable: false,
  }));
}

export function deriveExpireAccounts({
  dispute,
  task,
  worker,
  authority,
  validationRequired = false,
}) {
  if (task.rewardMint !== null)
    throw new Error(
      "unsupported expiry shape: token-denominated task requires a separately reviewed rail",
    );
  if (![0, 3].includes(task.taskType) || task.currentWorkers !== 1) {
    throw new Error(
      "unsupported expiry shape: only Exclusive/BidExclusive with one worker are supported; peer settlement requires separate review",
    );
  }
  if (task.status !== 5) throw new Error("expiry requires a Disputed task");
  assertPda(dispute.task, task.bump, "task", task.creator, task.taskId);
  const workerClaim = pda("claim", dispute.task, dispute.defendant)[0];
  const escrow = pda("escrow", dispute.task)[0];
  if (!eq(task.escrow, escrow)) throw new Error("Task escrow binding mismatch");
  const accounts = {
    dispute: dispute.pubkey,
    task: dispute.task,
    escrow,
    protocolConfig: PROTOCOL_PDA,
    creator: task.creator,
    authority,
    workerClaim,
    worker: dispute.defendant,
    workerWallet: worker.authority,
    hireRecord: pda("hire", dispute.task)[0],
    disputeOperator: null,
    disputeReferrer: null,
    tokenEscrowAta: null,
    creatorTokenAccount: null,
    workerTokenAccountAta: null,
    rewardMint: null,
    tokenProgram: null,
    creatorCompletionBond: pda(
      "completion_bond",
      dispute.task,
      task.creator,
    )[0],
    workerCompletionBond: pda(
      "completion_bond",
      dispute.task,
      worker.authority,
    )[0],
    taskSubmission: pda("task_submission", workerClaim)[0],
    taskValidationConfig: validationRequired
      ? pda("task_validation", dispute.task)[0]
      : null,
  };
  const remaining = [];
  if (task.dependencyType !== 0) {
    if (!task.dependsOn)
      throw new Error("dependent task is missing its parent");
    remaining.push({
      pubkey: task.dependsOn,
      isSigner: false,
      isWritable: false,
    });
  } else if (task.dependsOn)
    throw new Error("unexpected parent on dependency-free task");
  if (task.taskType === 3) {
    remaining.push(
      ...[
        pda("bid_book", dispute.task)[0],
        pda("bid", dispute.task, dispute.defendant)[0],
        pda("bidder_market", dispute.defendant)[0],
      ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    );
  }
  return { accounts, remaining };
}

export async function buildExpireInstruction({
  connection,
  program,
  dispute,
  worker,
  authority,
}) {
  const task = await readDecoded(
    connection,
    dispute.task,
    decodeTaskBinding,
    "Task",
  );
  let derived = deriveExpireAccounts({ dispute, task, worker, authority });
  const claim = await readDecoded(
    connection,
    derived.accounts.workerClaim,
    decodeClaimBinding,
    "TaskClaim",
  );
  assertPda(
    derived.accounts.workerClaim,
    claim.bump,
    "claim",
    dispute.task,
    dispute.defendant,
  );
  if (!eq(claim.task, dispute.task) || !eq(claim.worker, dispute.defendant))
    throw new Error("defendant claim binding mismatch");
  const submissionInfo = await connection.getAccountInfo(
    derived.accounts.taskSubmission,
    "confirmed",
  );
  if (
    submissionInfo &&
    (submissionInfo.lamports > 0 || submissionInfo.data.length > 0)
  ) {
    // An empty system-owned PDA proves absence. Every live program record is decoded.
    if (
      !(
        submissionInfo.owner.equals(SystemProgram.programId) &&
        submissionInfo.data.length === 0
      )
    ) {
      const submission = program.coder.accounts.decode(
        "taskSubmission",
        requireProgramAccount(submissionInfo, "TaskSubmission"),
      );
      assertPda(
        derived.accounts.taskSubmission,
        submission.bump,
        "task_submission",
        derived.accounts.workerClaim,
      );
      if (
        !eq(submission.task, dispute.task) ||
        !eq(submission.claim, derived.accounts.workerClaim) ||
        !eq(submission.worker, dispute.defendant)
      )
        throw new Error("submission binding mismatch");
      const validationRequired =
        Object.hasOwn(submission.status, "submitted") &&
        task.constraintHash.equals(
          MANUAL_VALIDATION_SENTINEL,
        );
      derived = deriveExpireAccounts({
        dispute,
        task,
        worker,
        authority,
        validationRequired,
      });
      if (validationRequired) {
        const config = await readDecoded(
          connection,
          derived.accounts.taskValidationConfig,
          (data) => program.coder.accounts.decode("taskValidationConfig", data),
          "TaskValidationConfig",
        );
        assertPda(
          derived.accounts.taskValidationConfig,
          config.bump,
          "task_validation",
          dispute.task,
        );
        if (!eq(config.task, dispute.task))
          throw new Error("validation config task mismatch");
      }
    }
  }
  if (task.dependencyType !== 0) {
    const parent = await readDecoded(
      connection,
      task.dependsOn,
      decodeTaskBinding,
      "dependency parent",
    );
    assertPda(
      task.dependsOn,
      parent.bump,
      "task",
      parent.creator,
      parent.taskId,
    );
  }
  if (task.taskType === 3) {
    const metas = derived.remaining.slice(-3);
    const [book, bid, bidder] = await Promise.all(
      metas.map((meta, i) =>
        readDecoded(
          connection,
          meta.pubkey,
          (data) =>
            program.coder.accounts.decode(
              ["taskBidBook", "taskBid", "bidderMarketState"][i],
              data,
            ),
          "bid settlement account",
        ),
      ),
    );
    if (
      !eq(book.task, dispute.task) ||
      !book.acceptedBid ||
      !eq(book.acceptedBid, metas[1].pubkey) ||
      !Object.hasOwn(book.state, "accepted") ||
      !Object.hasOwn(bid.state, "accepted") ||
      !eq(bid.task, dispute.task) ||
      !eq(bid.bidBook, metas[0].pubkey) ||
      !eq(bid.bidder, dispute.defendant) ||
      !eq(bid.bidderAuthority, worker.authority) ||
      !eq(bidder.bidder, dispute.defendant)
    ) {
      throw new Error("accepted bid settlement binding mismatch");
    }
  }
  return program.methods
    .expireDispute()
    .accountsStrict(derived.accounts)
    .remainingAccounts(derived.remaining)
    .instruction();
}

function finalizeInstruction(program, state, dispute, authority) {
  return program.methods
    .applyInitiatorSlash()
    .accountsStrict({
      dispute: dispute.pubkey,
      initiatorAgent: dispute.initiator,
      protocolConfig: PROTOCOL_PDA,
      treasury: state.config.treasury,
      authority,
    })
    .instruction();
}

// The CLI always supplies a pinned genesis/executable guard. Tests inject a local
// guard while exercising this same unsigned review, signing, and sending path.
export async function runReviewedInstructions({
  connection,
  instructions,
  signers,
  execute,
  guard,
  log = console.log,
  label,
}) {
  if (typeof guard !== "function")
    throw new Error("an executable/genesis binding guard is required");
  const before = await guard();
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: signers[0].publicKey,
    ...latest,
  }).add(...instructions);
  const signerPublicKeys = signers.map((s) => s.publicKey);
  const review = await reviewFreshAdminTransaction({
    connection,
    transaction,
    latest,
    signerPublicKeys,
    minContextSlot: before?.contextSlot ?? 0,
  });
  log(`${label}: unsigned admin review ${JSON.stringify(review)}`);
  if (!execute) return { review, signature: null };
  await guard(review.contextSlot);
  assertReviewedAdminTransaction(transaction, review, signerPublicKeys);
  transaction.sign(...signers);
  const localSignature = bs58.encode(transaction.signature);
  log(`${label}: local signature ${localSignature}`);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
  );
  if (signature !== localSignature)
    throw new Error(
      `RPC returned a mismatched signature; inspect ${localSignature} before retrying`,
    );
  const confirmed = await connection.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (confirmed.value.err)
    throw new Error(
      `transaction ${signature} failed: ${JSON.stringify(confirmed.value.err)}`,
    );
  await guard(confirmed.context.slot);
  return { review, signature };
}

export function assertPreparedState(record, state) {
  const pending = selectPendingDispute(record, state.disputes);
  if (
    state.agent.pendingInitiatorOutcomes !== 0 ||
    state.agent.disputesAsDefendant !== 0
  ) {
    throw new Error(
      `prepare postcondition: counters must be 0/0, observed ${state.agent.pendingInitiatorOutcomes}/${state.agent.disputesAsDefendant}`,
    );
  }
  return pending;
}
export async function runPreparePhase({
  connection,
  program,
  record,
  payer,
  execute = false,
  guard,
  log = console.log,
}) {
  await guard();
  let state = await readRepairState({ connection, program, record });
  const results = [];
  // Reject partial or unexpected finalization before making any mutation.
  if (
    state.disputes.some(
      (d) => d.status === 4 || (!terminal(d) && d.status !== 0),
    )
  )
    throw new Error(`unsupported prepare state: ${observed(state.disputes)}`);
  const pending = state.disputes.filter((d) => !d.initiatorSlashApplied);
  if (pending.length === 1 && state.disputes.every(terminal)) {
    assertPreparedState(record, state);
    log(
      "PREPARE already complete: counters=0/0, exactly one recorded outcome pending.",
    );
    return { results, state };
  }
  if (
    pending.length !== 2 ||
    state.agent.pendingInitiatorOutcomes !== 1 ||
    state.agent.disputesAsDefendant > 1
  ) {
    throw new Error(
      `unexpected historical counter/finalizer shape: counters=${state.agent.pendingInitiatorOutcomes}/${state.agent.disputesAsDefendant}; ${observed(state.disputes)}`,
    );
  }
  const expirations = [];
  for (const dispute of state.disputes) {
    if (dispute.status !== 0) continue;
    expirations.push({
      dispute,
      instruction: await buildExpireInstruction({
        connection,
        program,
        dispute,
        worker: state.agent,
        authority: payer.publicKey,
      }),
    });
  }
  for (const { dispute, instruction } of expirations) {
    results.push(
      await runReviewedInstructions({
        connection,
        instructions: [instruction],
        signers: [payer],
        execute,
        guard,
        log,
        label: `expire_dispute ${dispute.pubkey}`,
      }),
    );
  }
  state = await readRepairState({ connection, program, record });
  if (!state.disputes.every(terminal)) {
    if (execute)
      throw new Error(
        `prepare did not terminalize both disputes: ${observed(state.disputes)}`,
      );
    log(
      "PLAN: expiry simulations succeeded. Once both disputes are terminal, rerun prepare to simulate/finalize the recorded sibling. No transactions sent.",
    );
    return { results, state, finalizerDeferred: true };
  }
  if (
    state.disputes.some((d) => d.initiatorSlashApplied) ||
    state.agent.pendingInitiatorOutcomes !== 1 ||
    state.agent.disputesAsDefendant !== 0
  ) {
    throw new Error(
      `refusing sibling finalization: counters=${state.agent.pendingInitiatorOutcomes}/${state.agent.disputesAsDefendant}; ${observed(state.disputes)}`,
    );
  }
  const sibling = state.disputes.find((d) =>
    eq(d.pubkey, record.siblingDisputes[0].dispute),
  );
  results.push(
    await runReviewedInstructions({
      connection,
      instructions: [
        await finalizeInstruction(program, state, sibling, payer.publicKey),
      ],
      signers: [payer],
      execute,
      guard,
      log,
      label: `apply_initiator_slash sibling ${sibling.pubkey}`,
    }),
  );
  if (execute) {
    state = await readRepairState({ connection, program, record });
    assertPreparedState(record, state);
    log(
      "PREPARE verified: both disputes terminal, counters=0/0, exactly one recorded outcome pending.",
    );
  }
  return { results, state };
}

export function assertRepairReceipt(receipt, { record, pending, authority }) {
  if (
    !eq(receipt.incidentDispute, record.incident.dispute) ||
    !eq(receipt.pendingDispute, pending.pubkey) ||
    !eq(receipt.initiatorAgent, record.initiatorAgent) ||
    !eq(receipt.repairedBy, authority) ||
    receipt.initiatorUnitsRestored !== 1 ||
    !Buffer.from(receipt.incidentSignature).equals(
      Buffer.from(bs58.decode(record.incident.initiateDisputeSignature)),
    ) ||
    BigInt(receipt.repairedAt.toString()) <= 0n
  )
    throw new Error("repair receipt postcondition mismatch");
  assertPda(
    repairReceiptPda(record.incident.dispute),
    receipt.bump,
    "dispute_counter_repair",
    pk(record.incident.dispute),
  );
}
export async function runRepairPhase({
  connection,
  program,
  record,
  authority,
  cosigners = [],
  execute = false,
  guard,
  log = console.log,
  scan = scanDisputes,
}) {
  await guard();
  const state = await readRepairState({ connection, program, record });
  const pending = assertPreparedState(record, state);
  const receiptPda = repairReceiptPda(record.incident.dispute);
  if (await connection.getAccountInfo(receiptPda, "confirmed"))
    throw new Error("repair receipt already exists; refuse replay");
  const ownerMetas = selectRepairOwners(state.config, authority, cosigners);
  const repair = await program.methods
    .repairDisputeInitiatorCounter([
      ...bs58.decode(record.incident.initiateDisputeSignature),
    ])
    .accountsStrict({
      protocolConfig: PROTOCOL_PDA,
      incidentDispute: pk(record.incident.dispute),
      pendingDispute: pending.pubkey,
      initiatorAgent: pk(record.initiatorAgent),
      repairReceipt: receiptPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(ownerMetas)
    .instruction();
  const finalizer = await finalizeInstruction(
    program,
    state,
    pending,
    authority.publicKey,
  );
  const result = await runReviewedInstructions({
    connection,
    instructions: [repair, finalizer],
    signers: [authority, ...cosigners],
    execute,
    guard,
    log,
    label: `ATOMIC repair + apply_initiator_slash ${pending.pubkey}`,
  });
  if (execute) {
    const receipt = await readDecoded(
      connection,
      receiptPda,
      (data) => program.coder.accounts.decode("disputeCounterRepair", data),
      "repair receipt",
    );
    assertRepairReceipt(receipt, {
      record,
      pending,
      authority: authority.publicKey,
    });
    const after = await readRepairState({ connection, program, record });
    if (
      after.disputes.some((d) => !d.initiatorSlashApplied) ||
      after.agent.pendingInitiatorOutcomes !== 0 ||
      after.agent.disputesAsDefendant !== 0
    ) {
      throw new Error("repair finalizer/counter postcondition failed");
    }
    const scanned = await scan(connection);
    if (scanned.blockers.length || scanned.statusCounts.active !== 0)
      throw new Error(
        `repair landed but release scan is not clean: blockers=${scanned.blockers.length} active=${scanned.statusCounts.active}`,
      );
    log(
      `REPAIR verified: receipt=${receiptPda}, finalized=true, counters=0/0, scanner blockers=0, Active=0.`,
    );
    return { ...result, receipt, state: after, scan: scanned };
  }
  return result;
}

async function main() {
  const args = parseRepairArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/mainnet-repair-dispute-counter.mjs --phase prepare|repair [--execute --confirm <incident dispute>]\nPLAN simulates without signing. Keys: PAYER_KEYPAIR for prepare; AUTHORITY_KEYPAIR and COSIGNERS for repair. Repair also requires EXPECTED_IDL_SHA256 and EXPECTED_SO_SHA256. RPC_URL must be mainnet.",
    );
    return;
  }
  const record = loadDisputeCounterRepairRecord();
  if (args.execute && args.confirm !== record.incident.dispute)
    throw new Error(
      "--confirm must exactly equal the reviewed incident dispute",
    );
  if (
    process.env.PROGRAM_ID &&
    process.env.PROGRAM_ID !== PROGRAM_ID.toBase58()
  )
    throw new Error("PROGRAM_ID must equal the pinned mainnet program");
  const idlBytes = readFileSync(
    path.resolve(
      ROOT,
      process.env.IDL_PATH || "artifacts/anchor/idl/agenc_coordination.json",
    ),
  );
  // Prepare also binds to the committed ABI. It does not approve a new binary.
  const expectedIdl =
    args.phase === "repair"
      ? process.env.EXPECTED_IDL_SHA256
      : sha(
          readFileSync(
            path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json"),
          ),
        );
  const idl = assertRepairIdlBinding(idlBytes, expectedIdl);
  const policy = loadReviewedUpgradeAuthorityPolicy();
  const connection = new Connection(
    process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS)
    throw new Error(
      `wrong cluster genesis ${genesisHash}; mainnet-beta required`,
    );
  const initial = await readProgramUpgradeAuthoritySnapshot(
    connection,
    policy,
    { commitment: "confirmed" },
  );
  const binaryBytes =
    args.phase === "repair"
      ? readFileSync(
          path.resolve(
            ROOT,
            process.env.SO_PATH ||
              "programs/agenc-coordination/target/deploy/agenc_coordination.so",
          ),
        )
      : null;
  const guard = async (minContextSlot = initial.contextSlot) => {
    if ((await connection.getGenesisHash()) !== MAINNET_GENESIS)
      throw new Error("RPC genesis changed");
    const snapshot = await readProgramUpgradeAuthoritySnapshot(
      connection,
      policy,
      { commitment: "confirmed", minContextSlot },
    );
    assertImmediatePreUpgradeSnapshot(initial, snapshot);
    const config = await readDecoded(
      connection,
      PROTOCOL_PDA,
      (data) =>
        new anchor.BorshCoder(idl).accounts.decode("ProtocolConfig", data),
      "ProtocolConfig",
    );
    if (config.protocol_paused !== true)
      throw new Error("ProtocolConfig.protocol_paused must remain true");
    if (args.phase === "prepare") {
      if (
        sha(snapshot.payload) !==
        record.priorRevision.payloadSha256.toLowerCase()
      )
        throw new Error(
          "prepare requires the exact reviewed revision-5 payload still live",
        );
    } else {
      assertRepairExecutableBinding({
        genesisHash,
        policy,
        snapshot,
        binaryBytes,
        expectedSoSha256: process.env.EXPECTED_SO_SHA256,
      });
      if (
        sha(snapshot.payload) ===
        record.priorRevision.payloadSha256.toLowerCase()
      )
        throw new Error(
          "repair requires the approved revision-8 executable, not revision 5",
        );
    }
    return snapshot;
  };
  await guard();
  // Read only the explicitly configured paths, after all chain/artifact gates.
  const signer = loadKeypair(
    args.phase === "prepare"
      ? process.env.PAYER_KEYPAIR
      : process.env.AUTHORITY_KEYPAIR,
  );
  const cosigners =
    args.phase === "repair"
      ? (process.env.COSIGNERS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(loadKeypair)
      : [];
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
      commitment: "confirmed",
    }),
  );
  console.log(
    `${args.execute ? "EXECUTE" : "PLAN"} phase=${args.phase} rpc=<redacted-rpc> program=${PROGRAM_ID} incident=${record.incident.dispute}`,
  );
  const common = { connection, program, record, execute: args.execute, guard };
  if (args.phase === "prepare")
    await runPreparePhase({ ...common, payer: signer });
  else await runRepairPhase({ ...common, authority: signer, cosigners });
}
const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invoked)
  main().catch((error) => {
    console.error(`REPAIR FAIL: ${redactRpcText(error.message ?? error)}`);
    process.exitCode = 1;
  });
