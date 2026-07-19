#!/usr/bin/env node
// Read-only release cutover scanner for dormant ZK-private task state.
//
// This release deliberately disables new private-task creation and ZkConfig
// activation. A nonterminal task with a real constraint hash would still depend
// on the dormant proof settlement path, so deployment must stop until that
// obligation is resolved. The manual-validation sentinel is a separate review
// mode and is inventoried, never misclassified as a ZK constraint.

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
import { decodeTaskEscrow } from "./preflight-token-task-scan.mjs";
import {
  PRIVATE_TASK_RELEASE_STATE,
  assertPrivateTaskReleaseDisabled,
} from "./private-task-release-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

export { PRIVATE_TASK_RELEASE_STATE };
export const MANUAL_VALIDATION_SENTINEL = Buffer.from(
  "agenc-manual-validation-v2-seed!",
  "ascii",
);

const ZERO_HASH = Buffer.alloc(32);
const TERMINAL_STATUSES = new Set([3, 4]);
const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const CLAIM_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskClaim")
  .digest()
  .subarray(0, 8);
const ZK_CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:ZkConfig")
  .digest()
  .subarray(0, 8);

function discriminatorFilter(discriminator) {
  return [{
    memcmp: {
      offset: 0,
      bytes: discriminator.toString("base64"),
      encoding: "base64",
    },
  }];
}

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

export function decodePrivateTaskClaim(dataLike) {
  const data = exact(dataLike, 203, CLAIM_DISCRIMINATOR, "TaskClaim");
  const isCompleted = data[192];
  const isValidated = data[193];
  if (isCompleted > 1 || isValidated > 1) {
    throw new Error(
      `TaskClaim: invalid bool completed=${isCompleted} validated=${isValidated}`,
    );
  }
  const claimedAt = data.readBigInt64LE(72);
  const expiresAt = data.readBigInt64LE(80);
  const completedAt = data.readBigInt64LE(88);
  if (claimedAt <= 0n || expiresAt < claimedAt) {
    throw new Error(
      `TaskClaim: invalid claim timestamps claimed=${claimedAt} expires=${expiresAt}`,
    );
  }
  if (
    (isCompleted === 0 && completedAt !== 0n) ||
    (isCompleted === 1 && completedAt < claimedAt)
  ) {
    throw new Error(
      `TaskClaim: completion timestamp/state mismatch completed=${isCompleted} at=${completedAt}`,
    );
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    worker: new PublicKey(data.subarray(40, 72)),
    claimedAt,
    expiresAt,
    completedAt,
    isCompleted: isCompleted === 1,
    isValidated: isValidated === 1,
    rewardPaid: data.readBigUInt64LE(194),
    bump: data[202],
  };
}

export function decodeZkConfig(dataLike) {
  const data = exact(dataLike, 72, ZK_CONFIG_DISCRIMINATOR, "ZkConfig");
  if (!data.subarray(41, 72).equals(Buffer.alloc(31))) {
    throw new Error("ZkConfig: reserved bytes are nonzero");
  }
  return {
    activeImageId: Buffer.from(data.subarray(8, 40)),
    bump: data[40],
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
    const accounts = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    for (let index = 0; index < chunk.length; index++) {
      result.set(chunk[index].toBase58(), accounts[index] ?? null);
    }
  }
  return result;
}

export async function scanPrivateTaskCutover(
  connection,
  { targetClaimsPrivateReadiness = false } = {},
) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const [zkConfigAddress, zkConfigBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("zk_config")],
    PROGRAM_ID,
  );
  const [taskAccounts, claimAccounts, zkConfigAccount] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: discriminatorFilter(TASK_DISCRIMINATOR),
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: discriminatorFilter(CLAIM_DISCRIMINATOR),
    }),
    connection.getAccountInfo(zkConfigAddress, "confirmed"),
  ]);

  const blockers = [];
  try {
    assertPrivateTaskReleaseDisabled({ targetClaimsPrivateReadiness });
  } catch (error) {
    blockers.push(blocker(
      "private-task-readiness-claim-forbidden",
      PROGRAM_ID,
      error instanceof Error ? error.message : String(error),
    ));
  }

  let zkConfig = null;
  let zkConfigState = "absent-disabled";
  if (zkConfigAccount && zkConfigAccount.lamports !== 0) {
    zkConfigState = "present-disabled-legacy";
    if (
      !zkConfigAccount.owner.equals(PROGRAM_ID) ||
      zkConfigAccount.executable === true
    ) {
      blockers.push(blocker(
        "invalid-zk-config-owner",
        zkConfigAddress,
        `owner=${zkConfigAccount.owner.toBase58()} executable=${zkConfigAccount.executable === true}`,
      ));
      zkConfigState = "invalid";
    } else {
      try {
        zkConfig = decodeZkConfig(zkConfigAccount.data);
        if (zkConfig.bump !== zkConfigBump) {
          throw new Error(
            `ZkConfig.bump=${zkConfig.bump} canonical=${zkConfigBump}`,
          );
        }
      } catch (error) {
        blockers.push(blocker(
          "invalid-zk-config-layout",
          zkConfigAddress,
          error instanceof Error ? error.message : String(error),
        ));
        zkConfig = null;
        zkConfigState = "invalid";
      }
    }
  }

  const tasks = [];
  for (const { pubkey: address, account } of taskAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker(
        "invalid-private-task-owner",
        address,
        `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
      ));
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
      tasks.push({ address, ...task });
    } catch (error) {
      blockers.push(blocker(
        "invalid-private-task-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  const claims = [];
  for (const { pubkey: address, account } of claimAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker(
        "invalid-private-task-claim-owner",
        address,
        `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
      ));
      continue;
    }
    try {
      const claim = decodePrivateTaskClaim(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), claim.task.toBuffer(), claim.worker.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || claim.bump !== bump) {
        throw new Error("canonical TaskClaim PDA/bump mismatch");
      }
      claims.push({ address, ...claim });
    } catch (error) {
      blockers.push(blocker(
        "invalid-private-task-claim-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  const nonterminal = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const manualValidation = nonterminal.filter(
    (task) => task.constraintHash.equals(MANUAL_VALIDATION_SENTINEL),
  );
  const privateTasks = nonterminal.filter(
    (task) =>
      !task.constraintHash.equals(ZERO_HASH) &&
      !task.constraintHash.equals(MANUAL_VALIDATION_SENTINEL),
  );
  const terminalPrivateTasks = tasks.filter(
    (task) =>
      TERMINAL_STATUSES.has(task.status) &&
      !task.constraintHash.equals(ZERO_HASH) &&
      !task.constraintHash.equals(MANUAL_VALIDATION_SENTINEL),
  );

  const escrowAddresses = privateTasks.map((task) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), task.address.toBuffer()],
      PROGRAM_ID,
    )[0]);
  const escrowMap = await fetchAccountMap(connection, escrowAddresses);
  const records = [];
  for (let index = 0; index < privateTasks.length; index++) {
    const task = privateTasks[index];
    const escrowAddress = escrowAddresses[index];
    const escrowAccount = escrowMap.get(escrowAddress.toBase58());
    let escrow = null;
    if (!task.escrow.equals(escrowAddress)) {
      blockers.push(blocker(
        "private-task-escrow-binding-mismatch",
        task.address,
        `stored=${task.escrow.toBase58()} canonical=${escrowAddress.toBase58()}`,
        { task: task.address, escrow: escrowAddress },
      ));
    } else if (
      !escrowAccount ||
      escrowAccount.lamports === 0 ||
      !escrowAccount.owner.equals(PROGRAM_ID) ||
      escrowAccount.executable === true
    ) {
      blockers.push(blocker(
        "private-task-escrow-unavailable",
        task.address,
        !escrowAccount
          ? "canonical TaskEscrow is missing"
          : `owner=${escrowAccount.owner.toBase58()} executable=${escrowAccount.executable === true}`,
        { task: task.address, escrow: escrowAddress },
      ));
    } else {
      try {
        escrow = decodeTaskEscrow(escrowAccount.data);
        const [, bump] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), task.address.toBuffer()],
          PROGRAM_ID,
        );
        if (
          !escrow.task.equals(task.address) ||
          escrow.bump !== bump ||
          escrow.closed
        ) {
          throw new Error(
            `TaskEscrow binding/closed mismatch task=${escrow.task.toBase58()} ` +
            `bump=${escrow.bump}/${bump} closed=${escrow.closed}`,
          );
        }
      } catch (error) {
        blockers.push(blocker(
          "invalid-private-task-escrow-layout",
          task.address,
          error instanceof Error ? error.message : String(error),
          { task: task.address, escrow: escrowAddress },
        ));
        escrow = null;
      }
    }
    const linkedClaims = claims.filter((claim) => claim.task.equals(task.address));
    const record = {
      task: task.address,
      status: task.status,
      constraintHash: task.constraintHash,
      storedEscrow: task.escrow,
      canonicalEscrow: escrowAddress,
      escrowAmount: escrow?.amount ?? null,
      escrowDistributed: escrow?.distributed ?? null,
      escrowRemaining:
        escrow === null ? null : escrow.amount - escrow.distributed,
      claimCount: linkedClaims.length,
      claims: linkedClaims.map((claim) => ({
        address: claim.address,
        worker: claim.worker,
        isCompleted: claim.isCompleted,
        isValidated: claim.isValidated,
        rewardPaid: claim.rewardPaid,
      })),
    };
    records.push(record);
    blockers.push(blocker(
      "nonterminal-private-task-release-blocker",
      task.address,
      `status=${task.status} escrow=${escrowAddress.toBase58()} claims=${linkedClaims.length}`,
      { task: task.address, escrow: escrowAddress },
    ));
  }

  return {
    releaseState: PRIVATE_TASK_RELEASE_STATE,
    targetClaimsPrivateReadiness,
    taskCount: taskAccounts.length,
    decodedTaskCount: tasks.length,
    nonterminalTaskCount: nonterminal.length,
    manualValidationSentinelCount: manualValidation.length,
    privateTaskCount: privateTasks.length,
    terminalPrivateTaskCount: terminalPrivateTasks.length,
    claimAccountCount: claimAccounts.length,
    decodedClaimCount: claims.length,
    zkConfigAddress,
    zkConfigState,
    zkConfig,
    records,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  if (process.env.ZK_IMAGE_ID_HEX || process.env.PRIVATE_TASKS_READY === "1") {
    throw new Error(
      "ZK_IMAGE_ID_HEX/PRIVATE_TASKS_READY is forbidden: this release is explicitly ZK-disabled",
    );
  }
  console.log(
    `Scanning mainnet private-task cutover state via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanPrivateTaskCutover(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(
    `Private tasks: release=${result.releaseState} tasks=${result.taskCount} ` +
      `nonterminal=${result.nonterminalTaskCount} ` +
      `manual_validation_sentinel=${result.manualValidationSentinelCount} ` +
      `real_private_nonterminal=${result.privateTaskCount} ` +
      `real_private_terminal=${result.terminalPrivateTaskCount} ` +
      `claims=${result.claimAccountCount} zk_config=${result.zkConfigState} ` +
      `blockers=${result.blockers.length}`,
  );
  for (const record of result.records) {
    console.error(
      `  PRIVATE TASK: task=${record.task.toBase58()} status=${record.status} ` +
        `escrow=${record.canonicalEscrow.toBase58()} ` +
        `escrow_remaining=${record.escrowRemaining ?? "unavailable"} ` +
        `claims=${record.claimCount} ` +
        `claim_addresses=${record.claims.map((claim) => claim.address.toBase58()).join(",") || "none"}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: address=${item.address.toBase58()}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} private-task/ZK release blocker(s) found`,
    );
  }
  console.log(
    "PREFLIGHT OK: zero nonterminal real private constraints; manual-review sentinels are inventoried separately; ZK activation remains disabled.",
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
