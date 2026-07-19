import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  decodeHireRecordProvider,
  decodeServiceListingProvider,
  scanHireProviderBindings,
} from "./preflight-hire-provider-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({ status = 0 } = {}) {
  const taskId = Buffer.alloc(32, 91);
  const creator = new PublicKey(Buffer.alloc(32, 92));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(1_000n, 176);
  data[184] = 1;
  data[185] = status === 0 ? 0 : 1;
  data[186] = status;
  data[187] = 0;
  data[309] = 1;
  data[310] = bump;
  data[313] = 0;
  data[314] = 0;
  data.writeUInt16LE(0, 315);
  data[317] = 0;
  return { address, data };
}

function listingFixture({ openJobs = 1, maxOpenJobs = 0, totalHires = 1n } = {}) {
  const provider = new PublicKey(Buffer.alloc(32, 93));
  const listingId = Buffer.alloc(32, 94);
  const data = Buffer.alloc(697);
  disc("ServiceListing").copy(data);
  provider.toBuffer().copy(data, 8);
  listingId.copy(data, 72);
  const uri = Buffer.from("agenc://spec/fixture", "utf8");
  data.writeUInt32LE(uri.length, 264);
  uri.copy(data, 268);
  const uriEnd = 268 + uri.length;
  data.writeBigUInt64LE(1_000n, uriEnd);
  data[uriEnd + 8] = 0;
  const optionEnd = uriEnd + 9;
  data[optionEnd + 50] = 0;
  data.writeUInt16LE(maxOpenJobs, optionEnd + 51);
  data.writeUInt16LE(openJobs, optionEnd + 53);
  data.writeBigUInt64LE(totalHires, optionEnd + 55);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("service_listing"), provider.toBuffer(), listingId],
    PROGRAM_ID,
  );
  data[optionEnd + 99] = bump;
  return { address, data, provider };
}

function hireFixture(task, listing, designatedProvider) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("hire"), task.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(173);
  disc("HireRecord").copy(data);
  task.toBuffer().copy(data, 8);
  listing.toBuffer().copy(data, 40);
  data[106] = bump;
  designatedProvider.toBuffer().copy(data, 107);
  return { address, data };
}

function account(data, owner = PROGRAM_ID, overrides = {}) {
  return {
    owner,
    data,
    lamports: 2_000_000,
    executable: false,
    ...overrides,
  };
}

function scenario({
  status = 0,
  designated = "provider",
  openJobs = 1,
  maxOpenJobs = 0,
  totalHires = 1n,
} = {}) {
  const task = taskFixture({ status });
  const listing = listingFixture({ openJobs, maxOpenJobs, totalHires });
  const designatedProvider =
    designated === "provider"
      ? listing.provider
      : designated === "default"
        ? PublicKey.default
        : new PublicKey(Buffer.alloc(32, 95));
  const hire = hireFixture(task.address, listing.address, designatedProvider);
  const records = new Map([
    [task.address.toBase58(), account(task.data)],
    [listing.address.toBase58(), account(listing.data)],
  ]);
  return { task, listing, hire, records };
}

function connectionFor(value, overrides = {}) {
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async () => [
      {
        pubkey: value.hire.address,
        account: account(
          overrides.hireData ?? value.hire.data,
          overrides.hireOwner ?? PROGRAM_ID,
        ),
      },
    ],
    getMultipleAccountsInfo: async (addresses) => {
      const records = overrides.records ?? value.records;
      return addresses.map(
        (address) => records.get(address.toBase58()) ?? null,
      );
    },
  };
}

test("decodes exact HireRecord carve-out and dynamic ServiceListing tail", () => {
  const value = scenario();
  const hire = decodeHireRecordProvider(value.hire.data);
  assert.equal(hire.task.toBase58(), value.task.address.toBase58());
  assert.equal(hire.listing.toBase58(), value.listing.address.toBase58());
  assert.equal(
    hire.designatedProvider.toBase58(),
    value.listing.provider.toBase58(),
  );

  const listing = decodeServiceListingProvider(value.listing.data);
  assert.equal(listing.providerAgent.toBase58(), value.listing.provider.toBase58());
  assert.equal(listing.state, 0);
  assert.equal(listing.openJobs, 1);
  assert.equal(listing.totalHires, 1n);
});

test("zero-fee nondefault payees remain valid inactive snapshots", () => {
  const value = scenario();
  const inactivePayee = new PublicKey(Buffer.alloc(32, 96));

  const hireData = Buffer.from(value.hire.data);
  inactivePayee.toBuffer().copy(hireData, 72);
  const hire = decodeHireRecordProvider(hireData);
  assert.equal(hire.operator.toBase58(), inactivePayee.toBase58());
  assert.equal(hire.operatorFeeBps, 0);

  const listingData = Buffer.from(value.listing.data);
  const uriEnd = 268 + listingData.readUInt32LE(264);
  const priceMintEnd = uriEnd + 9;
  inactivePayee.toBuffer().copy(listingData, priceMintEnd + 16);
  const listing = decodeServiceListingProvider(listingData);
  assert.equal(listing.operator.toBase58(), inactivePayee.toBase58());
  assert.equal(listing.operatorFeeBps, 0);
});

test("accepts a canonical HireRecord bound to its immutable listing provider", async () => {
  const value = scenario();
  const result = await scanHireProviderBindings(connectionFor(value));
  assert.equal(result.accountCount, 1);
  assert.equal(result.boundCount, 1);
  assert.equal(result.backfillCount, 0);
  assert.equal(result.exactCapacityListingCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("inventories the canonical-listing fallback for nonterminal legacy hires", async () => {
  for (const status of [0, 1, 2, 5, 6]) {
    const value = scenario({ status, designated: "default" });
    const result = await scanHireProviderBindings(connectionFor(value));
    assert.equal(result.backfillCount, 1);
    assert.equal(result.nonterminalBackfillCount, 1);
    assert.deepEqual(result.blockers, []);
  }
});

test("inventories terminal legacy provider backfills without blocking settlement", async () => {
  for (const status of [3, 4]) {
    const value = scenario({ status, designated: "default" });
    const result = await scanHireProviderBindings(connectionFor(value));
    assert.equal(result.terminalBackfillCount, 1);
    assert.deepEqual(result.blockers, []);
  }
});

test("blocks a nondefault provider that disagrees with the source listing", async () => {
  const value = scenario({ designated: "wrong" });
  const result = await scanHireProviderBindings(connectionFor(value));
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "mismatched-hire-designated-provider",
    ),
  );
});

test("fails closed on missing/malformed listing state and non-mainnet", async () => {
  const value = scenario();
  const missing = new Map(value.records);
  missing.delete(value.listing.address.toBase58());
  let result = await scanHireProviderBindings(
    connectionFor(value, { records: missing }),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "missing-hire-service-listing"),
  );

  const malformed = Buffer.from(value.listing.data);
  malformed[0] ^= 0xff;
  const badRecords = new Map(value.records);
  badRecords.set(value.listing.address.toBase58(), account(malformed));
  result = await scanHireProviderBindings(
    connectionFor(value, { records: badRecords }),
  );
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "invalid-hire-service-listing-layout",
    ),
  );

  const undercounted = scenario({ openJobs: 0 });
  result = await scanHireProviderBindings(connectionFor(undercounted));
  assert.equal(result.undercountedListingCount, 1);
  assert.equal(result.openJobsDeficitTotal, 1);
  assert.ok(result.blockers.some(
    (item) => item.kind === "listing-open-jobs-below-live-links",
  ));

  const overcounted = scenario({ openJobs: 2 });
  result = await scanHireProviderBindings(connectionFor(overcounted));
  assert.equal(result.overcountedListingCount, 1);
  assert.equal(result.openJobsExcessTotal, 1);
  assert.deepEqual(result.blockers, []);

  const impossibleLifetime = scenario({ totalHires: 0n });
  result = await scanHireProviderBindings(connectionFor(impossibleLifetime));
  assert.ok(result.blockers.some(
    (item) => item.kind === "listing-total-hires-below-live-links",
  ));

  let enumerated = false;
  await assert.rejects(
    scanHireProviderBindings({
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
