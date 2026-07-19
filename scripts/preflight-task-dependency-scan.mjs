#!/usr/bin/env node
// Read-only cutover inventory for task dependency safety.
//
// A dependent child must not acquire a worker obligation until its parent is
// irrevocably Completed. Otherwise a creator can cancel the parent after claim,
// make the child impossible to complete, and later seize a no-show completion
// bond. The hardened binary gates assignment for every dependency type. This
// scanner distinguishes legacy/unassigned containment inventory from already-
// obligated children or bonded principal. Revision 5 additionally requires an
// explicit stable zero for every nonterminal dependent child: the deployed
// close_task exit can remove a Completed parent during a paused loader upload,
// while the candidate newly needs that live parent for Data/Ordering payout.
// Deployed dependent-task creation is pause-gated, so zero is stable.

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
const BOND_SIZE = 139;
const TERMINAL_STATUSES = new Set([3, 4]);
const COMPLETED_STATUS = 3;
const DEPENDENCY_NAMES = ["None", "Data", "Ordering", "Proof"];

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

function requireZero(data, start, end, field) {
  if (!data.subarray(start, end).equals(Buffer.alloc(end - start))) {
    throw new Error(`${field}: reserved bytes are nonzero`);
  }
}

function optionPubkeyEnd(data, offset, field) {
  if (data[offset] === 0) return offset + 1;
  if (data[offset] === 1 && offset + 33 <= data.length) return offset + 33;
  throw new Error(`${field}: invalid/truncated Option tag ${data[offset]}`);
}

export function decodeCompletionBond(dataLike) {
  const data = exact(
    dataLike,
    BOND_SIZE,
    BOND_DISCRIMINATOR,
    "CompletionBond",
  );
  const role = data[72];
  if (role > 1) throw new Error(`CompletionBond.role: invalid ${role}`);
  const mintEnd = optionPubkeyEnd(data, 81, "CompletionBond.bond_mint");
  if (mintEnd + 25 > data.length) throw new Error("CompletionBond: truncated tail");
  const postedAt = data.readBigInt64LE(mintEnd);
  if (postedAt <= 0n) {
    throw new Error(`CompletionBond.posted_at: invalid ${postedAt}`);
  }
  requireZero(data, mintEnd + 9, mintEnd + 25, "CompletionBond");
  return {
    task: new PublicKey(data.subarray(8, 40)),
    party: new PublicKey(data.subarray(40, 72)),
    role,
    amount: data.readBigUInt64LE(73),
    postedAt,
    bump: data[mintEnd + 8],
  };
}

function blocker(kind, address, detail, extra = {}) {
  return { kind, address, detail, ...extra };
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

function classifyParentAccount(address, account) {
  if (!account || account.lamports === 0) return { kind: "missing" };
  if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
    return {
      kind: "invalid",
      detail: `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
    };
  }
  try {
    const task = decodeTaskBinding(account.data);
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
      PROGRAM_ID,
    );
    if (!expected.equals(address) || task.bump !== bump) {
      throw new Error("canonical parent Task PDA/bump mismatch");
    }
    return { kind: "live", task };
  } catch (error) {
    return {
      kind: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function scanTaskDependencies(connection) {
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
  const tasks = [];
  for (const { pubkey: address, account } of taskAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker("invalid-dependency-task-owner", address));
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
      if ((task.dependsOn === null) !== (task.dependencyType === 0)) {
        throw new Error(
          `dependency Option/type mismatch parent=${task.dependsOn !== null} type=${task.dependencyType}`,
        );
      }
      tasks.push({ address, ...task });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-dependency-task-layout",
          address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

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
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker("invalid-dependency-bond-owner", address));
      continue;
    }
    try {
      const bond = decodeCompletionBond(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("completion_bond"),
          bond.task.toBuffer(),
          bond.party.toBuffer(),
        ],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || bond.bump !== bump) {
        throw new Error("canonical CompletionBond PDA/bump mismatch");
      }
      if (BigInt(account.lamports) < bond.amount) {
        throw new Error(
          `lamports ${account.lamports} below stored principal ${bond.amount}`,
        );
      }
      const key = bond.task.toBase58();
      const values = bondsByTask.get(key) ?? [];
      values.push({ address, lamports: BigInt(account.lamports), ...bond });
      bondsByTask.set(key, values);
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-dependency-bond-layout",
          address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const dependent = tasks.filter(
    (task) => !TERMINAL_STATUSES.has(task.status) && task.dependsOn !== null,
  );
  const parentMap = await fetchAccountMap(
    connection,
    dependent.map((task) => task.dependsOn),
  );
  const records = [];
  for (const task of dependent) {
    const parentState = classifyParentAccount(
      task.dependsOn,
      parentMap.get(task.dependsOn.toBase58()),
    );
    const bonds = bondsByTask.get(task.address.toBase58()) ?? [];
    const bondPrincipal = bonds.reduce((sum, bond) => sum + bond.amount, 0n);
    const parentCompleted =
      parentState.kind === "live" && parentState.task.status === COMPLETED_STATUS;
    const obligated =
      task.currentWorkers > 0 || task.status !== 0 || bondPrincipal > 0n;
    const record = {
      task: task.address,
      status: task.status,
      currentWorkers: task.currentWorkers,
      dependencyType: task.dependencyType,
      dependencyName: DEPENDENCY_NAMES[task.dependencyType],
      parent: task.dependsOn,
      parentState: parentState.kind,
      parentStatus: parentState.kind === "live" ? parentState.task.status : null,
      parentCompleted,
      completionBondCount: bonds.length,
      completionBondPrincipal: bondPrincipal,
      obligated,
    };
    records.push(record);

    if (parentState.kind === "invalid") {
      blockers.push(
        blocker(
          "invalid-dependent-parent",
          task.address,
          parentState.detail,
          { task: task.address, parent: task.dependsOn },
        ),
      );
    } else if (!parentCompleted && obligated) {
      blockers.push(
        blocker(
          "unsafe-dependent-obligation",
          task.address,
          `status=${task.status} workers=${task.currentWorkers} ` +
            `parent_state=${parentState.kind} parent_status=${record.parentStatus ?? "none"} ` +
            `bonds=${bonds.length} bond_principal=${bondPrincipal}`,
          { task: task.address, parent: task.dependsOn },
        ),
      );
    }
  }

  const unsafeParent = records.filter((record) => !record.parentCompleted);
  const statusCounts = Object.fromEntries(
    [0, 1, 2, 5, 6].map((status) => [
      status,
      unsafeParent.filter((record) => record.status === status).length,
    ]),
  );
  return {
    taskCount: taskAccounts.length,
    completionBondAccountCount: bondAccounts.length,
    dependentCount: records.length,
    nonterminalDependentCount: records.length,
    nonterminalDependencyTypeCounts: {
      data: records.filter((record) => record.dependencyType === 1).length,
      ordering: records.filter((record) => record.dependencyType === 2).length,
      proof: records.filter((record) => record.dependencyType === 3).length,
    },
    parentCompletedCount: records.filter((record) => record.parentCompleted).length,
    unsafeParentCount: unsafeParent.length,
    unsafeUnassignedCount: unsafeParent.filter((record) => !record.obligated).length,
    unsafeObligatedCount: unsafeParent.filter((record) => record.obligated).length,
    unsafeStatusCounts: statusCounts,
    dependentCompletionBondCount: records.reduce(
      (sum, record) => sum + record.completionBondCount,
      0,
    ),
    dependentCompletionBondPrincipal: records.reduce(
      (sum, record) => sum + record.completionBondPrincipal,
      0n,
    ),
    unsafeCompletionBondCount: unsafeParent.reduce(
      (sum, record) => sum + record.completionBondCount,
      0,
    ),
    unsafeCompletionBondPrincipal: unsafeParent.reduce(
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
    `Scanning mainnet Task dependency obligations via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanTaskDependencies(new Connection(rpcUrl, "confirmed"));
  console.log(
    `Task dependencies: tasks=${result.taskCount} nonterminal_dependent=${result.dependentCount} ` +
      `data=${result.nonterminalDependencyTypeCounts.data} ` +
      `ordering=${result.nonterminalDependencyTypeCounts.ordering} ` +
      `proof=${result.nonterminalDependencyTypeCounts.proof} ` +
      `parent_completed=${result.parentCompletedCount} unsafe_parent=${result.unsafeParentCount} ` +
      `unsafe_unassigned=${result.unsafeUnassignedCount} unsafe_obligated=${result.unsafeObligatedCount} ` +
      `dependent_bonds=${result.dependentCompletionBondCount} ` +
      `dependent_bond_principal=${result.dependentCompletionBondPrincipal} ` +
      `unsafe_bonds=${result.unsafeCompletionBondCount} ` +
      `unsafe_bond_principal=${result.unsafeCompletionBondPrincipal} ` +
      `blockers=${result.blockers.length}`,
  );
  for (const record of result.records.filter((item) => !item.parentCompleted)) {
    console.warn(
      `  CONTAINED ${record.obligated ? "UNSAFE" : "UNASSIGNED"}: ` +
        `task=${record.task.toBase58()} status=${record.status} workers=${record.currentWorkers} ` +
        `dependency=${record.dependencyName} parent=${record.parent.toBase58()} ` +
        `parent_state=${record.parentState} parent_status=${record.parentStatus ?? "none"} ` +
        `bonds=${record.completionBondCount} bond_principal=${record.completionBondPrincipal}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: address=${item.address.toBase58()}` +
        `${item.parent ? ` parent=${item.parent.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (
    result.blockers.length > 0 ||
    result.nonterminalDependentCount !== 0
  ) {
    throw new Error(
      `${result.blockers.length} unsafe/malformed dependency condition(s) and ` +
        `${result.nonterminalDependentCount} nonterminal dependent Task(s) found; ` +
        "revision-5 cutover requires stable zero",
    );
  }
  console.log(
    "PREFLIGHT OK: no nonterminal dependent Task exists; the parent-close cutover snapshot is stable while paused.",
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
