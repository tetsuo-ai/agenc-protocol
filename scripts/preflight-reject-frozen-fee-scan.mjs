#!/usr/bin/env node
// Read-only inventory for RejectFrozen settlement compatibility.
// Both worker-payout exits must preserve immutable operator/referrer legs, and
// every escrow/bond principal account needed by those exits must remain canonical.

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
import { decodeCompletionBond } from "./preflight-task-dependency-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const BOND_DISCRIMINATOR = createHash("sha256")
  .update("account:CompletionBond")
  .digest()
  .subarray(0, 8);
const ESCROW_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskEscrow")
  .digest()
  .subarray(0, 8);
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const REJECT_FROZEN_STATUS = 6;
const MAX_COMBINED_FEE_BPS = 4_000;

function exact(dataLike, size, discriminator, name) {
  const data = Buffer.from(dataLike);
  if (data.length !== size) {
    throw new Error(`${name}: unexpected size ${data.length}; expected ${size}`);
  }
  if (!data.subarray(0, 8).equals(discriminator)) {
    throw new Error(`${name}: discriminator mismatch`);
  }
  return data;
}

export function decodeTaskEscrowPrincipal(dataLike) {
  const data = exact(dataLike, 58, ESCROW_DISCRIMINATOR, "TaskEscrow");
  const amount = data.readBigUInt64LE(40);
  const distributed = data.readBigUInt64LE(48);
  const closed = data[56];
  if (closed > 1 || distributed > amount) {
    throw new Error(
      `TaskEscrow: invalid closed/distributed state closed=${closed} amount=${amount} distributed=${distributed}`,
    );
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    amount,
    distributed,
    remaining: amount - distributed,
    closed: closed === 1,
    bump: data[57],
  };
}

function blocker(kind, task, detail, extra = {}) {
  return { kind, task, detail, ...extra };
}

function validateFeePair(payee, feeBps, label) {
  if (payee.equals(PublicKey.default) !== (feeBps === 0)) {
    throw new Error(`${label}: payee/fee presence mismatch`);
  }
}

async function fetchAccountMap(connection, addresses) {
  const unique = [...new Map(
    addresses.map((address) => [address.toBase58(), address]),
  ).values()];
  const result = new Map();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    for (let index = 0; index < chunk.length; index++) {
      result.set(chunk[index].toBase58(), infos[index] ?? null);
    }
  }
  return result;
}

function absentSystemAccount(account) {
  return (
    !account ||
    account.lamports === 0 ||
    (account.owner.equals(SYSTEM_PROGRAM_ID) && account.data.length === 0)
  );
}

export async function scanRejectFrozenFees(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const blockers = [];
  const taskAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{
      memcmp: {
        offset: 0,
        bytes: TASK_DISCRIMINATOR.toString("base64"),
        encoding: "base64",
      },
    }],
  });
  const frozen = [];
  for (const { pubkey: address, account } of taskAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker("invalid-reject-frozen-task-owner", address));
      continue;
    }
    try {
      const task = decodeTaskBinding(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || task.bump !== bump) {
        throw new Error("canonical Task PDA/bump mismatch");
      }
      if (task.status === REJECT_FROZEN_STATUS) frozen.push({ address, ...task });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-reject-frozen-task-layout",
          address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const derived = frozen.map((task) => {
    const [escrow, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), task.address.toBuffer()],
      PROGRAM_ID,
    );
    const [hire, hireBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("hire"), task.address.toBuffer()],
      PROGRAM_ID,
    );
    return { ...task, escrowAddress: escrow, escrowBump, hireAddress: hire, hireBump };
  });
  const stateMap = await fetchAccountMap(
    connection,
    derived.flatMap((task) => [task.escrowAddress, task.hireAddress]),
  );

  const bondAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{
      memcmp: {
        offset: 0,
        bytes: BOND_DISCRIMINATOR.toString("base64"),
        encoding: "base64",
      },
    }],
  });
  const bondsByTask = new Map();
  for (const { pubkey: address, account } of bondAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) continue;
    try {
      const bond = decodeCompletionBond(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("completion_bond"), bond.task.toBuffer(), bond.party.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || bond.bump !== bump) continue;
      const values = bondsByTask.get(bond.task.toBase58()) ?? [];
      values.push({ address, ...bond });
      bondsByTask.set(bond.task.toBase58(), values);
    } catch {
      // The general task-child/dependency scans report malformed bonds globally.
    }
  }

  const records = [];
  for (const task of derived) {
    const escrowAccount = stateMap.get(task.escrowAddress.toBase58());
    let escrow = null;
    if (
      !escrowAccount ||
      escrowAccount.lamports === 0 ||
      !escrowAccount.owner.equals(PROGRAM_ID) ||
      escrowAccount.executable === true
    ) {
      blockers.push(
        blocker("missing-or-invalid-reject-frozen-escrow", task.address, undefined, {
          escrow: task.escrowAddress,
        }),
      );
    } else {
      try {
        escrow = decodeTaskEscrowPrincipal(escrowAccount.data);
        if (
          !escrow.task.equals(task.address) ||
          escrow.bump !== task.escrowBump ||
          escrow.closed ||
          !task.escrow.equals(task.escrowAddress)
        ) {
          throw new Error("Task/escrow canonical binding or open-state mismatch");
        }
        if (BigInt(escrowAccount.lamports) < escrow.remaining) {
          throw new Error("escrow lamports below remaining principal");
        }
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-reject-frozen-escrow-layout",
            task.address,
            error instanceof Error ? error.message : String(error),
            { escrow: task.escrowAddress },
          ),
        );
        escrow = null;
      }
    }

    const hireAccount = stateMap.get(task.hireAddress.toBase58());
    let hire = null;
    if (!absentSystemAccount(hireAccount)) {
      if (!hireAccount.owner.equals(PROGRAM_ID) || hireAccount.executable === true) {
        blockers.push(
          blocker("invalid-reject-frozen-hire-owner", task.address, undefined, {
            hire: task.hireAddress,
          }),
        );
      } else {
        try {
          hire = decodeHireRecordProvider(hireAccount.data);
          if (!hire.task.equals(task.address) || hire.bump !== task.hireBump) {
            throw new Error("canonical HireRecord task/PDA/bump mismatch");
          }
        } catch (error) {
          blockers.push(
            blocker(
              "invalid-reject-frozen-hire-layout",
              task.address,
              error instanceof Error ? error.message : String(error),
              { hire: task.hireAddress },
            ),
          );
          hire = null;
        }
      }
    }

    let feeSource = "none";
    let operator = PublicKey.default;
    let operatorFeeBps = 0;
    let referrer = PublicKey.default;
    let referrerFeeBps = 0;
    const taskHasStampedTerms =
      !task.operator.equals(PublicKey.default) ||
      !task.referrer.equals(PublicKey.default);
    try {
      validateFeePair(task.operator, task.operatorFeeBps, "Task.operator");
      validateFeePair(task.referrer, task.referrerFeeBps, "Task.referrer");
      if (taskHasStampedTerms) {
        feeSource = "task";
        operator = task.operator;
        operatorFeeBps = task.operatorFeeBps;
        referrer = task.referrer;
        referrerFeeBps = task.referrerFeeBps;
      } else if (hire) {
        feeSource = "legacy-hire-record";
        operator = hire.operator;
        operatorFeeBps = hire.operatorFeeBps;
        referrer = hire.referrer;
        referrerFeeBps = hire.referrerFeeBps;
      }
      validateFeePair(operator, operatorFeeBps, `${feeSource}.operator`);
      validateFeePair(referrer, referrerFeeBps, `${feeSource}.referrer`);
      const combined = task.protocolFeeBps + operatorFeeBps + referrerFeeBps;
      if (combined > MAX_COMBINED_FEE_BPS) {
        throw new Error(`combined fee ${combined} exceeds ${MAX_COMBINED_FEE_BPS}`);
      }
      if (task.rewardMint !== null) {
        throw new Error("RejectFrozen exit has no token payout account surface");
      }
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-reject-frozen-fee-terms",
          task.address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const bonds = bondsByTask.get(task.address.toBase58()) ?? [];
    const bondPrincipal = bonds.reduce((sum, bond) => sum + bond.amount, 0n);
    records.push({
      task: task.address,
      currentWorkers: task.currentWorkers,
      rewardAmount: task.rewardAmount,
      feeSource,
      protocolFeeBps: task.protocolFeeBps,
      operator,
      operatorFeeBps,
      referrer,
      referrerFeeBps,
      escrow: task.escrowAddress,
      escrowPrincipal: escrow?.remaining ?? null,
      completionBondCount: bonds.length,
      completionBondPrincipal: bondPrincipal,
      totalPrincipal:
        escrow === null ? null : escrow.remaining + bondPrincipal,
    });
  }

  return {
    taskCount: taskAccounts.length,
    rejectFrozenCount: records.length,
    taskStampedFeeCount: records.filter((record) => record.feeSource === "task").length,
    legacyHireFeeCount: records.filter(
      (record) => record.feeSource === "legacy-hire-record",
    ).length,
    noMarketplaceFeeCount: records.filter((record) => record.feeSource === "none").length,
    escrowPrincipal: records.reduce(
      (sum, record) => sum + (record.escrowPrincipal ?? 0n),
      0n,
    ),
    completionBondCount: records.reduce(
      (sum, record) => sum + record.completionBondCount,
      0,
    ),
    completionBondPrincipal: records.reduce(
      (sum, record) => sum + record.completionBondPrincipal,
      0n,
    ),
    records,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet RejectFrozen fee/principal state via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanRejectFrozenFees(new Connection(rpcUrl, "confirmed"));
  console.log(
    `RejectFrozen: count=${result.rejectFrozenCount} task_stamped_fees=${result.taskStampedFeeCount} ` +
      `legacy_hire_fees=${result.legacyHireFeeCount} no_marketplace_fees=${result.noMarketplaceFeeCount} ` +
      `escrow_principal=${result.escrowPrincipal} bonds=${result.completionBondCount} ` +
      `bond_principal=${result.completionBondPrincipal} blockers=${result.blockers.length}`,
  );
  for (const record of result.records) {
    console.warn(
      `  FROZEN: task=${record.task.toBase58()} workers=${record.currentWorkers} ` +
        `fee_source=${record.feeSource} protocol_bps=${record.protocolFeeBps} ` +
        `operator=${record.operator.toBase58()} operator_bps=${record.operatorFeeBps} ` +
        `referrer=${record.referrer.toBase58()} referrer_bps=${record.referrerFeeBps} ` +
        `escrow_principal=${record.escrowPrincipal ?? "unknown"} ` +
        `bonds=${record.completionBondCount} bond_principal=${record.completionBondPrincipal}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: task=${item.task.toBase58()}` +
        `${item.escrow ? ` escrow=${item.escrow.toBase58()}` : ""}` +
        `${item.hire ? ` hire=${item.hire.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(`${result.blockers.length} unsafe RejectFrozen condition(s) found`);
  }
  console.log(
    "PREFLIGHT OK: every RejectFrozen task has canonical fee-source and principal state for both worker-payout exits.",
  );
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
