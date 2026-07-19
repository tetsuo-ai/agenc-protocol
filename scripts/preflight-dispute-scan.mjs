#!/usr/bin/env node
// Mainnet dispute-liveness preflight for the audit-hardening upgrade.
//
// Blocks deployment on:
// - pre-single-resolver disputes (a retired `total_voters` value other than
//   zero or the current initiator-counter provenance sentinel);
// - any non-zero legacy `AgentRegistration.active_dispute_votes` byte before it
//   is repurposed as the pending initiator-outcome counter;
// - any non-zero defendant-dispute counter before deregistration changes from a
//   timestamp bypass to an exact terminal/finalizer gate;
// - active disputes whose canonical Task/defendant claim is missing or invalid;
// - every still-actionable historical initiator loss or provenance-tagged
//   terminal outcome that remains unapplied; expired/no-fault historical
//   outcomes own no counter and retain their deployed non-finalizable state;
// - legacy resolved, unapplied worker-loss rulings whose Task does not carry the
//   new `_reserved[2] = worker_slash_pending` invariant. The upgraded slash
//   finalizer intentionally requires that flag and would otherwise become
//   unusable for the legacy dispute.
//
// The scanner decodes the actual Borsh prefix from state.rs, validates every
// owner/discriminator/PDA/bump binding, requires mainnet genesis, and fails
// closed on all layout ambiguity.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

export const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
export const MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const DISPUTE_DISCRIMINATOR = createHash("sha256")
  .update("account:Dispute")
  .digest()
  .subarray(0, 8);
const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
const CLAIM_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskClaim")
  .digest()
  .subarray(0, 8);
const AGENT_DISCRIMINATOR = createHash("sha256")
  .update("account:AgentRegistration")
  .digest()
  .subarray(0, 8);

const DISPUTE_PREFIX_SIZE = 263;
const DISPUTE_CURRENT_SIZE = 587;
const TASK_SIZES = new Set([382, 432, 466]);
const CLAIM_SIZE = 203;
const AGENT_SIZE = 566;
const STATUS_ACTIVE = 0;
const STATUS_RESOLVED = 1;
const STATUS_MAX = 3;
const RESOLUTION_COMPLETE = 1;
const INITIATOR_OUTCOME_COUNTER_MARKER = 0xff;
const LEGACY_INITIATOR_SLASH_WINDOW_SECS = 604_800n;

function requireBytes(data, offset, length, field) {
  if (!Buffer.isBuffer(data)) throw new Error(`${field}: expected Buffer`);
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(
      `${field}: truncated account (${data.length} bytes; need ${offset + length})`,
    );
  }
}

function assertDiscriminator(data, expected, accountType) {
  requireBytes(data, 0, 8, `${accountType} discriminator`);
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error(`${accountType}: discriminator mismatch`);
  }
}

function readOptionPubkey(data, offset, field) {
  requireBytes(data, offset, 1, `${field} option tag`);
  const tag = data[offset];
  if (tag === 0) return { end: offset + 1, value: null };
  if (tag !== 1) throw new Error(`${field}: invalid Option tag ${tag}`);
  requireBytes(data, offset + 1, 32, field);
  return {
    end: offset + 33,
    value: new PublicKey(data.subarray(offset + 1, offset + 33)),
  };
}

function readBorshStringEnd(data, offset, field, maxLength) {
  requireBytes(data, offset, 4, `${field} length`);
  const length = data.readUInt32LE(offset);
  if (length > maxLength) {
    throw new Error(`${field}: encoded length ${length} exceeds maximum ${maxLength}`);
  }
  requireBytes(data, offset + 4, length, field);
  return offset + 4 + length;
}

export function decodeDispute(dataLike) {
  const data = Buffer.from(dataLike);
  if (
    data.length !== DISPUTE_PREFIX_SIZE &&
    data.length !== DISPUTE_CURRENT_SIZE
  ) {
    throw new Error(
      `Dispute: unexpected account size ${data.length}; expected ${DISPUTE_PREFIX_SIZE} (legacy) or ${DISPUTE_CURRENT_SIZE} (current)`,
    );
  }
  assertDiscriminator(data, DISPUTE_DISCRIMINATOR, "Dispute");
  const resolutionType = data[168];
  const status = data[169];
  const slashAppliedByte = data[219];
  const initiatorSlashAppliedByte = data[220];
  if (resolutionType > 2) {
    throw new Error(`Dispute.resolution_type: invalid enum variant ${resolutionType}`);
  }
  if (status > STATUS_MAX) {
    throw new Error(`Dispute.status: invalid enum variant ${status}`);
  }
  if (slashAppliedByte > 1) {
    throw new Error(`Dispute.slash_applied: invalid bool ${slashAppliedByte}`);
  }
  if (initiatorSlashAppliedByte > 1) {
    throw new Error(
      `Dispute.initiator_slash_applied: invalid bool ${initiatorSlashAppliedByte}`,
    );
  }
  const votesFor = data.readBigUInt64LE(186);
  const votesAgainst = data.readBigUInt64LE(194);
  if (
    status === STATUS_RESOLVED &&
    !(
      (votesFor === 1n && votesAgainst === 0n) ||
      (votesFor === 0n && votesAgainst === 1n)
    )
  ) {
    throw new Error(
      `Dispute: resolved ruling is not canonical (votes_for=${votesFor}, votes_against=${votesAgainst})`,
    );
  }
  return {
    accountSize: data.length,
    legacyLayout: data.length === DISPUTE_PREFIX_SIZE,
    disputeId: Buffer.from(data.subarray(8, 40)),
    task: new PublicKey(data.subarray(40, 72)),
    initiator: new PublicKey(data.subarray(72, 104)),
    initiatorAuthority: new PublicKey(data.subarray(104, 136)),
    resolutionType,
    status,
    resolvedAt: data.readBigInt64LE(178),
    votesFor,
    votesAgainst,
    totalVoters: data[202],
    votingDeadline: data.readBigInt64LE(203),
    expiresAt: data.readBigInt64LE(211),
    slashApplied: slashAppliedByte === 1,
    initiatorSlashApplied: initiatorSlashAppliedByte === 1,
    bump: data[230],
    defendant: new PublicKey(data.subarray(231, 263)),
  };
}

export function decodeTaskBinding(dataLike) {
  const data = Buffer.from(dataLike);
  if (!TASK_SIZES.has(data.length)) {
    throw new Error(`Task: unsupported account size ${data.length}`);
  }
  assertDiscriminator(data, TASK_DISCRIMINATOR, "Task");
  const taskId = Buffer.from(data.subarray(8, 40));
  const creator = new PublicKey(data.subarray(40, 72));
  const constraintHash = Buffer.from(data.subarray(144, 176));
  const rewardAmount = data.readBigUInt64LE(176);
  const maxWorkers = data[184];
  const currentWorkers = data[185];
  const status = data[186];
  if (status > 6) {
    throw new Error(`Task.status: invalid enum variant ${status}`);
  }
  const taskType = data[187];
  if (taskType > 3) {
    throw new Error(`Task.task_type: invalid enum variant ${taskType}`);
  }
  const escrow = new PublicKey(data.subarray(212, 244));
  const bump = data[310];
  const protocolFeeBps = data.readUInt16LE(311);
  if (protocolFeeBps > 2_000) {
    throw new Error(`Task.protocol_fee_bps: invalid ${protocolFeeBps}`);
  }

  // Prefix through protocol_fee_bps ends at 313. depends_on is a Borsh Option,
  // so dependency_type moves by 32 bytes between None and Some encodings.
  const dependsOnOption = readOptionPubkey(
    data,
    313,
    "Task.depends_on",
  );
  requireBytes(
    data,
    dependsOnOption.end,
    3,
    "Task.dependency_type/min_reputation",
  );
  const dependencyType = data[dependsOnOption.end];
  if (dependencyType > 3) {
    throw new Error(`Task.dependency_type: invalid enum variant ${dependencyType}`);
  }
  const rewardMintOption = readOptionPubkey(
    data,
    dependsOnOption.end + 3,
    "Task.reward_mint",
  );

  // The 382-byte legacy layout predates operator/_reserved. Its appended bytes
  // have the same zero semantics as worker_slash_pending=false.
  if (data.length === 382) {
    return {
      taskId,
      creator,
      constraintHash,
      rewardAmount,
      maxWorkers,
      currentWorkers,
      status,
      taskType,
      escrow,
      dependsOn: dependsOnOption.value,
      dependencyType,
      rewardMint: rewardMintOption.value,
      bump,
      workerSlashPending: false,
      protocolFeeBps,
      operator: PublicKey.default,
      operatorFeeBps: 0,
      referrer: PublicKey.default,
      referrerFeeBps: 0,
    };
  }

  // Prefix through protocol_fee_bps ends at 313. Both Options are Borsh-tagged,
  // so locate the append using their actual encoded variants rather than a
  // max-allocation offset.
  const offset = rewardMintOption.end;
  requireBytes(data, offset, 32 + 2 + 16, "Task operator/reserved append");
  const reserved = data.subarray(offset + 34, offset + 50);
  if (reserved[2] > 1) {
    throw new Error(`Task.worker_slash_pending: invalid bool ${reserved[2]}`);
  }
  const operator = new PublicKey(data.subarray(offset, offset + 32));
  const operatorFeeBps = data.readUInt16LE(offset + 32);
  if (operatorFeeBps > 2_000) {
    throw new Error(`Task.operator_fee_bps: invalid ${operatorFeeBps}`);
  }
  let referrer = PublicKey.default;
  let referrerFeeBps = 0;
  if (data.length === 466) {
    requireBytes(data, offset + 50, 34, "Task referrer append");
    referrer = new PublicKey(data.subarray(offset + 50, offset + 82));
    referrerFeeBps = data.readUInt16LE(offset + 82);
    if (referrerFeeBps > 2_000) {
      throw new Error(`Task.referrer_fee_bps: invalid ${referrerFeeBps}`);
    }
  }
  return {
    taskId,
    creator,
    constraintHash,
    rewardAmount,
    maxWorkers,
    currentWorkers,
    status,
    taskType,
    escrow,
    dependsOn: dependsOnOption.value,
    dependencyType,
    rewardMint: rewardMintOption.value,
    bump,
    workerSlashPending: reserved[2] === 1,
    protocolFeeBps,
    operator,
    operatorFeeBps,
    referrer,
    referrerFeeBps,
  };
}

export function decodeClaimBinding(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== CLAIM_SIZE) {
    throw new Error(
      `TaskClaim: unexpected account size ${data.length}; expected ${CLAIM_SIZE}`,
    );
  }
  assertDiscriminator(data, CLAIM_DISCRIMINATOR, "TaskClaim");
  return {
    task: new PublicKey(data.subarray(8, 40)),
    worker: new PublicKey(data.subarray(40, 72)),
    bump: data[202],
  };
}

export function decodeAgentBinding(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== AGENT_SIZE) {
    throw new Error(
      `AgentRegistration: unexpected account size ${data.length}; expected ${AGENT_SIZE}`,
    );
  }
  assertDiscriminator(data, AGENT_DISCRIMINATOR, "AgentRegistration");
  const status = data[80];
  if (status > 3) {
    throw new Error(`AgentRegistration.status: invalid enum variant ${status}`);
  }
  let offset = 81;
  offset = readBorshStringEnd(data, offset, "AgentRegistration.endpoint", 256);
  offset = readBorshStringEnd(
    data,
    offset,
    "AgentRegistration.metadata_uri",
    128,
  );
  requireBytes(data, offset, 93, "AgentRegistration fixed tail");
  const registeredAt = data.readBigInt64LE(offset);
  if (registeredAt <= 0n) {
    throw new Error(
      `AgentRegistration.registered_at: invalid timestamp ${registeredAt}`,
    );
  }
  const reputation = data.readUInt16LE(offset + 32);
  if (reputation > 10_000) {
    throw new Error(`AgentRegistration.reputation: invalid ${reputation}`);
  }
  const reserved = data.subarray(offset + 89, offset + 93);
  const retired = reserved.equals(Buffer.from("RETD", "ascii"));
  if (!retired && !reserved.equals(Buffer.alloc(4))) {
    throw new Error("AgentRegistration: invalid reserved identity marker");
  }
  return {
    agentId: Buffer.from(data.subarray(8, 40)),
    authority: new PublicKey(data.subarray(40, 72)),
    status,
    registeredAt,
    reputation,
    activeTasks: data.readUInt16LE(offset + 34),
    stake: data.readBigUInt64LE(offset + 36),
    bump: data[offset + 44],
    // Historical field name: P6.3 retired arbiter voting and the hardened
    // binary reuses this byte as pending initiator-outcome count.
    pendingInitiatorOutcomes: data[offset + 71],
    lastVoteTimestamp: data.readBigInt64LE(offset + 72),
    disputesAsDefendant: data[offset + 88],
    retired,
  };
}

export function isResolvedUnappliedWorkerLoss(dispute) {
  return (
    dispute.status === STATUS_RESOLVED &&
    !dispute.slashApplied &&
    dispute.votesFor === 1n &&
    dispute.votesAgainst === 0n &&
    dispute.resolutionType !== RESOLUTION_COMPLETE
  );
}

export function redactRpcText(value) {
  return String(value).replace(
    /(?:https?|wss?):\/\/[^\s"']+/giu,
    "<redacted-rpc>",
  );
}

function blocker(kind, pubkey, detail) {
  return { kind, dispute: pubkey, detail };
}

async function inspectAgentCounterCutover(connection, blockers) {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: AGENT_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });

  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-agent-owner", pubkey));
      continue;
    }
    try {
      const agent = decodeAgentBinding(account.data);
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agent.agentId],
        PROGRAM_ID,
      );
      if (!expected.equals(pubkey) || expectedBump !== agent.bump) {
        blockers.push(blocker("invalid-agent-pda", pubkey));
        continue;
      }
      // Hard cutover invariant: this byte belonged to retired arbiter voting in
      // the old binary. New code treats it as a pending initiator-outcome count,
      // so any non-zero legacy value would create an unowned deregistration lock.
      if (agent.pendingInitiatorOutcomes !== 0) {
        blockers.push(
          blocker(
            "legacy-agent-initiator-counter-nonzero",
            pubkey,
            `active_dispute_votes=${agent.pendingInitiatorOutcomes}`,
          ),
        );
      }
      // The hardened deregistration gate no longer lets this liability age out
      // against an unrelated `last_active` timestamp. Requiring a zero cutover
      // prevents a stale legacy count from silently freezing retirement.
      if (agent.disputesAsDefendant !== 0) {
        blockers.push(
          blocker(
            "legacy-agent-defendant-counter-nonzero",
            pubkey,
            `disputes_as_defendant=${agent.disputesAsDefendant}`,
          ),
        );
      }
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-agent-layout",
          pubkey,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return accounts.length;
}

async function inspectTaskAndClaim(
  connection,
  pubkey,
  dispute,
  blockers,
  { requireLiveClaim },
) {
  const [claimPda, claimBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("claim"),
      dispute.task.toBuffer(),
      dispute.defendant.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const [taskAccount, claimAccount] = await connection.getMultipleAccountsInfo(
    [dispute.task, claimPda],
    "confirmed",
  );

  let task = null;
  if (!taskAccount || taskAccount.lamports === 0) {
    blockers.push(blocker("missing-task", pubkey, dispute.task.toBase58()));
  } else if (!taskAccount.owner.equals(PROGRAM_ID)) {
    blockers.push(blocker("invalid-task-owner", pubkey, dispute.task.toBase58()));
  } else {
    try {
      task = decodeTaskBinding(taskAccount.data);
      const [expectedTask, taskBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
        PROGRAM_ID,
      );
      if (!expectedTask.equals(dispute.task) || task.bump !== taskBump) {
        blockers.push(
          blocker("invalid-task-pda", pubkey, dispute.task.toBase58()),
        );
        task = null;
      }
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-task-layout",
          pubkey,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  let claimState = "missing";
  if (!claimAccount || claimAccount.lamports === 0) {
    if (requireLiveClaim) {
      blockers.push(
        blocker("missing-defendant-claim", pubkey, claimPda.toBase58()),
      );
    }
  } else if (!claimAccount.owner.equals(PROGRAM_ID)) {
    claimState = "invalid";
    blockers.push(
      blocker("invalid-claim-owner", pubkey, claimPda.toBase58()),
    );
  } else {
    try {
      const claim = decodeClaimBinding(claimAccount.data);
      if (
        !claim.task.equals(dispute.task) ||
        !claim.worker.equals(dispute.defendant) ||
        claim.bump !== claimBump
      ) {
        blockers.push(
          blocker("invalid-claim-binding", pubkey, claimPda.toBase58()),
        );
        claimState = "invalid";
      } else {
        claimState = "live";
      }
    } catch (error) {
      claimState = "invalid";
      blockers.push(
        blocker(
          "invalid-claim-layout",
          pubkey,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return { task, claimState, claimPda };
}

async function validateInitiator(connection, pubkey, dispute, blockers) {
  const account = await connection.getAccountInfo(
    dispute.initiator,
    "confirmed",
  );
  if (!account || account.lamports === 0) {
    blockers.push(
      blocker("missing-dispute-initiator", pubkey, dispute.initiator.toBase58()),
    );
    return;
  }
  if (!account.owner.equals(PROGRAM_ID)) {
    blockers.push(
      blocker(
        "invalid-dispute-initiator-owner",
        pubkey,
        dispute.initiator.toBase58(),
      ),
    );
    return;
  }
  try {
    const initiator = decodeAgentBinding(account.data);
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), initiator.agentId],
      PROGRAM_ID,
    );
    if (
      !expected.equals(dispute.initiator) ||
      initiator.bump !== expectedBump ||
      !initiator.authority.equals(dispute.initiatorAuthority)
    ) {
      blockers.push(
        blocker(
          "invalid-dispute-initiator-binding",
          pubkey,
          `initiator=${dispute.initiator.toBase58()} ` +
            `stored_authority=${dispute.initiatorAuthority.toBase58()} ` +
            `agent_authority=${initiator.authority.toBase58()}`,
        ),
      );
    }
  } catch (error) {
    blockers.push(
      blocker(
        "invalid-dispute-initiator-layout",
        pubkey,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

export async function scanDisputes(
  connection,
  { nowUnixTimestamp } = {},
) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  let now = nowUnixTimestamp;
  if (now === undefined) {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    if (!Number.isSafeInteger(blockTime)) {
      throw new Error(
        `cannot obtain a safe confirmed block time for slot ${slot}`,
      );
    }
    now = BigInt(blockTime);
  } else {
    now = BigInt(now);
  }
  const blockers = [];
  const agentCount = await inspectAgentCounterCutover(connection, blockers);
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: DISPUTE_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });

  const statusCounts = { active: 0, resolved: 0, expired: 0, cancelled: 0 };
  let expiredLegacyInitiatorLiabilityCount = 0;
  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-dispute-owner", pubkey));
      continue;
    }
    let dispute;
    try {
      dispute = decodeDispute(account.data);
      const [expectedDispute, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), dispute.disputeId],
        PROGRAM_ID,
      );
      if (!expectedDispute.equals(pubkey) || expectedBump !== dispute.bump) {
        blockers.push(blocker("invalid-dispute-pda", pubkey));
        continue;
      }
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-dispute-layout",
          pubkey,
          error instanceof Error ? error.message : String(error),
        ),
      );
      continue;
    }

    const statusName = ["active", "resolved", "expired", "cancelled"][
      dispute.status
    ];
    statusCounts[statusName]++;
    if (
      dispute.totalVoters !== 0 &&
      dispute.totalVoters !== INITIATOR_OUTCOME_COUNTER_MARKER
    ) {
      blockers.push(
        blocker(
          "legacy-arbiter-voters",
          pubkey,
          `total_voters=${dispute.totalVoters}`,
        ),
      );
    }

    const active = dispute.status === STATUS_ACTIVE;
    if (
      (active && dispute.resolvedAt !== 0n) ||
      (!active && dispute.resolvedAt <= 0n)
    ) {
      blockers.push(
        blocker(
          "invalid-dispute-resolution-timestamp",
          pubkey,
          `status=${statusName} resolved_at=${dispute.resolvedAt}`,
        ),
      );
    }
    const possibleWorkerSlash = isResolvedUnappliedWorkerLoss(dispute);
    const initiatorLost =
      (dispute.status === STATUS_RESOLVED &&
        dispute.votesFor === 0n &&
        dispute.votesAgainst === 1n) ||
      dispute.status === 3;
    const terminal = !active;
    const counterTracked =
      dispute.totalVoters === INITIATOR_OUTCOME_COUNTER_MARKER;
    // Historical zero-marker records retain their deployed semantics. No-fault
    // outcomes were never finalizable; losses are actionable only during the
    // original seven-day window. The sentinel makes both categories safe after
    // cutover because neither owns a new counter unit. Every tagged terminal
    // outcome does own one and must finalize before another upgrade.
    const legacyLossWindowOpen =
      initiatorLost &&
      dispute.resolvedAt > 0n &&
      now <=
        dispute.resolvedAt + LEGACY_INITIATOR_SLASH_WINDOW_SECS;
    if (
      terminal &&
      !counterTracked &&
      initiatorLost &&
      !dispute.initiatorSlashApplied &&
      !legacyLossWindowOpen
    ) {
      expiredLegacyInitiatorLiabilityCount++;
    }
    const pendingInitiatorFinalization =
      terminal &&
      !dispute.initiatorSlashApplied &&
      (counterTracked || legacyLossWindowOpen);
    if (pendingInitiatorFinalization) {
      const blockerKind = counterTracked
        ? "tracked-initiator-outcome-unapplied"
        : "actionable-legacy-initiator-liability-unapplied";
      blockers.push(
        blocker(
          blockerKind,
          pubkey,
          `status=${statusName} initiator_lost=${initiatorLost} ` +
            `resolved_at=${dispute.resolvedAt}`,
        ),
      );
    }

    // Hard cutover invariant: ZERO Active disputes. Pause blocks new dispute
    // entry, but resolve_dispute remains an exit while paused and the clock keeps
    // advancing. Allowing even an in-window Active account would let the old
    // binary create a deferred slash after this snapshot without the revision-5
    // Task flag, or cross the changed expiry boundary during the .so upload.
    if (active) {
      blockers.push(
        blocker(
          "active-dispute-cutover",
          pubkey,
          `now=${now} voting_deadline=${dispute.votingDeadline} ` +
            `expires_at=${dispute.expiresAt}`,
        ),
      );
    }

    // The hardened binary deserializes the full 587-byte Dispute layout. An
    // Active 263-byte legacy account would lose both resolution and expiry exits
    // after deployment, regardless of the appended fields' zero defaults.
    if (active && dispute.legacyLayout) {
      blockers.push(
        blocker(
          "legacy-active-dispute-layout",
          pubkey,
          `account_size=${dispute.accountSize}; hardened Dispute requires ${DISPUTE_CURRENT_SIZE}`,
        ),
      );
    }

    if (active || pendingInitiatorFinalization) {
      await validateInitiator(connection, pubkey, dispute, blockers);
    }
    if (pendingInitiatorFinalization && dispute.legacyLayout) {
      blockers.push(
        blocker(
          "legacy-dispute-needs-initiator-finalizer",
          pubkey,
          `status=${statusName} resolved_at=${dispute.resolvedAt}`,
        ),
      );
    }

    if (!active && !possibleWorkerSlash) continue;

    const { task, claimState } = await inspectTaskAndClaim(
      connection,
      pubkey,
      dispute,
      blockers,
      { requireLiveClaim: active },
    );

    if (active && task && claimState === "live" && task.currentWorkers === 0) {
      blockers.push(
        blocker(
          "invalid-active-task-worker-state",
          pubkey,
          "active dispute has a live defendant claim but Task.current_workers=0",
        ),
      );
    }

    if (possibleWorkerSlash && task && claimState !== "invalid") {
      const claimLive = claimState === "live";
      const workerCountLive = task.currentWorkers > 0;

      // Old zero-monetary resolutions legitimately closed the claim and freed
      // the worker slot without setting slash_applied. Only the both-live pair is
      // a deferred worker finalizer; either one-sided pair is ambiguous/corrupt.
      if (claimLive !== workerCountLive) {
        blockers.push(
          blocker(
            "inconsistent-resolved-worker-state",
            pubkey,
            `claim=${claimState} Task.current_workers=${task.currentWorkers}`,
          ),
        );
      } else if (!claimLive) {
        if (task.workerSlashPending) {
          blockers.push(
            blocker(
              "stale-worker-slash-pending-flag",
              pubkey,
              "claim is absent and Task.current_workers=0 but Task._reserved[2]=1",
            ),
          );
        }
      } else if (dispute.legacyLayout) {
        blockers.push(
          blocker(
            "legacy-resolved-dispute-needs-finalizer",
            pubkey,
            `account_size=${dispute.accountSize}; live claim and Task.current_workers=${task.currentWorkers} require apply_dispute_slash`,
          ),
        );
      } else if (!task.workerSlashPending) {
        blockers.push(
          blocker(
            "legacy-worker-slash-flag-missing",
            pubkey,
            "live claim and worker slot require finalization but Task._reserved[2]=0",
          ),
        );
      }
    }
  }

  return {
    accountCount: accounts.length,
    agentCount,
    statusCounts,
    expiredLegacyInitiatorLiabilityCount,
    blockers,
    now,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet Dispute accounts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanDisputes(new Connection(rpcUrl, "confirmed"));
  console.log(
    `Agents: ${result.agentCount}; disputes: ${result.accountCount} (active=${result.statusCounts.active}, resolved=${result.statusCounts.resolved}, ` +
      `expired=${result.statusCounts.expired}, cancelled=${result.statusCounts.cancelled}, ` +
      `expired_legacy_initiator_liabilities=${result.expiredLegacyInitiatorLiabilityCount})`,
  );
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: dispute=${item.dispute.toBase58()}${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} dispute-liveness blocker(s) found; remediate before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: every agent liability counter is zero, zero disputes are Active, and no tagged or still-actionable legacy initiator outcome is unapplied.",
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
