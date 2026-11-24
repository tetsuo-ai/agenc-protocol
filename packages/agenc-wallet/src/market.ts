import { jobNetworkFees, type JobDeposits } from "./job-money.js";
// Chain-facing marketplace steps for the buyer side: read a listing, resolve
// the moderation gate, hire, activate, review, cancel, tidy up.
//
// Every function here is a single idempotent step. It reads the chain first,
// does nothing if the step already happened, and otherwise sends exactly one
// transaction through the public SDK client. The caller (the wallet) journals
// intent before and outcome after, which is what makes the whole purchase
// resumable after a crash without ever paying twice: a task address is fixed
// by (buyer, random task id), and the program creates it at most once.
import { claimGeneration, decisionAssertions, hireCostAssertions, laterRentWithinApproval, recordCostGuards, type BoundDelivery } from "./money-assertions.js";
import { reviewMemo } from "./review-memo.js";
import { withListingOperation } from "./transport-scope.js";
import { address, getAddressEncoder, type Address, type KeyPairSigner, type Instruction, type TransactionPartialSigner, type TransactionSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  AgentStatus,
  facade,
  findAgentPda,
  findAgentStatsPda,
  findClaimPda,
  findCreatorStatsPda,
  findCreateTaskHumanlessAuthorityRateLimitPda,
  findCreatorCompletionBondPda,
  findEscrowPda,
  findHireRatingPda,
  findHireRecordPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskAttestorConfigPda, getTaskAttestorConfigDiscriminatorBytes,
  findTaskJobSpecPda,
  findTaskModerationPda,
  findTaskPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  findWorkerCompletionBondPda,
  getAgentRegistrationDecoder,
  getAgentRegistrationDiscriminatorBytes,
  getAgentStatsDiscriminatorBytes,
  getAuthorityRateLimitSize,
  getCreatorStatsDiscriminatorBytes,
  getCreatorStatsSize,
  getDisputeBondSize,
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
  getTaskMarkerSize,
  getTaskModerationSize,
  getTaskClaimDecoder,
  getTaskClaimDiscriminatorBytes,
  getTaskSubmissionDecoder,
  getTaskSubmissionDiscriminatorBytes,
  getTaskValidationConfigDiscriminatorBytes,
  getTaskValidationConfigSize,
  resolveProgramAccountsTransport,
  SubmissionStatus,
  TASK_CLAIM_TASK_OFFSET,
  TaskStatus,
  values,
  type AgentRegistration,
  type HireRecord,
  type ProtocolConfig,
  type ServiceListing,
  type Task,
  type TaskSubmission,
  lighthouse,
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
export async function readProgramAccount<T>(
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
  maxOpenJobs: number;
  operator: Address | null;
  operatorFeeBps: number;
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
    maxOpenJobs: account.maxOpenJobs,
    operator: isDefaultAddress(account.operator) ? null : account.operator,
    operatorFeeBps: account.operatorFeeBps,
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
 * The approvers whose records this wallet's gated steps can use: the
 * marketplace's own authority, then the ones its services name.
 */
export async function acceptedApprovers(
  chain: Chain,
  services: MarketServices,
): Promise<Address[]> {
  return (await candidateModerators(chain, services)).candidates;
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
 * accounts it creates, plus fee headroom. Revision 9: almost all of it comes
 * back when the finished job is tidied, the deposit behind the safety check
 * of the job's request included. Only the small marker that stays where the
 * job's record was keeps a deposit.
 */
export function purchaseDeposits(
  chain: Chain,
  buyer: Address,
  rent?: (space: number) => bigint,
): Promise<JobDeposits> {
  return jobDeposits(chain, buyer, true, rent);
}

/**
 * The same for a request posted for anyone to take: the accounts are those
 * of a hire without the record that ties a hire to its service.
 */
export function requestDeposits(
  chain: Chain,
  creator: Address,
): Promise<JobDeposits> {
  return jobDeposits(chain, creator, false);
}

async function jobDeposits(
  chain: Chain,
  payer: Address,
  hired: boolean,
  rent: (space: number) => bigint | Promise<bigint> = space => chain.getMinimumBalanceForRentExemption(space),
): Promise<JobDeposits> {
  const [taskRent, escrowRent, hireRent, validationRent, jobSpecRent, approvalRent, markerRent] =
    await Promise.all([
      rent(TASK_ACCOUNT_SPACE),
      rent(getTaskEscrowSize()),
      hired ? rent(getHireRecordSize()) : Promise.resolve(0n),
      rent(getTaskValidationConfigSize()),
      rent(TASK_JOB_SPEC_SPACE),
      rent(getTaskModerationSize()),
      rent(getTaskMarkerSize()),
    ]);
  let total =
    taskRent +
    escrowRent +
    hireRent +
    validationRent +
    jobSpecRent +
    approvalRent +
    FEE_HEADROOM_LAMPORTS;
  // Revision 9: tidying compacts the job's record into a marker, which keeps
  // only its own deposit; the rest of the record's and the safety check's
  // deposits come back.
  let kept = markerRent;
  // The marketplace keeps one record per paying wallet of how often it posts:
  // made, and kept, on that wallet's first job of either kind.
  const [rateLimit] = await findCreateTaskHumanlessAuthorityRateLimitPda({ creator: payer });
  if ((await chain.readAccountInfo(rateLimit)) === null) {
    const once = await rent(getAuthorityRateLimitSize());
    total += once;
    kept += once;
  }
  const cancellationRent = await creatorRecordCost(chain, payer, rent);
  const networkFees = jobNetworkFees(chain.transferFeeLamports);
  return { total: total + cancellationRent + networkFees, kept: kept + cancellationRent, networkFees, cancellationRent };
}

/**
 * Lamports `payer` still lacks to pay for its first cancel's record on top of
 * fee headroom, or 0 when it can cancel (or has its record already).
 */
export async function cancelShortfall(chain: Chain, payer: Address): Promise<bigint> {
  const cost = await creatorRecordCost(chain, payer);
  if (cost === 0n) return 0n;
  const needed = cost + FEE_HEADROOM_LAMPORTS;
  const balance = await chain.getBalance(payer);
  return balance >= needed ? 0n : needed - balance;
}

/**
 * Lamports the wallet `creator` pays, once, to start its marketplace record of
 * turn-downs and cancels: the record's rent, read live, or 0 once it exists.
 * Its first turn-down or cancel pays it, before any refund, and it never
 * comes back.
 */
export async function creatorRecordCost(chain: Chain, creator: Address,
  rent: (space: number) => bigint | Promise<bigint> = space => chain.getMinimumBalanceForRentExemption(space),
): Promise<bigint> {
  const [record] = await findCreatorStatsPda({ authority: creator });
  const info = await chain.readAccountInfo(record);
  if (
    info !== null &&
    info.owner === AGENC_COORDINATION_PROGRAM_ADDRESS &&
    startsWith(info.data, getCreatorStatsDiscriminatorBytes())
  ) {
    return 0n;
  }
  return rent(getCreatorStatsSize());
}

/** An owner-aware reader over the wallet's chain, for the SDK's turn-down readers. */
export function snapshotReader(chain: Chain): facade.ReadAccountSnapshot {
  return async (account) => {
    return chain.readRawAccount(account);
  };
}

/**
 * How a refusal for lack of money says its amounts: `cost` for what something
 * costs, `add` for what to add (never less than enough). The wallet passes the
 * person's own money (dollars when it knows a rate); the default is exact SOL.
 */
export interface AmountWords {
  cost(lamports: bigint): string;
  add(lamports: bigint): string;
}

export const SOL_AMOUNT_WORDS: AmountWords = { cost: solText, add: solText };

/**
 * Fail before signing when `payer` cannot pay `cost` on top of fee headroom,
 * saying what the cost is for and how much to add.
 */
async function requireBalanceFor(
  chain: Chain,
  payer: Address,
  cost: bigint,
  what: string,
  words: AmountWords,
  fee = FEE_HEADROOM_LAMPORTS,
): Promise<void> {
  if (cost === 0n && fee === FEE_HEADROOM_LAMPORTS) return;
  const balance = await chain.getBalance(payer);
  const needed = cost + fee;
  if (balance < needed) {
    throw new WalletError(
      "NOT_ENOUGH_MONEY",
      `${what} starts your marketplace record, which costs ${words.cost(cost)} once and does not come back. Add at least ${words.add(needed - balance)} and try again.`,
    );
  }
}

/** Lamports as SOL, every digit kept, trailing zeros dropped. */
export function solText(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${whole}${frac.length > 0 ? `.${frac}` : ""} SOL`;
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
  protocolFeeBps: number,
  rentTerms: string,
): Promise<string> {
  const guards = await hireCostAssertions(protocolFeeBps, rentTerms);
  const ix = await facade.hireFromListingHumanless({
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
  return (await chain.clientFor(buyer).send([...guards, ix])).signature;
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

// ------------------------------------------------- posting a request
//
// A request is a job nobody was hired for: anyone may take it. It is the
// marketplace's single-worker task with the buyer's review forced on, the
// door a wallet with no registered agent uses.

export interface RequestIntent {
  maxEntries?: number;
  minReputation: number;
  requiredCapabilities: bigint;
  taskId: Uint8Array;
  /** Canonical hash of the published request. The task commits to it. */
  jobSpecHash: Uint8Array;
  rewardLamports: bigint;
  /** Unix seconds: when the work must be delivered by. */
  deadline: bigint;
  reviewWindowSecs: bigint;
}

/** The 64-byte description a request's task carries: the request's hash, then zeros. */
export function requestDescription(jobSpecHash: Uint8Array): Uint8Array {
  const description = new Uint8Array(64);
  description.set(jobSpecHash.subarray(0, 32), 0);
  return description;
}

/**
 * Post the request: creates the task for one worker with the buyer's review
 * on, and puts the reward in escrow.
 */
export async function sendRequest(
  chain: Chain,
  creator: KeyPairSigner,
  intent: RequestIntent,
): Promise<string> {
  const client = chain.clientFor(creator);
  const result = await client.send([
    await facade.createTaskHumanless({
      creator,
      taskId: intent.taskId,
      requiredCapabilities: intent.requiredCapabilities,
      description: requestDescription(intent.jobSpecHash),
      rewardAmount: intent.rewardLamports,
      deadline: intent.deadline,
      minReputation: intent.minReputation,
      reviewWindowSecs: intent.reviewWindowSecs,
    }),
  ]);
  return result.signature;
}

/**
 * True when the task at the journaled address is exactly the request that
 * was meant: created by this wallet, for this reward and this request, and
 * not tied to any service.
 */
export async function requestLanded(
  chain: Chain,
  creator: Address,
  task: Address,
  intent: Pick<RequestIntent, "rewardLamports" | "jobSpecHash" | "minReputation" | "requiredCapabilities" | "deadline" | "maxEntries">,
): Promise<boolean> {
  const account = await readTask(chain, task);
  if (account === null) return false;
  const mismatch = (): never => {
    throw new WalletError("INTERNAL", "A job on the marketplace does not match the wallet's records.");
  };
  if (account.creator !== creator || account.rewardAmount !== intent.rewardLamports ||
      account.minReputation !== intent.minReputation || account.requiredCapabilities !== intent.requiredCapabilities ||
      account.deadline !== intent.deadline || account.maxWorkers !== (intent.maxEntries ?? 1) ||
      Number(account.taskType) !== (intent.maxEntries === undefined ? 0 : 2)) mismatch();
  if (!bytesEqual(new Uint8Array(account.description), requestDescription(intent.jobSpecHash))) mismatch();
  if ((await readHireRecord(chain, task)) !== null) mismatch();
  return true;
}

/**
 * The agent that took a request, found by its claim on the task. Null while
 * nobody holds one. Needs a program-account scan, so it is asked only once
 * the task says someone took it.
 */
export async function requestWorker(chain: Chain, task: Address): Promise<Address | null> {
  const found = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({
    filters: [
      { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskClaimDiscriminatorBytes()) } },
      { memcmp: { offset: TASK_CLAIM_TASK_OFFSET, bytes: Uint8Array.from(getAddressEncoder().encode(task)) } },
    ],
  });
  for (const entry of found) {
    try {
      const claim = getTaskClaimDecoder().decode(entry.data);
      if (claim.task !== task) continue;
      // The claim's address proves which worker it belongs to.
      const [expected] = await findClaimPda({ task, bidder: claim.worker });
      if (expected === entry.address) return claim.worker;
    } catch {
      // Not a claim this wallet can read; keep looking.
    }
  }
  return null;
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
  /** Approved Rent bytes (hex) of a hire. The job spec's deposit is checked against them, also at landing. */
  approvedRentTerms?: string,
): Promise<string> {
  const client = chain.clientFor(buyer);
  const spec = {
    task: input.task,
    creator: buyer,
    jobSpecHash: input.jobSpecHash,
    jobSpecUri: input.jobSpecUri,
    ...gateArgs(gate),
    ...(gate.record !== undefined ? { taskModeration: gate.record } : {}),
  };
  if (approvedRentTerms === undefined) return (await client.setTaskJobSpec(spec)).signature;
  const current = await laterRentWithinApproval(chain, approvedRentTerms, [TASK_JOB_SPEC_SPACE]);
  if (current === null) throw new LaterRentRose();
  const guard = lighthouse.assertBytes(lighthouse.RENT, 0, Buffer.from(current, "hex"));
  return (await client.send([guard, await facade.setTaskJobSpec(spec)])).signature;
}

/** A hire's later account would cost more than the buyer approved. */
export class LaterRentRose extends WalletError {
  constructor() {
    super("PRICE_CHANGED", "The network's account deposits rose after you approved this job.");
  }
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

/** A turned-down job, as the chain shows it (see the SDK's `readTurnDown`). */
export interface TurnDownOnChain {
  /**
   * True: a revision 9 turn-down. The provider may dispute it until
   * `disputeUntil`; the buyer is refunded unless a ruling pays the provider.
   * False: a turn-down made before revision 9. If nobody rules by its review
   * time (`disputeUntil` here), the provider is paid.
   */
  disputable: boolean;
  /** Unix seconds: the last second the provider may dispute (or, before revision 9, the review time). */
  disputeUntil: number;
  /** Lamports a dispute posts as its bond. */
  bondLamports: bigint;
  /** Unix seconds: the last second a ruling may land, once disputed. Null before a dispute. */
  rulingUntil: number | null;
  /** Whether the provider may dispute it now, by the cluster's clock. */
  disputeOpen: boolean;
  /**
   * The marketplace suspended the provider's agent. The program refuses a
   * suspended agent's dispute (`AgentSuspended`), so none is offered.
   */
  providerSuspended: boolean;
  /** What an expiry sent now would do, or null while it cannot be sent yet. */
  expiryDue: "refunds_buyer" | "pays_provider" | null;
}

export interface JobOnChain {
  status: ChainTaskStatus;
  /** Closed markers no longer carry the reward mint. */
  tokenReward?: boolean;
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
  /** While the job is turned down (reject_frozen): the turn-down. Null otherwise. */
  turnDown: TurnDownOnChain | null;
  /**
   * Revision 9: the job was tidied and its record compacted into a marker
   * that keeps only how it ended. Its deadline, price and counts are then
   * gone (read as 0).
   */
  closed: boolean;
}

/** Read a turned-down job's turn-down, or null when the job is not frozen. */
export async function readTurnDownOnChain(
  chain: Chain,
  task: Address,
  providerAgent: Address,
): Promise<TurnDownOnChain | null> {
  const turnDown = await facade.readTurnDown(snapshotReader(chain), {
    task,
    worker: providerAgent,
  });
  if (turnDown === null) return null;
  const stage = facade.turnDownStage(turnDown, await chain.clusterTime());
  const agent = await readAgent(chain, providerAgent);
  return {
    disputable: turnDown.disputable,
    disputeUntil: Number(turnDown.reviewDeadlineAt),
    bondLamports: turnDown.bondToDispute,
    rulingUntil: turnDown.dispute === null ? null : Number(turnDown.dispute.rulingDeadline),
    disputeOpen: stage === "dispute_window",
    providerSuspended: agent !== null && Number(agent.status) === AgentStatus.Suspended,
    expiryDue:
      stage === "legacy_payout_due"
        ? "pays_provider"
        : stage === "refund_due" || stage === "unruled_refund_due"
          ? "refunds_buyer"
          : null,
  };
}

export async function readSubmission(
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

export async function settledOperatorPayment(chain: Chain, task: Address) {
  const read = await facade.readTask(snapshotReader(chain), task);
  if (read.kind === "missing") return null;
  const creator = read.kind === "closed" ? read.marker.creator : read.task.creator;
  const facts = await chain.findSettlement?.(task, creator, { includeFrozen: true });
  if (facts?.operatorPayment) return facts.operatorPayment;
  if (!facts?.unpaidOperator) return null;
  const { address, sellerNet } = facts.unpaidOperator;
  // The task pins the operator at hire. After cleanup the marker has no terms,
  // so require the original hire and the operator slot of its paid settlement.
  if (read.kind === "closed") {
    const hire = await chain.findSettlement?.(task, creator, { includeFrozen: true, listing: true });
    if (!hire?.listing || hire.unpaidOperator?.address !== address || hire.unpaidOperator.sellerNet !== sellerNet) return null;
  } else if (
    read.task.operator !== address || read.task.operatorFeeBps === 0 || read.task.rewardAmount !== facts.priceLamports ||
    read.task.rewardAmount * BigInt(read.task.operatorFeeBps) >= 10_000n
  ) return null;
  return { address, paid: 0n, forfeited: 0n, sellerNet };
}

/**
 * Where a job stands on the chain, or null when its task does not exist.
 * `providerAgent` is null for a request nobody is known to have taken: there
 * is then no delivery to read.
 */
export async function inspectJob(
  chain: Chain,
  task: Address,
  providerAgent: Address | null,
): Promise<JobOnChain | null> {
  const read = await facade.readTask(snapshotReader(chain), task);
  if (read.kind === "missing") return null;
  if (read.kind === "closed") {
    const submission = providerAgent === null ? null : await readSubmission(chain, task, providerAgent);
    return {
      status: read.status,
      deadline: 0,
      rewardLamports: 0n,
      workers: 0,
      completions: 0,
      activated: false,
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
      turnDown: null,
      closed: true,
    };
  }
  const account = read.task;
  const status = STATUS_NAMES[Number(account.status)];
  if (status === undefined) {
    throw new WalletError("INTERNAL", "The marketplace reported a job state this wallet does not know.");
  }
  const submission = providerAgent === null ? null : await readSubmission(chain, task, providerAgent);
  const turnDown =
    status === "reject_frozen" && providerAgent !== null
      ? await readTurnDownOnChain(chain, task, providerAgent)
      : null;
  return {
    status,
    deadline: Number(account.deadline),
    rewardLamports: account.rewardAmount,
    tokenReward: account.rewardMint.__option === "Some",
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
    turnDown,
    closed: false,
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

async function sendBuyerDecision(
  chain: Chain, payer: KeyPairSigner, task: Address, provider: Address,
  action: "approve" | "change" | "reject", ix: Instruction, expected: BoundDelivery, costGuards: readonly Instruction[] = [],
) {
  const [claim] = await findClaimPda({ task, bidder: provider });
  const [submission] = await findTaskSubmissionPda({ claim });
  const account = await readTask(chain, task);
  if (!account) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  // Cost checks come first. The receipt reader expects the three decision
  // guards immediately before the memo.
  const guards = [...costGuards, ...decisionAssertions(task, account, submission, expected)];
  let refusal: WalletError | undefined;
  // The SDK obtains a fresh lifetime and assembles the message before calling
  // this signer. Keep the claim read here, after uploads, quotes and RPC setup.
  const signer: TransactionPartialSigner = {
    address: payer.address,
    async signTransactions(transactions, config) {
      const [current, now] = await Promise.all([readSubmission(chain, task, provider).then(found => found?.account), readTask(chain, task)]);
      if (!current || !now || claimGeneration(now) !== expected.claimGeneration || current.claim !== claim || current.worker !== provider || current.status !== SubmissionStatus.Submitted ||
          current.submissionCount !== expected.submissionCount || values.bytesToHex(Uint8Array.from(current.proofHash)) !== expected.deliveryHash) {
        refusal = new WalletError("NOT_ALLOWED", "The delivery changed before signing. Open the new delivery and review it again.");
        throw refusal;
      }
      return payer.signTransactions(transactions, config);
    },
  };
  try {
    return await chain.clientFor(signer, { review: true }).send([...guards, reviewMemo(action, claim, expected), ix], { maxRetries: 0 });
  } catch (error) {
    // The SDK wraps errors raised by a signer.
    throw refusal ?? error;
  }
}

/** Accept the delivery: releases the held price to the provider. */
export async function sendApproval(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  expected: BoundDelivery,
  approvedPayees?: Pick<Payees, "workerAuthority" | "treasury">,
): Promise<string> {
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const payees = await settlementPayees(chain, account, providerAgent);
  if (approvedPayees && (payees.workerAuthority !== approvedPayees.workerAuthority || payees.treasury !== approvedPayees.treasury ||
      payees.operator !== null || payees.referrer !== null)) {
    throw new WalletError("PRICE_CHANGED", "The payout recipients changed. Review a new quote.");
  }
  const [hireRecord] = await findHireRecordPda({ task });
  const [creatorCompletionBond] = await findCreatorCompletionBondPda({
    task,
    creator: buyer.address,
  });
  const [workerCompletionBond] = await findWorkerCompletionBondPda({
    task,
    workerAuthority: payees.workerAuthority,
  });
  const ix = await facade.acceptTaskResult({
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
  const result = await sendBuyerDecision(chain, buyer, task, providerAgent, "approve", ix, expected);
  return result.signature;
}

/** Send the delivery back for another round, committing to the note's hash. */
export async function sendChangesRequest(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  changesHash: Uint8Array,
  expected: BoundDelivery,
): Promise<string> {
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const ix = await facade.requestChanges({ task, claim, creator: buyer, changesHash });
  const result = await sendBuyerDecision(chain, buyer, task, providerAgent, "change", ix, expected);
  return result.signature;
}

/** The one reason a person gives by turning a delivery down. */
export const TURN_DOWN_REASON = "The delivery does not do what was asked.";

/**
 * What a turn-down commits to: which job, which delivery, the request it
 * answered, and why it was turned down. Each part is public (the task, the
 * delivery's fingerprint and the request's are all recorded with the job), so
 * anyone, the reviewer first, can work the hash out again and see exactly
 * what was turned down and for what.
 */
export async function turnDownReason(input: {
  task: Address;
  /** The fingerprint the provider recorded for the delivery. */
  deliveryHashHex: string;
  /** The fingerprint of the request the job was posted with. */
  requestHashHex: string;
}): Promise<{ document: Record<string, unknown>; hash: Uint8Array; hex: string }> {
  const document = {
    kind: "agenc.marketplace.turnDown",
    v: 1,
    task: input.task,
    delivery: input.deliveryHashHex,
    request: input.requestHashHex,
    reason: TURN_DOWN_REASON,
  };
  const { bytes, hex } = await values.canonicalJobSpecHash(document);
  return { document, hash: bytes, hex };
}

/** Where a provider agent's record of turn-downs, expired claims and disputes lives. */
export async function providerRecordAddress(providerAgent: Address): Promise<Address> {
  const [stats] = await findAgentStatsPda({ creatorAgent: providerAgent });
  return stats;
}

/**
 * Whether the marketplace keeps that record for the provider agent. Since
 * revision 9 the provider's first claim starts it, so only a provider whose
 * claim is older has none; a turn-down then starts it, paid by the buyer. A
 * record is never removed.
 */
export async function providerHasRecord(chain: Chain, providerAgent: Address): Promise<boolean> {
  const info = await chain.readAccountInfo(await providerRecordAddress(providerAgent));
  return (
    info !== null &&
    info.owner === AGENC_COORDINATION_PROGRAM_ADDRESS &&
    startsWith(info.data, getAgentStatsDiscriminatorBytes())
  );
}

/**
 * Turn a delivery down: a freeze that holds the price. It does not hand the
 * money back at once, and a plain rejection that reopened the job for a free
 * refund is refused on these jobs. Since revision 9 the provider has 72
 * hours to dispute the turn-down, posting a bond. If it does not, the buyer
 * is refunded when that time ends. If it does, the marketplace's reviewers
 * rule within 72 hours more: for the provider, the provider is paid; for the
 * buyer, the buyer is refunded and receives the bond; with no ruling, the
 * buyer is refunded and the bond goes back.
 *
 * The turn-down always goes on the provider's record and on the buyer's own,
 * with a reason that says what was turned down (see {@link turnDownReason}).
 * A record that does not exist yet is started by this transaction and paid
 * by the buyer, for good: the buyer's own at its first turn-down or cancel,
 * and the provider's only for a claim made before revision 9. The cost is
 * read before signing, and a wallet that cannot pay it fails here with
 * nothing changed. `recordLamports` says what it paid.
 */
export async function sendRejectAndFreeze(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  rejectionHash: Uint8Array,
  words: AmountWords = SOL_AMOUNT_WORDS,
  expected: BoundDelivery,
  /** The record lamports the buyer approved. A higher current charge is refused. */
  approvedRecordLamports?: bigint,
): Promise<{ signature: string; recordLamports: bigint }> {
  // The revision first, so a person on the wrong one is not asked for money.
  await chain.assertSigningRevision?.();
  const cost = await recordCostGuards(chain, { creator: buyer.address, workerAgent: providerAgent }, approvedRecordLamports);
  await requireBalanceFor(chain, buyer.address, cost.lamports, "Turning this down", words, chain.transferFeeLamports);
  const ix = await facade.rejectAndFreeze({ task, worker: providerAgent, creator: buyer, rejectionHash });
  const result = await sendBuyerDecision(chain, buyer, task, providerAgent, "reject", ix, expected, cost.guards);
  return { signature: result.signature, recordLamports: cost.lamports };
}

/**
 * Settle a turned-down job once its time is over. Anyone may send it, so
 * either side's wallet does. What it does depends on the turn-down:
 * revision 9 (with no dispute, or a dispute nobody ruled on) refunds the
 * buyer and returns the provider's claim and submission rent, and its bond
 * when it disputed; a turn-down made before revision 9 pays the provider.
 * `paidProvider` says which it was, read from the chain before sending, so a
 * refund is never recorded as a payment.
 */
export async function sendFrozenExpiry(
  chain: Chain,
  sender: KeyPairSigner,
  task: Address,
  providerAgent: Address,
): Promise<{ signature: string; paidProvider: boolean }> {
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const turnDown = await readTurnDownOnChain(chain, task, providerAgent);
  if (turnDown === null || turnDown.expiryDue === null) {
    throw new WalletError("NOT_ALLOWED", "This turned-down job cannot be settled yet.");
  }
  const payees = await settlementPayees(chain, account, providerAgent);
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const [hireRecord] = await findHireRecordPda({ task });
  const client = chain.clientFor(sender);
  const result = await client.send([
    await facade.expireRejectFrozen({
      task,
      claim,
      worker: providerAgent,
      treasury: payees.treasury,
      creator: account.creator,
      workerAuthority: payees.workerAuthority,
      authority: sender,
      hireRecord,
      ...(payees.operator !== null ? { operator: payees.operator } : {}),
      ...(payees.referrer !== null ? { referrer: payees.referrer } : {}),
    }),
  ]);
  return { signature: result.signature, paidProvider: turnDown.expiryDue === "pays_provider" };
}

export async function disputeDeposit(chain: Chain, task: Address): Promise<bigint> {
  const [rent, account] = await Promise.all([
    chain.getMinimumBalanceForRentExemption(getDisputeBondSize()),
    facade.findRejectionDisputeBondPda(task).then(address => chain.readRawAccount(address)),
  ]);
  if (account && (account.data.length || account.owner !== "11111111111111111111111111111111")) return rent;
  return rent > (account?.lamports ?? 0n) ? rent - (account?.lamports ?? 0n) : 0n;
}

/**
 * The provider disputes a buyer's turn-down of its delivery (revision 9),
 * posting the bond: 10% of the price, at least 0.01 SOL, plus the bond
 * account's rent, which always comes back. The marketplace's reviewers then
 * rule. For the provider: it is paid and the bond comes back. For the buyer:
 * the bond goes to the buyer. With no ruling in time: the buyer is refunded
 * and the bond comes back. This is a person's decision; a wallet never sends
 * it by itself. The delivery's recorded fingerprint is the evidence.
 */
export async function sendDisputeTurnDown(
  chain: Chain,
  provider: KeyPairSigner,
  task: Address,
  providerAgent: Address,
  words: AmountWords = SOL_AMOUNT_WORDS,
  evidence?: { hash: Uint8Array; uri: string },
): Promise<{ signature: string; bondLamports: bigint }> {
  await chain.assertSigningRevision?.();
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const turnDown = await readTurnDownOnChain(chain, task, providerAgent);
  if (turnDown === null || !turnDown.disputable) {
    throw new WalletError("NOT_ALLOWED", "This job has no turn-down that can be disputed.");
  }
  if (turnDown.rulingUntil !== null) {
    throw new WalletError("NOT_ALLOWED", "This turn-down is already disputed.");
  }
  if (turnDown.providerSuspended) {
    throw new WalletError(
      "NOT_ALLOWED",
      "The marketplace has suspended this agent, and a suspended agent cannot dispute a turn-down. If nobody disputes it in time, the price goes back to the buyer.",
    );
  }
  if ((await chain.clusterTime()) > turnDown.disputeUntil) {
    throw new WalletError("NOT_ALLOWED", "The time to dispute this turn-down is over.");
  }
  const submission = await readSubmission(chain, task, providerAgent);
  if (submission === null) {
    throw new WalletError("NOT_FOUND", "The turned-down delivery could not be found.");
  }
  const bondRent = await disputeDeposit(chain, task);
  const needed = turnDown.bondLamports + bondRent + chain.transferFeeLamports;
  const balance = await chain.getBalance(provider.address);
  if (balance < needed) {
    throw new WalletError(
      "NOT_ENOUGH_MONEY",
      `Disputing this turn-down needs ${words.cost(needed)}: the bond of ${words.cost(turnDown.bondLamports)}, a deposit of ${words.cost(bondRent)} that comes back, and network fees. Add at least ${words.add(needed - balance)} and try again.`,
    );
  }
  const client = chain.clientFor(provider);
  const result = await client.send([
    await facade.disputeRejection({
      task,
      worker: providerAgent,
      creator: account.creator,
      authority: provider,
      evidenceHash: evidence?.hash ?? new Uint8Array(submission.account.proofHash),
      evidenceUri: evidence?.uri ?? "",
    }),
  ], { maxRetries: 0 });
  return { signature: result.signature, bondLamports: turnDown.bondLamports };
}

/**
 * Rule on a turned-down job as the marketplace's reviewer. `payProvider`
 * true overturns the buyer's turn-down and pays the provider; false upholds
 * it and the price goes back to the buyer. Only the marketplace's own
 * approvers can send this, and the program wants at least two of them to
 * agree. Since revision 9 a ruling needs the provider's dispute first, lands
 * within the ruling time, and carries a reason. A wallet never sends it: it
 * is here for the practice marketplace, which has reviewers of its own, and
 * for tests.
 */
export async function sendFrozenRuling(
  chain: Chain,
  reviewers: readonly KeyPairSigner[],
  task: Address,
  providerAgent: Address,
  payProvider: boolean,
): Promise<string> {
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  const payees = await settlementPayees(chain, account, providerAgent);
  const [claim] = await findClaimPda({ task, bidder: providerAgent });
  const [hireRecord] = await findHireRecordPda({ task });
  const reviewer = reviewers[0];
  if (reviewer === undefined) throw new WalletError("BAD_REQUEST", "A ruling needs a reviewer.");
  const rationale = await values.canonicalJobSpecHash({
    kind: "agenc.marketplace.ruling",
    v: 1,
    task,
    ruling: payProvider ? "pay_provider" : "refund_buyer",
  });
  const client = chain.clientFor(reviewer);
  const result = await client.send([
    await facade.resolveRejectFrozen({
      task,
      claim,
      worker: providerAgent,
      treasury: payees.treasury,
      creator: account.creator,
      workerAuthority: payees.workerAuthority,
      authority: reviewer,
      hireRecord,
      approveCompletion: payProvider,
      rationaleHash: rationale.bytes,
      rationaleUri: "",
      multisigSigners: [...reviewers],
      ...(payees.operator !== null ? { operator: payees.operator } : {}),
      ...(payees.referrer !== null ? { referrer: payees.referrer } : {}),
    }),
  ]);
  return result.signature;
}

/**
 * Cancel and refund. Allowed while nobody has started, or after the deadline
 * passed with a provider who started and never delivered (its claim deposit
 * then comes to the buyer too, unless it is still inside its first hour or a
 * dispute was filed on the job). Since revision 9 a cancel also counts on the
 * buyer's marketplace record; the first one starts that record, paid by the
 * buyer before the refund. A wallet that cannot pay it fails here with
 * nothing changed.
 */
export async function sendCancel(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address | null,
  words: AmountWords = SOL_AMOUNT_WORDS,
): Promise<string> {
  await chain.assertSigningRevision?.();
  const account = await readTask(chain, task);
  if (account === null) throw new WalletError("NOT_FOUND", "That job no longer exists.");
  await requireBalanceFor(
    chain,
    buyer.address,
    await creatorRecordCost(chain, buyer.address),
    "Cancelling this job",
    words,
  );
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
    const agent = providerAgent === null ? null : await readAgent(chain, providerAgent);
    if (agent === null) {
      throw new WalletError("NOT_AVAILABLE", "This job cannot be cancelled from here yet.");
    }
    const worker = providerAgent as Address;
    const [claim] = await findClaimPda({ task, bidder: worker });
    const config = await readProtocolConfig(chain);
    const result = await client.cancelTask({
      task,
      authority: buyer,
      workerBondAuthority: agent.authority,
      workerAccounts: [{ claim, workerAgent: worker, workerAuthority: agent.authority }],
      treasury: config.treasury,
    });
    return result.signature;
  }
  throw new WalletError("NOT_ALLOWED", "This job can no longer be cancelled.");
}

/** At most this many of a job's safety-check records are collected in one tidy. */
const TIDY_MODERATION_RECORDS = 4;
/** Where a safety-check record keeps its job: right after its kind (8 bytes). */
const TASK_MODERATION_TASK_OFFSET = 8;

/**
 * The safety-check records of `task` whose deposit comes back to `buyer`:
 * revision 9 records the buyer paid as rent payer. A record the approver paid
 * goes back to the approver and is left alone.
 */
async function buyerPaidModerationRecords(
  chain: Chain,
  task: Address,
  buyer: Address,
): Promise<Address[]> {
  const found = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({
    filters: [
      { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskModerationDiscriminatorBytes()) } },
      { memcmp: { offset: TASK_MODERATION_TASK_OFFSET, bytes: Uint8Array.from(getAddressEncoder().encode(task)) } },
    ],
  });
  const records: Address[] = [];
  for (const { address, data } of found) {
    let record: ReturnType<ReturnType<typeof getTaskModerationDecoder>["decode"]>;
    try {
      record = getTaskModerationDecoder().decode(data);
    } catch {
      continue;
    }
    if (record.task !== task) continue;
    if (facade.taskModerationRentRecipient(record) !== buyer) continue;
    records.push(address);
    if (records.length === TIDY_MODERATION_RECORDS) break;
  }
  return records;
}

/**
 * Tidy a finished job: release the provider's capacity slot and collect the
 * deposits that can come back. Revision 9: the job's record is compacted
 * into a small marker and the rest of its deposit comes back, with the
 * safety-check record the buyer paid for and any escrow left behind. Safe to
 * call again: on a marker it collects what is still left, and it returns null
 * when there is nothing left to collect.
 */
export async function sendTidy(
  chain: Chain,
  buyer: KeyPairSigner,
  task: Address,
  providerAgent: Address | null,
): Promise<string | null> {
  const instruction = await prepareTidy(chain, buyer, task, providerAgent);
  return instruction ? (await chain.clientFor(buyer).send([instruction])).signature : null;
}

export async function prepareTidy(chain: Chain, buyer: TransactionSigner, task: Address, providerAgent: Address | null) {
  const read = await facade.readTask(snapshotReader(chain), task);
  if (read.kind === "missing") return null;
  if (read.kind === "task") {
    const status = Number(read.task.status);
    if (status !== TaskStatus.Completed && status !== TaskStatus.Cancelled) return null;
    if (read.task.currentWorkers !== 0) return null;
  } else if (read.marker.creator !== buyer.address) {
    return null;
  }
  const closed = read.kind === "closed";

  // A marker has no hire link or job-spec pointer left to close.
  const hire = closed ? null : await readHireRecord(chain, task);
  const activated = closed ? false : await isActivated(chain, task);
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

  const submission = providerAgent === null ? null : await readSubmission(chain, task, providerAgent);
  if (
    providerAgent !== null &&
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

  const [attestor] = await findTaskAttestorConfigPda({ task });
  const attestorInfo = await chain.readAccountInfo(attestor);
  if (attestorInfo?.owner === AGENC_COORDINATION_PROGRAM_ADDRESS && startsWith(attestorInfo.data, getTaskAttestorConfigDiscriminatorBytes())) {
    children.push({ kind: "creatorFunded", account: attestor });
  }
  for (const record of await buyerPaidModerationRecords(chain, task, buyer.address)) {
    children.push({ kind: "namedRecipient", account: record, recipient: buyer.address });
  }

  // On a marker, a settled escrow that was left behind comes back too (the
  // close passes the canonical escrow address by default).
  const [escrow] = await findEscrowPda({ task });
  const escrowLeft = closed && (await chain.readAccountInfo(escrow))?.owner === AGENC_COORDINATION_PROGRAM_ADDRESS;
  // A Task always has its own deposit to give back; a marker only what is left.
  if (closed && children.length === 0 && !escrowLeft) return null;

  const [creatorCompletionBond] = await findCreatorCompletionBondPda({
    task,
    creator: buyer.address,
  });
  return facade.closeTask({
    task,
    authority: buyer,
    creatorCompletionBond,
    listing: hire === null ? null : hire.listing,
    ...(activated ? {} : { taskJobSpec: null }),
    children,
  });
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
  terms: import("./client/seller-terms.js").SellerTerms;
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
 * Admit hires up to the chosen capacity. The program enforces this atomically,
 * including concurrent buyers. close_task frees the slot after settlement.
 * A delayed close conservatively keeps the service busy.
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
    tags: offer.terms.tags,
    specHash: offer.specHash,
    specUri: offer.specUri,
    price: offer.priceLamports,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: BigInt(offer.deliverySecs),
    maxOpenJobs: offer.terms.maxOpenJobs,
    operator: offer.terms.operator ? address(offer.terms.operator) : null,
    operatorFeeBps: offer.terms.operatorFeeBps,
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
    terms: ListingOffer["terms"];
    spec: { hash: Uint8Array; uri: string } | null;
    deliverySecs?: number | undefined;
  },
): Promise<string> {
  return withListingOperation({ kind: "update", listings: [input.listing], lamports: "0" }, async () => {
    const result = await chain.clientFor(provider).send([
      await facade.updateServiceListing({
        listing: input.listing,
        providerAgent: input.providerAgent,
        authority: provider,
        price: input.priceLamports,
        ...(input.spec === null
          ? { specHash: null, specUri: null }
          : { specHash: input.spec.hash, specUri: input.spec.uri }),
        tags: values.encodeListingTags(input.terms.tags),
        requiredCapabilities: null,
        defaultDeadlineSecs: BigInt(input.terms.deliverySecs),
        maxOpenJobs: input.terms.maxOpenJobs,
        operator: input.terms.operator ? address(input.terms.operator) : SYSTEM_PROGRAM_ADDRESS,
        operatorFeeBps: input.terms.operatorFeeBps,
      }),
    ]);
    return result.signature;
  });
}

/**
 * Put a listing on offer ("Active"), take it off ("Paused"), or take it off
 * for good ("Retired", which cannot be undone).
 */
export async function sendListingState(
  chain: Chain,
  provider: KeyPairSigner,
  input: { listing: Address; providerAgent: Address; state: "Active" | "Paused" | "Retired" },
): Promise<string> {
  const sent = await sendListingStates(chain, provider, input.providerAgent, [input.listing], input.state);
  return sent.get(input.listing)!;
}

/**
 * Listings set in one transaction. Measured in litesvm: 15,871 compute units
 * to pause or retire one, 21,397 to put one back on offer; 8 stay well inside
 * the 250,000 a transaction gets when a priority fee is set.
 */
const LISTINGS_PER_TRANSACTION = 8;

/**
 * Set several of a provider's listings to one state, as few transactions as
 * fit, so the agent pays one fee for all of them instead of one each.
 * Returns each listing's transaction.
 */
export async function sendListingStates(
  chain: Chain,
  provider: KeyPairSigner,
  providerAgent: Address,
  listings: readonly Address[],
  state: "Active" | "Paused" | "Retired",
): Promise<Map<Address, string>> {
  const sent = new Map<Address, string>();
  for (let start = 0; start < listings.length; start += LISTINGS_PER_TRANSACTION) {
    const batch = listings.slice(start, start + LISTINGS_PER_TRANSACTION);
    const instructions = await Promise.all(
      batch.map((listing) => facade.setServiceListingState({ listing, authority: provider, providerAgent, state })),
    );
    const signature = await withListingOperation({ kind: "state", state, listings: batch, lamports: "0" },
      async () => (await chain.clientFor(provider).send(instructions)).signature);
    for (const listing of batch) sent.set(listing, signature);
  }
  return sent;
}

// ------------------------------------------------- stopping for good

/** `AgentRegistration._reserved` of an agent that was retired (`deregister_agent`). */
const RETIRED_IDENTITY_MARKER = [0x52, 0x45, 0x54, 0x44]; // "RETD"

/** True once the agent was retired on the marketplace. It can never take a job again. */
export function isRetiredAgent(agent: AgentRegistration): boolean {
  const reserved = agent.reserved;
  return (
    reserved.length === RETIRED_IDENTITY_MARKER.length &&
    RETIRED_IDENTITY_MARKER.every((byte, index) => reserved[index] === byte)
  );
}

/**
 * Every listing a provider agent has on the marketplace, in any state, with
 * its address. The wallet's own records name the ones it made; this also
 * finds one it replaced or forgot.
 */
export async function listingsOf(
  chain: Chain,
  providerAgent: Address,
): Promise<Array<{ address: Address; listing: ServiceListing }>> {
  const found = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({
    filters: [
      { memcmp: { offset: 0, bytes: Uint8Array.from(getServiceListingDiscriminatorBytes()) } },
      { memcmp: { offset: 8, bytes: Uint8Array.from(getAddressEncoder().encode(providerAgent)) } },
    ],
  });
  const out: Array<{ address: Address; listing: ServiceListing }> = [];
  for (const entry of found) {
    try {
      const listing = getServiceListingDecoder().decode(entry.data);
      if (listing.providerAgent === providerAgent) out.push({ address: entry.address, listing });
    } catch {
      // Not a listing this wallet can read.
    }
  }
  return out;
}

/** Offset of `HireRecord.designated_provider`: discriminator, task, listing, operator, fee, bump. */
const HIRE_DESIGNATED_PROVIDER_OFFSET = 8 + 32 + 32 + 32 + 2 + 1;

/**
 * Hires of a provider's services that nobody has started yet and that can
 * still be done: the buyer paid and waits, and only this provider may take
 * them. A provider that stopped for good could never do them, so the buyer
 * would wait out the whole time to deliver for nothing. One whose time to
 * deliver is over can be done by nobody; its buyer gets the price back.
 */
export async function waitingHires(
  chain: Chain,
  providerAgent: Address,
): Promise<Array<{ task: Address; rewardLamports: bigint }>> {
  const found = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({
    filters: [
      { memcmp: { offset: 0, bytes: Uint8Array.from(getHireRecordDiscriminatorBytes()) } },
      {
        memcmp: {
          offset: HIRE_DESIGNATED_PROVIDER_OFFSET,
          bytes: Uint8Array.from(getAddressEncoder().encode(providerAgent)),
        },
      },
    ],
  });
  const waiting: Array<{ task: Address; rewardLamports: bigint }> = [];
  let now: number | null = null;
  for (const entry of found) {
    let hire: HireRecord;
    try {
      hire = getHireRecordDecoder().decode(entry.data);
    } catch {
      continue;
    }
    if (hire.designatedProvider !== providerAgent) continue;
    const task = await readTask(chain, hire.task);
    if (task === null || Number(task.status) !== TaskStatus.Open) continue;
    now ??= await chain.clusterTime();
    if (task.deadline > 0n && Number(task.deadline) <= now) continue;
    waiting.push({ task: hire.task, rewardLamports: task.rewardAmount });
  }
  return waiting;
}

/**
 * Retire a provider agent on the marketplace (`deregister_agent`): it can
 * never take a job again, and every lamport its record holds above the
 * network's minimum, its deposit for taking jobs, goes back to its wallet.
 * The marketplace refuses while the agent still holds a job.
 */
export async function sendRetireAgent(
  chain: Chain,
  authority: KeyPairSigner,
  agent: Address,
): Promise<string> {
  const result = await chain.clientFor(authority).send([
    await facade.deregisterAgent({ agent, authority }),
  ]);
  return result.signature;
}
