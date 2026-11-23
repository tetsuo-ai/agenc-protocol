import { balanceChanges, workSimulationMessage } from "./work-simulation.js";
// A whole marketplace in this process, for practice and for tests: the REAL
// compiled marketplace program running in litesvm, play money, a local
// moderator, in-memory hosting, and house providers that actually take and
// deliver jobs through the stock worker runtime.
//
// Nothing here touches a network or real funds. It needs the optional
// `litesvm` native module (loaded only when a sandbox is started).
import { listingDetails } from "./listing-details.js";
import { SERVICE_STATES } from "./client/discovery.js";
import type { ReviewedDelivery } from "./client/reviews.js";
import { resubmissionDeadline } from "./review.js";
import { reviewAnchor, type ReviewAnchor } from "./review-history.js";
import { mkdtempSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import lighthouseFixture from "../testing-assets/lighthouse.so.json";
import { LIGHTHOUSE } from "./contest-assertions.js";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
  getTransactionEncoder,
  lamports,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  createMarketplaceClient,
  facade,
  findAgentPda,
  findClaimPda,
  findHireRecordPda,
  findListingModerationPda,
  findProtocolConfigPda,
  findTaskModerationPda,
  findTaskPda,
  getListingModerationSize,
  getHireRecordDecoder,
  getHireRecordDiscriminatorBytes,
  getProtocolConfigDecoder,
  getProtocolConfigEncoder,
  getServiceListingDecoder,
  getTaskClaimDecoder,
  getTaskDecoder,
  getTaskModerationSize,
  parseAgencCoordinationEvents,
  taskThread,
  values,
  type GpaFilter,
  type ProgramAccountsTransport,
  type Transport,
} from "@tetsuo-ai/marketplace-sdk";
import type { LocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  emptyState,
  bytesToHex as workerHex,
  runTickOnce,
  saveState,
  type WorkerContext,
} from "@tetsuo-ai/agenc-worker";
import {
  BASE_FEE_LAMPORTS,
  sendThroughTransport,
  SYSTEM_PROGRAM_ADDRESS,
  transferInstruction,
  type Chain,
} from "./chain.js";
import { contestEvents } from "./contest-history.js";
import { scopedSendTransport, transportSignal } from "./transport-scope.js";
import { WalletError } from "./errors.js";
import { prepareOutbox, publishingOutbox } from "./outbox.js";
import { sendDisputeTurnDown, sendFrozenRuling } from "./market.js";
import { fixedPrice, type PriceSource } from "./pricing.js";
import { settledDeliveryFromLogs } from "./delivery-history.js";
import { hiredListingFromLogs, settlementFactsFromLogs, settlementOf, type Settlement } from "./settlement.js";
import {
  buildJobSpec,
  decodeResultPointer,
  digestFromPointer,
  sha256Hex,
  type ApprovalPayment,
  type CatalogRow,
  type MarketServices,
} from "./services.js";

/** Play-money exchange rate: one cent is exactly 100,000 lamports. */
export const SANDBOX_USD_PER_SOL = 100;
/** Marketplace fee stamped into the sandbox, matching the live network. */
const SANDBOX_PROTOCOL_FEE_BPS = 500;
/** Stake a provider posts to register, matching the live network. */
const SANDBOX_MIN_AGENT_STAKE = 10_000_000n;
/**
 * House providers only deliver the services they list. They ignore any job
 * paying less than this, which leaves the practice buyer's small public jobs
 * for the person's own earning agent.
 */
const HOUSE_PROVIDER_MIN_REWARD = 1_500_000n;
/** What a practice public job pays (12 cents of play money). */
export const PRACTICE_OPEN_JOB_REWARD = 1_200_000n;

const CLEAN = {
  status: 0,
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32),
  scannerHash: new Uint8Array(32),
  expiresAt: 0n,
} as const;

export interface HouseService {
  name: string;
  category: string;
  /** What the buyer gets, in a sentence. */
  summary: string;
  /** What the buyer is asked to send along. */
  inputs?: readonly string[];
  /** What comes back. */
  outputs?: readonly string[];
  priceLamports: bigint;
  /** Seconds the provider gets to deliver. Default one hour. */
  deliverySecs?: number;
  /** The first line of every delivery this house provider writes. */
  replyPrefix: string;
  /** Take jobs but never deliver them (for trying the refund path). */
  noShow?: boolean;
  /** Send a small picture back with the delivery (for trying a file delivery). */
  picture?: boolean;
}

export interface OpenJob {
  task: Address;
  /** The house buyer approves the delivery, paying whoever did the job. */
  approve(): Promise<void>;
  /**
   * The house buyer turns the delivery down, which puts the price on hold.
   * The provider then has the dispute time (72 hours here too) to dispute
   * it; if it does not, the house buyer is refunded when that time ends. The
   * turn-down always counts on the provider's record.
   */
  turnDown(): Promise<void>;
  /** True once someone has delivered and the job waits for approval. */
  delivered(): Promise<boolean>;
}

export interface Sandbox {
  readonly chain: Chain;
  readonly services: MarketServices;
  readonly prices: PriceSource;
  /** The underlying local marketplace (clock, raw accounts) for tests. */
  readonly market: LocalMarketplace;
  /** Add play money to any address. */
  fund(account: Address, amount: bigint): void;
  /** Register a house provider and list a service it will deliver. */
  addService(service: HouseService): Promise<Address>;
  /** Let every house provider take and deliver one waiting job. */
  workOnce(): Promise<number>;
  /** Post a public job any earning agent may take. */
  postOpenJob(job: {
    title: string;
    instructions: string;
    rewardLamports: bigint;
    deadlineSeconds?: number;
    settlement?: "auto" | "contest";
    minReputation?: number;
    brief?: Record<string, unknown>;
  }): Promise<OpenJob>;
  /** Move the sandbox clock forward. */
  advanceClock(seconds: number): void;
  /**
   * Rule on a delivery its buyer turned down, as the practice marketplace's
   * reviewers. Since revision 9 they rule only on a turn-down the provider
   * disputed, within the ruling time. `payProvider` false sends the price
   * back to the buyer, with the provider's bond.
   */
  ruleOnTurnedDown(input: {
    task: Address;
    /** The claim's worker agent; found from the task's claim when omitted. */
    providerAgent?: Address;
    payProvider: boolean;
  }): Promise<void>;
  /**
   * A house provider disputes the turn-down of its delivery, posting the
   * bond, as a provider's person would. For trying a disputed turn-down.
   */
  disputeTurnDown(input: { task: Address; providerAgent: Address }): Promise<void>;
  /**
   * Suspend an agent, or lift its suspension, as the practice marketplace's
   * owners do (both approve). For trying what a suspended provider may do.
   */
  setAgentSuspended(input: {
    /** The agent; or the one that holds the claim on `task` when omitted. */
    agent?: Address;
    task?: Address;
    suspended: boolean;
  }): Promise<void>;
  /** Deliveries published so far, keyed by fingerprint (tests). */
  readonly deliveries: ReadonlyMap<string, Uint8Array>;
}

function matchesFilter(filter: GpaFilter, data: Uint8Array): boolean {
  if ("dataSize" in filter) return data.length === filter.dataSize;
  const { offset, bytes } = filter.memcmp;
  if (offset + bytes.length > data.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (data[offset + index] !== bytes[index]) return false;
  }
  return true;
}

function envelopeBytes(payload: Record<string, unknown>, payloadHash: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      integrity: { algorithm: "sha256", canonicalization: "json-stable-v1", payloadHash },
      payload,
    }),
  );
}

/** The script a house provider runs: echo a canned reply plus the request. */
const HOUSE_EXECUTOR_SCRIPT = [
  "const [prefix, prompt] = process.argv.slice(1);",
  "let request = '';",
  "const start = prompt.indexOf('--- BEGIN UNTRUSTED JOB SPEC ---');",
  "const end = prompt.indexOf('--- END UNTRUSTED JOB SPEC ---');",
  "if (start !== -1 && end > start) {",
  "  try {",
  "    const doc = JSON.parse(prompt.slice(start + 32, end));",
  "    const spec = doc.payload ?? doc;",
  "    request = String(spec.instructions ?? spec.summary ?? spec.title ?? '');",
  "  } catch {}",
  "}",
  "let reply = prefix + (request ? '\\n\\nYou asked: ' + request : '') + '\\n';",
  // With an outbox, send a small picture along: a file named by its sha-256
  // in the outbox, and listed at the end of the delivery exactly as
  // client/delivery-files.ts writes the list.
  "const [outbox, linkPrefix] = process.argv.slice(3);",
  "if (outbox) {",
  "  const zlib = require('node:zlib');",
  "  const w = 160, h = 100, row = w * 3 + 1;",
  "  const raw = Buffer.alloc(row * h);",
  "  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {",
  "    const at = y * row + 1 + x * 3, sun = Math.hypot(x - 118, y - 30) < 16, hill = y > 62 + 10 * Math.sin(x / 17);",
  "    raw[at] = sun ? 250 : hill ? 60 : 110 + y; raw[at + 1] = sun ? 210 : hill ? 140 - y / 3 : 170 + y / 3; raw[at + 2] = sun ? 90 : hill ? 80 : 235;",
  "  }",
  "  const chunk = (type, data) => {",
  "    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);",
  "    const out = Buffer.alloc(12 + data.length);",
  "    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);",
  "    return out;",
  "  };",
  "  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;",
  "  const picture = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);",
  "  const sha = require('node:crypto').createHash('sha256').update(picture).digest('hex');",
  "  require('node:fs').writeFileSync(require('node:path').join(outbox, sha), picture);",
  "  reply = reply.trimEnd() + '\\n\\n---\\nFiles with this delivery:\\n1. postcard.png (image/png, ' + picture.length + ' bytes)\\n   ' + linkPrefix + sha + '\\n';",
  "}",
  "process.stdout.write(reply);",
].join("\n");

interface HouseProvider {
  signer: KeyPairSigner;
  agent: Address;
  stateDir: string;
  replyPrefix: string;
  noShow: boolean;
  picture: boolean;
}

export interface StartSandboxOptions {
  /** Keep the sandbox clock in step with the real clock. Default true. */
  followWallClock?: boolean;
  /** Folder for the house providers' ledgers. Default a fresh temp folder. */
  workDir?: string;
  /** Inject a transport fault around local execution (tests). */
  transport?: (base: Transport) => Transport;
}

/** Boot a sandbox marketplace. */
export async function startSandbox(options: StartSandboxOptions = {}): Promise<Sandbox> {
  let testing: typeof import("@tetsuo-ai/marketplace-sdk/testing");
  try {
    testing = await import("@tetsuo-ai/marketplace-sdk/testing");
  } catch (error) {
    throw new WalletError(
      "NOT_AVAILABLE",
      "Practice mode needs a component that is not installed on this computer.",
      { cause: error },
    );
  }
  const followWallClock = options.followWallClock ?? true;
  // The sandbox clock starts at the real time either way: the worker runtime
  // compares on-chain deadlines with the machine's clock, as it would live.
  const market = await testing.startLocalMarketplace({
    unixTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  });
  const svm = market.svm;
  svm.addProgram(LIGHTHOUSE, gunzipSync(Buffer.from(lighthouseFixture.gzipBase64, "base64")));
  // litesvm keeps one blockhash and refuses a byte-identical repeat, so the
  // second "give $5" would be dropped as a duplicate. Expiring the blockhash
  // after each send would fix that but break any sender who had already
  // built its transaction. Turning the duplicate check off is the safe way:
  // nothing here re-sends a transaction that was accepted.
  svm.withTransactionHistory(0n);
  const workDir = options.workDir ?? mkdtempSync(path.join(tmpdir(), "agenc-wallet-sandbox-"));

  // The practice marketplace's reviewers. The program wants two approvals
  // for a ruling, so there are two.
  const reviewers = [await generateKeyPairSigner(), await generateKeyPairSigner()];
  for (const reviewer of reviewers) svm.airdrop(reviewer.address, lamports(1_000_000_000n));

  // Stamp the live network's fee and stake so practice numbers are honest.
  {
    const [pda] = await findProtocolConfigPda();
    const account = svm.getAccount(pda);
    if (!account || !account.exists) throw new Error("sandbox protocol config is missing");
    const config = getProtocolConfigDecoder().decode(Uint8Array.from(account.data));
    const data = getProtocolConfigEncoder().encode({
      ...config,
      protocolFeeBps: SANDBOX_PROTOCOL_FEE_BPS,
      minAgentStake: SANDBOX_MIN_AGENT_STAKE,
      // The practice marketplace's own reviewers: the keys that may rule on a
      // delivery its buyer turned down.
      multisigThreshold: reviewers.length,
      multisigOwnersLen: reviewers.length,
      multisigOwners: config.multisigOwners.map(
        (owner, index) => reviewers[index]?.address ?? owner,
      ),
    });
    svm.setAccount({
      address: pda,
      data: data as Uint8Array,
      executable: false,
      lamports: account.lamports,
      programAddress: account.programAddress,
      space: BigInt(data.length),
    });
  }

  const syncClock = (): void => {
    if (!followWallClock) return;
    const clock = svm.getClock();
    const wall = BigInt(Math.floor(Date.now() / 1000));
    if (wall > clock.unixTimestamp) {
      clock.unixTimestamp = wall;
      svm.setClock(clock);
    }
  };

  // litesvm cannot list accounts, so remember every address a transaction
  // names and answer program-account scans from that set.
  const known = new Set<Address>();
  // Which agent each hire was for, and the hire's link on the chain,
  // remembered as the hire is made: the practice marketplace's own list of
  // who did which job. Like the real one, which reads only what is still
  // open on the chain, it no longer names a job once that link is closed
  // (when the job is tidied).
  const hiredFrom = new Map<Address, { provider: Address; link: Address }>();
  const hireDiscriminator = Uint8Array.from(getHireRecordDiscriminatorBytes());
  /** The account's bytes when it is a live hire record, else null. */
  const hireRecordData = (account: Address): Uint8Array | null => {
    const found = svm.getAccount(account);
    if (!found || !found.exists || found.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
    const data = Uint8Array.from(found.data);
    if (data.length < hireDiscriminator.length || hireDiscriminator.some((byte, index) => data[index] !== byte)) return null;
    return data;
  };
  /** A job whose record was compacted into a Completed marker (revision 9). */
  const compactedFinished = (task: Address): boolean => {
    const found = svm.getAccount(task);
    if (!found || !found.exists) return false;
    try {
      const read = facade.decodeTaskAccount({ owner: found.programAddress, data: Uint8Array.from(found.data) });
      return read.kind === "closed" && read.status === "completed";
    } catch {
      return false;
    }
  };
  const rememberHire = (account: Address): void => {
    const data = hireRecordData(account);
    if (data === null) return;
    try {
      const hire = getHireRecordDecoder().decode(data);
      hiredFrom.set(hire.task, { provider: hire.designatedProvider, link: account });
    } catch {
      // Not a hire record after all; nothing to remember.
    }
  };
  // The agent each settled job paid, and the log of the transaction that
  // settled it: the history the live network keeps and litesvm does not.
  const frozenReceipts = new Map<Address, { worker: Address; operator?: Address; logs: readonly string[] }>();
  const settlements = new Map<Address, Settlement>();
  const submissions = new Map<Address, ReviewedDelivery>();
  const reviewEntries = new Map<Address, ReviewAnchor[]>();
  const settledLogs = new Map<Address, readonly string[]>();
  // The log of the transaction that hired each job, which names its service.
  const hireLogs = new Map<Address, readonly string[]>();
  const gpa: ProgramAccountsTransport = {
    async getProgramAccounts({ filters }) {
      const out: Array<{ address: Address; data: Uint8Array }> = [];
      for (const account of known) {
        const found = svm.getAccount(account);
        if (!found || !found.exists) continue;
        if (found.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) continue;
        const data = Uint8Array.from(found.data);
        if (filters.every((filter) => matchesFilter(filter, data))) {
          out.push({ address: account, data });
        }
      }
      return out;
    },
  };
  // LiteSVM history is disabled so identical sandbox transactions can be replayed.
  const contestLogs = new Map<Address, Array<{ signature: string; logs: readonly string[]; changes: import("./contest-history.js").NativeChange[] }>>();
  const landedListingSends = new Set<string>();
  const failedWorkSends = new Set<string>();
  const failedReviewSends = new Set<string>();
  const debits = new Map<string, { payer: Address; fee: bigint; debit: bigint }>();
  const base = market.transport;
  const transport: Transport = {
    ...base,
    getLatestBlockhash: () => base.getLatestBlockhash(),
    async sendAndConfirm(signedTx) {
      const signal = transportSignal();
      signal?.throwIfAborted();
      syncClock();
      const message = getCompiledTransactionMessageDecoder().decode(signedTx.messageBytes);
      const payer = message.staticAccounts[0]!;
      const balances = new Map(message.staticAccounts.map(address => [address, BigInt(svm.getBalance(address) ?? 0)]));
      const before = balances.get(payer)!;
      const result = await base.sendAndConfirm(signedTx).catch(error => {
        if (signal) {
          const signature = getSignatureFromTransaction(signedTx);
          const fee = before - BigInt(svm.getBalance(payer) ?? 0);
          debits.set(signature, { payer, fee, debit: fee });
          failedReviewSends.add(signature);
          failedWorkSends.add(signature);
        }
        throw error;
      });
      if (signal) {
        landedListingSends.add(result.signature);
        debits.set(result.signature, { payer, fee: BASE_FEE_LAMPORTS * BigInt(Object.keys(signedTx.signatures).length),
          debit: before - BigInt(svm.getBalance(payer) ?? 0) });
      }
      const changes = message.staticAccounts.flatMap((address) => {
        const delta = BigInt(svm.getBalance(address) ?? 0n) - balances.get(address)!;
        return delta ? [{ address, lamports: delta.toString() }] : [];
      });
      try {
        for (const account of message.staticAccounts) {
          known.add(account);
          rememberHire(account);
        }
        const instructions = "instructions" in message ? message.instructions : [];
        for (const [index, instruction] of instructions.entries()) {
          const programAddress = message.staticAccounts[instruction.programAddressIndex];
          if (programAddress === undefined) continue;
          const accounts = (instruction.accountIndices ?? []).map((index: number) => message.staticAccounts[index]);
          if (accounts.some((account: Address | undefined) => account === undefined)) continue;
          const subject = accounts[0];
          const previous = instructions[index - 1];
          const memo = previous && { programId: message.staticAccounts[previous.programAddressIndex], accounts: [],
            data: getBase58Decoder().decode(previous.data ?? new Uint8Array()) };
          const anchor = reviewAnchor({ programAddress, accounts: accounts as Address[], data: Uint8Array.from(instruction.data ?? []) }, result.logs, result.signature, {
            fee: BASE_FEE_LAMPORTS * BigInt(Object.keys(signedTx.signatures).length),
            balanceChange: address => BigInt(svm.getBalance(address) ?? 0) - balances.get(address)!,
          }, memo);
          if (anchor?.intendedDelivery && accounts[1]) anchor.appliedDelivery = submissions.get(accounts[1]);
          const claim = accounts[1];
          if (anchor?.action === "change" && subject && claim) {
            const taskAccount = svm.getAccount(subject);
            const claimAccount = svm.getAccount(claim);
            if (taskAccount?.exists && claimAccount?.exists) {
              const due = resubmissionDeadline(getTaskDecoder().decode(taskAccount.data).deadline, getTaskClaimDecoder().decode(claimAccount.data).expiresAt);
              if (due !== null) anchor.deadline = due * 1000;
            }
          }
          if (anchor && claim) reviewEntries.set(claim, [...(reviewEntries.get(claim) ?? []), anchor]);
          const sent = {
            programAddress,
            accounts: accounts as Address[],
            data: Uint8Array.from(instruction.data ?? []),
          };
          const settled = settlementOf(sent);
          if (!settled) {
            const exit = settlementOf(sent, true);
            if (exit) frozenReceipts.set(exit.task, { ...exit, logs: result.logs });
          }
          if (settled !== null) {
            settlements.set(settled.task, settled);
            settledLogs.set(settled.task, result.logs);
          }
        }
        const recorded = new Set<Address>();
        for (const event of parseAgencCoordinationEvents(result.logs)) {
          if (["TaskResultSubmitted", "GhostShareDistributed", "TaskResultRejected", "TaskResultAccepted"].includes(event.eventName) && "task" in event.data) {
            const task = event.data.task as Address;
            if (!recorded.has(task)) {
              const log = contestLogs.get(task) ?? [];
              log.push({ signature: result.signature, logs: result.logs, changes });
              contestLogs.set(task, log);
              recorded.add(task);
            }
          }
          if (event.eventName === "TaskResultSubmitted") submissions.set(event.data.claim, {
            submissionCount: event.data.submissionCount, deliveryHash: Buffer.from(event.data.proofHash).toString("hex"),
          });
          if (event.eventName === "ServiceListingHired") hireLogs.set(event.data.task, result.logs);
        }
      } catch {
        // Indexing is best effort; the transaction itself succeeded.
      }
      return result;
    },
  };

  const readInfo = (account: Address) => {
    const found = svm.getAccount(account);
    if (!found || !found.exists) return null;
    return {
      data: Uint8Array.from(found.data),
      owner: found.programAddress,
      executable: found.executable,
      lamports: BigInt(found.lamports),
    };
  };

  const decorated = options.transport?.(transport) ?? transport;
  const inFlight = new Set<string>();
  const sending = scopedSendTransport({
    ...decorated,
    async sendAndConfirm(tx) {
      const signature = getSignatureFromTransaction(tx);
      inFlight.add(signature);
      try { return await decorated.sendAndConfirm(tx); }
      finally { inFlight.delete(signature); }
    },
  });
  const chain: Chain = {
    network: "sandbox",
    transferFeeLamports: BASE_FEE_LAMPORTS,
    // Local sends execute atomically; no broadcast can arrive after cancellation.
    reviewSendOutcome: async ({ signature }) => landedListingSends.has(signature) ? "landed" :
      failedReviewSends.has(signature) ? "failed" : "expired",
    reviewDebit: async (signature, payer) => {
      const paid = debits.get(signature);
      return paid?.payer === payer ? paid : null;
    },
    listingSendOutcome: async ({ signature }) => landedListingSends.has(signature) ? "landed" : "failed",
    listingSendSettled: async () => true,
    workOutcome: async ({ signature }) => landedListingSends.has(signature) ? "landed" : failedWorkSends.has(signature) ? "failed" : inFlight.has(signature) ? "pending" : "expired",
    async simulateWork(payer, ix) {
      syncClock();
      const { tx, accounts } = workSimulationMessage(payer, ix, svm.latestBlockhash());
      // No await while the practice VM accepts unsigned simulation messages.
      svm.withSigverify(false);
      try {
        const result = svm.simulateTransaction(tx);
        if (!("postAccounts" in result)) return null;
        const post = new Map(result.postAccounts().map(a => [a.address, BigInt(a.lamports)]));
        const before = accounts.map(a => BigInt(svm.getBalance(a) ?? 0n));
        return balanceChanges(accounts, before, accounts.map((a, i) => post.get(a) ?? before[i]!), BASE_FEE_LAMPORTS);
      } finally { svm.withSigverify(true); }
    },
    clientFor: (signer) => createMarketplaceClient({ transport: sending, signer }),
    sendSigned: (transaction) => sendThroughTransport(sending, transaction),
    readAccount: async (account) => readInfo(account)?.data ?? null,
    readRawAccount: async (account) => {
      const info = readInfo(account);
      return info === null ? null : { data: info.data, owner: info.owner, lamports: info.lamports };
    },
    readRawAccounts: async (accounts) =>
      accounts.map((account) => {
        const info = readInfo(account);
        return info === null ? null : { data: info.data, owner: info.owner, lamports: info.lamports };
      }),
    readAccountInfo: async (account) => {
      const info = readInfo(account);
      return info === null
        ? null
        : { data: info.data, owner: info.owner, executable: info.executable };
    },
    getBalance: async (account) => BigInt(svm.getBalance(account) ?? 0n),
    getBalances: async (accounts) => accounts.map((account) => BigInt(svm.getBalance(account) ?? 0n)),
    getMinimumBalanceForRentExemption: async (space) =>
      BigInt(svm.minimumBalanceForRentExemption(BigInt(space))),
    clusterTime: async () => {
      syncClock();
      return Number(svm.getClock().unixTimestamp);
    },
    gpa,
    contestHistory: async (task, since) => {
      const log = contestLogs.get(task) ?? [];
      const fresh = log.slice(log.findIndex(item => item.signature === since) + 1);
      return { cursor: fresh.at(-1)?.signature ?? since, events: fresh.flatMap(item => contestEvents(task, item.logs, item.signature, item.changes)) };
    },
    findSettlementWorker: async (task) => settlements.get(task)?.worker ?? null,
    reviewHistory: async (_task, claim) => ({ entries: reviewEntries.get(claim) ?? [], complete: true }),
    findSettledDelivery: async (task, creator) => {
      const worker = settlements.get(task)?.worker;
      const logs = settledLogs.get(task);
      return worker === undefined || logs === undefined ? null : settledDeliveryFromLogs(logs, task, creator, worker);
    },
    findSettlement: async (task, creator, options) => {
      const exit = options?.includeFrozen ? frozenReceipts.get(task) : undefined;
      const settlement = exit ?? settlements.get(task);
      const logs = exit?.logs ?? settledLogs.get(task);
      if (settlement === undefined || logs === undefined) return null;
      const { worker, operator } = settlement;
      const facts = await settlementFactsFromLogs(logs, task, worker, creator, operator);
      if (facts === null || options?.listing !== true) return facts;
      return { ...facts, listing: hiredListingFromLogs(hireLogs.get(task) ?? [], task, creator, worker) };
    },
  };

  const moderatorClient = chain.clientFor(market.moderator.signer);
  const jobSpecs = new Map<string, Uint8Array>();
  const deliveries = new Map<string, Uint8Array>();
  const threads = new Map<string, taskThread.TaskThreadEnvelope[]>();
  const listed: Array<{
    listing: Address;
    summary: string;
    category: string;
    inputs: string[];
    outputs: string[];
  }> = [];
  const providers: HouseProvider[] = [];

  const resolveAgencUri = async (uri: string): Promise<Uint8Array> => {
    const match = /^agenc:\/\/job-spec\/sha256\/([0-9a-f]{64})$/.exec(uri);
    const body = match ? jobSpecs.get(match[1]!) : undefined;
    if (body === undefined) throw new Error(`unknown sandbox job spec: ${uri}`);
    return body;
  };

  const uploadFetch: typeof fetch = async (_input, init) => {
    const body = init?.body;
    if (!(body instanceof Uint8Array)) return new Response(null, { status: 400 });
    const digest = sha256Hex(body);
    deliveries.set(digest, Uint8Array.from(body));
    return new Response(JSON.stringify({ uri: `agenc://result/sha256/${digest}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const taskThreadTransport: NonNullable<MarketServices["taskThreadTransport"]> = {
    baseUrl: "https://sandbox.invalid",
    async get(route) {
      const task = decodeURIComponent(route.split("/").pop() ?? "");
      return { messages: threads.get(task) ?? [] };
    },
    async post() {
      throw new Error("the sandbox thread is written by the wallet directly");
    },
  };

  /**
   * The practice marketplace's approver works the way the real one does: it
   * signs the approval and hands the transaction to whoever asked, who pays
   * the deposit behind the record and the fee, and sends it. (The house pays
   * for the house's own services and jobs.)
   */
  async function approvalFor(
    payer: Address,
    record: Address,
    recordSpace: number,
    instruction: Instruction,
    payerFundsRecord?: TransactionSigner,
  ): Promise<ApprovalPayment> {
    const moderator = market.moderator.signer;
    const full = BigInt(svm.minimumBalanceForRentExemption(BigInt(recordSpace)));
    const held = readInfo(record);
    // A record that exists is reused; an address somebody already sent money
    // to is topped up to the full deposit; a new record takes all of it. A
    // job's record (revision 9) is funded by its payer as rent payer instead,
    // so no transfer goes to the approver.
    const deposit = payerFundsRecord !== undefined
      ? 0n
      : held === null
        ? full
        : held.owner !== SYSTEM_PROGRAM_ADDRESS || held.lamports >= full
          ? 0n
          : full - held.lamports;
    // One signer object per address: the rent payer and the fee payer of a
    // job's approval are the same wallet.
    const payerSigner = payerFundsRecord ?? createNoopSigner(payer);
    const latest = await transport.getLatestBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) =>
        appendTransactionMessageInstructions(
          deposit > 0n
            ? [transferInstruction(payerSigner, moderator.address, deposit), instruction]
            : [instruction],
          m,
        ),
    );
    // Signed by the approver only: the payer's place is left for the payer.
    const partial = await partiallySignTransactionMessageWithSigners(message);
    return {
      transaction: new Uint8Array(getTransactionEncoder().encode(partial)),
      moderator: moderator.address,
    };
  }

  const services: MarketServices = {
    async listServices(filters) {
      const rows: CatalogRow[] = [];
      for (const entry of listed) {
        const info = readInfo(entry.listing);
        if (info === null) continue;
        const account = getServiceListingDecoder().decode(info.data);
        const state = SERVICE_STATES[Number(account.state)];
        if (state !== (filters?.state ?? "active") || account.priceMint.__option === "Some") continue;
        if (state === "active" && account.maxOpenJobs > 0 && account.openJobs >= account.maxOpenJobs) continue;
        // Like the real catalog, only a service that passed the check is shown.
        const [approval] = await findListingModerationPda({
          listing: entry.listing,
          jobSpecHash: new Uint8Array(account.specHash),
          moderator: market.moderator.address,
        });
        if (readInfo(approval)?.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS) continue;
        rows.push({
          listing: entry.listing,
          ...(state === "active" ? {} : { state }),
          providerAgent: account.providerAgent,
          name: values.decodeListingName(new Uint8Array(account.name)),
          category: entry.category,
          summary: entry.summary,
          description: entry.summary.length > 0 ? entry.summary : null,
          tags: values.decodeListingTags(new Uint8Array(account.tags)),
          listingVersion: account.version.toString(),
          maxOpenJobs: account.maxOpenJobs,
          operatorFeeBps: account.operatorFeeBps,
          operator: account.operator === SYSTEM_PROGRAM_ADDRESS ? null : account.operator,
          inputs: entry.inputs,
          outputs: entry.outputs,
          terms: [],
          // The practice marketplace keeps the words itself; nothing is fetched.
          details: "ready",
          priceLamports: account.price,
          // What a buyer is shown of a service's record is read from the
          // chain and weighed by money (records.ts). The listing's own
          // counters are not: its hire count includes hires never paid for.
          rating: null,
          ratingCount: 0,
          jobsDone: 0,
          deliverySecs:
            account.defaultDeadlineSecs > 0n ? Number(account.defaultDeadlineSecs) : null,
          specHashHex: values.bytesToHex(new Uint8Array(account.specHash)),
        });
      }
      return rows;
    },
    async finishedJobs(provider) {
      // Revision 9: tidying compacts a finished job's record into a marker,
      // so the marketplace keeps the history of finished jobs itself: a hire
      // whose record was compacted after it finished is still named.
      return [...hiredFrom]
        .filter(
          ([task, hire]) =>
            hire.provider === provider && (hireRecordData(hire.link) !== null || compactedFinished(task)),
        )
        .map(([task]) => task);
    },
    async trustedModerators() {
      return [];
    },
    async acquireListingAttestation() {
      throw new WalletError("NOT_AVAILABLE", "That service cannot be hired in practice mode.");
    },
    async publishListing(input) {
      const hash = await values.canonicalJobSpecHash(input.spec);
      if (hash.hex !== input.specHashHex) {
        throw new WalletError("NOT_ALLOWED", "The description does not match the service on offer.");
      }
      jobSpecs.set(hash.hex, envelopeBytes(input.spec, hash.hex));
      return `agenc://job-spec/sha256/${hash.hex}`;
    },
    async publishJobSpec(input) {
      const spec = buildJobSpec(input);
      const hash = await values.canonicalJobSpecHash(spec);
      jobSpecs.set(hash.hex, envelopeBytes(spec, hash.hex));
      return { spec, hashHex: hash.hex, uri: `agenc://job-spec/sha256/${hash.hex}` };
    },
    async attestListing(input) {
      const hash = await values.canonicalJobSpecHash(input.spec);
      if (hash.hex !== input.specHashHex) {
        throw new WalletError("NOT_ALLOWED", "The description does not match the service on offer.");
      }
      const info = readInfo(input.listing);
      if (info === null) throw new WalletError("NETWORK", "The marketplace has not seen that service yet.");
      // Nothing is approved that nobody can read.
      if (!jobSpecs.has(hash.hex)) {
        throw new WalletError("NETWORK", "The description has not been published yet.");
      }
      // The practice catalog lists it like any house service once the
      // approval below has been paid for and recorded.
      const metadata = (input.spec.custom as { listingMetadata?: { longDescription?: unknown } } | undefined)
        ?.listingMetadata;
      const details = listingDetails(input.spec);
      const entry = {
        listing: input.listing,
        summary: typeof metadata?.longDescription === "string" ? metadata.longDescription : "",
        category: typeof input.spec.category === "string" ? input.spec.category : "other",
        inputs: details.inputs,
        outputs: details.outputs,
      };
      const at = listed.findIndex((item) => item.listing === input.listing);
      if (at === -1) listed.push(entry);
      else listed[at] = entry;
      const [record] = await findListingModerationPda({
        listing: input.listing,
        jobSpecHash: hash.bytes,
        moderator: market.moderator.address,
      });
      return approvalFor(
        input.payer,
        record,
        getListingModerationSize(),
        (await facade.recordListingModeration({
          moderator: market.moderator.signer,
          listing: input.listing,
          jobSpecHash: hash.bytes,
          ...CLEAN,
        })) as Instruction,
      );
    },
    async attestTask(input) {
      const hash = await values.canonicalJobSpecHash(input.jobSpec);
      if (hash.hex !== input.jobSpecHashHex) {
        throw new WalletError("NOT_ALLOWED", "The request does not match what was paid for.");
      }
      // Nothing is approved that nobody can read.
      if (!jobSpecs.has(hash.hex)) {
        throw new WalletError("NETWORK", "The request has not been published yet.");
      }
      const [record] = await findTaskModerationPda({
        task: input.task,
        jobSpecHash: hash.bytes,
        moderator: market.moderator.address,
      });
      // Revision 9: the buyer pays the record's rent as its rent payer and
      // gets it back when the finished job is tidied.
      const payerSigner = createNoopSigner(input.payer);
      return approvalFor(
        input.payer,
        record,
        getTaskModerationSize(),
        (await facade.recordTaskModeration({
          moderator: market.moderator.signer,
          rentPayer: payerSigner,
          task: input.task,
          jobSpecHash: hash.bytes,
          ...CLEAN,
        })) as Instruction,
        payerSigner,
      );
    },
    async fetchResult({ proofHashHex, resultData }) {
      const pointed = digestFromPointer(decodeResultPointer(resultData));
      if (pointed !== null && pointed !== proofHashHex) return null;
      const bytes = deliveries.get(proofHashHex);
      return bytes === undefined
        ? null
        : { bytes, uri: null };
    },
    resultUploader() {
      return { url: "https://sandbox.invalid/results", fetch: uploadFetch };
    },
    // Practice deliveries and their files never leave this process.
    fileLinkPrefix: "agenc://artifact/sha256/",
    async fetchFile(sha256Hex) {
      return deliveries.get(sha256Hex) ?? null;
    },
    resolveAgencUri,
    async postChangeRequest(envelope) {
      const bytes = new TextEncoder().encode(taskThread.canonicalEnvelopeJson(envelope));
      deliveries.set(sha256Hex(bytes), bytes);
      const list = threads.get(envelope.taskPda) ?? [];
      list.push(envelope);
      threads.set(envelope.taskPda, list);
    },
    taskThreadTransport,
  };

  function workerContext(provider: HouseProvider): WorkerContext {
    const outboxDir = path.join(provider.stateDir, "outbox");
    if (provider.picture) prepareOutbox(outboxDir);
    return {
      config: {
        capabilities: 1n,
        minRewardLamports: HOUSE_PROVIDER_MIN_REWARD,
        maxRewardLamports: null,
        allowUnboundedReward: true,
        executor: provider.noShow
          ? [process.execPath, "-e", "process.exit(1)", "{prompt}"]
          : [
              process.execPath,
              "-e",
              HOUSE_EXECUTOR_SCRIPT,
              provider.replyPrefix,
              "{prompt}",
              ...(provider.picture ? [outboxDir, services.fileLinkPrefix ?? ""] : []),
            ],
        executorMode: "unsafe",
        executorEnvAllowlist: [],
        resultUploader: "https://sandbox.invalid/results",
        creatorAllowlist: null,
        allowAnyCreator: true,
        endpoint: "https://sandbox.invalid/house",
        executorTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
      },
      client: chain.clientFor(provider.signer),
      signer: provider.signer,
      gpa,
      readAccount: chain.readAccount,
      readAccountInfo: chain.readAccountInfo,
      stateDir: provider.stateDir,
      log: (event) => {
        if (process.env.AGENC_WALLET_SANDBOX_DEBUG === "1") {
          process.stderr.write(`house provider: ${JSON.stringify(event)}\n`);
        }
      },
      getBalance: chain.getBalance,
      getMinimumBalanceForRentExemption: chain.getMinimumBalanceForRentExemption,
      uploadFetch: provider.picture ? publishingOutbox(uploadFetch, outboxDir) : uploadFetch,
      resolveAgencUri,
      taskThreadTransport,
    };
  }

  async function newProvider(replyPrefix: string, noShow: boolean, picture = false): Promise<HouseProvider> {
    const signer = await market.fundedSigner();
    const agentId = values.randomId32();
    await chain.clientFor(signer).registerAgent({
      authority: signer,
      agentId,
      capabilities: 1n,
      endpoint: "https://sandbox.invalid/house",
      metadataUri: null,
      stakeAmount: SANDBOX_MIN_AGENT_STAKE,
    });
    const [agent] = await findAgentPda({ agentId });
    const stateDir = path.join(workDir, `house-${providers.length}`);
    const state = emptyState();
    state.agentIdHex = workerHex(agentId);
    saveState(stateDir, state);
    const provider = { signer, agent, stateDir, replyPrefix, noShow, picture };
    providers.push(provider);
    return provider;
  }

  /** The agent that holds the claim on `task`. */
  async function claimWorker(task: Address): Promise<Address> {
    const { getTaskClaimDecoder, getTaskClaimDiscriminatorBytes } = await import(
      "@tetsuo-ai/marketplace-sdk"
    );
    const claims = await gpa.getProgramAccounts({
      filters: [
        { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskClaimDiscriminatorBytes()) } },
      ],
    });
    const worker = claims
      .map((entry) => getTaskClaimDecoder().decode(entry.data))
      .find((entry) => entry.task === task)?.worker;
    if (worker === undefined) throw new Error("nobody holds a claim on that job");
    return worker;
  }

  return {
    chain,
    services,
    prices: fixedPrice(SANDBOX_USD_PER_SOL),
    market,
    deliveries,
    fund(account, amount) {
      svm.airdrop(account, lamports(amount));
    },
    advanceClock(seconds) {
      const clock = svm.getClock();
      clock.unixTimestamp += BigInt(seconds);
      svm.setClock(clock);
    },
    async ruleOnTurnedDown({ task, providerAgent, payProvider }) {
      const worker = providerAgent ?? (await claimWorker(task));
      await sendFrozenRuling(chain, reviewers, task, worker, payProvider);
    },
    async disputeTurnDown({ task, providerAgent }) {
      const provider = providers.find((entry) => entry.agent === providerAgent);
      if (provider === undefined) throw new Error("that is not a house provider");
      await sendDisputeTurnDown(chain, provider.signer, task, providerAgent);
    },
    async setAgentSuspended({ agent: named, task, suspended }) {
      const agent = named ?? (await claimWorker(task!));
      const proposer = reviewers[0]!;
      const instruction = suspended
        ? await facade.suspendAgent({ agent, authority: proposer, multisigSigners: reviewers })
        : await facade.unsuspendAgent({ agent, authority: proposer, multisigSigners: reviewers });
      await chain.clientFor(proposer).send([instruction]);
    },

    async addService(service) {
      const provider = await newProvider(service.replyPrefix, service.noShow === true, service.picture === true);
      const listingId = values.randomId32();
      const metadata = { name: service.name, summary: service.summary };
      const specHash = (await values.canonicalJobSpecHash(metadata)).bytes;
      jobSpecs.set(values.bytesToHex(specHash), envelopeBytes(metadata, values.bytesToHex(specHash)));
      await chain.clientFor(provider.signer).createServiceListing({
        providerAgent: provider.agent,
        authority: provider.signer,
        listingId,
        name: service.name,
        category: service.category as never,
        tags: [],
        specHash,
        specUri: `agenc://job-spec/sha256/${values.bytesToHex(specHash)}`,
        price: service.priceLamports,
        priceMint: null,
        requiredCapabilities: 1n,
        defaultDeadlineSecs: BigInt(service.deliverySecs ?? 3_600),
        maxOpenJobs: 0,
        operator: null,
        operatorFeeBps: 0,
      });
      const [listing] = await facade.findListingPda({
        providerAgent: provider.agent,
        listingId,
      });
      await moderatorClient.send([
        await facade.recordListingModeration({
          moderator: market.moderator.signer,
          listing,
          jobSpecHash: specHash,
          ...CLEAN,
        }),
      ]);
      listed.push({
        listing,
        summary: service.summary,
        category: service.category,
        inputs: [...(service.inputs ?? [])],
        outputs: [...(service.outputs ?? [])],
      });
      return listing;
    },

    async workOnce() {
      let delivered = 0;
      for (const provider of providers) {
        const tick = await runTickOnce(workerContext(provider));
        if (tick.outcome?.status === "submitted") delivered += 1;
      }
      return delivered;
    },

    async postOpenJob(job) {
      const buyer = await market.fundedSigner();
      const client = chain.clientFor(buyer);
      const agentId = values.randomId32();
      await client.registerAgent({
        authority: buyer,
        agentId,
        capabilities: 1n,
        endpoint: "https://sandbox.invalid/buyer",
        metadataUri: null,
        stakeAmount: SANDBOX_MIN_AGENT_STAKE,
      });
      const [creatorAgent] = await findAgentPda({ agentId });
      const payload = { title: job.title, ...(job.brief ?? { instructions: job.instructions }) };
      const hash = await values.canonicalJobSpecHash(payload);
      const description = new Uint8Array(64);
      description.set(hash.bytes, 0);
      const taskId = values.randomId32();
      syncClock();
      const now = svm.getClock().unixTimestamp;
      await client.send([
        await facade.createTask({
          authority: buyer,
          creator: buyer,
          creatorAgent,
          taskId,
          requiredCapabilities: 1n,
          description,
          rewardAmount: job.rewardLamports,
          maxWorkers: job.settlement === "contest" ? 3 : 1,
          deadline: now + BigInt(job.deadlineSeconds ?? 3_600),
          taskType: job.settlement === "contest" ? 2 : 0,
          constraintHash: null,
          minReputation: job.minReputation ?? 0,
          rewardMintArg: null,
        }),
      ]);
      const [task] = await findTaskPda({ creator: buyer.address, taskId });
      const [hireRecord] = await findHireRecordPda({ task });
      if (job.settlement !== "auto") await client.send([
        await facade.configureTaskValidation({
          task,
          creator: buyer,
          hireRecord,
          mode: 1,
          reviewWindowSecs: 3_600n,
          validatorQuorum: 0,
          attestor: null,
        }),
      ]);
      jobSpecs.set(hash.hex, envelopeBytes(payload, hash.hex));
      await moderatorClient.send([
        await facade.recordTaskModeration({
          moderator: market.moderator.signer,
          task,
          jobSpecHash: hash.bytes,
          ...CLEAN,
        }),
      ]);
      await client.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash: hash.bytes,
        jobSpecUri: `agenc://job-spec/sha256/${hash.hex}`,
        moderator: market.moderator.address,
      });
      async function practiceDelivery(worker: Address): Promise<ReviewedDelivery> {
        const { readSubmission } = await import("./market.js");
        const submission = await readSubmission(chain, task, worker);
        if (!submission) throw new Error("No practice delivery to review");
        return { submissionCount: submission.account.submissionCount, deliveryHash: Buffer.from(submission.account.proofHash).toString("hex") };
      }
      return {
        task,
        async delivered() {
          const { readTask } = await import("./market.js");
          const account = await readTask(chain, task);
          // TaskStatus.PendingValidation
          return account !== null && Number(account.status) === 2;
        },
        async approve() {
          const { sendApproval, readTask } = await import("./market.js");
          const account = await readTask(chain, task);
          if (account === null) throw new Error("sandbox job vanished");
          // Exactly one worker took the job; find its claim through the gPA set.
          const { getTaskClaimDecoder, getTaskClaimDiscriminatorBytes } = await import(
            "@tetsuo-ai/marketplace-sdk"
          );
          const claims = await gpa.getProgramAccounts({
            filters: [
              { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskClaimDiscriminatorBytes()) } },
            ],
          });
          const claim = claims
            .map((entry) => getTaskClaimDecoder().decode(entry.data))
            .find((entry) => entry.task === task);
          if (claim === undefined) throw new Error("nobody has taken the sandbox job");
          await sendApproval(chain, buyer, task, claim.worker, await practiceDelivery(claim.worker));
        },
        async turnDown() {
          const { sendRejectAndFreeze } = await import("./market.js");
          const { getTaskClaimDecoder, getTaskClaimDiscriminatorBytes } = await import(
            "@tetsuo-ai/marketplace-sdk"
          );
          const claims = await gpa.getProgramAccounts({
            filters: [
              { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskClaimDiscriminatorBytes()) } },
            ],
          });
          const claim = claims
            .map((entry) => getTaskClaimDecoder().decode(entry.data))
            .find((entry) => entry.task === task);
          if (claim === undefined) throw new Error("nobody has taken the sandbox job");
          const reason = (await values.sha256(`house buyer turned down ${task}`)) as Uint8Array;
          await sendRejectAndFreeze(chain, buyer, task, claim.worker, reason, undefined, await practiceDelivery(claim.worker));
        },
      };
    },
  };
}

/** A small shelf of house services for practice mode. */
export const PRACTICE_SERVICES: readonly HouseService[] = [
  {
    name: "Haiku Writer",
    category: "writing",
    summary: "A three-line poem about anything you name.",
    inputs: ["What the poem is about"],
    outputs: ["One haiku"],
    priceLamports: 2_000_000n,
    replyPrefix: "Quiet keys at dawn\na small job crosses the wire\npaid before the tea",
  },
  {
    name: "Plain English Summary",
    category: "writing",
    summary: "A short, plain summary of the text you send.",
    inputs: ["The text to sum up", "How long the summary should be"],
    outputs: ["A summary in plain words"],
    priceLamports: 5_000_000n,
    replyPrefix: "Summary: this is a practice delivery. In practice mode the provider repeats your request so you can see the whole trip.",
  },
  {
    name: "Name Ideas",
    category: "marketing",
    summary: "Ten name ideas for a product, pet or project.",
    inputs: ["What needs a name", "The feeling the name should give"],
    outputs: ["Ten name ideas"],
    priceLamports: 8_000_000n,
    replyPrefix: "Ten ideas: Northlight, Pebble, Juniper, Tandem, Lumen, Fable, Harbor, Quill, Ember, Atlas.",
  },
  {
    name: "Postcard Picture",
    category: "image-gen",
    summary: "A small picture sent back as a file, so you can see how a picture delivery looks.",
    inputs: ["What the postcard is for"],
    outputs: ["One picture"],
    priceLamports: 6_000_000n,
    replyPrefix: "Here is your postcard. It is a practice picture: every practice order gets the same one.",
    picture: true,
  },
];
