#!/usr/bin/env node
// Read-only mainnet inventory for settlement solvency and fee-payee routing.
//
// The upgraded program rejects collaborative tasks that cannot pay at least one
// gross reward unit per required completion. It also rejects active marketplace
// payees aliased to the creator-owned Task/escrow lifecycle, where a same-account
// transfer could otherwise be counted without moving value. This scanner proves
// that every nonterminal live Task can pass those fail-closed settlement guards
// before the binary is upgraded.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  decodeTaskBinding,
  redactRpcText,
} from "./preflight-dispute-scan.mjs";
import { decodeHireRecordProvider } from "./preflight-hire-provider-scan.mjs";
import { MANUAL_VALIDATION_SENTINEL } from "./preflight-private-task-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const HIRE_DISCRIMINATOR = createHash("sha256")
  .update("account:HireRecord")
  .digest()
  .subarray(0, 8);
const TERMINAL_STATUSES = new Set([3, 4]);
const REVISION4_BOND_POST_STATUSES = new Set([0, 1, 2]);
const TASK_TYPE_EXCLUSIVE = 0;
const TASK_TYPE_COLLABORATIVE = 1;
const ZERO_HASH = Buffer.alloc(32);
const COMPLETIONS_OFFSET = 308;
const REQUIRED_COMPLETIONS_OFFSET = 309;

function asPublicKey(value) {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function issue(kind, task, detail, extra = {}) {
  return { kind, task: task.toBase58(), detail, ...extra };
}

function activePayeeIssues({
  taskAddress,
  escrow,
  creator,
  operator,
  operatorFeeBps,
  referrer,
  referrerFeeBps,
  source,
}) {
  const issues = [];
  const forbidden = new Map([
    [creator.toBase58(), "creator"],
    [taskAddress.toBase58(), "task"],
    [escrow.toBase58(), "escrow"],
  ]);
  for (const [role, payee, feeBps] of [
    ["operator", operator, operatorFeeBps],
    ["referrer", referrer, referrerFeeBps],
  ]) {
    if (feeBps === 0) continue;
    if (payee.equals(PublicKey.default)) {
      issues.push(
        issue(
          `${role}-payee-missing`,
          taskAddress,
          `${source} ${role}_fee_bps=${feeBps} has the default payee`,
          { role, source, feeBps },
        ),
      );
      continue;
    }
    const alias = forbidden.get(payee.toBase58());
    if (alias) {
      issues.push(
        issue(
          `${role}-payee-alias`,
          taskAddress,
          `${source} ${role} payee aliases ${alias}`,
          { role, source, alias, payee: payee.toBase58(), feeBps },
        ),
      );
    }
  }
  return issues;
}

/**
 * Match the deployed revision-4 `post_completion_bond` entry surface exactly.
 * That instruction is not pause-gated, so a zero CompletionBond snapshot is
 * stable during loader upload only when no Task remains eligible for a new post.
 */
export function isRevision4BondPostEligible(task) {
  return (
    task.taskType === TASK_TYPE_EXCLUSIVE &&
    REVISION4_BOND_POST_STATUSES.has(task.status) &&
    task.rewardMint === null &&
    (
      task.constraintHash.equals(ZERO_HASH) ||
      task.constraintHash.equals(MANUAL_VALIDATION_SENTINEL)
    )
  );
}

/**
 * Inspect one canonical Task using the exact settlement term precedence in Rust:
 * Task-stamped terms first, then the canonical legacy HireRecord fallback.
 *
 * Structural ambiguity throws and is always a deployment blocker. Economic
 * violations are returned as blockers only while the Task remains nonterminal;
 * terminal violations remain visible inventory because no settlement exit is
 * left to strand.
 */
export function inspectTaskSettlementRecord(
  addressLike,
  dataLike,
  legacyHireRecord = null,
) {
  const address = asPublicKey(addressLike);
  const data = Buffer.from(dataLike);
  const task = decodeTaskBinding(data);
  const [expectedTask, expectedTaskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
    PROGRAM_ID,
  );
  if (!expectedTask.equals(address) || expectedTaskBump !== task.bump) {
    throw new Error("canonical Task PDA/bump mismatch");
  }
  const [expectedEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), address.toBuffer()],
    PROGRAM_ID,
  );
  if (!task.escrow.equals(expectedEscrow)) {
    throw new Error(
      `Task.escrow ${task.escrow.toBase58()} is not canonical ${expectedEscrow.toBase58()}`,
    );
  }

  const completions = data[COMPLETIONS_OFFSET];
  const requiredCompletions = data[REQUIRED_COMPLETIONS_OFFSET];
  const expectedRequired = task.taskType === TASK_TYPE_COLLABORATIVE
    ? task.maxWorkers
    : 1;
  if (task.maxWorkers === 0) {
    throw new Error("Task.max_workers must be positive");
  }
  if (requiredCompletions === 0 || requiredCompletions !== expectedRequired) {
    throw new Error(
      `Task.required_completions=${requiredCompletions}; expected ${expectedRequired}`,
    );
  }
  if (completions > requiredCompletions) {
    throw new Error(
      `Task.completions=${completions} exceeds required_completions=${requiredCompletions}`,
    );
  }
  if (task.currentWorkers > task.maxWorkers) {
    throw new Error(
      `Task.current_workers=${task.currentWorkers} exceeds max_workers=${task.maxWorkers}`,
    );
  }
  if (
    (task.operatorFeeBps > 0 && task.operator.equals(PublicKey.default)) ||
    (task.referrerFeeBps > 0 && task.referrer.equals(PublicKey.default))
  ) {
    throw new Error("Task has a positive marketplace fee with a default payee");
  }

  const taskStamped =
    !task.operator.equals(PublicKey.default) ||
    !task.referrer.equals(PublicKey.default);
  let source = "none";
  let operator = PublicKey.default;
  let operatorFeeBps = 0;
  let referrer = PublicKey.default;
  let referrerFeeBps = 0;
  if (taskStamped) {
    source = "task";
    ({ operator, operatorFeeBps, referrer, referrerFeeBps } = task);
  } else if (legacyHireRecord) {
    if (!legacyHireRecord.task.equals(address)) {
      throw new Error("legacy HireRecord belongs to a different Task");
    }
    source = "hire-record";
    ({ operator, operatorFeeBps, referrer, referrerFeeBps } = legacyHireRecord);
  }

  const terminal = TERMINAL_STATUSES.has(task.status);
  const revision4BondPostEligible = isRevision4BondPostEligible(task);
  const economicIssues = [];
  const underfundedCollaborative =
    task.taskType === TASK_TYPE_COLLABORATIVE &&
    task.rewardAmount < BigInt(requiredCompletions);
  if (underfundedCollaborative) {
    economicIssues.push(
      issue(
        "underfunded-collaborative-task",
        address,
        `reward_amount=${task.rewardAmount} required_completions=${requiredCompletions}`,
        {
          rewardAmount: task.rewardAmount.toString(),
          requiredCompletions,
          rewardMint: task.rewardMint?.toBase58() ?? null,
        },
      ),
    );
  }
  economicIssues.push(
    ...activePayeeIssues({
      taskAddress: address,
      escrow: task.escrow,
      creator: task.creator,
      operator,
      operatorFeeBps,
      referrer,
      referrerFeeBps,
      source,
    }),
  );

  return {
    task: address.toBase58(),
    status: task.status,
    terminal,
    revision4BondPostEligible,
    taskType: task.taskType,
    rewardAmount: task.rewardAmount.toString(),
    rewardMint: task.rewardMint?.toBase58() ?? null,
    completions,
    requiredCompletions,
    feeTermsSource: source,
    operator: operator.toBase58(),
    operatorFeeBps,
    referrer: referrer.toBase58(),
    referrerFeeBps,
    hasActiveFees: operatorFeeBps > 0 || referrerFeeBps > 0,
    sharedOperatorReferrer:
      operatorFeeBps > 0 &&
      referrerFeeBps > 0 &&
      operator.equals(referrer),
    underfundedCollaborative,
    payeeAliasCount: economicIssues.filter((item) =>
      item.kind.endsWith("-payee-alias")
    ).length,
    inventory: economicIssues,
    blockers: terminal ? [] : economicIssues,
  };
}

function exactOwner(account, accountType) {
  if (!account.owner.equals(PROGRAM_ID) || account.executable) {
    throw new Error(
      `${accountType}: owner=${account.owner.toBase58()} executable=${account.executable}`,
    );
  }
}

export async function scanTaskSettlementSafety(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const [taskAccounts, hireAccounts] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{
        memcmp: {
          offset: 0,
          bytes: TASK_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      }],
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{
        memcmp: {
          offset: 0,
          bytes: HIRE_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      }],
    }),
  ]);

  const blockers = [];
  const hireByTask = new Map();
  for (const { pubkey, account } of hireAccounts) {
    try {
      exactOwner(account, "HireRecord");
      const hire = decodeHireRecordProvider(account.data);
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("hire"), hire.task.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(pubkey) || expectedBump !== hire.bump) {
        throw new Error("canonical HireRecord PDA/bump mismatch");
      }
      const taskKey = hire.task.toBase58();
      if (hireByTask.has(taskKey)) {
        throw new Error("duplicate canonical HireRecord returned for Task");
      }
      hireByTask.set(taskKey, hire);
    } catch (error) {
      blockers.push({
        kind: "invalid-hire-settlement-layout",
        hireRecord: pubkey.toBase58(),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const records = [];
  for (const { pubkey, account } of taskAccounts) {
    try {
      exactOwner(account, "Task");
      const record = inspectTaskSettlementRecord(
        pubkey,
        account.data,
        hireByTask.get(pubkey.toBase58()) ?? null,
      );
      records.push(record);
      blockers.push(...record.blockers);
    } catch (error) {
      blockers.push({
        kind: "invalid-task-settlement-layout",
        task: pubkey.toBase58(),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const inventory = records.flatMap((record) => record.inventory);
  const revision4BondPostEligibleTasks = records
    .filter((record) => record.revision4BondPostEligible)
    .map((record) => record.task);
  return {
    taskCount: taskAccounts.length,
    decodedTaskCount: records.length,
    hireRecordCount: hireAccounts.length,
    nonterminalCount: records.filter((record) => !record.terminal).length,
    revision4BondPostEligibleTaskCount:
      revision4BondPostEligibleTasks.length,
    revision4BondPostEligibleTasks,
    collaborativeCount: records.filter(
      (record) => record.taskType === TASK_TYPE_COLLABORATIVE,
    ).length,
    underfundedCollaborativeCount: records.filter(
      (record) => record.underfundedCollaborative,
    ).length,
    taskStampedFeeCount: records.filter(
      (record) => record.feeTermsSource === "task" && record.hasActiveFees,
    ).length,
    legacyHireFeeCount: records.filter(
      (record) => record.feeTermsSource === "hire-record" && record.hasActiveFees,
    ).length,
    legacyHireFallbackCount: records.filter(
      (record) => record.feeTermsSource === "hire-record",
    ).length,
    nonterminalLegacyHireFallbackCount: records.filter(
      (record) =>
        !record.terminal && record.feeTermsSource === "hire-record",
    ).length,
    activeFeeTaskCount: records.filter(
      (record) => !record.terminal && record.hasActiveFees,
    ).length,
    payeeAliasCount: records.reduce(
      (sum, record) => sum + record.payeeAliasCount,
      0,
    ),
    sharedOperatorReferrerCount: records.filter(
      (record) => record.sharedOperatorReferrer,
    ).length,
    inventory,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const result = await scanTaskSettlementSafety(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} task settlement safety blocker(s) found`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `PREFLIGHT FAIL: ${redactRpcText(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 1;
  });
}
