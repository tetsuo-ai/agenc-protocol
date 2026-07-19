#!/usr/bin/env node
// Read-only revision-5 preflight for SPL-token-denominated Task escrow safety.
//
// A token Task is only safely settleable when its mint is an initialized classic
// SPL Token mint with no freeze authority and its canonical escrow ATA is an
// initialized, unfrozen token account owned by the TaskEscrow PDA. Every live
// token Task is checked against its TaskEscrow accounting so the ATA holds at
// least the unsettled principal. Terminal token Tasks are inventoried only: their
// token escrow may already have been swept and closed by a valid exit path.

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

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const ESCROW_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskEscrow")
  .digest()
  .subarray(0, 8);
const CLASSIC_MINT_SIZE = 82;
const CLASSIC_TOKEN_ACCOUNT_SIZE = 165;
const TASK_ESCROW_SIZE = 58;
const TERMINAL_STATUSES = new Set([3, 4]);

function decodeCOptionPubkey(data, offset, field) {
  if (offset + 36 > data.length) throw new Error(`${field}: truncated COption`);
  const tag = data.readUInt32LE(offset);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`${field}: invalid COption tag ${tag}`);
  return new PublicKey(data.subarray(offset + 4, offset + 36));
}

export function decodeClassicMint(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== CLASSIC_MINT_SIZE) {
    throw new Error(
      `SPL Mint: unexpected size ${data.length}; expected ${CLASSIC_MINT_SIZE}`,
    );
  }
  const mintAuthority = decodeCOptionPubkey(data, 0, "SPL Mint.mint_authority");
  const initialized = data[45];
  if (initialized > 1) {
    throw new Error(`SPL Mint.is_initialized: invalid bool ${initialized}`);
  }
  const freezeAuthority = decodeCOptionPubkey(
    data,
    46,
    "SPL Mint.freeze_authority",
  );
  return {
    mintAuthority,
    supply: data.readBigUInt64LE(36),
    decimals: data[44],
    initialized: initialized === 1,
    freezeAuthority,
  };
}

export function decodeClassicTokenAccount(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== CLASSIC_TOKEN_ACCOUNT_SIZE) {
    throw new Error(
      `SPL TokenAccount: unexpected size ${data.length}; expected ${CLASSIC_TOKEN_ACCOUNT_SIZE}`,
    );
  }
  // Validate every COption tag even when the field is not part of the policy;
  // malformed classic-token state must never be treated as an initialized ATA.
  decodeCOptionPubkey(data, 72, "SPL TokenAccount.delegate");
  const isNativeTag = data.readUInt32LE(109);
  if (isNativeTag !== 0 && isNativeTag !== 1) {
    throw new Error(`SPL TokenAccount.is_native: invalid COption tag ${isNativeTag}`);
  }
  decodeCOptionPubkey(data, 129, "SPL TokenAccount.close_authority");
  const state = data[108];
  if (state > 2) throw new Error(`SPL TokenAccount.state: invalid ${state}`);
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    authority: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
    state,
  };
}

export function decodeTaskEscrow(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== TASK_ESCROW_SIZE) {
    throw new Error(
      `TaskEscrow: unexpected size ${data.length}; expected ${TASK_ESCROW_SIZE}`,
    );
  }
  if (!data.subarray(0, 8).equals(ESCROW_DISCRIMINATOR)) {
    throw new Error("TaskEscrow: discriminator mismatch");
  }
  const closed = data[56];
  if (closed > 1) throw new Error(`TaskEscrow.is_closed: invalid bool ${closed}`);
  const amount = data.readBigUInt64LE(40);
  const distributed = data.readBigUInt64LE(48);
  if (distributed > amount) {
    throw new Error(
      `TaskEscrow: distributed ${distributed} exceeds amount ${amount}`,
    );
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    amount,
    distributed,
    closed: closed === 1,
    bump: data[57],
  };
}

export function deriveEscrowAta(escrow, mint) {
  return PublicKey.findProgramAddressSync(
    [escrow.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
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

export async function scanTokenRewardTasks(connection) {
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
  const live = [];
  const terminal = [];

  for (const { pubkey: taskAddress, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-token-task-owner", taskAddress));
      continue;
    }
    try {
      const task = decodeTaskBinding(account.data);
      const [canonicalTask, taskBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
        PROGRAM_ID,
      );
      if (!canonicalTask.equals(taskAddress) || task.bump !== taskBump) {
        throw new Error("canonical Task PDA/bump mismatch");
      }
      if (!task.rewardMint) continue;

      const [escrow, escrowBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskAddress.toBuffer()],
        PROGRAM_ID,
      );
      const tokenTask = {
        task: taskAddress,
        status: task.status,
        mint: task.rewardMint,
        escrow,
        escrowBump,
        ata: deriveEscrowAta(escrow, task.rewardMint),
        rewardAmount: task.rewardAmount,
      };
      if (!task.escrow.equals(escrow)) {
        blockers.push(
          blocker(
            "invalid-token-task-escrow-binding",
            taskAddress,
            `stored=${task.escrow.toBase58()} canonical=${escrow.toBase58()}`,
            { mint: task.rewardMint, escrow },
          ),
        );
      }
      if (TERMINAL_STATUSES.has(task.status)) terminal.push(tokenTask);
      else live.push(tokenTask);
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-token-task-layout",
          taskAddress,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const accountMap = await fetchAccountMap(
    connection,
    live.flatMap((item) => [item.mint, item.escrow, item.ata]),
  );

  for (const item of live) {
    const mintAccount = accountMap.get(item.mint.toBase58());
    if (isMissing(mintAccount)) {
      blockers.push(
        blocker("missing-token-reward-mint", item.task, undefined, {
          mint: item.mint,
        }),
      );
    } else if (
      !mintAccount.owner.equals(TOKEN_PROGRAM_ID) ||
      mintAccount.executable
    ) {
      blockers.push(
        blocker(
          "unsafe-token-reward-mint-owner",
          item.task,
          `owner=${mintAccount.owner.toBase58()} executable=${mintAccount.executable}`,
          { mint: item.mint },
        ),
      );
    } else {
      try {
        const mint = decodeClassicMint(mintAccount.data);
        if (!mint.initialized) {
          blockers.push(
            blocker("uninitialized-token-reward-mint", item.task, undefined, {
              mint: item.mint,
            }),
          );
        }
        if (mint.freezeAuthority) {
          blockers.push(
            blocker(
              "freezable-token-reward-mint",
              item.task,
              `freeze_authority=${mint.freezeAuthority.toBase58()}`,
              { mint: item.mint },
            ),
          );
        }
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-token-reward-mint-layout",
            item.task,
            error instanceof Error ? error.message : String(error),
            { mint: item.mint },
          ),
        );
      }
    }

    let unsettledPrincipal = null;
    const escrowAccount = accountMap.get(item.escrow.toBase58());
    if (isMissing(escrowAccount)) {
      blockers.push(
        blocker("missing-token-task-escrow", item.task, undefined, {
          mint: item.mint,
          escrow: item.escrow,
        }),
      );
    } else if (!escrowAccount.owner.equals(PROGRAM_ID) || escrowAccount.executable) {
      blockers.push(
        blocker(
          "invalid-token-task-escrow-owner",
          item.task,
          `owner=${escrowAccount.owner.toBase58()} executable=${escrowAccount.executable}`,
          { mint: item.mint, escrow: item.escrow },
        ),
      );
    } else {
      try {
        const escrow = decodeTaskEscrow(escrowAccount.data);
        if (
          !escrow.task.equals(item.task) ||
          escrow.bump !== item.escrowBump ||
          escrow.closed
        ) {
          throw new Error(
            `binding/closed mismatch task=${escrow.task.toBase58()} ` +
              `bump=${escrow.bump}/${item.escrowBump} closed=${escrow.closed}`,
          );
        }
        if (escrow.amount !== item.rewardAmount) {
          throw new Error(
            `amount ${escrow.amount} != Task.reward_amount ${item.rewardAmount}`,
          );
        }
        unsettledPrincipal = escrow.amount - escrow.distributed;
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-token-task-escrow-layout",
            item.task,
            error instanceof Error ? error.message : String(error),
            { mint: item.mint, escrow: item.escrow },
          ),
        );
      }
    }

    const ataAccount = accountMap.get(item.ata.toBase58());
    if (isMissing(ataAccount)) {
      blockers.push(
        blocker("missing-token-escrow-ata", item.task, undefined, {
          mint: item.mint,
          escrow: item.escrow,
          ata: item.ata,
        }),
      );
    } else if (!ataAccount.owner.equals(TOKEN_PROGRAM_ID) || ataAccount.executable) {
      blockers.push(
        blocker(
          "invalid-token-escrow-ata-owner",
          item.task,
          `owner=${ataAccount.owner.toBase58()} executable=${ataAccount.executable}`,
          { mint: item.mint, escrow: item.escrow, ata: item.ata },
        ),
      );
    } else {
      try {
        const ata = decodeClassicTokenAccount(ataAccount.data);
        if (!ata.mint.equals(item.mint) || !ata.authority.equals(item.escrow)) {
          throw new Error(
            `mint/authority mismatch mint=${ata.mint.toBase58()} ` +
              `authority=${ata.authority.toBase58()}`,
          );
        }
        if (ata.state !== 1) {
          throw new Error(
            `account state ${ata.state} is not Initialized (Frozen=2)`,
          );
        }
        if (unsettledPrincipal !== null && ata.amount < unsettledPrincipal) {
          blockers.push(
            blocker(
              "insufficient-token-escrow-principal",
              item.task,
              `balance=${ata.amount} required=${unsettledPrincipal}`,
              { mint: item.mint, escrow: item.escrow, ata: item.ata },
            ),
          );
        }
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-token-escrow-ata-layout",
            item.task,
            error instanceof Error ? error.message : String(error),
            { mint: item.mint, escrow: item.escrow, ata: item.ata },
          ),
        );
      }
    }
  }

  return {
    accountCount: accounts.length,
    tokenTaskCount: live.length + terminal.length,
    liveCount: live.length,
    terminalCount: terminal.length,
    live,
    terminal,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet token-reward Tasks via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanTokenRewardTasks(new Connection(rpcUrl, "confirmed"));
  console.log(
    `Token Tasks: all_tasks=${result.accountCount} token_tasks=${result.tokenTaskCount} ` +
      `live=${result.liveCount} terminal=${result.terminalCount} ` +
      `blockers=${result.blockers.length}`,
  );
  for (const item of result.terminal.slice(0, 10)) {
    console.log(
      `  TERMINAL INVENTORY: task=${item.task.toBase58()} status=${item.status} ` +
        `mint=${item.mint.toBase58()} reward=${item.rewardAmount}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: task=${item.task.toBase58()}` +
        `${item.mint ? ` mint=${item.mint.toBase58()}` : ""}` +
        `${item.escrow ? ` escrow=${item.escrow.toBase58()}` : ""}` +
        `${item.ata ? ` ata=${item.ata.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} unsafe live token-task escrow condition(s) found`,
    );
  }
  console.log(
    "PREFLIGHT OK: every live token Task has a nonfreezable classic mint and sufficient canonical initialized escrow ATA principal.",
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
