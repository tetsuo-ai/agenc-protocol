#!/usr/bin/env node
// Read-only revision-5 bid-contract cutover inventory.
// Legacy Active bids remain cancellable/expirable but cannot be accepted until
// their bidder refreshes the exact current TaskJobSpec. BoundActive bids carry
// that commitment via the one-way job-spec lock. Accepted legacy contracts are
// a hard cutover review because principal and an active worker obligation exist.

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
import { decodeCanonicalTaskJobSpec } from "./preflight-active-job-spec-block-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const BID_SIZE = 252;
const BOOK_SIZE = 114;
const BID_TERMS_HASH_DOMAIN = Buffer.from("agenc:bid-terms:v1", "utf8");
const BID_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskBid")
  .digest()
  .subarray(0, 8);
const BOOK_DISCRIMINATOR = createHash("sha256")
  .update("account:TaskBidBook")
  .digest()
  .subarray(0, 8);
const BIDDER_MARKET_DISCRIMINATOR = createHash("sha256")
  .update("account:BidderMarketState")
  .digest()
  .subarray(0, 8);

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

function optionPubkey(data, offset, field) {
  if (data[offset] === 0) return { value: null, end: offset + 1 };
  if (data[offset] === 1 && offset + 33 <= data.length) {
    return {
      value: new PublicKey(data.subarray(offset + 1, offset + 33)),
      end: offset + 33,
    };
  }
  throw new Error(`${field}: invalid/truncated Option tag ${data[offset]}`);
}

function requireZero(data, start, end, field) {
  if (!data.subarray(start, end).equals(Buffer.alloc(end - start))) {
    throw new Error(`${field}: allocation padding is nonzero`);
  }
}

export function decodeTaskBid(dataLike) {
  const data = exact(dataLike, BID_SIZE, BID_DISCRIMINATOR, "TaskBid");
  const state = data[240];
  if (state > 2) throw new Error(`TaskBid.state: invalid ${state}`);
  const requestedReward = data.readBigUInt64LE(136);
  const etaSeconds = data.readUInt32LE(144);
  const confidenceBps = data.readUInt16LE(148);
  const reputationSnapshotBps = data.readUInt16LE(150);
  const acceptedNoShowSlashBps = data.readUInt16LE(250);
  const expiresAt = data.readBigInt64LE(216);
  const createdAt = data.readBigInt64LE(224);
  const updatedAt = data.readBigInt64LE(232);
  if (requestedReward === 0n || etaSeconds === 0 || confidenceBps > 10_000) {
    throw new Error("TaskBid: invalid reward/ETA/confidence terms");
  }
  if (
    reputationSnapshotBps > 10_000 ||
    acceptedNoShowSlashBps > 10_000 ||
    createdAt <= 0n ||
    updatedAt < createdAt ||
    expiresAt <= createdAt
  ) {
    throw new Error("TaskBid: invalid snapshot/timestamp terms");
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    bidBook: new PublicKey(data.subarray(40, 72)),
    bidder: new PublicKey(data.subarray(72, 104)),
    bidderAuthority: new PublicKey(data.subarray(104, 136)),
    requestedReward,
    etaSeconds,
    confidenceBps,
    reputationSnapshotBps,
    qualityGuaranteeHash: Buffer.from(data.subarray(152, 184)),
    metadataHash: Buffer.from(data.subarray(184, 216)),
    expiresAt,
    createdAt,
    updatedAt,
    state,
    bondLamports: data.readBigUInt64LE(241),
    bump: data[249],
    acceptedNoShowSlashBps,
  };
}

export function decodeTaskBidBook(dataLike) {
  const data = exact(dataLike, BOOK_SIZE, BOOK_DISCRIMINATOR, "TaskBidBook");
  const state = data[40];
  const policy = data[41];
  if (state > 2 || policy > 2) {
    throw new Error(`TaskBidBook: invalid state/policy ${state}/${policy}`);
  }
  const weights = [42, 44, 46, 48].map((offset) => data.readUInt16LE(offset));
  if (weights.some((value) => value > 10_000)) {
    throw new Error("TaskBidBook: invalid weight");
  }
  if (policy === 2 && weights.reduce((sum, value) => sum + value, 0) !== 10_000) {
    throw new Error("TaskBidBook: weighted policy does not total 10000");
  }
  if (policy !== 2 && weights.some((value) => value !== 0)) {
    throw new Error("TaskBidBook: non-weighted policy carries weights");
  }
  const accepted = optionPubkey(data, 50, "TaskBidBook.accepted_bid");
  const version = data.readBigUInt64LE(accepted.end);
  const totalBids = data.readUInt32LE(accepted.end + 8);
  const activeBids = data.readUInt16LE(accepted.end + 12);
  const createdAt = data.readBigInt64LE(accepted.end + 14);
  const updatedAt = data.readBigInt64LE(accepted.end + 22);
  const bump = data[accepted.end + 30];
  requireZero(data, accepted.end + 31, data.length, "TaskBidBook");
  if (activeBids > totalBids || createdAt <= 0n || updatedAt < createdAt) {
    throw new Error("TaskBidBook: invalid counts/timestamps");
  }
  if (
    (state === 1 && accepted.value === null) ||
    (state === 0 && accepted.value !== null)
  ) {
    throw new Error("TaskBidBook: state/accepted account presence mismatch");
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    state,
    policy,
    weights,
    acceptedBid: accepted.value,
    version,
    totalBids,
    activeBids,
    createdAt,
    updatedAt,
    bump,
  };
}

export function decodeBidderMarketState(dataLike) {
  const data = exact(
    dataLike,
    77,
    BIDDER_MARKET_DISCRIMINATOR,
    "BidderMarketState",
  );
  const bidsCreatedInWindow = data.readUInt16LE(56);
  const activeBidCount = data.readUInt16LE(58);
  const totalBidsCreated = data.readBigUInt64LE(60);
  const totalBidsAccepted = data.readBigUInt64LE(68);
  if (
    activeBidCount > totalBidsCreated ||
    totalBidsAccepted > totalBidsCreated
  ) {
    throw new Error("BidderMarketState: invalid active/total counters");
  }
  return {
    bidder: new PublicKey(data.subarray(8, 40)),
    lastBidCreatedAt: data.readBigInt64LE(40),
    bidWindowStartedAt: data.readBigInt64LE(48),
    bidsCreatedInWindow,
    activeBidCount,
    totalBidsCreated,
    totalBidsAccepted,
    bump: data[76],
  };
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

export function calculateBidTermsHash(taskAddress, bidAddress, bid, jobSpec) {
  return createHash("sha256")
    .update(Buffer.concat([
      BID_TERMS_HASH_DOMAIN,
      taskAddress.toBuffer(),
      bidAddress.toBuffer(),
      bid.task.toBuffer(),
      bid.bidBook.toBuffer(),
      bid.bidder.toBuffer(),
      bid.bidderAuthority.toBuffer(),
      u64(bid.requestedReward),
      u32(bid.etaSeconds),
      u16(bid.confidenceBps),
      u16(bid.reputationSnapshotBps),
      bid.qualityGuaranteeHash,
      bid.metadataHash,
      i64(bid.expiresAt),
      i64(bid.createdAt),
      i64(bid.updatedAt),
      u64(bid.bondLamports),
      u16(bid.acceptedNoShowSlashBps),
      jobSpec.jobSpecHash,
      i64(jobSpec.updatedAt),
    ]))
    .digest();
}

/**
 * Build the exact read-only `[TaskBid, AgentRegistration]` pairs required after
 * the optional dependency-parent prefix of `accept_bid`. Legacy Active bids are
 * still open accounts and must be enumerated even though they cannot win until
 * rebound to the locked job spec.
 */
export function buildAcceptBidCompetitionPairs(records, selectedBidAddress) {
  const selectedKey = selectedBidAddress.toBase58();
  const selected = records.find(
    (record) => record.address.toBase58() === selectedKey,
  );
  if (!selected || (selected.state !== 0 && selected.state !== 2)) {
    throw new Error("selected bid is missing or not open");
  }
  const selectedBook = selected.bidBook.toBase58();
  const pairs = records
    .filter(
      (record) =>
        record.address.toBase58() !== selectedKey &&
        record.bidBook.toBase58() === selectedBook &&
        (record.state === 0 || record.state === 2),
    )
    .sort((left, right) =>
      Buffer.compare(left.address.toBuffer(), right.address.toBuffer()),
    )
    .map((record) => ({ bid: record.address, bidder: record.bidder }));
  const bidKeys = new Set(pairs.map(({ bid }) => bid.toBase58()));
  const bidderKeys = new Set([
    selected.bidder.toBase58(),
    ...pairs.map(({ bidder }) => bidder.toBase58()),
  ]);
  if (
    bidKeys.size !== pairs.length ||
    bidderKeys.size !== pairs.length + 1
  ) {
    throw new Error("open bid inventory contains a duplicate bid or bidder account");
  }
  return pairs;
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

export async function scanBidContracts(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  const blockers = [];
  const [rawBids, rawBooks] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: {
        offset: 0,
        bytes: BID_DISCRIMINATOR.toString("base64"),
        encoding: "base64",
      } }],
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: {
        offset: 0,
        bytes: BOOK_DISCRIMINATOR.toString("base64"),
        encoding: "base64",
      } }],
    }),
  ]);

  const bids = [];
  for (const { pubkey: address, account } of rawBids) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker("invalid-bid-owner", address));
      continue;
    }
    try {
      const bid = decodeTaskBid(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bid"), bid.task.toBuffer(), bid.bidder.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || bid.bump !== bump) {
        throw new Error("canonical TaskBid PDA/bump mismatch");
      }
      if (BigInt(account.lamports) < bid.bondLamports) {
        throw new Error("account lamports below stored bond principal");
      }
      bids.push({ address, lamports: BigInt(account.lamports), ...bid });
    } catch (error) {
      blockers.push(blocker(
        "invalid-bid-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  const books = [];
  for (const { pubkey: address, account } of rawBooks) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker("invalid-bid-book-owner", address));
      continue;
    }
    try {
      const book = decodeTaskBidBook(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bid_book"), book.task.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || book.bump !== bump) {
        throw new Error("canonical TaskBidBook PDA/bump mismatch");
      }
      books.push({ address, ...book });
    } catch (error) {
      blockers.push(blocker(
        "invalid-bid-book-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  const bookMap = new Map(books.map((book) => [book.address.toBase58(), book]));
  const bidderAddresses = [...new Map(
    bids.map((bid) => [bid.bidder.toBase58(), bid.bidder]),
  ).values()];
  const marketAddresses = bidderAddresses.map((bidder) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("bidder_market"), bidder.toBuffer()],
      PROGRAM_ID,
    )[0]);
  const [agentMap, bidderMarketMap] = await Promise.all([
    fetchAccountMap(connection, bidderAddresses),
    fetchAccountMap(connection, marketAddresses),
  ]);
  const bidderStates = new Map();
  for (let index = 0; index < bidderAddresses.length; index++) {
    const bidder = bidderAddresses[index];
    const agentAccount = agentMap.get(bidder.toBase58());
    const marketAddress = marketAddresses[index];
    const marketAccount = bidderMarketMap.get(marketAddress.toBase58());
    let agent = null;
    let market = null;
    let detail = null;
    try {
      if (
        !agentAccount ||
        agentAccount.lamports === 0 ||
        !agentAccount.owner.equals(PROGRAM_ID) ||
        agentAccount.executable === true
      ) {
        throw new Error("bidder AgentRegistration missing or has invalid owner");
      }
      agent = decodeAgentBinding(agentAccount.data);
      const [expectedAgent, agentBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agent.agentId],
        PROGRAM_ID,
      );
      if (!expectedAgent.equals(bidder) || agent.bump !== agentBump) {
        throw new Error("canonical bidder AgentRegistration PDA/bump mismatch");
      }
      if (
        !marketAccount ||
        marketAccount.lamports === 0 ||
        !marketAccount.owner.equals(PROGRAM_ID) ||
        marketAccount.executable === true
      ) {
        throw new Error("BidderMarketState missing or has invalid owner");
      }
      market = decodeBidderMarketState(marketAccount.data);
      const [expectedMarket, marketBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bidder_market"), bidder.toBuffer()],
        PROGRAM_ID,
      );
      if (
        !expectedMarket.equals(marketAddress) ||
        market.bump !== marketBump ||
        !market.bidder.equals(bidder)
      ) {
        throw new Error("canonical BidderMarketState PDA/bump/bidder mismatch");
      }
      const bidderBidCount = bids.filter((bid) => bid.bidder.equals(bidder)).length;
      if (market.activeBidCount !== bidderBidCount) {
        throw new Error(
          `BidderMarketState.active_bid_count=${market.activeBidCount} decoded=${bidderBidCount}`,
        );
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    bidderStates.set(bidder.toBase58(), {
      kind: detail ? "invalid" : "live",
      detail,
      agent,
      market,
      marketAddress,
    });
  }
  const taskAddresses = [...new Map(
    [...books, ...bids].map((item) => [item.task.toBase58(), item.task]),
  ).values()];
  const taskMap = await fetchAccountMap(connection, taskAddresses);
  const taskStates = new Map();
  for (const address of taskAddresses) {
    const account = taskMap.get(address.toBase58());
    if (!account || account.lamports === 0) {
      taskStates.set(address.toBase58(), { kind: "missing" });
      continue;
    }
    try {
      if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
        throw new Error("invalid Task owner/executable state");
      }
      const task = decodeTaskBinding(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || task.bump !== bump) {
        throw new Error("canonical Task PDA/bump mismatch");
      }
      taskStates.set(address.toBase58(), { kind: "live", task });
    } catch (error) {
      taskStates.set(address.toBase58(), {
        kind: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const jobAddresses = taskAddresses.map((task) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("task_job_spec"), task.toBuffer()],
      PROGRAM_ID,
    )[0]);
  const jobMap = await fetchAccountMap(connection, jobAddresses);
  const jobsByTask = new Map();
  for (let index = 0; index < taskAddresses.length; index++) {
    const taskAddress = taskAddresses[index];
    const jobAddress = jobAddresses[index];
    const account = jobMap.get(jobAddress.toBase58());
    if (!account || account.lamports === 0) {
      jobsByTask.set(taskAddress.toBase58(), { kind: "missing", address: jobAddress });
      continue;
    }
    try {
      if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
        throw new Error("invalid TaskJobSpec owner/executable state");
      }
      const job = decodeCanonicalTaskJobSpec(account.data);
      if (!job.task.equals(taskAddress)) throw new Error("TaskJobSpec.task mismatch");
      const [, expectedJobBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("task_job_spec"), taskAddress.toBuffer()],
        PROGRAM_ID,
      );
      if (job.bump !== expectedJobBump) {
        throw new Error("TaskJobSpec.bump mismatch");
      }
      const taskState = taskStates.get(taskAddress.toBase58());
      if (
        taskState?.kind === "live" &&
        !job.creator.equals(taskState.task.creator)
      ) {
        throw new Error("TaskJobSpec.creator mismatch");
      }
      jobsByTask.set(taskAddress.toBase58(), {
        kind: "live",
        address: jobAddress,
        job,
      });
    } catch (error) {
      jobsByTask.set(taskAddress.toBase58(), {
        kind: "invalid",
        address: jobAddress,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const book of books) {
    const linked = bids.filter((bid) => bid.bidBook.equals(book.address));
    if (linked.length !== book.activeBids || linked.length > book.totalBids) {
      blockers.push(blocker(
        "bid-book-count-mismatch",
        book.address,
        `stored_active=${book.activeBids} decoded=${linked.length} total=${book.totalBids}`,
        { task: book.task },
      ));
    }
    if (book.state === 1 && book.acceptedBid) {
      const accepted = linked.find((bid) => bid.address.equals(book.acceptedBid));
      if (!accepted || accepted.state !== 1) {
        blockers.push(blocker(
          "bid-book-accepted-binding-mismatch",
          book.address,
          "accepted_bid is missing or not Accepted",
          { task: book.task },
        ));
      }
    } else if (book.state !== 2 && linked.some((bid) => bid.state === 1)) {
      blockers.push(blocker(
        "bid-book-accepted-binding-mismatch",
        book.address,
        "Accepted TaskBid exists without accepted_bid pointer",
        { task: book.task },
      ));
    }
  }

  const records = [];
  for (const bid of bids) {
    const taskState = taskStates.get(bid.task.toBase58());
    const book = bookMap.get(bid.bidBook.toBase58());
    const jobState = jobsByTask.get(bid.task.toBase58());
    const bidderState = bidderStates.get(bid.bidder.toBase58());
    if (taskState?.kind !== "live") {
      blockers.push(blocker(
        "bid-principal-task-unavailable",
        bid.address,
        taskState?.detail ?? taskState?.kind ?? "lookup missing",
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    } else if (taskState.task.taskType !== 3 || taskState.task.maxWorkers !== 1) {
      blockers.push(blocker(
        "bid-principal-task-structure-invalid",
        bid.address,
        `type=${taskState.task.taskType} max_workers=${taskState.task.maxWorkers}`,
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    }
    if (!book || !book.task.equals(bid.task)) {
      blockers.push(blocker(
        "bid-principal-book-unavailable",
        bid.address,
        "stored TaskBidBook is missing or task-mismatched",
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    }
    if (
      bidderState?.kind !== "live" ||
      !bidderState.agent.authority.equals(bid.bidderAuthority)
    ) {
      blockers.push(blocker(
        "bid-principal-bidder-exit-unavailable",
        bid.address,
        bidderState?.kind !== "live"
          ? bidderState?.detail ?? "bidder state lookup missing"
          : "TaskBid.bidder_authority does not match AgentRegistration.authority",
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    }
    if (jobState?.kind === "invalid") {
      blockers.push(blocker(
        "invalid-bid-job-spec",
        bid.address,
        jobState.detail,
        { task: bid.task },
      ));
    }
    if (bid.state === 2 && (jobState?.kind !== "live" || !jobState.job.bidLocked)) {
      blockers.push(blocker(
        "bound-bid-job-spec-unavailable",
        bid.address,
        `job_spec=${jobState?.kind ?? "missing"} locked=${jobState?.job?.bidLocked ?? false}`,
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    }
    if (bid.state === 1) {
      blockers.push(blocker(
        "accepted-bid-compatibility-review-required",
        bid.address,
        `book_version=${book?.version ?? "missing"} ` +
          `job_spec=${jobState?.kind ?? "missing"} locked=${jobState?.job?.bidLocked ?? false}`,
        { task: bid.task, bondLamports: bid.bondLamports },
      ));
    }
    records.push({
      ...bid,
      bookVersion: book?.version ?? null,
      bookState: book?.state ?? null,
      jobSpec: jobState?.address ?? null,
      jobSpecState: jobState?.kind ?? "missing",
      jobSpecHash: jobState?.job?.jobSpecHash ?? null,
      jobSpecUpdatedAt: jobState?.job?.updatedAt ?? null,
      jobSpecLocked: jobState?.job?.bidLocked ?? false,
      bidTermsHash:
        jobState?.kind === "live"
          ? calculateBidTermsHash(bid.task, bid.address, bid, jobState.job)
          : null,
      bidderIdentityRetired: bidderState?.agent?.retired ?? null,
      bidderStatus: bidderState?.agent?.status ?? null,
      bidderStake: bidderState?.agent?.stake ?? null,
      bidderActiveTasks: bidderState?.agent?.activeTasks ?? null,
      bidderMarket: bidderState?.marketAddress ?? null,
      bidderMarketActiveBidCount: bidderState?.market?.activeBidCount ?? null,
    });
  }

  const openRecords = records.filter(
    (record) => record.state === 0 || record.state === 2,
  );
  return {
    bidCount: rawBids.length,
    bookCount: rawBooks.length,
    decodedBidCount: bids.length,
    decodedBookCount: books.length,
    legacyActiveCount: records.filter((record) => record.state === 0).length,
    boundActiveCount: records.filter((record) => record.state === 2).length,
    acceptedCount: records.filter((record) => record.state === 1).length,
    openBidCount: openRecords.length,
    missingJobSpecCount: records.filter((record) => record.jobSpecState === "missing").length,
    lockedJobSpecCount: records.filter((record) => record.jobSpecLocked).length,
    bondPrincipal: records.reduce((sum, record) => sum + record.bondLamports, 0n),
    legacyActiveBondPrincipal: records
      .filter((record) => record.state === 0)
      .reduce((sum, record) => sum + record.bondLamports, 0n),
    openBidBondPrincipal: openRecords.reduce(
      (sum, record) => sum + record.bondLamports,
      0n,
    ),
    acceptedBondPrincipal: records
      .filter((record) => record.state === 1)
      .reduce((sum, record) => sum + record.bondLamports, 0n),
    openBidPairs: openRecords.map((record) => ({
      bidBook: record.bidBook,
      bid: record.address,
      bidder: record.bidder,
    })),
    books,
    records,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet TaskBid contracts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanBidContracts(new Connection(rpcUrl, "confirmed"));
  console.log(
    `Bid contracts: bids=${result.bidCount} books=${result.bookCount} ` +
      `legacy_active=${result.legacyActiveCount} bound_active=${result.boundActiveCount} ` +
      `accepted=${result.acceptedCount} open=${result.openBidCount} ` +
      `open_bond_principal=${result.openBidBondPrincipal} ` +
      `missing_specs=${result.missingJobSpecCount} ` +
      `locked_specs=${result.lockedJobSpecCount} bond_principal=${result.bondPrincipal} ` +
      `accepted_bond_principal=${result.acceptedBondPrincipal} blockers=${result.blockers.length}`,
  );
  for (const record of result.records) {
    console.warn(
      `  BID state=${record.state}: bid=${record.address.toBase58()} task=${record.task.toBase58()} ` +
        `book=${record.bidBook.toBase58()} book_version=${record.bookVersion ?? "missing"} ` +
        `bond=${record.bondLamports} job_spec=${record.jobSpecState} ` +
        `job_updated_at=${record.jobSpecUpdatedAt ?? "none"} locked=${record.jobSpecLocked} ` +
        `terms_hash=${record.bidTermsHash?.toString("hex") ?? "unavailable"}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: address=${item.address.toBase58()}` +
        `${item.task ? ` task=${item.task.toBase58()}` : ""}` +
        `${item.bondLamports !== undefined ? ` bond=${item.bondLamports}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(`${result.blockers.length} unsafe/malformed bid contract condition(s) found`);
  }
  console.log(
    "PREFLIGHT OK: bid principal remains exit-safe; no accepted legacy contract requires cutover review.",
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
