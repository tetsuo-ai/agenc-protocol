#!/usr/bin/env node
// Read-only inventory for the revision-5 HireRecord provider-binding carve-out.
//
// HireRecord's former 32-byte reserved region now stores designated_provider.
// Existing accounts deserialize that region as Pubkey::default(). The hardened
// claim gate supports those records only through an explicit canonical
// ServiceListing fallback; new records bind the provider directly. The source
// ServiceListing is the immutable provider-of-record for both paths.

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

const HIRE_RECORD_SIZE = 173;
const SERVICE_LISTING_SIZE = 697;
const MAX_OPERATOR_FEE_BPS = 2_000;
const MAX_REFERRER_FEE_BPS = 2_000;
const TERMINAL_STATUSES = new Set([3, 4]);
const HIRE_DISCRIMINATOR = createHash("sha256")
  .update("account:HireRecord")
  .digest()
  .subarray(0, 8);
const LISTING_DISCRIMINATOR = createHash("sha256")
  .update("account:ServiceListing")
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

function borshStringEnd(data, offset, maxLength, field) {
  if (offset + 4 > data.length) throw new Error(`${field}: truncated length`);
  const length = data.readUInt32LE(offset);
  if (length > maxLength || offset + 4 + length > data.length) {
    throw new Error(`${field}: invalid/truncated length ${length}`);
  }
  return offset + 4 + length;
}

function optionPubkeyEnd(data, offset, field) {
  if (offset >= data.length) throw new Error(`${field}: truncated option`);
  if (data[offset] === 0) return offset + 1;
  if (data[offset] === 1 && offset + 33 <= data.length) return offset + 33;
  throw new Error(`${field}: invalid/truncated option tag ${data[offset]}`);
}

function requireZero(data, start, end, field) {
  if (!data.subarray(start, end).equals(Buffer.alloc(end - start))) {
    throw new Error(`${field}: reserved bytes are nonzero`);
  }
}

export function decodeHireRecordProvider(dataLike) {
  const data = exact(
    dataLike,
    HIRE_RECORD_SIZE,
    HIRE_DISCRIMINATOR,
    "HireRecord",
  );
  const operator = new PublicKey(data.subarray(72, 104));
  const operatorFeeBps = data.readUInt16LE(104);
  const designatedProvider = new PublicKey(data.subarray(107, 139));
  const referrer = new PublicKey(data.subarray(139, 171));
  const referrerFeeBps = data.readUInt16LE(171);
  if (operatorFeeBps > MAX_OPERATOR_FEE_BPS) {
    throw new Error(`HireRecord.operator_fee_bps: invalid ${operatorFeeBps}`);
  }
  if (referrerFeeBps > MAX_REFERRER_FEE_BPS) {
    throw new Error(`HireRecord.referrer_fee_bps: invalid ${referrerFeeBps}`);
  }
  if (operatorFeeBps > 0 && operator.equals(PublicKey.default)) {
    throw new Error("HireRecord: positive operator fee has the default payee");
  }
  if (referrerFeeBps > 0 && referrer.equals(PublicKey.default)) {
    throw new Error("HireRecord: positive referrer fee has the default payee");
  }
  return {
    task: new PublicKey(data.subarray(8, 40)),
    listing: new PublicKey(data.subarray(40, 72)),
    operator,
    operatorFeeBps,
    bump: data[106],
    designatedProvider,
    referrer,
    referrerFeeBps,
  };
}

export function decodeServiceListingProvider(dataLike) {
  const data = exact(
    dataLike,
    SERVICE_LISTING_SIZE,
    LISTING_DISCRIMINATOR,
    "ServiceListing",
  );
  const uriEnd = borshStringEnd(
    data,
    264,
    256,
    "ServiceListing.spec_uri",
  );
  const priceMintOffset = uriEnd + 8;
  const priceMintEnd = optionPubkeyEnd(
    data,
    priceMintOffset,
    "ServiceListing.price_mint",
  );
  const priceMint = data[priceMintOffset] === 1
    ? new PublicKey(data.subarray(priceMintOffset + 1, priceMintOffset + 33))
    : null;
  if (priceMintEnd + 132 > data.length) {
    throw new Error("ServiceListing: truncated tail");
  }
  const state = data[priceMintEnd + 50];
  if (state > 2) throw new Error(`ServiceListing.state: invalid ${state}`);
  const operator = new PublicKey(data.subarray(
    priceMintEnd + 16,
    priceMintEnd + 48,
  ));
  const operatorFeeBps = data.readUInt16LE(priceMintEnd + 48);
  if (operatorFeeBps > MAX_OPERATOR_FEE_BPS) {
    throw new Error(`ServiceListing.operator_fee_bps: invalid ${operatorFeeBps}`);
  }
  if (operatorFeeBps > 0 && operator.equals(PublicKey.default)) {
    throw new Error("ServiceListing: positive operator fee has the default payee");
  }
  requireZero(
    data,
    priceMintEnd + 100,
    priceMintEnd + 132,
    "ServiceListing",
  );
  return {
    providerAgent: new PublicKey(data.subarray(8, 40)),
    listingId: Buffer.from(data.subarray(72, 104)),
    bump: data[priceMintEnd + 99],
    state,
    operator,
    operatorFeeBps,
    priceMint,
    maxOpenJobs: data.readUInt16LE(priceMintEnd + 51),
    openJobs: data.readUInt16LE(priceMintEnd + 53),
    totalHires: data.readBigUInt64LE(priceMintEnd + 55),
  };
}

function blocker(kind, hireRecord, detail, extra = {}) {
  return { kind, hireRecord, detail, ...extra };
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

export async function scanHireProviderBindings(connection) {
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
          bytes: HIRE_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });
  const blockers = [];
  const records = [];

  for (const { pubkey: address, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push(blocker("invalid-hire-record-owner", address));
      continue;
    }
    try {
      const record = decodeHireRecordProvider(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("hire"), record.task.toBuffer()],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || record.bump !== bump) {
        throw new Error("canonical HireRecord PDA/bump mismatch");
      }
      records.push({ address, ...record });
    } catch (error) {
      blockers.push(
        blocker(
          "invalid-hire-record-layout",
          address,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const accountMap = await fetchAccountMap(
    connection,
    records.flatMap((record) => [record.task, record.listing]),
  );
  const backfill = [];
  const bound = [];
  const canonicalListings = new Map();

  for (const record of records) {
    const taskAccount = accountMap.get(record.task.toBase58());
    let task = null;
    if (isMissing(taskAccount)) {
      blockers.push(
        blocker("missing-hired-task", record.address, undefined, {
          task: record.task,
          listing: record.listing,
        }),
      );
    } else if (!taskAccount.owner.equals(PROGRAM_ID) || taskAccount.executable) {
      blockers.push(
        blocker(
          "invalid-hired-task-owner",
          record.address,
          `owner=${taskAccount.owner.toBase58()} executable=${taskAccount.executable}`,
          { task: record.task, listing: record.listing },
        ),
      );
    } else {
      try {
        task = decodeTaskBinding(taskAccount.data);
        const [expected, bump] = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), task.creator.toBuffer(), task.taskId],
          PROGRAM_ID,
        );
        if (!expected.equals(record.task) || task.bump !== bump) {
          throw new Error("canonical Task PDA/bump mismatch");
        }
        if (task.taskType !== 0 || task.maxWorkers !== 1) {
          throw new Error(
            `hired Task must be Exclusive/single-worker; type=${task.taskType} max=${task.maxWorkers}`,
          );
        }
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-hired-task-layout",
            record.address,
            error instanceof Error ? error.message : String(error),
            { task: record.task, listing: record.listing },
          ),
        );
        task = null;
      }
    }

    const listingAccount = accountMap.get(record.listing.toBase58());
    let listing = null;
    if (isMissing(listingAccount)) {
      blockers.push(
        blocker("missing-hire-service-listing", record.address, undefined, {
          task: record.task,
          listing: record.listing,
        }),
      );
    } else if (!listingAccount.owner.equals(PROGRAM_ID) || listingAccount.executable) {
      blockers.push(
        blocker(
          "invalid-hire-service-listing-owner",
          record.address,
          `owner=${listingAccount.owner.toBase58()} executable=${listingAccount.executable}`,
          { task: record.task, listing: record.listing },
        ),
      );
    } else {
      try {
        listing = decodeServiceListingProvider(listingAccount.data);
        const [expected, bump] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("service_listing"),
            listing.providerAgent.toBuffer(),
            listing.listingId,
          ],
          PROGRAM_ID,
        );
        if (!expected.equals(record.listing) || listing.bump !== bump) {
          throw new Error("canonical ServiceListing PDA/bump mismatch");
        }
        if (listing.providerAgent.equals(PublicKey.default)) {
          throw new Error("ServiceListing.provider_agent is default");
        }
        canonicalListings.set(record.listing.toBase58(), {
          address: record.listing,
          ...listing,
        });
      } catch (error) {
        blockers.push(
          blocker(
            "invalid-hire-service-listing-layout",
            record.address,
            error instanceof Error ? error.message : String(error),
            { task: record.task, listing: record.listing },
          ),
        );
        listing = null;
      }
    }

    if (!listing) continue;
    if (record.designatedProvider.equals(PublicKey.default)) {
      const terminal = task ? TERMINAL_STATUSES.has(task.status) : null;
      const item = {
        hireRecord: record.address,
        task: record.task,
        listing: record.listing,
        expectedProvider: listing.providerAgent,
        taskStatus: task?.status ?? null,
        terminal,
      };
      backfill.push(item);
    } else if (!record.designatedProvider.equals(listing.providerAgent)) {
      blockers.push(
        blocker(
          "mismatched-hire-designated-provider",
          record.address,
          `stored=${record.designatedProvider.toBase58()} ` +
            `listing_provider=${listing.providerAgent.toBase58()}`,
          {
            task: record.task,
            listing: record.listing,
            expectedProvider: listing.providerAgent,
          },
        ),
      );
    } else {
      bound.push({
        hireRecord: record.address,
        task: record.task,
        listing: record.listing,
        designatedProvider: record.designatedProvider,
        taskStatus: task?.status ?? null,
      });
    }
  }

  const listingCapacity = [];
  for (const listing of canonicalListings.values()) {
    const linkedRecords = records.filter((record) =>
      record.listing.equals(listing.address));
    const liveHireRecordCount = linkedRecords.length;
    const delta = listing.openJobs - liveHireRecordCount;
    const capacityState = delta < 0
      ? "undercounted"
      : delta > 0
        ? "overcounted"
        : "exact";
    const item = {
      listing: listing.address,
      providerAgent: listing.providerAgent,
      priceMint: listing.priceMint,
      state: listing.state,
      maxOpenJobs: listing.maxOpenJobs,
      openJobs: listing.openJobs,
      totalHires: listing.totalHires,
      liveHireRecordCount,
      delta,
      capacityState,
      linkedHireRecords: linkedRecords.map((record) => record.address),
    };
    listingCapacity.push(item);
    if (listing.openJobs < liveHireRecordCount) {
      blockers.push(blocker(
        "listing-open-jobs-below-live-links",
        linkedRecords[0]?.address ?? listing.address,
        `listing_open_jobs=${listing.openJobs} live_hire_records=${liveHireRecordCount}`,
        {
          listing: listing.address,
          expectedOpenJobsFloor: liveHireRecordCount,
        },
      ));
    }
    if (listing.totalHires < BigInt(liveHireRecordCount)) {
      blockers.push(blocker(
        "listing-total-hires-below-live-links",
        linkedRecords[0]?.address ?? listing.address,
        `listing_total_hires=${listing.totalHires} live_hire_records=${liveHireRecordCount}`,
        { listing: listing.address },
      ));
    }
  }

  return {
    accountCount: accounts.length,
    decodedCount: records.length,
    boundCount: bound.length,
    backfillCount: backfill.length,
    nonterminalBackfillCount: backfill.filter((item) => item.terminal === false).length,
    terminalBackfillCount: backfill.filter((item) => item.terminal === true).length,
    listingCount: listingCapacity.length,
    exactCapacityListingCount: listingCapacity.filter(
      (item) => item.capacityState === "exact",
    ).length,
    undercountedListingCount: listingCapacity.filter(
      (item) => item.capacityState === "undercounted",
    ).length,
    overcountedListingCount: listingCapacity.filter(
      (item) => item.capacityState === "overcounted",
    ).length,
    openJobsDeficitTotal: listingCapacity.reduce(
      (sum, item) => sum + Math.max(0, -item.delta),
      0,
    ),
    openJobsExcessTotal: listingCapacity.reduce(
      (sum, item) => sum + Math.max(0, item.delta),
      0,
    ),
    listingCapacity,
    bound,
    backfill,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet HireRecord provider bindings via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanHireProviderBindings(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(
    `HireRecord: accounts=${result.accountCount} bound=${result.boundCount} ` +
    `backfill=${result.backfillCount} nonterminal_backfill=${result.nonterminalBackfillCount} ` +
      `terminal_backfill=${result.terminalBackfillCount} listings=${result.listingCount} ` +
      `capacity_exact=${result.exactCapacityListingCount} ` +
      `capacity_undercounted=${result.undercountedListingCount} ` +
      `capacity_overcounted=${result.overcountedListingCount} ` +
      `open_jobs_deficit=${result.openJobsDeficitTotal} ` +
      `open_jobs_excess=${result.openJobsExcessTotal} blockers=${result.blockers.length}`,
  );
  for (const item of result.listingCapacity.filter(
    (listing) => listing.capacityState !== "exact",
  )) {
    console.warn(
      `  CAPACITY ${item.capacityState.toUpperCase()}: listing=${item.listing.toBase58()} ` +
        `open_jobs=${item.openJobs} live_hire_records=${item.liveHireRecordCount} ` +
        `delta=${item.delta} max_open_jobs=${item.maxOpenJobs} total_hires=${item.totalHires}`,
    );
  }
  for (const item of result.backfill.slice(0, 20)) {
    console.warn(
      `  LEGACY FALLBACK ${item.terminal ? "terminal/inventory" : "nonterminal/canonical-listing-required"}: ` +
        `hire=${item.hireRecord.toBase58()} task=${item.task.toBase58()} ` +
        `listing=${item.listing.toBase58()} expected_provider=${item.expectedProvider.toBase58()} ` +
        `status=${item.taskStatus ?? "unknown"}`,
    );
  }
  for (const item of result.blockers) {
    console.error(
      `  BLOCKER ${item.kind}: hire=${item.hireRecord.toBase58()}` +
        `${item.task ? ` task=${item.task.toBase58()}` : ""}` +
        `${item.listing ? ` listing=${item.listing.toBase58()}` : ""}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} hired-task provider binding blocker(s) found`,
    );
  }
  console.log(
    "PREFLIGHT OK: every HireRecord has canonical task/listing/provider bindings; listing open_jobs never falls below live HireRecord links; conservative overcounts remain explicit inventory.",
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
