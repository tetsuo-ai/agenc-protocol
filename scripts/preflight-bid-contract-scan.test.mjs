import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  buildAcceptBidCompetitionPairs,
  calculateBidTermsHash,
  decodeBidderMarketState,
  decodeTaskBid,
  decodeTaskBidBook,
  scanBidContracts,
} from "./preflight-bid-contract-scan.mjs";
import { decodeCanonicalTaskJobSpec } from "./preflight-active-job-spec-block-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture(marker = 191) {
  const taskId = Buffer.alloc(32, marker);
  const creator = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(50_000n, 176);
  data[184] = 1;
  data[186] = 0;
  data[187] = 3;
  data[310] = bump;
  data[313] = 0;
  data[314] = 0;
  data.writeUInt16LE(0, 315);
  data[317] = 0;
  return { address, creator, data };
}

function bookFixture(
  task,
  { state = 0, acceptedBid = null, activeBids = 1, totalBids = activeBids } = {},
) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid_book"), task.address.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(114);
  disc("TaskBidBook").copy(data);
  task.address.toBuffer().copy(data, 8);
  data[40] = state;
  data[41] = 0;
  let end;
  if (acceptedBid) {
    data[50] = 1;
    acceptedBid.toBuffer().copy(data, 51);
    end = 83;
  } else {
    data[50] = 0;
    end = 51;
  }
  data.writeBigUInt64LE(1n, end);
  data.writeUInt32LE(totalBids, end + 8);
  data.writeUInt16LE(activeBids, end + 12);
  data.writeBigInt64LE(100n, end + 14);
  data.writeBigInt64LE(101n, end + 22);
  data[end + 30] = bump;
  return { address, data };
}

function bidFixture(
  task,
  book,
  { state = 0, marker = 193, acceptedNoShowSlashBps = 1_000 } = {},
) {
  const agentId = Buffer.alloc(32, marker);
  const [bidder, bidderBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const bidderAuthority = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid"), task.address.toBuffer(), bidder.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(252);
  disc("TaskBid").copy(data);
  task.address.toBuffer().copy(data, 8);
  book.address.toBuffer().copy(data, 40);
  bidder.toBuffer().copy(data, 72);
  bidderAuthority.toBuffer().copy(data, 104);
  data.writeBigUInt64LE(40_000n, 136);
  data.writeUInt32LE(3_600, 144);
  data.writeUInt16LE(9_000, 148);
  data.writeUInt16LE(5_000, 150);
  Buffer.alloc(32, 195).copy(data, 152);
  Buffer.alloc(32, 196).copy(data, 184);
  data.writeBigInt64LE(1_000n, 216);
  data.writeBigInt64LE(100n, 224);
  data.writeBigInt64LE(101n, 232);
  data[240] = state;
  data.writeBigUInt64LE(5_000n, 241);
  data[249] = bump;
  data.writeUInt16LE(acceptedNoShowSlashBps, 250);
  return { address, data, agentId, bidder, bidderBump, bidderAuthority, state };
}

function identityFixtures(bid, activeBidCount = 1) {
  const agent = Buffer.alloc(566);
  disc("AgentRegistration").copy(agent);
  bid.agentId.copy(agent, 8);
  bid.bidderAuthority.toBuffer().copy(agent, 40);
  agent[80] = 1;
  agent.writeUInt32LE(0, 81);
  agent.writeUInt32LE(0, 85);
  agent.writeBigInt64LE(100n, 89);
  agent[133] = bid.bidderBump;

  const [marketAddress, marketBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("bidder_market"), bid.bidder.toBuffer()],
    PROGRAM_ID,
  );
  const market = Buffer.alloc(77);
  disc("BidderMarketState").copy(market);
  bid.bidder.toBuffer().copy(market, 8);
  market.writeBigInt64LE(100n, 40);
  market.writeBigInt64LE(100n, 48);
  market.writeUInt16LE(1, 56);
  market.writeUInt16LE(activeBidCount, 58);
  market.writeBigUInt64LE(BigInt(activeBidCount), 60);
  market.writeBigUInt64LE(bid.state === 1 ? 1n : 0n, 68);
  market[76] = marketBump;
  return {
    agent: { address: bid.bidder, data: agent },
    market: { address: marketAddress, data: market },
  };
}

function jobFixture(task, locked = true) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_job_spec"), task.address.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(388);
  disc("TaskJobSpec").copy(data);
  task.address.toBuffer().copy(data, 8);
  task.creator.toBuffer().copy(data, 40);
  Buffer.alloc(32, 197).copy(data, 72);
  const uri = Buffer.from("agenc://job-spec/bid", "utf8");
  data.writeUInt32LE(uri.length, 104);
  uri.copy(data, 108);
  const end = 108 + uri.length;
  data.writeBigInt64LE(100n, end);
  data.writeBigInt64LE(101n, end + 8);
  data[end + 16] = bump;
  data[end + 17] = locked ? 1 : 0;
  return { address, data };
}

function info(data, lamports = 2_000_000) {
  return { owner: PROGRAM_ID, executable: false, data, lamports };
}

function connectionFor({
  tasks = [],
  books = [],
  bids = [],
  jobs = [],
  withIdentities = true,
} = {}) {
  const identities = withIdentities ? bids.flatMap((bid) => {
    const count = bids.filter((other) => other.bidder.equals(bid.bidder)).length;
    const value = identityFixtures(bid, count);
    return [value.agent, value.market];
  }) : [];
  const fetched = new Map([
    ...tasks.map((item) => [item.address.toBase58(), info(item.data)]),
    ...jobs.map((item) => [item.address.toBase58(), info(item.data)]),
    ...identities.map((item) => [item.address.toBase58(), info(item.data)]),
  ]);
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("TaskBid"))) {
        return bids.map((item) => ({
          pubkey: item.address,
          account: info(item.data, 2_005_000),
        }));
      }
      if (wanted.equals(disc("TaskBidBook"))) {
        return books.map((item) => ({ pubkey: item.address, account: info(item.data) }));
      }
      return [];
    },
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => fetched.get(address.toBase58()) ?? null),
  };
}

test("exact-decodes bid state offset and bid-book dynamic option tail", () => {
  const task = taskFixture();
  const provisionalBook = bookFixture(task);
  const bid = bidFixture(task, provisionalBook, { state: 2 });
  const acceptedBook = bookFixture(task, {
    state: 1,
    acceptedBid: bid.address,
  });
  assert.equal(decodeTaskBid(bid.data).state, 2);
  assert.equal(decodeTaskBid(bid.data).acceptedNoShowSlashBps, 1_000);
  assert.equal(
    decodeBidderMarketState(identityFixtures(bid).market.data).activeBidCount,
    1,
  );
  assert.equal(
    decodeTaskBidBook(acceptedBook.data).acceptedBid.toBase58(),
    bid.address.toBase58(),
  );
  assert.throws(
    () => decodeTaskBid(bid.data.subarray(0, 250)),
    /unexpected size 250; expected 252/,
  );
  const invalidSlash = Buffer.from(bid.data);
  invalidSlash.writeUInt16LE(10_001, 250);
  assert.throws(
    () => decodeTaskBid(invalidSlash),
    /invalid snapshot\/timestamp terms/,
  );
});

test("legacy Active bid is refundable inventory even without a job spec", async () => {
  const task = taskFixture();
  const book = bookFixture(task);
  const bid = bidFixture(task, book, { state: 0 });
  const result = await scanBidContracts(
    connectionFor({ tasks: [task], books: [book], bids: [bid] }),
  );
  assert.equal(result.legacyActiveCount, 1);
  assert.equal(result.openBidCount, 1);
  assert.equal(result.missingJobSpecCount, 1);
  assert.equal(result.legacyActiveBondPrincipal, 5_000n);
  assert.equal(result.openBidBondPrincipal, 5_000n);
  assert.deepEqual(result.blockers, []);
});

test("BoundActive requires the canonical one-way locked job contract", async () => {
  const task = taskFixture();
  const book = bookFixture(task);
  const bid = bidFixture(task, book, { state: 2 });
  let job = jobFixture(task, false);
  let result = await scanBidContracts(
    connectionFor({ tasks: [task], books: [book], bids: [bid], jobs: [job] }),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "bound-bid-job-spec-unavailable"),
  );

  job = jobFixture(task, true);
  result = await scanBidContracts(
    connectionFor({ tasks: [task], books: [book], bids: [bid], jobs: [job] }),
  );
  assert.equal(result.boundActiveCount, 1);
  assert.equal(result.openBidCount, 1);
  assert.equal(result.openBidBondPrincipal, 5_000n);
  assert.equal(result.records[0].bidTermsHash.length, 32);
  assert.deepEqual(result.blockers, []);
});

test("builds deterministic exact bid/AgentRegistration competition pairs", async () => {
  const task = taskFixture();
  const book = bookFixture(task, { activeBids: 2 });
  const selected = bidFixture(task, book, { state: 2, marker: 193 });
  const competitor = bidFixture(task, book, { state: 2, marker: 201 });
  const job = jobFixture(task, true);
  const result = await scanBidContracts(
    connectionFor({
      tasks: [task],
      books: [book],
      bids: [selected, competitor],
      jobs: [job],
    }),
  );

  assert.deepEqual(result.blockers, []);
  assert.equal(result.openBidPairs.length, 2);
  assert.equal(result.openBidCount, 2);
  assert.equal(result.openBidBondPrincipal, 10_000n);
  assert.deepEqual(
    buildAcceptBidCompetitionPairs(result.records, selected.address).map(
      ({ bid, bidder }) => [bid.toBase58(), bidder.toBase58()],
    ),
    [[competitor.address.toBase58(), competitor.bidder.toBase58()]],
  );
  assert.throws(
    () => buildAcceptBidCompetitionPairs(result.records, PublicKey.unique()),
    /missing or not open/,
  );
});

test("terms digest commits every appended economic snapshot term", () => {
  const task = taskFixture();
  const book = bookFixture(task);
  const rawBid = bidFixture(task, book, { state: 2 });
  const job = decodeCanonicalTaskJobSpec(jobFixture(task, true).data);
  const bid = decodeTaskBid(rawBid.data);
  const first = calculateBidTermsHash(task.address, rawBid.address, bid, job);
  const changed = { ...bid, requestedReward: bid.requestedReward + 1n };
  const second = calculateBidTermsHash(task.address, rawBid.address, changed, job);
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(
    first,
    calculateBidTermsHash(
      task.address,
      rawBid.address,
      { ...bid, bondLamports: bid.bondLamports + 1n },
      job,
    ),
  );
  assert.notDeepEqual(
    first,
    calculateBidTermsHash(
      task.address,
      rawBid.address,
      {
        ...bid,
        acceptedNoShowSlashBps: bid.acceptedNoShowSlashBps + 1,
      },
      job,
    ),
  );
  assert.notDeepEqual(
    first,
    calculateBidTermsHash(
      task.address,
      rawBid.address,
      { ...bid, bidBook: PublicKey.unique() },
      job,
    ),
  );
});

test("terms digest matches the fixed Rust and SDK golden vector", () => {
  const task = new PublicKey(Buffer.alloc(32, 1));
  const bidAddress = new PublicKey(Buffer.alloc(32, 2));
  const bid = {
    task,
    bidBook: new PublicKey(Buffer.alloc(32, 3)),
    bidder: new PublicKey(Buffer.alloc(32, 4)),
    bidderAuthority: new PublicKey(Buffer.alloc(32, 5)),
    requestedReward: 1_000n,
    etaSeconds: 3_600,
    confidenceBps: 8_000,
    reputationSnapshotBps: 9_000,
    qualityGuaranteeHash: Buffer.alloc(32, 6),
    metadataHash: Buffer.alloc(32, 7),
    expiresAt: 1_700_000_000n,
    createdAt: 1_699_000_000n,
    updatedAt: 1_699_500_000n,
    bondLamports: 50_000n,
    acceptedNoShowSlashBps: 625,
  };
  const job = {
    jobSpecHash: Buffer.alloc(32, 8),
    updatedAt: 42n,
  };

  assert.equal(
    calculateBidTermsHash(task, bidAddress, bid, job).toString("hex"),
    "e5970db9eb02a75ed66d2370b4e907d5aab4a3ace7d8dc181e23397a2264c7e5",
  );
});

test("Accepted bid always requires explicit cutover compatibility review", async () => {
  const task = taskFixture();
  const provisionalBook = bookFixture(task);
  const bid = bidFixture(task, provisionalBook, { state: 1 });
  const book = bookFixture(task, { state: 1, acceptedBid: bid.address });
  // Rebind the bid to the final book address (same canonical address).
  const job = jobFixture(task, false);
  const result = await scanBidContracts(
    connectionFor({ tasks: [task], books: [book], bids: [bid], jobs: [job] }),
  );
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.acceptedBondPrincipal, 5_000n);
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "accepted-bid-compatibility-review-required",
    ),
  );
});

test("fails closed on book counters that cannot account for bonded bids", async () => {
  const task = taskFixture();
  const book = bookFixture(task, { activeBids: 0 });
  const bid = bidFixture(task, book);
  const result = await scanBidContracts(
    connectionFor({ tasks: [task], books: [book], bids: [bid] }),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "bid-book-count-mismatch"),
  );
});

test("blocks bonded bid principal when bidder exit identity state is unavailable", async () => {
  const task = taskFixture();
  const book = bookFixture(task);
  const bid = bidFixture(task, book);
  const result = await scanBidContracts(
    connectionFor({
      tasks: [task],
      books: [book],
      bids: [bid],
      withIdentities: false,
    }),
  );
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "bid-principal-bidder-exit-unavailable",
    ),
  );
});

test("empty live bid surface is valid and non-mainnet is rejected first", async () => {
  let result = await scanBidContracts(connectionFor());
  assert.equal(result.bidCount, 0);
  assert.equal(result.bookCount, 0);
  assert.equal(result.openBidCount, 0);
  assert.equal(result.openBidBondPrincipal, 0n);
  assert.deepEqual(result.blockers, []);

  let enumerated = false;
  await assert.rejects(
    scanBidContracts({
      getGenesisHash: async () => "devnet",
      getProgramAccounts: async () => {
        enumerated = true;
        return [];
      },
    }),
    /wrong cluster genesis/,
  );
  assert.equal(enumerated, false);
});
