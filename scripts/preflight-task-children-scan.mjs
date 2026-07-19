#!/usr/bin/env node
// Read-only inventory of every task-child account family used by the live program.
//
// Historical close_task deleted Task while callers could omit non-enumerable child
// PDAs. Revision 5 retains terminal Task accounts, but pre-existing orphans remain.
// This scanner validates each child's actual Borsh allocation, owner, discriminator,
// canonical PDA/bump, and live direct-parent binding. Most children bind to Task;
// TaskValidationVote binds to TaskSubmission. Missing-parent children with unsettled
// principal or active state are blockers. Known rent-only orphans are reported with
// aggregate lamports and stored payer/reclaim identities for a typed reclaim sweep.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  decodeAgentBinding,
  decodeTaskBinding,
  redactRpcText,
} from "./preflight-dispute-scan.mjs";
import { decodeTaskValidationConfig } from "./preflight-task-validation-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey, SystemProgram } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function exact(dataLike, name, size) {
  const data = Buffer.from(dataLike);
  if (data.length !== size) {
    throw new Error(`${name}: unexpected account size ${data.length}; expected ${size}`);
  }
  if (!data.subarray(0, 8).equals(discriminator(name))) {
    throw new Error(`${name}: discriminator mismatch`);
  }
  return data;
}

function pubkey(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function requireZeroBytes(data, start, end, field) {
  if (!data.subarray(start, end).equals(Buffer.alloc(end - start))) {
    throw new Error(`${field}: reserved bytes are nonzero`);
  }
}

function borshStringEnd(data, offset, maxLength, field) {
  if (offset + 4 > data.length) throw new Error(`${field}: truncated length`);
  const length = data.readUInt32LE(offset);
  if (length > maxLength) {
    throw new Error(`${field}: encoded length ${length} exceeds ${maxLength}`);
  }
  const end = offset + 4 + length;
  if (end > data.length) throw new Error(`${field}: truncated value`);
  return end;
}

function optionPubkeyEnd(data, offset, field) {
  const tag = data[offset];
  if (tag === 0) return offset + 1;
  if (tag === 1 && offset + 33 <= data.length) return offset + 33;
  throw new Error(`${field}: invalid/truncated Option tag ${tag}`);
}

// A PDA that has never been initialized may still carry donated lamports.
// Solana keeps that account system-owned with zero data, and the on-chain
// orphan-reclaim rail intentionally accepts it as absent so a one-lamport
// transfer cannot block cleanup. Mirror that exact liveness rule here.
function isAbsentProgramPda(account) {
  return !account || (
    account.owner.equals(SystemProgram.programId) &&
    account.executable !== true &&
    Buffer.from(account.data).length === 0
  );
}

function fixedFamily({
  name,
  size,
  seed,
  decode,
  parentKind = "task",
}) {
  return {
    name,
    parentKind,
    discriminator: discriminator(name),
    decode(dataLike) {
      return decode(exact(dataLike, name, size));
    },
    pdaSeeds(record) {
      return [[Buffer.from(seed), ...record.seedParts]];
    },
  };
}

const FAMILIES = [
  fixedFamily({
    name: "TaskClaim",
    size: 203,
    seed: "claim",
    decode: (data) => {
      // TaskClaim includes the 8-byte Anchor discriminator. The two booleans
      // follow result_data[64], at absolute offsets 192/193; reward_paid is
      // historical settlement accounting, not principal held by this PDA.
      const completed = data[192];
      const validated = data[193];
      if (completed > 1 || validated > 1) throw new Error("TaskClaim: invalid bool");
      const task = pubkey(data, 8);
      const worker = pubkey(data, 40);
      return {
        task,
        bump: data[202],
        seedParts: [task.toBuffer(), worker.toBuffer()],
        payer: worker,
        // The claim stores only the worker AgentRegistration. Direct claims are
        // authority-funded, while accept_bid claims are creator-funded, so the
        // original rent payer cannot be reconstructed after the Task is gone.
        payerField: "worker_agent (close recipient; original payer not stored)",
        active: completed === 0 || validated === 0,
        principal: 0n,
        state:
          `completed=${completed} validated=${validated} ` +
          `historical_reward_paid=${data.readBigUInt64LE(194)}`,
      };
    },
  }),
  {
    name: "TaskValidationConfig",
    discriminator: discriminator("TaskValidationConfig"),
    decode(dataLike) {
      const value = decodeTaskValidationConfig(dataLike);
      return {
        ...value,
        seedParts: [value.task.toBuffer()],
        payer: value.creator,
        payerField: "creator",
        active: value.pendingSubmissionCount > 0,
        principal: 0n,
        state: `mode=${value.mode} pending_submissions=${value.pendingSubmissionCount}`,
      };
    },
    pdaSeeds(record) {
      return [[Buffer.from("task_validation"), ...record.seedParts]];
    },
  },
  fixedFamily({
    name: "TaskAttestorConfig",
    size: 128,
    seed: "task_attestor",
    decode: (data) => {
      const task = pubkey(data, 8);
      const creator = pubkey(data, 40);
      requireZeroBytes(data, 121, 128, "TaskAttestorConfig");
      return {
        task,
        creator,
        bump: data[120],
        seedParts: [task.toBuffer()],
        payer: creator,
        payerField: "creator",
        active: false,
        principal: 0n,
        state: "config",
      };
    },
  }),
  fixedFamily({
    name: "TaskSubmission",
    size: 273,
    seed: "task_submission",
    decode: (data) => {
      const status = data[104];
      if (status > 3) throw new Error(`TaskSubmission.status: invalid ${status}`);
      if (status === 0) {
        throw new Error("TaskSubmission.status: initialized Idle account is not recoverable");
      }
      const task = pubkey(data, 8);
      const claim = pubkey(data, 40);
      const worker = pubkey(data, 72);
      // _reserved[0..2] are the live approval/rejection counters. The remaining
      // three bytes are still unallocated and must remain zero.
      requireZeroBytes(data, 270, 273, "TaskSubmission");
      return {
        task,
        worker,
        submittedAt: data.readBigInt64LE(203),
        bump: data[267],
        seedParts: [claim.toBuffer()],
        payer: worker,
        payerField: "worker_agent",
        active: status === 1,
        principal: 0n,
        state: `status=${status}`,
      };
    },
  }),
  fixedFamily({
    name: "TaskValidationVote",
    size: 121,
    seed: "task_validation_vote",
    parentKind: "submission",
    decode: (data) => {
      const approved = data[106];
      if (approved > 1) {
        throw new Error(`TaskValidationVote.approved: invalid bool ${approved}`);
      }
      requireZeroBytes(data, 116, 121, "TaskValidationVote");
      const submission = pubkey(data, 8);
      const reviewer = pubkey(data, 40);
      const reviewerAgent = pubkey(data, 72);
      const submissionRound = data.readUInt16LE(104);
      return {
        submission,
        reviewer,
        reviewerAgent,
        submissionRound,
        bump: data[115],
        seedParts: [submission.toBuffer(), reviewer.toBuffer()],
        payer: reviewer,
        payerField: "reviewer",
        active: false,
        principal: 0n,
        state:
          `round=${submissionRound} approved=${approved} ` +
          `voted_at=${data.readBigInt64LE(107)} ` +
          `reviewer_agent=${reviewerAgent.toBase58()}`,
      };
    },
  }),
  {
    name: "TaskJobSpec",
    discriminator: discriminator("TaskJobSpec"),
    decode(dataLike) {
      const data = exact(dataLike, "TaskJobSpec", 388);
      const task = pubkey(data, 8);
      const creator = pubkey(data, 40);
      const end = borshStringEnd(data, 104, 256, "TaskJobSpec.job_spec_uri");
      if (end + 24 > data.length) throw new Error("TaskJobSpec: truncated tail");
      // _reserved[0] is the canonical bid-lock bool; bytes [1..7] remain
      // unallocated. Treating all seven as padding would reject legitimate
      // job specs once a bidder has locked the content.
      if (data[end + 17] > 1) {
        throw new Error(`TaskJobSpec.bid_locked: invalid bool ${data[end + 17]}`);
      }
      requireZeroBytes(data, end + 18, end + 24, "TaskJobSpec");
      return {
        task,
        creator,
        bump: data[end + 16],
        seedParts: [task.toBuffer()],
        payer: creator,
        payerField: "creator",
        active: false,
        principal: 0n,
        state: "published",
      };
    },
    pdaSeeds(record) {
      return [[Buffer.from("task_job_spec"), ...record.seedParts]];
    },
  },
  {
    name: "TaskModeration",
    discriminator: discriminator("TaskModeration"),
    decode(dataLike) {
      const data = exact(dataLike, "TaskModeration", 234);
      const task = pubkey(data, 8);
      const creator = pubkey(data, 40);
      const hash = Buffer.from(data.subarray(72, 104));
      const moderator = pubkey(data, 194);
      if (data[104] > 5 || data[105] > 100) {
        throw new Error("TaskModeration: invalid status/risk score");
      }
      requireZeroBytes(data, 227, 234, "TaskModeration");
      return {
        task,
        creator,
        bump: data[226],
        seedParts: [],
        moderationPdaParts: [task.toBuffer(), hash, moderator.toBuffer()],
        // record_task_moderation uses the stored moderator as the rent payer and
        // close_task routes the refund back to this exact named recipient.
        payer: moderator,
        payerField: "moderator",
        active: false,
        principal: 0n,
        state: `status=${data[104]}`,
      };
    },
    pdaSeeds(record) {
      const [task, hash, moderator] = record.moderationPdaParts;
      return [
        [Buffer.from("task_moderation"), task, hash],
        [Buffer.from("task_moderation_v2"), task, hash, moderator],
      ];
    },
  },
  fixedFamily({
    name: "TaskEscrow",
    size: 58,
    seed: "escrow",
    decode: (data) => {
      const task = pubkey(data, 8);
      const amount = data.readBigUInt64LE(40);
      const distributed = data.readBigUInt64LE(48);
      const closed = data[56];
      if (closed > 1 || distributed > amount) {
        throw new Error("TaskEscrow: invalid closed/distribution state");
      }
      return {
        task,
        bump: data[57],
        seedParts: [task.toBuffer()],
        payer: null,
        payerField: "task.creator (parent required)",
        active: closed === 0,
        principal: amount - distributed,
        state: `closed=${closed} amount=${amount} distributed=${distributed}`,
      };
    },
  }),
  fixedFamily({
    name: "HireRecord",
    size: 173,
    seed: "hire",
    decode: (data) => {
      const task = pubkey(data, 8);
      const designatedProvider = pubkey(data, 107);
      return {
        task,
        designatedProvider,
        bump: data[106],
        seedParts: [task.toBuffer()],
        payer: null,
        payerField: "task.creator (parent required)",
        active: true,
        principal: 0n,
        state:
          `listing=${pubkey(data, 40).toBase58()} ` +
          `designated_provider=${designatedProvider.toBase58()} open-job link`,
      };
    },
  }),
  {
    name: "CompletionBond",
    discriminator: discriminator("CompletionBond"),
    decode(dataLike) {
      const data = exact(dataLike, "CompletionBond", 139);
      const task = pubkey(data, 8);
      const party = pubkey(data, 40);
      if (data[72] > 1) throw new Error(`CompletionBond.role: invalid ${data[72]}`);
      const amount = data.readBigUInt64LE(73);
      const mintEnd = optionPubkeyEnd(data, 81, "CompletionBond.bond_mint");
      if (mintEnd + 25 > data.length) throw new Error("CompletionBond: truncated tail");
      requireZeroBytes(data, mintEnd + 9, mintEnd + 25, "CompletionBond");
      return {
        task,
        bump: data[mintEnd + 8],
        seedParts: [task.toBuffer(), party.toBuffer()],
        payer: party,
        payerField: "party",
        active: amount > 0n,
        principal: amount,
        state: `role=${data[72]} amount=${amount}`,
      };
    },
    pdaSeeds(record) {
      return [[Buffer.from("completion_bond"), ...record.seedParts]];
    },
  },
  {
    name: "TaskBidBook",
    discriminator: discriminator("TaskBidBook"),
    decode(dataLike) {
      const data = exact(dataLike, "TaskBidBook", 114);
      const task = pubkey(data, 8);
      const state = data[40];
      if (state > 2 || data[41] > 2) throw new Error("TaskBidBook: invalid enum");
      const optionEnd = optionPubkeyEnd(data, 50, "TaskBidBook.accepted_bid");
      if (optionEnd + 31 > data.length) throw new Error("TaskBidBook: truncated tail");
      const activeBids = data.readUInt16LE(optionEnd + 12);
      return {
        task,
        bump: data[optionEnd + 30],
        seedParts: [task.toBuffer()],
        payer: null,
        payerField: "task.creator (parent required)",
        active: state !== 2 || activeBids > 0,
        principal: 0n,
        state: `state=${state} active_bids=${activeBids}`,
      };
    },
    pdaSeeds(record) {
      return [[Buffer.from("bid_book"), ...record.seedParts]];
    },
  },
  fixedFamily({
    name: "TaskBid",
    size: 252,
    seed: "bid",
    decode: (data) => {
      const task = pubkey(data, 8);
      const bidder = pubkey(data, 72);
      const bidderAuthority = pubkey(data, 104);
      const state = data[240];
      if (state > 2) throw new Error(`TaskBid.state: invalid ${state}`);
      const bond = data.readBigUInt64LE(241);
      const acceptedNoShowSlashBps = data.readUInt16LE(250);
      if (acceptedNoShowSlashBps > 10_000) {
        throw new Error(
          `TaskBid.accepted_no_show_slash_bps: invalid ${acceptedNoShowSlashBps}`,
        );
      }
      return {
        task,
        bump: data[249],
        seedParts: [task.toBuffer(), bidder.toBuffer()],
        payer: bidderAuthority,
        payerField: "bidder_authority",
        active: true,
        principal: bond,
        state:
          `state=${state} bond_lamports=${bond} ` +
          `accepted_no_show_slash_bps=${acceptedNoShowSlashBps}`,
      };
    },
  }),
];

const TASK_SUBMISSION_FAMILY = FAMILIES.find(
  (family) => family.name === "TaskSubmission",
);

function canonicalPda(family, record, address) {
  for (const seeds of family.pdaSeeds(record)) {
    const [expected, bump] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
    if (expected.equals(address) && bump === record.bump) return true;
  }
  return false;
}

export function classifyTaskChildOrphan(record) {
  return record.active || record.principal > 0n
    ? "active-or-principal"
    : "rent-only";
}

export async function scanTaskChildren(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const blockers = [];
  const decoded = [];
  const families = {};
  for (const family of FAMILIES) {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: family.discriminator.toString("base64"),
            encoding: "base64",
          },
        },
      ],
    });
    families[family.name] = {
      accountCount: accounts.length,
      orphanCount: 0,
      rentOnlyOrphanCount: 0,
      blockingOrphanCount: 0,
      recoverableWorkerIdentityCount: 0,
      treasuryRecoveryIdentityCount: 0,
      unavailableWorkerIdentityCount: 0,
      orphanLamports: 0n,
      orphans: [],
    };
    for (const { pubkey: address, account } of accounts) {
      if (!account.owner.equals(PROGRAM_ID)) {
        blockers.push({ kind: "invalid-child-owner", family: family.name, address });
        continue;
      }
      try {
        const record = family.decode(account.data);
        if (!canonicalPda(family, record, address)) {
          blockers.push({ kind: "invalid-child-pda", family: family.name, address });
          continue;
        }
        decoded.push({
          family,
          address,
          lamports: BigInt(account.lamports),
          record,
        });
      } catch (error) {
        blockers.push({
          kind: "invalid-child-layout",
          family: family.name,
          address,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const taskBoundChildren = decoded.filter(
    ({ family }) => family.parentKind !== "submission",
  );
  const submissionBoundChildren = decoded.filter(
    ({ family }) => family.parentKind === "submission",
  );
  const uniqueTasks = [...new Map(
    taskBoundChildren.map(({ record }) => [record.task.toBase58(), record.task]),
  ).values()];
  const taskStates = new Map();
  for (let offset = 0; offset < uniqueTasks.length; offset += 100) {
    const chunk = uniqueTasks.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    for (let index = 0; index < chunk.length; index++) {
      const address = chunk[index];
      const account = infos[index];
      if (isAbsentProgramPda(account)) {
        taskStates.set(address.toBase58(), { kind: "missing" });
        continue;
      }
      if (account.lamports === 0) {
        taskStates.set(address.toBase58(), {
          kind: "invalid",
          detail: "non-absent account has zero lamports",
        });
        continue;
      }
      if (!account.owner.equals(PROGRAM_ID)) {
        taskStates.set(address.toBase58(), { kind: "invalid", detail: "owner" });
        continue;
      }
      try {
        const task = decodeTaskBinding(account.data);
        const [expected, expectedBump] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
          PROGRAM_ID,
        );
        if (!expected.equals(address) || task.bump !== expectedBump) {
          throw new Error("canonical PDA/bump mismatch");
        }
        taskStates.set(address.toBase58(), { kind: "live", task });
      } catch (error) {
        taskStates.set(address.toBase58(), {
          kind: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const uniqueSubmissions = [...new Map(
    submissionBoundChildren.map(({ record }) => [
      record.submission.toBase58(),
      record.submission,
    ]),
  ).values()];
  const submissionStates = new Map();
  for (let offset = 0; offset < uniqueSubmissions.length; offset += 100) {
    const chunk = uniqueSubmissions.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    for (let index = 0; index < chunk.length; index++) {
      const address = chunk[index];
      const account = infos[index];
      if (isAbsentProgramPda(account)) {
        submissionStates.set(address.toBase58(), { kind: "missing" });
        continue;
      }
      if (account.lamports === 0) {
        submissionStates.set(address.toBase58(), {
          kind: "invalid",
          detail: "non-absent account has zero lamports",
        });
        continue;
      }
      if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
        submissionStates.set(address.toBase58(), {
          kind: "invalid",
          detail:
            `owner=${account.owner.toBase58()} ` +
            `executable=${account.executable === true}`,
        });
        continue;
      }
      try {
        const submission = TASK_SUBMISSION_FAMILY.decode(account.data);
        if (!canonicalPda(TASK_SUBMISSION_FAMILY, submission, address)) {
          throw new Error("canonical TaskSubmission PDA/bump mismatch");
        }
        submissionStates.set(address.toBase58(), { kind: "live", submission });
      } catch (error) {
        submissionStates.set(address.toBase58(), {
          kind: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (const item of taskBoundChildren) {
    const state = taskStates.get(item.record.task.toBase58());
    if (!state || state.kind === "invalid") {
      blockers.push({
        kind: "invalid-child-task-binding",
        family: item.family.name,
        address: item.address,
        task: item.record.task,
        detail: state?.detail ?? "task lookup missing",
      });
      continue;
    }
    if (state.kind === "live") {
      if (
        item.record.creator &&
        !item.record.creator.equals(state.task.creator)
      ) {
        blockers.push({
          kind: "invalid-child-creator-binding",
          family: item.family.name,
          address: item.address,
          task: item.record.task,
        });
      }
      continue;
    }

    const risk = classifyTaskChildOrphan(item.record);
    const summary = families[item.family.name];
    const orphan = {
      address: item.address,
      task: item.record.task,
      lamports: item.lamports,
      payer: item.record.payer,
      payerField: item.record.payerField,
      worker: item.record.worker,
      submittedAt: item.record.submittedAt,
      state: item.record.state,
      risk,
    };
    summary.orphanCount++;
    summary.orphanLamports += item.lamports;
    summary.orphans.push(orphan);
    if (risk === "rent-only") {
      summary.rentOnlyOrphanCount++;
    } else {
      summary.blockingOrphanCount++;
      blockers.push({
        kind: "orphaned-active-or-principal-child",
        family: item.family.name,
        address: item.address,
        task: item.record.task,
        detail: `${item.record.state} principal=${item.record.principal}`,
      });
    }
  }

  for (const item of submissionBoundChildren) {
    const state = submissionStates.get(item.record.submission.toBase58());
    if (!state || state.kind === "invalid") {
      blockers.push({
        kind: "invalid-child-submission-binding",
        family: item.family.name,
        address: item.address,
        submission: item.record.submission,
        detail: state?.detail ?? "submission lookup missing",
      });
      continue;
    }
    if (state.kind === "live") continue;

    const risk = classifyTaskChildOrphan(item.record);
    const summary = families[item.family.name];
    const orphan = {
      address: item.address,
      submission: item.record.submission,
      lamports: item.lamports,
      payer: item.record.payer,
      payerField: item.record.payerField,
      state: item.record.state,
      risk,
    };
    summary.orphanCount++;
    summary.orphanLamports += item.lamports;
    summary.orphans.push(orphan);
    if (risk === "rent-only") {
      summary.rentOnlyOrphanCount++;
    } else {
      summary.blockingOrphanCount++;
      blockers.push({
        kind: "orphaned-active-or-principal-child",
        family: item.family.name,
        address: item.address,
        submission: item.record.submission,
        detail: `${item.record.state} principal=${item.record.principal}`,
      });
    }
  }

  // ReclaimOrphanTaskChild routes terminal TaskSubmission rent to the authority
  // stored in its worker AgentRegistration. The parent is already absent, so
  // prove whether that durable identity is continuous. A continuous identity
  // returns rent to the stored authority; a closed/dusted or discontinuous clone
  // is still recoverable through the candidate's canonical treasury suffix. Both
  // are inventory (no protocol principal remains), not upgrade blockers.
  const submissionSummary = families.TaskSubmission;
  const terminalSubmissionOrphans = submissionSummary.orphans.filter(
    (orphan) => orphan.risk === "rent-only",
  );
  for (let offset = 0; offset < terminalSubmissionOrphans.length; offset += 100) {
    const chunk = terminalSubmissionOrphans.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(
      chunk.map((orphan) => orphan.worker),
      "confirmed",
    );
    for (let index = 0; index < chunk.length; index++) {
      const orphan = chunk[index];
      const account = infos[index];
      let treasuryRecoveryReason = null;
      let invalidIdentityReason = null;
      if (isAbsentProgramPda(account)) {
        treasuryRecoveryReason = "worker AgentRegistration is absent/system-owned empty";
      } else if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
        invalidIdentityReason =
          `worker owner=${account.owner.toBase58()} executable=${account.executable === true}`;
      } else {
        try {
          const worker = decodeAgentBinding(account.data);
          const [expected, bump] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), worker.agentId],
            PROGRAM_ID,
          );
          if (!expected.equals(orphan.worker) || worker.bump !== bump) {
            throw new Error("canonical AgentRegistration PDA/bump mismatch");
          }
          if (worker.authority.equals(PublicKey.default)) {
            throw new Error("worker authority is default");
          }
          // Revision 4 could close and re-create an AgentRegistration at the
          // same PDA. Only a registration that strictly predates the submission
          // is identity-continuous; equality is deliberately discontinuous for
          // same-second bundle ambiguity. Closed/cloned identities use the
          // candidate program's canonical treasury fallback.
          if (worker.registeredAt < orphan.submittedAt) {
            orphan.recovery = "recoverable-worker-identity";
            orphan.workerIdentityRetired = worker.retired;
            orphan.workerStatus = worker.status;
            orphan.payer = worker.authority;
            orphan.payerField = "worker_agent.authority";
            submissionSummary.recoverableWorkerIdentityCount++;
          } else {
            treasuryRecoveryReason =
              `worker identity is discontinuous: registered_at=${worker.registeredAt} ` +
              `submitted_at=${orphan.submittedAt}`;
          }
        } catch (error) {
          invalidIdentityReason = error instanceof Error ? error.message : String(error);
        }
      }
      if (treasuryRecoveryReason) {
        orphan.recovery = "recoverable-protocol-treasury";
        orphan.recoveryDetail = treasuryRecoveryReason;
        orphan.payer = null;
        orphan.payerField = "protocol_config.treasury";
        submissionSummary.treasuryRecoveryIdentityCount++;
      } else if (invalidIdentityReason) {
        orphan.recovery = "unavailable-invalid-worker-identity";
        orphan.recoveryDetail = invalidIdentityReason;
        submissionSummary.unavailableWorkerIdentityCount++;
        blockers.push({
          kind: "invalid-orphan-submission-worker-identity",
          family: "TaskSubmission",
          address: orphan.address,
          task: orphan.task,
          detail: invalidIdentityReason,
        });
      }
    }
  }

  const orphanCount = Object.values(families)
    .reduce((sum, value) => sum + value.orphanCount, 0);
  const rentOnlyOrphanCount = Object.values(families)
    .reduce((sum, value) => sum + value.rentOnlyOrphanCount, 0);
  const orphanLamports = Object.values(families)
    .reduce((sum, value) => sum + value.orphanLamports, 0n);
  const liveCompletionBonds = decoded.filter(
    ({ family, record }) =>
      family.name === "CompletionBond" && record.principal > 0n,
  );
  return {
    accountCount: decoded.length,
    orphanCount,
    rentOnlyOrphanCount,
    orphanLamports,
    orphanSubmissionRecoverableCount:
      submissionSummary.recoverableWorkerIdentityCount,
    orphanSubmissionTreasuryRecoveryCount:
      submissionSummary.treasuryRecoveryIdentityCount,
    orphanSubmissionUnavailableIdentityCount:
      submissionSummary.unavailableWorkerIdentityCount,
    liveCompletionBondCount: liveCompletionBonds.length,
    liveCompletionBondPrincipal: liveCompletionBonds.reduce(
      (sum, { record }) => sum + record.principal,
      0n,
    ),
    families,
    blockers,
  };
}

function formatPayer(orphan) {
  return orphan.payer
    ? `${orphan.payerField}=${orphan.payer.toBase58()}`
    : orphan.payerField;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet task-child accounts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanTaskChildren(new Connection(rpcUrl, "confirmed"));
  console.log(
    `Task children: decoded=${result.accountCount} orphans=${result.orphanCount} ` +
      `rent_only=${result.rentOnlyOrphanCount} orphan_lamports=${result.orphanLamports} ` +
      `submission_recoverable=${result.orphanSubmissionRecoverableCount} ` +
      `submission_treasury_recovery=${result.orphanSubmissionTreasuryRecoveryCount} ` +
      `submission_identity_unavailable=${result.orphanSubmissionUnavailableIdentityCount} ` +
      `live_completion_bonds=${result.liveCompletionBondCount} ` +
      `live_completion_bond_principal=${result.liveCompletionBondPrincipal}`,
  );
  for (const [name, value] of Object.entries(result.families)) {
    console.log(
      `  ${name}: accounts=${value.accountCount} orphans=${value.orphanCount} ` +
        `rent_only=${value.rentOnlyOrphanCount} blocking=${value.blockingOrphanCount} ` +
        `lamports=${value.orphanLamports}`,
    );
    for (const orphan of value.orphans.slice(0, 5)) {
      const parent = orphan.task
        ? `task=${orphan.task.toBase58()}`
        : `submission=${orphan.submission.toBase58()}`;
      console.log(
        `    ORPHAN ${orphan.risk}: address=${orphan.address.toBase58()} ` +
          `${parent} lamports=${orphan.lamports} ` +
          `${formatPayer(orphan)} state=${orphan.state}` +
          `${orphan.recovery ? ` recovery=${orphan.recovery}` : ""}` +
          `${orphan.recoveryDetail ? ` recovery_detail=${orphan.recoveryDetail}` : ""}`,
      );
    }
    if (value.orphans.length > 5) {
      console.log(`    ... ${value.orphans.length - 5} additional orphan(s)`);
    }
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: family=${item.family} address=${item.address.toBase58()}` +
        `${item.task ? ` task=${item.task.toBase58()}` : ""}` +
        `${item.submission ? ` submission=${item.submission.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} task-child blocker(s) found; remediate active/principal or malformed state before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: no task-child orphan carries active state or principal; rent-only orphan inventory remains explicit for typed reclamation.",
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
