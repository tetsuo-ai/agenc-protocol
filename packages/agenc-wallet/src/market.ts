// Chain-facing marketplace steps for the buyer side: read a listing, resolve
// the moderation gate, hire, activate, review, cancel, tidy up.
//
// Every function here is a single idempotent step. It reads the chain first,
// does nothing if the step already happened, and otherwise sends exactly one
// transaction through the public SDK client. The caller (the wallet) journals
// intent before and outcome after, which is what makes the whole purchase
// resumable after a crash without ever paying twice: a task address is fixed
// by (buyer, random task id), and the program creates it at most once.
import { type Address, type KeyPairSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  facade,
  findAgentPda,
  findClaimPda,
  findCreateTaskHumanlessAuthorityRateLimitPda,
  findCreatorCompletionBondPda,
  findHireRatingPda,
  findHireRecordPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskJobSpecPda,
  findTaskModerationPda,
  findTaskPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findWorkerCompletionBondPda,
  getAgentRegistrationDecoder,
  getAgentRegistrationDiscriminatorBytes,
  getAuthorityRateLimitSize,
  getHireRecordDecoder,
  getHireRecordDiscriminatorBytes,
  getHireRecordSize,
  getListingModerationDecoder,
  getListingModerationDiscriminatorBytes,
  getModerationAttestorDecoder,
  getModerationAttestorDiscriminatorBytes,
  getModerationConfigDecoder,
  getModerationConfigDiscriminatorBytes,
  getProtocolConfigDecoder,
  getProtocolConfigDiscriminatorBytes,
  getServiceListingDecoder,
  getServiceListingDiscriminatorBytes,
  getTaskDecoder,
  getTaskDiscriminatorBytes,
  getTaskEscrowSize,
  getTaskJobSpecDecoder,
  getTaskJobSpecDiscriminatorBytes,
  getTaskModerationDecoder,
  getTaskModerationDiscriminatorBytes,
  getTaskSubmissionDecoder,
  getTaskSubmissionDiscriminatorBytes,
  getTaskValidationConfigDiscriminatorBytes,
  getTaskValidationConfigSize,
  SubmissionStatus,
  TaskStatus,
  values,
  type AgentRegistration,
  type HireRecord,
  type ProtocolConfig,
  type ServiceListing,
  type Task,
  type TaskSubmission,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import { SYSTEM_PROGRAM_ADDRESS } from "./chain.js";
import { WalletError } from "./errors.js";
import type { MarketServices } from "./services.js";
import type { ChainTaskStatus } from "./store.js";

/** Program account sizes the hire path allocates (bytes). */
export const TASK_ACCOUNT_SPACE = 466;
export const TASK_JOB_SPEC_SPACE = 388;
/** Size of the permanent record a rating creates (measured: 439 bytes). */
export const HIRE_RATING_SPACE = 439;

/** Lamports kept aside for the network fees of one purchase, start to tidy. */
export const FEE_HEADROOM_LAMPORTS = 200_000n;

/** How long the buyer has to look at a delivery before it pays by itself. */
export const DEFAULT_REVIEW_WINDOW_SECS = 24n * 60n * 60n;

const LISTING_STATE_ACTIVE = 0;
const MODERATION_STATUS_CLEAN = 0;
const MODERATION_STATUS_HUMAN_APPROVED = 4;

function startsWith(data: Uint8Array, prefix: ArrayLike<number>): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Read and decode one program account. Returns null when the account is
 * absent, owned by another program, closed (tombstoned) or of another type.
 */
async function readProgramAccount<T>(
  chain: Chain,
  account: Address,
  discriminator: ArrayLike<number>,
  decode: (data: Uint8Array) => T,
): Promise<T | null> {
  const info = await chain.readAccountInfo(account);
  if (info === null) return null;
  if (info.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  if (!startsWith(info.data, discriminator)) return null;
  try {
    return decode(info.data);
  } catch {
    return null;
  }
}

export async function readListing(chain: Chain, listing: Address): Promise<ServiceListing | null> {
  return readProgramAccount(chain, listing, getServiceListingDiscriminatorBytes(), (data) =>
    getServiceListingDecoder().decode(data),
  );
}

export async function readTask(chain: Chain, task: Address): Promise<Task | null> {
  return readProgramAccount(chain, task, getTaskDiscriminatorBytes(), (data) =>
    getTaskDecoder().decode(data),
  );
}

export async function readAgent(
  chain: Chain,
  agent: Address,
): Promise<AgentRegistration | null> {
  return readProgramAccount(chain, agent, getAgentRegistrationDiscriminatorBytes(), (data) =>
    getAgentRegistrationDecoder().decode(data),
  );
}

async function readHireRecord(chain: Chain, task: Address): Promise<HireRecord | null> {
  const [pda] = await findHireRecordPda({ task });
  return readProgramAccount(chain, pda, getHireRecordDiscriminatorBytes(), (data) =>
    getHireRecordDecoder().decode(data),
  );
}

export async function readProtocolConfig(chain: Chain): Promise<ProtocolConfig> {
  const [pda] = await findProtocolConfigPda();
  const config = await readProgramAccount(chain, pda, getProtocolConfigDiscriminatorBytes(), (data) =>
    getProtocolConfigDecoder().decode(data),
  );
  if (config === null) {
    throw new WalletError("NETWORK", "The marketplace is not available on this network.");
  }
  return config;
}

function isDefaultAddress(value: Address): boolean {
  return value === SYSTEM_PROGRAM_ADDRESS;
}

function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Listing terms as a buyer needs them, read fresh from the chain. */
export interface ListingTerms {
  listing: Address;
  providerAgent: Address;
  name: string;
  category: string | null;
  priceLamports: bigint;
  version: bigint;
  specHash: Uint8Array;
  deliverySecs: number | null;
  ratingCount: number;
}

/**
 * Read a listing and refuse anything a buyer cannot hire: paused or closed,
 * priced in a token, or at capacity.
 */
export async function readHireableListing(chain: Chain, listing: Address): Promise<ListingTerms> {
  const account = await readListing(chain, listing);
  if (account === null) {
    throw new WalletError("NOT_FOUND", "That service does not exist.");
  }
  if (Number(account.state) !== LISTING_STATE_ACTIVE) {
    throw new WalletError("NOT_AVAILABLE", "That service is not taking jobs right now.");
  }
  if (account.priceMint.__option === "Some") {
    throw new WalletError("NOT_AVAILABLE", "That service is priced in a token this wallet does not pay with yet.");
  }
  if (account.maxOpenJobs > 0 && account.openJobs >= account.maxOpenJobs) {
    throw new WalletError("NOT_AVAILABLE", "That service is busy right now. Try again later.");
  }
  let name = "Service";
  let category: string | null = null;
  try {
    name = values.decodeListingName(new Uint8Array(account.name)) || name;
  } catch {
    // Keep the placeholder name for a listing with non-text name bytes.
  }
  try {
    category = values.decodeListingCategory(new Uint8Array(account.category)) || null;
  } catch {
    category = null;
  }
  return {
    listing,
    providerAgent: account.providerAgent,
    name,
    category,
    priceLamports: account.price,
    version: account.version,
    specHash: new Uint8Array(account.specHash),
    deliverySecs: account.defaultDeadlineSecs > 0n ? Number(account.defaultDeadlineSecs) : null,
    ratingCount: account.ratingCount,
  };
}

/** Which attestation a gated instruction consumes, and how to point at it. */
export interface GateAccounts {
  moderator: Address;
  /** Set only for a pre-upgrade record at the frozen legacy address. */
  record?: Address;
  /** True when `moderator` is a roster attestor rather than the authority. */
  moderatorIsAttestor: boolean;
}

interface ModerationRoot {
  authority: Address;
  enabled: boolean;
}

async function readModerationRoot(chain: Chain): Promise<ModerationRoot> {
  const [pda] = await findModerationConfigPda();
  const config = await readProgramAccount(chain, pda, getModerationConfigDiscriminatorBytes(), (data) =>
    getModerationConfigDecoder().decode(data),
  );
  if (config === null) {
    throw new WalletError("NETWORK", "The marketplace is not available on this network.");
  }
  return { authority: config.moderationAuthority, enabled: config.enabled };
}

/** A roster attestor counts only while registered and not exiting. */
async function isLiveAttestor(chain: Chain, moderator: Address): Promise<boolean> {
  const [pda] = await findModerationAttestorPda({ attestor: moderator });
  const entry = await readProgramAccount(chain, pda, getModerationAttestorDiscriminatorBytes(), (data) =>
    getModerationAttestorDecoder().decode(data),
  );
  return entry !== null && entry.attestor === moderator && entry.exitAt === 0n;
}

function recordIsUsable(
  record: { status: number; riskScore: number; expiresAt: bigint },
  nowSecs: number,
): boolean {
  return (
    (record.status === MODERATION_STATUS_CLEAN ||
      record.status === MODERATION_STATUS_HUMAN_APPROVED) &&
    record.riskScore <= 100 &&
    (record.expiresAt === 0n || record.expiresAt >= BigInt(nowSecs))
  );
}

async function candidateModerators(
  chain: Chain,
  services: MarketServices,
): Promise<{ root: ModerationRoot; candidates: Address[] }> {
  const root = await readModerationRoot(chain);
  const trusted = await services.trustedModerators();
  const candidates = [root.authority, ...trusted.filter((entry) => entry !== root.authority)];
  return { root, candidates };
}

/**
 * Find an attestation for `(listing, specHash)` signed by someone this wallet
 * accepts, mirroring the checks the hire instruction makes. Returns null when
 * there is none.
 */
export async function findListingGate(
  chain: Chain,
  services: MarketServices,
  terms: Pick<ListingTerms, "listing" | "specHash" | "providerAgent">,
): Promise<GateAccounts | null> {
  const { root, candidates } = await candidateModerators(chain, services);
  if (!root.enabled) return { moderator: root.authority, moderatorIsAttestor: false };
  const nowSecs = await chain.clusterTime();
  for (const moderator of candidates) {
    const isAuthority = moderator === root.authority;
    if (!isAuthority && !(await isLiveAttestor(chain, moderator))) continue;
    const usable = (record: ReturnType<ReturnType<typeof getListingModerationDecoder>["decode"]>) =>
      recordIsUsable(record, nowSecs) &&
      record.listing === terms.listing &&
      record.providerAgent === terms.providerAgent &&
      record.moderator === moderator &&
      bytesEqual(record.jobSpecHash, terms.specHash);
    const [current] = await findListingModerationPda({
      listing: terms.listing,
      jobSpecHash: terms.specHash,
      moderator,
    });
    const decode = (data: Uint8Array) => getListingModerationDecoder().decode(data);
    const record = await readProgramAccount(
      chain,
      current,
      getListingModerationDiscriminatorBytes(),
      decode,
    );
    if (record !== null && usable(record)) {
      return { moderator, moderatorIsAttestor: !isAuthority };
    }
    const [legacy] = await facade.findLegacyListingModerationPda({
      listing: terms.listing,
      jobSpecHash: terms.specHash,
    });
    const old = await readProgramAccount(
      chain,
      legacy,
      getListingModerationDiscriminatorBytes(),
      decode,
    );
    if (old !== null && usable(old)) {
      return { moderator, record: legacy, moderatorIsAttestor: !isAuthority };
    }
  }
  return null;
}

/** Same as {@link findListingGate}, for a hired task's job spec. */
export async function findTaskGate(
  chain: Chain,
  services: MarketServices,
  input: { task: Address; creator: Address; jobSpecHash: Uint8Array },
): Promise<GateAccounts | null> {
  const { root, candidates } = await candidateModerators(chain, services);
  const nowSecs = await chain.clusterTime();
  for (const moderator of candidates) {
    const isAuthority = moderator === root.authority;
    if (!isAuthority && !(await isLiveAttestor(chain, moderator))) continue;
    const usable = (record: ReturnType<ReturnType<typeof getTaskModerationDecoder>["decode"]>) =>
      recordIsUsable(record, nowSecs) &&
      record.task === input.task &&
      record.creator === input.creator &&
      record.moderator === moderator &&
      bytesEqual(record.jobSpecHash, input.jobSpecHash);
    const decode = (data: Uint8Array) => getTaskModerationDecoder().decode(data);
    const [current] = await findTaskModerationPda({
      task: input.task,
      jobSpecHash: input.jobSpecHash,
      moderator,
    });
    const record = await readProgramAccount(
      chain,
      current,
      getTaskModerationDiscriminatorBytes(),
      decode,
    );
    if (record !== null && usable(record)) {
      return { moderator, moderatorIsAttestor: !isAuthority };
    }
    const [legacy] = await facade.findLegacyTaskModerationPda({
      task: input.task,
      jobSpecHash: input.jobSpecHash,
    });
    const old = await readProgramAccount(
      chain,
      legacy,
      getTaskModerationDiscriminatorBytes(),
      decode,
    );
    if (old !== null && usable(old)) {
      return { moderator, record: legacy, moderatorIsAttestor: !isAuthority };
    }
  }
  return null;
}

/**
 * Lamports a purchase sets aside on top of the price: the deposits behind the
 * accounts it creates, plus fee headroom. Most deposits return when the
 * finished job is tidied; the task record's own deposit does not.
 */
export async function purchaseDeposits(
  chain: Chain,
  buyer: Address,
): Promise<{ total: bigint; kept: bigint }> {
  const rent = (space: number) => chain.getMinimumBalanceForRentExemption(space);
  const [taskRent, escrowRent, hireRent, validationRent, jobSpecRent] = await Promise.all([
    rent(TASK_ACCOUNT_SPACE),
    rent(getTaskEscrowSize()),
    rent(getHireRecordSize()),
    rent(getTaskValidationConfigSize()),
    rent(TASK_JOB_SPEC_SPACE),
  ]);
  let total = taskRent + escrowRent + hireRent + validationRent + jobSpecRent + FEE_HEADROOM_LAMPORTS;
  let kept = taskRent;
  const [rateLimit] = await findCreateTaskHumanlessAuthorityRateLimitPda({ creator: buyer });
  if ((await chain.readAccountInfo(rateLimit)) === null) {
    const once = await rent(getAuthorityRateLimitSize());
    total += once;
    kept += once;
  }
  return { total, kept };
}

/** The task address a purchase will create. */
export async function taskAddressFor(buyer: Address, taskId: Uint8Array): Promise<Address> {
  const [task] = await findTaskPda({ creator: buyer, taskId });
  return task;
}

function gateArgs(gate: GateAccounts): { moderator: Address; moderatorIsAttestor?: true } {
  return gate.moderatorIsAttestor
    ? { moderator: gate.moderator, moderatorIsAttestor: true }
    : { moderator: gate.moderator };
}

export interface HireIntent {
  listing: Address;
  providerAgent: Address;
  taskId: Uint8Array;
  jobSpecHash: Uint8Array;
  priceLamports: bigint;
  listingVersion: bigint;
  listingSpecHash: Uint8Array;
  reviewWindowSecs: bigint;
}

/** Send the hire: creates the task and puts the price in escrow. */
export async function sendHire(
  chain: Chain,
  buyer: KeyPairSigner,
  intent: HireIntent,
  gate: GateAccounts,
): Promise<string> {
  const client = chain.clientFor(buyer);
  const result = await client.hireFromListingHumanless({
    creator: buyer,
    listing: intent.listing,
    providerAgent: intent.providerAgent,
    taskId: intent.taskId,
    taskJobSpecHash: intent.jobSpecHash,
    expectedPrice: intent.priceLamports,
    expectedVersion: intent.listingVersion,
    reviewWindowSecs: intent.reviewWindowSecs,
    listingSpecHash: intent.listingSpecHash,
    ...gateArgs(gate),
    ...(gate.record !== undefined ? { listingModeration: gate.record } : {}),
  });
  return result.signature;
}

/**
 * True when the task at the journaled address is exactly the purchase that
 * was intended: created by this buyer, for this listing, price and job spec.
 */
export async function hireLanded(
  chain: Chain,
  buyer: Address,
  task: Address,
  intent: Pick<HireIntent, "listing" | "priceLamports" | "jobSpecHash">,
): Promise<boolean> {
  const account = await readTask(chain, task);
  if (account === null) return false;
  if (account.creator !== buyer || account.rewardAmount !== intent.priceLamports) {
    throw new WalletError("INTERNAL", "A job on the marketplace does not match the wallet's records.");
  }
  const hire = await readHireRecord(chain, task);
  if (hire !== null && hire.listing !== intent.listing) {
    throw new WalletError("INTERNAL", "A job on the marketplace does not match the wallet's records.");
  }
  // A hired task carries its job-spec commitment in the second half of the
  // 64-byte description field.
  const description = new Uint8Array(account.description);
  if (description.length === 64 && !bytesEqual(description.subarray(32), intent.jobSpecHash)) {
    throw new WalletError("INTERNAL", "A job on the marketplace does not match the wallet's records.");
  }
  return true;
}

/** True once the job spec is pinned and providers can start. */
export async function isActivated(chain: Chain, task: Address): Promise<boolean> {
  const [pda] = await findTaskJobSpecPda({ task });
  const spec = await readProgramAccount(chain, pda, getTaskJobSpecDiscriminatorBytes(), (data) =>
    getTaskJobSpecDecoder().decode(data),
  );
  return spec !== null && spec.jobSpecUri.trim().length > 0;
}

/** Pin the attested job spec so providers can read it and start. */
export async function sendActivation(
  chain: Chain,
  buyer: KeyPairSigner,
  input: { task: Address; jobSpecHash: Uint8Array; jobSpecUri: string },
  gate: GateAccounts,
): Promise<string> {
  const client = chain.clientFor(buyer);
  const result = await client.setTaskJobSpec({
    task: input.task,
    creator: buyer,
    jobSpecHash: input.jobSpecHash,
    jobSpecUri: input.jobSpecUri,
    ...gateArgs(gate),
    ...(gate.record !== undefined ? { taskModeration: gate.record } : {}),
  });
  return result.signature;
}

const STATUS_NAMES: Record<number, ChainTaskStatus> = {
  [TaskStatus.Open]: "open",
  [TaskStatus.InProgress]: "in_progress",
  [TaskStatus.PendingValidation]: "pending_validation",
  [TaskStatus.Completed]: "completed",
  [TaskStatus.Cancelled]: "cancelled",
  [TaskStatus.Disputed]: "disputed",
  [TaskStatus.RejectFrozen]: "reject_frozen",
};

export interface JobOnChain {
  status: ChainTaskStatus;
  /** Unix seconds; 0 when the task has no deadline. */
  deadline: number;
  rewardLamports: bigint;
  workers: number;
  completions: number;
  activated: boolean;
  submission: {
    address: Address;
    status: SubmissionStatus;
    proofHashHex: string;
    resultData: Uint8Array;
    reviewDeadlineAt: number;
    submissionCount: number;
  } | null;
}

async function readSubmission(
  chain: Chain,
  task: Address,
  providerAgent: Address,
): Promise<{ address: Address; claim: Address; account: TaskSubmission } | null> {
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const [submission] = await findTaskSubmissionPda({ claim });
  const account = await readProgramAccount(
    chain,
    submission,
    getTaskSubmissionDiscriminatorBytes(),
    (data) => getTaskSubmissionDecoder().decode(data),
  );
  if (account === null || account.task !== task) return null;
  return { address: submission, claim, account };
}

/** Where a job stands on the chain, or null when its task does not exist. */
export async function inspectJob(
  chain: Chain,
  task: Address,
  providerAgent: Address,
): Promise<JobOnChain | null> {
  const account = await readTask(chain, task);
  if (account === null) return null;
  const status = STATUS_NAMES[Number(account.status)];
  if (status === undefined) {
    throw new WalletError("INTERNAL", "The marketplace reported a job state this wallet does not know.");
  }
  const submission = await readSubmission(chain, task, providerAgent);
  return {
    status,
    deadline: Number(account.deadline),
    rewardLamports: account.rewardAmount,
    workers: account.currentWorkers,
    completions: account.completions,
    activated: await isActivated(chain, task),
    submission:
      submission === null
        ? null
        : {
            address: submission.address,
            status: submission.account.status,
            proofHashHex: values.bytesToHex(new Uint8Array(submission.account.proofHash)),
            resultData: new Uint8Array(submission.account.resultData),
            reviewDeadlineAt: Number(submission.account.reviewDeadlineAt),
            submissionCount: submission.account.submissionCount,
          },
  };
}

interface Payees {
  workerAuthority: Address;
  treasury: Address;
  operator: Address | null;
  referrer: Address | null;
}

async function settlementPayees(
  chain: Chain,
  task: Task,
  providerAgent: Address,
): Promise<Payees> {
  const agent = await readAgent(chain, providerAgent);
  if (agent === null) {
    throw new WalletError(
      "NOT_AVAILABLE",
      "The provider's account could not be found, so this job cannot be paid from here.",
    );
  }
  const config = await readProtocolConfig(chain);
  return {
    workerAuthority: agent.authority,
    treasury: config.treasury,
    operator: isDefaultAddress(task.operator) || task.operatorFeeBps === 0 ? null : task.operator,
    referrer: isDefaultAddress(task.referrer) || task.referrerFeeBps === 0 ? null : task.referrer,
  };
}

/** Accept the delivery: releases the held price to the provider. */
export async function sendApproval(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
): Promise<string> {
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const payees = await settlementPayees(chain, account, providerAgent);
  const [hireRecord] = await findHireRecordPda({ task });
  const [creatorCompletionBond] = await findCreatorCompletionBondPda({
    task,
    creator: buyer.address,
  });
  const [workerCompletionBond] = await findWorkerCompletionBondPda({
    task,
    workerAuthority: payees.workerAuthority,
  });
  const client = chain.clientFor(buyer);
  const result = await client.acceptTaskResult({
    task,
    worker: providerAgent,
    creator: buyer,
    treasury: payees.treasury,
    workerAuthority: payees.workerAuthority,
    hireRecord,
    creatorCompletionBond,
    workerCompletionBond,
    ...(payees.operator !== null ? { operator: payees.operator } : {}),
    ...(payees.referrer !== null ? { referrer: payees.referrer } : {}),
  });
  return result.signature;
}

/** Send the delivery back for another round, committing to the note's hash. */
export async function sendChangesRequest(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  changesHash: Uint8Array,
): Promise<string> {
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const client = chain.clientFor(buyer);
  const result = await client.send([
    await facade.requestChanges({ task, claim, creator: buyer, changesHash }),
  ]);
  return result.signature;
}

/**
 * Turn a delivery down. The job goes back to "nobody has started", from where
 * it can be cancelled for a refund.
 */
export async function sendReject(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  rejectionHash: Uint8Array,
): Promise<string> {
  const agent = await readAgent(chain, providerAgent);
  if (agent === null) {
    throw new WalletError("NOT_AVAILABLE", "This delivery cannot be turned down from here yet.");
  }
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const [workerCompletionBond] = await findWorkerCompletionBondPda({
    task,
    workerAuthority: agent.authority,
  });
  const client = chain.clientFor(buyer);
  const result = await client.rejectTaskResult({
    task,
    claim,
    worker: providerAgent,
    creator: buyer,
    workerAuthority: agent.authority,
    workerCompletionBond,
    rejectionHash,
  });
  return result.signature;
}

/**
 * Cancel and refund. Allowed while nobody has started, or after the deadline
 * passed with a provider who started and never delivered.
 */
export async function sendCancel(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
): Promise<string> {
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const client = chain.clientFor(buyer);
  if (Number(account.status) === TaskStatus.Open && account.currentWorkers === 0) {
    const result = await client.cancelTask({
      task,
      authority: buyer,
      workerBondAuthority: buyer.address,
    });
    return result.signature;
  }
  if (Number(account.status) === TaskStatus.InProgress && account.completions === 0) {
    const agent = await readAgent(chain, providerAgent);
    if (agent === null) {
      throw new WalletError("NOT_AVAILABLE", "This job cannot be cancelled from here yet.");
    }
    const [claim] = await findClaimPda({ task, bidder: providerAgent });
    const config = await readProtocolConfig(chain);
    const result = await client.cancelTask({
      task,
      authority: buyer,
      workerBondAuthority: agent.authority,
      workerAccounts: [{ claim, workerAgent: providerAgent, workerAuthority: agent.authority }],
      treasury: config.treasury,
    });
    return result.signature;
  }
  throw new WalletError("NOT_ALLOWED", "This job can no longer be cancelled.");
}

/**
 * Tidy a finished job: release the provider's capacity slot and collect the
 * deposits that can come back. Safe to call again; returns null when there
 * is nothing left to collect.
 */
export async function sendTidy(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
): Promise<string | null> {
  const account = await readTask(chain, task);
  if (account === null) return null;
  const status = Number(account.status);
  if (status !== TaskStatus.Completed && status !== TaskStatus.Cancelled) return null;
  if (account.currentWorkers !== 0) return null;

  const hire = await readHireRecord(chain, task);
  const activated = await isActivated(chain, task);
  const children: Parameters<typeof facade.closeTask>[0]["children"] & unknown[] = [];

  const [validationConfig] = await findTaskValidationConfigPda({ task });
  const validation = await chain.readAccountInfo(validationConfig);
  if (
    validation !== null &&
    validation.owner === AGENC_COORDINATION_PROGRAM_ADDRESS &&
    startsWith(validation.data, getTaskValidationConfigDiscriminatorBytes())
  ) {
    children.push({ kind: "creatorFunded", account: validationConfig });
  }

  const submission = await readSubmission(chain, task, providerAgent);
  if (
    submission !== null &&
    (submission.account.status === SubmissionStatus.Accepted ||
      submission.account.status === SubmissionStatus.Rejected)
  ) {
    const agent = await readAgent(chain, providerAgent);
    if (agent !== null) {
      children.push({
        kind: "workerSubmission",
        submission: submission.address,
        workerAgent: providerAgent,
        rentRecipient: agent.authority,
      });
    }
  }

  if (hire === null && !activated && children.length === 0) return null;

  const [creatorCompletionBond] = await findCreatorCompletionBondPda({
    task,
    creator: buyer.address,
  });
  const client = chain.clientFor(buyer);
  const result = await client.closeTask({
    task,
    authority: buyer,
    creatorCompletionBond,
    listing: hire === null ? null : hire.listing,
    ...(activated ? {} : { taskJobSpec: null }),
    children,
  });
  return result.signature;
}

/** What leaving a rating costs: the record's deposit (never returned) plus a fee. */
export async function ratingCost(chain: Chain): Promise<bigint> {
  return (await chain.getMinimumBalanceForRentExemption(HIRE_RATING_SPACE)) + 5_000n;
}

/** Whether this buyer already rated this job. */
export async function alreadyRated(chain: Chain, task: Address): Promise<boolean> {
  const [rating] = await findHireRatingPda({ task });
  const info = await chain.readAccountInfo(rating);
  return info !== null && info.owner === AGENC_COORDINATION_PROGRAM_ADDRESS;
}

/** Record 1 to 5 stars for a paid job. Must happen before the job is tidied. */
export async function sendRating(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  listing: Address,
  score: number,
): Promise<string> {
  const client = chain.clientFor(buyer);
  const result = await client.send([
    await facade.rateHire({ task, listing, buyer, score }),
  ]);
  return result.signature;
}

/** The provider agent's address for an agent id (earn side bookkeeping). */
export async function agentAddressFor(agentId: Uint8Array): Promise<Address> {
  const [agent] = await findAgentPda({ agentId });
  return agent;
}

// ------------------------------------------------- offering a service
//
// The provider side of a listing: an earning agent advertises one service,
// and the stock worker loop then takes the hires made against it.

/** Size of a service listing account (measured on mainnet: 697 bytes). */
export const LISTING_ACCOUNT_SPACE = 697;

/** The on-chain name of a listing holds this many bytes of UTF-8. */
export const LISTING_NAME_MAX_BYTES = values.LISTING_NAME_BYTES;

/** The address of the listing a provider agent creates with this listing id. */
export async function listingAddressFor(
  providerAgent: Address,
  listingId: Uint8Array,
): Promise<Address> {
  const [listing] = await facade.findListingPda({ providerAgent, listingId });
  return listing;
}

export interface ListingOffer {
  providerAgent: Address;
  listingId: Uint8Array;
  name: string;
  category: string;
  /** Canonical hash of the advertised description, and where it is published. */
  specHash: Uint8Array;
  specUri: string;
  priceLamports: bigint;
  /** Seconds the provider gets to deliver a hired job. */
  deliverySecs: number;
}

/**
 * Create the listing. Hires are not capped: the marketplace only lowers a
 * listing's open-job count when a buyer tidies the finished job, so a cap
 * would let one buyer who never tidies block every later hire. The worker
 * still takes one job at a time.
 */
export async function sendCreateListing(
  chain: Chain,
  provider: KeyPairSigner,
  offer: ListingOffer,
): Promise<string> {
  const result = await chain.clientFor(provider).createServiceListing({
    providerAgent: offer.providerAgent,
    authority: provider,
    listingId: offer.listingId,
    name: offer.name,
    category: offer.category as never,
    tags: [],
    specHash: offer.specHash,
    specUri: offer.specUri,
    price: offer.priceLamports,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: BigInt(offer.deliverySecs),
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  return result.signature;
}

/** Change a listing's price, and its description when one is given. */
export async function sendUpdateListing(
  chain: Chain,
  provider: KeyPairSigner,
  input: {
    listing: Address;
    providerAgent: Address;
    priceLamports: bigint;
    spec: { hash: Uint8Array; uri: string } | null;
  },
): Promise<string> {
  const result = await chain.clientFor(provider).send([
    await facade.updateServiceListing({
      listing: input.listing,
      providerAgent: input.providerAgent,
      authority: provider,
      price: input.priceLamports,
      ...(input.spec === null
        ? { specHash: null, specUri: null }
        : { specHash: input.spec.hash, specUri: input.spec.uri }),
      tags: null,
      requiredCapabilities: null,
      defaultDeadlineSecs: null,
      maxOpenJobs: null,
      operator: null,
      operatorFeeBps: null,
    }),
  ]);
  return result.signature;
}

/** Take a listing off offer (paused) or put it back (active). */
export async function sendListingState(
  chain: Chain,
  provider: KeyPairSigner,
  input: { listing: Address; providerAgent: Address; active: boolean },
): Promise<string> {
  const result = await chain.clientFor(provider).send([
    await facade.setServiceListingState({
      listing: input.listing,
      authority: provider,
      providerAgent: input.providerAgent,
      state: input.active ? "Active" : "Paused",
    }),
  ]);
  return result.signature;
}
