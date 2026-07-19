#!/usr/bin/env node
// Mainnet TaskValidationConfig cutover preflight for the revision-5 binary.
//
// ValidatorQuorum identities are permissionless/self-asserted, so revision 5
// disables new quorum configuration at the binary boundary. This scanner proves
// every existing TaskValidationConfig's owner, exact Borsh layout, canonical PDA,
// bump, and Task binding, then blocks every legacy ValidatorQuorum config. It is
// intentionally run only after ProtocolConfig.protocol_paused has been confirmed:
// the pause closes the old configure/claim entry paths during the scan/deploy gap.

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

const CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskValidationConfig")
  .digest()
  .subarray(0, 8);
const CONFIG_SIZE = 105;
const MODE_CREATOR_REVIEW = 1;
const MODE_VALIDATOR_QUORUM = 2;
const MODE_EXTERNAL_ATTESTATION = 3;
const MAX_REVIEW_WINDOW_SECS = 604_800n;
const MANUAL_VALIDATION_SENTINEL = Buffer.from(
  "agenc-manual-validation-v2-seed!",
);
const TASK_STATUS_NAMES = [
  "Open",
  "InProgress",
  "PendingValidation",
  "Completed",
  "Cancelled",
  "Disputed",
  "RejectFrozen",
];

function assertDiscriminator(data) {
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new Error("TaskValidationConfig: discriminator mismatch");
  }
}

export function decodeTaskValidationConfig(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== CONFIG_SIZE) {
    throw new Error(
      `TaskValidationConfig: unexpected account size ${data.length}; expected ${CONFIG_SIZE}`,
    );
  }
  assertDiscriminator(data);

  const mode = data[72];
  const reviewWindowSecs = data.readBigInt64LE(73);
  const reserved = data.subarray(98, 105);
  const validatorQuorum = reserved[0];
  const pendingSubmissionCount = reserved.readUInt16LE(1);

  if (
    mode !== MODE_CREATOR_REVIEW &&
    mode !== MODE_VALIDATOR_QUORUM &&
    mode !== MODE_EXTERNAL_ATTESTATION
  ) {
    throw new Error(`TaskValidationConfig.mode: invalid enum variant ${mode}`);
  }
  if (
    mode === MODE_CREATOR_REVIEW &&
    (reviewWindowSecs <= 0n || reviewWindowSecs > MAX_REVIEW_WINDOW_SECS)
  ) {
    throw new Error(
      `TaskValidationConfig: invalid CreatorReview window ${reviewWindowSecs}`,
    );
  }
  if (
    mode !== MODE_CREATOR_REVIEW &&
    reviewWindowSecs !== 0n
  ) {
    throw new Error(
      `TaskValidationConfig: mode ${mode} requires review_window_secs=0`,
    );
  }
  if (
    (mode === MODE_VALIDATOR_QUORUM && validatorQuorum === 0) ||
    (mode !== MODE_VALIDATOR_QUORUM && validatorQuorum !== 0)
  ) {
    throw new Error(
      `TaskValidationConfig: mode ${mode} has invalid validator_quorum=${validatorQuorum}`,
    );
  }
  if (!reserved.subarray(3).equals(Buffer.alloc(4))) {
    throw new Error("TaskValidationConfig: unknown reserved bytes are nonzero");
  }

  return {
    task: new PublicKey(data.subarray(8, 40)),
    creator: new PublicKey(data.subarray(40, 72)),
    mode,
    reviewWindowSecs,
    createdAt: data.readBigInt64LE(81),
    updatedAt: data.readBigInt64LE(89),
    bump: data[97],
    validatorQuorum,
    pendingSubmissionCount,
  };
}

function blocker(kind, config, task, detail) {
  return { kind, config, task, detail };
}

function quorumBlockerKind(task) {
  if (!task) return "validator-quorum-configured-unknown-task";
  if (task.status === 2) return "validator-quorum-pending-validation";
  if (task.status === 0 || task.status === 1) {
    return "validator-quorum-future-entry-risk";
  }
  if (task.status === 5 || task.status === 6) {
    return "validator-quorum-live-task";
  }
  return "validator-quorum-terminal-config";
}

export async function scanTaskValidationConfigs(connection) {
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
          bytes: CONFIG_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });
  const blockers = [];
  const orphans = [];
  const decoded = [];
  const modeCounts = {
    creatorReview: 0,
    validatorQuorum: 0,
    externalAttestation: 0,
  };

  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-validation-config-owner", pubkey));
      continue;
    }
    if (!Number.isSafeInteger(account.lamports) || account.lamports < 0) {
      blockers.push(
        blocker(
          "invalid-validation-config-lamports",
          pubkey,
          undefined,
          `invalid RPC lamports value ${String(account.lamports)}`,
        ),
      );
      continue;
    }
    try {
      const config = decodeTaskValidationConfig(account.data);
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task_validation"), config.task.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(pubkey) || config.bump !== expectedBump) {
        blockers.push(
          blocker(
            "invalid-validation-config-pda",
            pubkey,
            config.task,
            `stored_bump=${config.bump} canonical_bump=${expectedBump}`,
          ),
        );
        continue;
      }
      if (config.mode === MODE_CREATOR_REVIEW) modeCounts.creatorReview++;
      else if (config.mode === MODE_VALIDATOR_QUORUM) modeCounts.validatorQuorum++;
      else modeCounts.externalAttestation++;
      decoded.push({ pubkey, config, lamports: BigInt(account.lamports) });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-validation-config-layout",
          pubkey,
          undefined,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const CHUNK_SIZE = 100;
  for (let offset = 0; offset < decoded.length; offset += CHUNK_SIZE) {
    const chunk = decoded.slice(offset, offset + CHUNK_SIZE);
    const taskAccounts = await connection.getMultipleAccountsInfo(
      chunk.map(({ config }) => config.task),
      "confirmed",
    );
    for (let index = 0; index < chunk.length; index++) {
      const { pubkey, config, lamports } = chunk[index];
      const account = taskAccounts[index];
      let task = null;
      if (!account || account.lamports === 0) {
        const active =
          config.mode === MODE_VALIDATOR_QUORUM ||
          config.pendingSubmissionCount > 0;
        orphans.push({
          config: pubkey,
          task: config.task,
          creator: config.creator,
          mode: config.mode,
          pendingSubmissionCount: config.pendingSubmissionCount,
          lamports,
          risk: active ? "active" : "rent-only",
        });
        if (active) {
          blockers.push(
            blocker(
              "orphaned-active-validation-config",
              pubkey,
              config.task,
              `mode=${config.mode} pending_submissions=${config.pendingSubmissionCount}`,
            ),
          );
        }
      } else if (!account.owner.equals(PROGRAM_ID)) {
        blockers.push(
          blocker("invalid-validation-task-owner", pubkey, config.task),
        );
      } else {
        try {
          task = decodeTaskBinding(account.data);
          const [expectedTask, expectedBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
            PROGRAM_ID,
          );
          if (
            !expectedTask.equals(config.task) ||
            task.bump !== expectedBump ||
            !task.creator.equals(config.creator)
          ) {
            blockers.push(
              blocker(
                "invalid-validation-task-binding",
                pubkey,
                config.task,
                `task_creator=${task.creator.toBase58()} config_creator=${config.creator.toBase58()}`,
              ),
            );
            task = null;
          } else if (!task.constraintHash.equals(MANUAL_VALIDATION_SENTINEL)) {
            blockers.push(
              blocker(
                "validation-task-missing-manual-sentinel",
                pubkey,
                config.task,
              ),
            );
          }
        } catch (error) {
          blockers.push(
            blocker(
              "invalid-validation-task-layout",
              pubkey,
              config.task,
              error instanceof Error ? error.message : String(error),
            ),
          );
          task = null;
        }
      }

      if (config.mode === MODE_VALIDATOR_QUORUM) {
        const status = task ? TASK_STATUS_NAMES[task.status] : "Unknown";
        blockers.push(
          blocker(
            quorumBlockerKind(task),
            pubkey,
            config.task,
            `status=${status} validator_quorum=${config.validatorQuorum} ` +
              `pending_submissions=${config.pendingSubmissionCount}`,
          ),
        );
      }
    }
  }

  return {
    accountCount: accounts.length,
    modeCounts,
    orphanCount: orphans.length,
    orphanLamports: orphans.reduce((sum, item) => sum + item.lamports, 0n),
    orphans,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet TaskValidationConfig accounts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanTaskValidationConfigs(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(
    `TaskValidationConfig: ${result.accountCount} ` +
      `(creator_review=${result.modeCounts.creatorReview}, ` +
      `validator_quorum=${result.modeCounts.validatorQuorum}, ` +
      `external_attestation=${result.modeCounts.externalAttestation}, ` +
      `orphaned=${result.orphanCount}, orphan_lamports=${result.orphanLamports})`,
  );
  for (const item of result.orphans.slice(0, 10)) {
    console.warn(
      `  ORPHAN ${item.risk}: config=${item.config.toBase58()} ` +
        `task=${item.task.toBase58()} creator=${item.creator.toBase58()} ` +
        `mode=${item.mode} pending_submissions=${item.pendingSubmissionCount} ` +
        `lamports=${item.lamports}`,
    );
  }
  if (result.orphans.length > 10) {
    console.warn(`  ... ${result.orphans.length - 10} additional orphan config(s)`);
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: config=${item.config.toBase58()}` +
        `${item.task ? ` task=${item.task.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} task-validation cutover blocker(s) found; settle/remove legacy quorum state before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: no ValidatorQuorum or active orphan config exists; rent-only historical orphans remain inventoried for typed reclamation.",
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
