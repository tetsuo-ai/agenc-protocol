#!/usr/bin/env node
// Read-only inventory of moderation BLOCKs covering canonical job specs on
// nonterminal Tasks. A valid BLOCK is containment evidence, not a deployment
// blocker: the hardened binary must stop future assignment while preserving
// existing workers' exit and settlement. Malformed/mismatched canonical state is
// a hard blocker because clients could not safely construct the required gate.

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

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const TASK_JOB_SPEC_SIZE = 388;
const MODERATION_BLOCK_SIZE = 398;
const TERMINAL_STATUSES = new Set([3, 4]);
const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const JOB_SPEC_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskJobSpec")
  .digest()
  .subarray(0, 8);
const BLOCK_DISCRIMINATOR = createHash("sha256")
  .update("account:ModerationBlock")
  .digest()
  .subarray(0, 8);
const utf8 = new TextDecoder("utf-8", { fatal: true });

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

function readString(data, offset, maxLength, field) {
  if (offset + 4 > data.length) throw new Error(`${field}: truncated length`);
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > maxLength || end > data.length) {
    throw new Error(`${field}: invalid/truncated length ${length}`);
  }
  let value;
  try {
    value = utf8.decode(data.subarray(start, end));
  } catch {
    throw new Error(`${field}: invalid UTF-8`);
  }
  return { value, end };
}

function requireZero(data, start, end, field) {
  if (!data.subarray(start, end).equals(Buffer.alloc(end - start))) {
    throw new Error(`${field}: reserved bytes are nonzero`);
  }
}

function requireNonzero(bytes, field) {
  if (!bytes.some((value) => value !== 0)) {
    throw new Error(`${field}: zero value`);
  }
}

export function decodeCanonicalTaskJobSpec(dataLike) {
  const data = exact(
    dataLike,
    TASK_JOB_SPEC_SIZE,
    JOB_SPEC_DISCRIMINATOR,
    "TaskJobSpec",
  );
  const jobSpecHash = Buffer.from(data.subarray(72, 104));
  requireNonzero(jobSpecHash, "TaskJobSpec.job_spec_hash");
  const uri = readString(data, 104, 256, "TaskJobSpec.job_spec_uri");
  if (uri.value.trim().length === 0) {
    throw new Error("TaskJobSpec.job_spec_uri: empty");
  }
  if (uri.end + 24 > data.length) throw new Error("TaskJobSpec: truncated tail");
  const createdAt = data.readBigInt64LE(uri.end);
  const updatedAt = data.readBigInt64LE(uri.end + 8);
  if (createdAt <= 0n || updatedAt < createdAt) {
    throw new Error(
      `TaskJobSpec: invalid timestamps created=${createdAt} updated=${updatedAt}`,
    );
  }
  // _reserved[0] is the live bid-lock bit. It is not padding anymore; only
  // values 0/1 are canonical and the remaining six bytes stay reserved.
  if (data[uri.end + 17] > 1) {
    throw new Error(
      `TaskJobSpec.bid_locked: invalid bool ${data[uri.end + 17]}`,
    );
  }
  requireZero(data, uri.end + 18, uri.end + 24, "TaskJobSpec");
  return {
    task: new PublicKey(data.subarray(8, 40)),
    creator: new PublicKey(data.subarray(40, 72)),
    jobSpecHash,
    jobSpecUri: uri.value,
    createdAt,
    updatedAt,
    bump: data[uri.end + 16],
    bidLocked: data[uri.end + 17] === 1,
  };
}

export function decodeModerationBlock(dataLike) {
  const data = exact(
    dataLike,
    MODERATION_BLOCK_SIZE,
    BLOCK_DISCRIMINATOR,
    "ModerationBlock",
  );
  const status = data[40];
  if (status > 1) throw new Error(`ModerationBlock.status: invalid ${status}`);
  const contentHash = Buffer.from(data.subarray(8, 40));
  const rationaleHash = Buffer.from(data.subarray(41, 73));
  requireNonzero(contentHash, "ModerationBlock.content_hash");
  requireNonzero(rationaleHash, "ModerationBlock.rationale_hash");
  const uri = readString(data, 73, 256, "ModerationBlock.rationale_uri");
  if (uri.value.trim().length === 0) {
    throw new Error("ModerationBlock.rationale_uri: empty");
  }
  if (uri.end + 65 > data.length) throw new Error("ModerationBlock: truncated tail");
  requireZero(data, uri.end + 49, uri.end + 65, "ModerationBlock");
  return {
    contentHash,
    status,
    rationaleHash,
    rationaleUri: uri.value,
    bump: data[uri.end + 48],
  };
}

function blocker(kind, task, detail, extra = {}) {
  return { kind, task, detail, ...extra };
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

function isMissing(account) {
  return !account || account.lamports === 0;
}

export async function scanActiveJobSpecBlocks(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: TASK_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });
  const blockers = [];
  const activeTasks = [];
  for (const { pubkey: address, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-active-job-spec-task-owner", address));
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
      if (TERMINAL_STATUSES.has(task.status)) continue;
      const [jobSpec, jobSpecBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task_job_spec"), address.toBuffer()],
        PROGRAM_ID,
      );
      activeTasks.push({
        task: address,
        creator: task.creator,
        status: task.status,
        currentWorkers: task.currentWorkers,
        jobSpec,
        jobSpecBump,
      });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-active-job-spec-task-layout",
          address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const jobSpecMap = await fetchAccountMap(
    connection,
    activeTasks.map((item) => item.jobSpec),
  );
  const canonicalJobSpecs = [];
  const missingJobSpecs = [];
  for (const item of activeTasks) {
    const account = jobSpecMap.get(item.jobSpec.toBase58());
    if (
      isMissing(account) ||
      (account.owner.equals(SYSTEM_PROGRAM_ID) && account.data.length === 0)
    ) {
      missingJobSpecs.push(item);
      continue;
    }
    if (!account.owner.equals(PROGRAM_ID) || account.executable) {
      blockers.push(
        blocker(
          "invalid-active-job-spec-owner",
          item.task,
          `owner=${account.owner.toBase58()} executable=${account.executable}`,
          { jobSpec: item.jobSpec },
        ),
      );
      continue;
    }
    try {
      const jobSpec = decodeCanonicalTaskJobSpec(account.data);
      if (
        !jobSpec.task.equals(item.task) ||
        !jobSpec.creator.equals(item.creator) ||
        jobSpec.bump !== item.jobSpecBump
      ) {
        throw new Error("Task/creator/bump binding mismatch");
      }
      const [block, blockBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("moderation_block"), jobSpec.jobSpecHash],
        PROGRAM_ID,
      );
      canonicalJobSpecs.push({ ...item, ...jobSpec, block, blockBump });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-active-job-spec-layout",
          item.task,
          error instanceof Error ? error.message : String(error),
          { jobSpec: item.jobSpec },
        ),
      );
    }
  }

  const blockMap = await fetchAccountMap(
    connection,
    canonicalJobSpecs.map((item) => item.block),
  );
  const blocked = [];
  const cleared = [];
  for (const item of canonicalJobSpecs) {
    const account = blockMap.get(item.block.toBase58());
    if (isMissing(account)) continue;
    if (account.owner.equals(SYSTEM_PROGRAM_ID) && account.data.length === 0) {
      continue;
    }
    if (!account.owner.equals(PROGRAM_ID) || account.executable) {
      blockers.push(
        blocker(
          "invalid-active-moderation-block-owner",
          item.task,
          `owner=${account.owner.toBase58()} executable=${account.executable} ` +
            `data_len=${account.data.length}`,
          { jobSpec: item.jobSpec, block: item.block },
        ),
      );
      continue;
    }
    try {
      const block = decodeModerationBlock(account.data);
      if (
        !block.contentHash.equals(item.jobSpecHash) ||
        block.bump !== item.blockBump
      ) {
        throw new Error("content-hash/bump binding mismatch");
      }
      const record = {
        task: item.task,
        jobSpec: item.jobSpec,
        block: item.block,
        status: item.status,
        currentWorkers: item.currentWorkers,
        contentHash: item.jobSpecHash,
      };
      if (block.status === 1) blocked.push(record);
      else cleared.push(record);
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-active-moderation-block-layout",
          item.task,
          error instanceof Error ? error.message : String(error),
          { jobSpec: item.jobSpec, block: item.block },
        ),
      );
    }
  }

  return {
    taskCount: accounts.length,
    activeTaskCount: activeTasks.length,
    canonicalJobSpecCount: canonicalJobSpecs.length,
    missingJobSpecCount: missingJobSpecs.length,
    missingJobSpecUnassignedCount: missingJobSpecs.filter(
      (item) => item.currentWorkers === 0,
    ).length,
    missingJobSpecWithWorkersCount: missingJobSpecs.filter(
      (item) => item.currentWorkers > 0,
    ).length,
    missingJobSpecs,
    blockedCount: blocked.length,
    blockedUnassignedCount: blocked.filter((item) => item.currentWorkers === 0).length,
    blockedWithWorkersCount: blocked.filter((item) => item.currentWorkers > 0).length,
    clearedCount: cleared.length,
    blocked,
    cleared,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning active mainnet job-spec BLOCK state via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanActiveJobSpecBlocks(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(
    `Active job specs: total_tasks=${result.taskCount} nonterminal_tasks=${result.activeTaskCount} ` +
      `canonical_specs=${result.canonicalJobSpecCount} missing_specs=${result.missingJobSpecCount} ` +
      `missing_unassigned=${result.missingJobSpecUnassignedCount} ` +
      `missing_with_workers=${result.missingJobSpecWithWorkersCount} blocked=${result.blockedCount} ` +
      `blocked_unassigned=${result.blockedUnassignedCount} ` +
      `blocked_with_workers=${result.blockedWithWorkersCount} cleared=${result.clearedCount} ` +
      `blockers=${result.blockers.length}`,
  );
  for (const item of result.blocked) {
    console.warn(
      `  CONTAINED BLOCK: task=${item.task.toBase58()} job_spec=${item.jobSpec.toBase58()} ` +
        `block=${item.block.toBase58()} status=${item.status} ` +
        `current_workers=${item.currentWorkers}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: task=${item.task.toBase58()}` +
        `${item.jobSpec ? ` job_spec=${item.jobSpec.toBase58()}` : ""}` +
        `${item.block ? ` block=${item.block.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} malformed active job-spec moderation condition(s) found`,
    );
  }
  console.log(
    "PREFLIGHT OK: active canonical job-spec BLOCK state is well formed; valid blocks remain containment inventory, not deployment blockers.",
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
