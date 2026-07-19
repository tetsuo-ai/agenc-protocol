import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import {
  createRpcProgramAccountsTransport,
  fetchTaskGuarantee,
  isTaskJobSpecPinned,
  listActiveListings,
  listOpenTasks,
  listPinnedJobSpecTasks,
  listingsByProvider,
  COMPLETION_BOND_ROLE_CREATOR,
  COMPLETION_BOND_ROLE_WORKER,
  COMPLETION_BOND_TASK_OFFSET,
  HIRE_RECORD_TASK_OFFSET,
  SERVICE_LISTING_AUTHORITY_OFFSET,
  SERVICE_LISTING_CATEGORY_OFFSET,
  SERVICE_LISTING_PROVIDER_AGENT_OFFSET,
  TASK_BID_TASK_OFFSET,
  TASK_CLAIM_TASK_OFFSET,
  TASK_CLAIM_WORKER_OFFSET,
  TASK_CREATOR_OFFSET,
  TASK_JOB_SPEC_HASH_OFFSET,
  TASK_JOB_SPEC_TASK_OFFSET,
  TASK_STATUS_OFFSET,
  type GpaFilter,
  type ProgramAccountsTransport,
} from "../src/queries/index.js";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  COMPLETION_BOND_DISCRIMINATOR,
  DependencyType,
  ListingState,
  SERVICE_LISTING_DISCRIMINATOR,
  TaskStatus,
  TaskType,
  getCompletionBondEncoder,
  getHireRecordEncoder,
  getServiceListingEncoder,
  getTaskBidEncoder,
  getTaskClaimEncoder,
  getTaskEncoder,
  getTaskJobSpecEncoder,
  type CompletionBondArgs,
  type ServiceListingArgs,
  type TaskArgs,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers: distinctive sentinel values so a byte match at an offset can
// only come from the intended field.
// ---------------------------------------------------------------------------

const addressDecoder = getAddressDecoder();

function addrFromByte(b: number): Address {
  return addressDecoder.decode(new Uint8Array(32).fill(b));
}

function bytes32(b: number): Uint8Array {
  return new Uint8Array(32).fill(b);
}

function decodeAddressAt(data: Uint8Array, offset: number): Address {
  return addressDecoder.decode(data.subarray(offset, offset + 32));
}

const DEFAULT_ADDR = address("11111111111111111111111111111111");

function listingFixtureArgs(
  overrides: Partial<ServiceListingArgs> = {},
): ServiceListingArgs {
  return {
    providerAgent: addrFromByte(0xa1),
    authority: addrFromByte(0xa2),
    listingId: bytes32(0x10),
    name: bytes32(0x11),
    category: bytes32(0xc3),
    tags: new Uint8Array(64).fill(0x12),
    specHash: bytes32(0x13),
    specUri: "spec",
    price: 1_000_000n,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    operator: DEFAULT_ADDR,
    operatorFeeBps: 9,
    state: ListingState.Paused,
    maxOpenJobs: 7,
    openJobs: 0,
    totalHires: 0n,
    totalRating: 0n,
    ratingCount: 0,
    version: 1n,
    createdAt: 0n,
    updatedAt: 0n,
    bump: 254,
    reserved: new Uint8Array(32),
    ...overrides,
  };
}

function encodeListing(overrides: Partial<ServiceListingArgs> = {}): Uint8Array {
  return new Uint8Array(
    getServiceListingEncoder().encode(listingFixtureArgs(overrides)),
  );
}

function taskFixtureArgs(overrides: Partial<TaskArgs> = {}): TaskArgs {
  return {
    taskId: bytes32(0x21),
    creator: addrFromByte(0xb7),
    requiredCapabilities: 0b101n,
    description: new Uint8Array(64).fill(0x22),
    constraintHash: bytes32(0x23),
    rewardAmount: 4_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: TaskStatus.Disputed,
    taskType: TaskType.Exclusive,
    createdAt: 0n,
    deadline: 0n,
    completedAt: 0n,
    escrow: addrFromByte(0x24),
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    protocolFeeBps: 100,
    dependsOn: null,
    dependencyType: DependencyType.None,
    minReputation: 0,
    rewardMint: null,
    operator: DEFAULT_ADDR,
    operatorFeeBps: 0,
    reserved: new Uint8Array(16),
    // P6.2: no-referrer default (Pubkey::default()), fee 0 — the no-leg case.
    referrer: DEFAULT_ADDR,
    referrerFeeBps: 0,
    ...overrides,
  };
}

function encodeTask(overrides: Partial<TaskArgs> = {}): Uint8Array {
  return new Uint8Array(getTaskEncoder().encode(taskFixtureArgs(overrides)));
}

function encodeCompletionBond(
  overrides: Partial<CompletionBondArgs> = {},
): Uint8Array {
  return new Uint8Array(
    getCompletionBondEncoder().encode({
      task: addrFromByte(0xd1),
      party: addrFromByte(0xd2),
      role: COMPLETION_BOND_ROLE_WORKER,
      amount: 1_000_000n,
      bondMint: null,
      postedAt: 0n,
      bump: 253,
      reserved: new Uint8Array(16),
      ...overrides,
    }),
  );
}

function encodeTaskJobSpec(
  overrides: Partial<{
    task: Address;
    creator: Address;
    jobSpecHash: Uint8Array;
  }> = {},
): Uint8Array {
  return new Uint8Array(
    getTaskJobSpecEncoder().encode({
      task: overrides.task ?? addrFromByte(0x91),
      creator: overrides.creator ?? addrFromByte(0x92),
      jobSpecHash: overrides.jobSpecHash ?? bytes32(0x93),
      jobSpecUri: "agenc://job-spec/x",
      createdAt: 0n,
      updatedAt: 0n,
      bump: 247,
      reserved: new Uint8Array(7),
    }),
  );
}

// ---------------------------------------------------------------------------
// DRIFT-PROOF offset fixtures: encode each account through the GENERATED
// encoder with sentinel values and assert the bytes at each exported offset
// decode back to exactly the sentinel. Any program/IDL layout change that moves
// a filtered field breaks these loudly.
// ---------------------------------------------------------------------------

describe("queries offsets are drift-proofed against the generated encoders", () => {
  it("ServiceListing: providerAgent/authority/category offsets hit their sentinels", () => {
    const providerAgent = addrFromByte(0xa1);
    const authority = addrFromByte(0xa2);
    const data = encodeListing();
    expect(decodeAddressAt(data, SERVICE_LISTING_PROVIDER_AGENT_OFFSET)).toBe(
      providerAgent,
    );
    expect(decodeAddressAt(data, SERVICE_LISTING_AUTHORITY_OFFSET)).toBe(
      authority,
    );
    expect(
      data.subarray(
        SERVICE_LISTING_CATEGORY_OFFSET,
        SERVICE_LISTING_CATEGORY_OFFSET + 32,
      ),
    ).toEqual(bytes32(0xc3));
  });

  it("ServiceListing: state sits at a VARIABLE offset (after specUri) — no memcmp constant", () => {
    // state offset (priceMint = None) = 264 (specUri start) + 4 (u32 len)
    //   + len + 8 (price) + 1 (Option tag) + 8 (caps) + 8 (deadline)
    //   + 32 (operator) + 2 (operatorFeeBps) = 327 + len.
    const short = encodeListing({ specUri: "spec" }); // len 4
    const long = encodeListing({ specUri: "spec-is-longer" }); // len 14
    expect(short[327 + 4]).toBe(ListingState.Paused);
    expect(long[327 + 14]).toBe(ListingState.Paused);
    // The two state bytes land at different absolute offsets: the field is not
    // memcmp-filterable, which is why listActiveListings refines state
    // client-side and offsets.ts exports no SERVICE_LISTING_STATE_OFFSET.
    expect(327 + 4).not.toBe(327 + 14);
    expect(short.length).not.toBe(long.length);
  });

  it("Task: creator/status offsets hit their sentinels", () => {
    const data = encodeTask();
    expect(decodeAddressAt(data, TASK_CREATOR_OFFSET)).toBe(addrFromByte(0xb7));
    expect(data[TASK_STATUS_OFFSET]).toBe(TaskStatus.Disputed);
    // listOpenTasks' status memcmp encodes TaskStatus.Open as a single 0 byte.
    expect(TaskStatus.Open).toBe(0);
    expect(encodeTask({ status: TaskStatus.Open })[TASK_STATUS_OFFSET]).toBe(0);
  });

  it("TaskClaim: task/worker offsets hit their sentinels", () => {
    const data = new Uint8Array(
      getTaskClaimEncoder().encode({
        task: addrFromByte(0xd1),
        worker: addrFromByte(0xd2),
        claimedAt: 0n,
        expiresAt: 0n,
        completedAt: 0n,
        proofHash: bytes32(0),
        resultData: new Uint8Array(64),
        isCompleted: false,
        isValidated: false,
        rewardPaid: 0n,
        bump: 250,
      }),
    );
    expect(decodeAddressAt(data, TASK_CLAIM_TASK_OFFSET)).toBe(
      addrFromByte(0xd1),
    );
    expect(decodeAddressAt(data, TASK_CLAIM_WORKER_OFFSET)).toBe(
      addrFromByte(0xd2),
    );
  });

  it("TaskBid: task offset hits its sentinel", () => {
    const data = new Uint8Array(
      getTaskBidEncoder().encode({
        task: addrFromByte(0xe1),
        bidBook: addrFromByte(0xe2),
        bidder: addrFromByte(0xe3),
        bidderAuthority: addrFromByte(0xe4),
        requestedRewardLamports: 1n,
        etaSeconds: 60,
        confidenceBps: 100,
        reputationSnapshotBps: 0,
        qualityGuaranteeHash: bytes32(0),
        metadataHash: bytes32(0),
        expiresAt: 0n,
        createdAt: 0n,
        updatedAt: 0n,
        state: 0,
        bondLamports: 0n,
        bump: 249,
        acceptedNoShowSlashBps: 0,
      }),
    );
    expect(decodeAddressAt(data, TASK_BID_TASK_OFFSET)).toBe(addrFromByte(0xe1));
  });

  it("HireRecord: task offset hits its sentinel", () => {
    const data = new Uint8Array(
      getHireRecordEncoder().encode({
        task: addrFromByte(0xf1),
        listing: addrFromByte(0xf2),
        operator: DEFAULT_ADDR,
        operatorFeeBps: 0,
        bump: 248,
        designatedProvider: addrFromByte(0xf3),
        // P6.2: no-referrer default (Pubkey::default()), fee 0.
        referrer: DEFAULT_ADDR,
        referrerFeeBps: 0,
      }),
    );
    expect(decodeAddressAt(data, HIRE_RECORD_TASK_OFFSET)).toBe(
      addrFromByte(0xf1),
    );
  });

  it("TaskJobSpec: task + jobSpecHash offsets hit their sentinels", () => {
    const data = encodeTaskJobSpec({
      task: addrFromByte(0x91),
      jobSpecHash: bytes32(0x93),
    });
    expect(decodeAddressAt(data, TASK_JOB_SPEC_TASK_OFFSET)).toBe(
      addrFromByte(0x91),
    );
    expect(
      data.subarray(TASK_JOB_SPEC_HASH_OFFSET, TASK_JOB_SPEC_HASH_OFFSET + 32),
    ).toEqual(bytes32(0x93));
  });

  it("CompletionBond: task offset hits its sentinel", () => {
    const data = encodeCompletionBond({ task: addrFromByte(0xd1) });
    expect(decodeAddressAt(data, COMPLETION_BOND_TASK_OFFSET)).toBe(
      addrFromByte(0xd1),
    );
  });
});

// ---------------------------------------------------------------------------
// Guaranteed Hire read: fetchTaskGuarantee mirrors the on-chain bond lifecycle
// (a bond PDA is closed at settlement, so a live account == posted+unresolved)
// and `guaranteed` keys off the WORKER bond specifically.
// ---------------------------------------------------------------------------
describe("fetchTaskGuarantee (WP-H3 Guaranteed Hire read)", () => {
  const task = addrFromByte(0x81);
  const workerWallet = addrFromByte(0x82);
  const creatorWallet = addrFromByte(0x83);
  const workerBondPda = addrFromByte(0x84);
  const creatorBondPda = addrFromByte(0x85);

  it("reports guaranteed:true with the decoded worker bond when a role-1 bond is live", async () => {
    const captured: Array<readonly GpaFilter[]> = [];
    const transport = staticTransport(
      [
        {
          address: workerBondPda,
          data: encodeCompletionBond({
            task,
            party: workerWallet,
            role: COMPLETION_BOND_ROLE_WORKER,
            amount: 1_000_000n,
          }),
        },
        {
          address: creatorBondPda,
          data: encodeCompletionBond({
            task,
            party: creatorWallet,
            role: COMPLETION_BOND_ROLE_CREATOR,
            amount: 1_000_000n,
          }),
        },
      ],
      captured,
    );
    const g = await fetchTaskGuarantee(transport, task);
    expect(g.guaranteed).toBe(true);
    expect(g.workerBond?.address).toBe(workerBondPda);
    expect(g.workerBond?.account.party).toBe(workerWallet);
    expect(g.workerBond?.account.amount).toBe(1_000_000n);
    expect(g.creatorBond?.address).toBe(creatorBondPda);
    // The fetch is scoped server-side: discriminator + task memcmp at the
    // drift-proofed CompletionBond.task offset.
    expect(captured[0][0]).toEqual({
      memcmp: {
        offset: 0,
        bytes: Uint8Array.from(COMPLETION_BOND_DISCRIMINATOR),
      },
    });
    expect(captured[0][1]).toEqual({
      memcmp: {
        offset: COMPLETION_BOND_TASK_OFFSET,
        bytes: new Uint8Array(getAddressEncoder().encode(task)),
      },
    });
  });

  it("a creator bond alone does NOT make the task guaranteed (worker bond keys the flag)", async () => {
    const transport = staticTransport([
      {
        address: creatorBondPda,
        data: encodeCompletionBond({
          task,
          party: creatorWallet,
          role: COMPLETION_BOND_ROLE_CREATOR,
        }),
      },
    ]);
    const g = await fetchTaskGuarantee(transport, task);
    expect(g.guaranteed).toBe(false);
    expect(g.workerBond).toBeNull();
    expect(g.creatorBond?.address).toBe(creatorBondPda);
  });

  it("no live bonds (never posted, or settled+closed) → guaranteed:false, both null", async () => {
    const g = await fetchTaskGuarantee(staticTransport([]), task);
    expect(g).toEqual({ guaranteed: false, workerBond: null, creatorBond: null });
  });
});

// ---------------------------------------------------------------------------
// Job-spec pin helpers: these mirror the on-chain claim_task_with_job_spec gate
// (the ["task_job_spec", task] PDA exists AND its jobSpecHash is non-zero), so
// the watch/worker layer never builds a doomed claim against an unpinned task.
// ---------------------------------------------------------------------------
describe("listPinnedJobSpecTasks / isTaskJobSpecPinned", () => {
  it("listPinnedJobSpecTasks returns only tasks with a NON-ZERO job-spec hash", async () => {
    const pinnedTask = addrFromByte(0x41);
    const zeroHashTask = addrFromByte(0x42);
    const jobSpecPinned = addrFromByte(0x51);
    const jobSpecZero = addrFromByte(0x52);
    const transport = staticTransport([
      {
        address: jobSpecPinned,
        data: encodeTaskJobSpec({
          task: pinnedTask,
          jobSpecHash: bytes32(0xaa),
        }),
      },
      {
        address: jobSpecZero,
        data: encodeTaskJobSpec({
          task: zeroHashTask,
          jobSpecHash: new Uint8Array(32), // all-zero: validate_job_spec_pointer rejects
        }),
      },
    ]);
    const pinned = await listPinnedJobSpecTasks(transport);
    expect(pinned.has(pinnedTask)).toBe(true);
    expect(pinned.has(zeroHashTask)).toBe(false);
    expect(pinned.size).toBe(1);
  });

  it("isTaskJobSpecPinned: true for a non-zero-hash pointer, false when absent or zero", async () => {
    const task = addrFromByte(0x61);
    const jobSpec = addrFromByte(0x71);
    // memcmp on TASK_JOB_SPEC_TASK_OFFSET must go out so the transport can scope.
    const captured: Array<readonly GpaFilter[]> = [];
    const pinnedTransport = staticTransport(
      [
        {
          address: jobSpec,
          data: encodeTaskJobSpec({ task, jobSpecHash: bytes32(0xbb) }),
        },
      ],
      captured,
    );
    expect(await isTaskJobSpecPinned(pinnedTransport, task)).toBe(true);
    // The task-field memcmp filter is present at the right offset.
    expect(captured[0][1]).toEqual({
      memcmp: {
        offset: TASK_JOB_SPEC_TASK_OFFSET,
        bytes: new Uint8Array(getAddressEncoder().encode(task)),
      },
    });

    // Absent pointer → not pinned.
    expect(await isTaskJobSpecPinned(staticTransport([]), task)).toBe(false);

    // Present but zero hash → not pinned.
    const zeroTransport = staticTransport([
      {
        address: jobSpec,
        data: encodeTaskJobSpec({ task, jobSpecHash: new Uint8Array(32) }),
      },
    ]);
    expect(await isTaskJobSpecPinned(zeroTransport, task)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kit-RPC adapter: filter encoding + response decoding against a fake rpc that
// captures the exact request. The fake also exposes getAccountInfo so it has
// the kit-Rpc shape the helpers detect.
// ---------------------------------------------------------------------------

type CapturedCall = { program: unknown; config: Record<string, unknown> };

function makeFakeRpc(
  results: Array<{ pubkey: Address; account: { data: [string, string] } }>,
) {
  const calls: CapturedCall[] = [];
  const rpc = {
    // kit-Rpc shape marker: the real Rpc proxy serves a function for every
    // RPC method name, including getAccountInfo.
    getAccountInfo() {
      return { send: async () => null };
    },
    getProgramAccounts(program: unknown, config: Record<string, unknown>) {
      calls.push({ program, config });
      return { send: async () => results };
    },
  };
  return { rpc: rpc as never, calls };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("createRpcProgramAccountsTransport", () => {
  it("encodes dataSize passthrough and memcmp bytes as base64 with bigint offsets", async () => {
    const { rpc, calls } = makeFakeRpc([]);
    const transport = createRpcProgramAccountsTransport(rpc);
    const memcmpBytes = new Uint8Array([7, 0, 255, 1]);
    await transport.getProgramAccounts({
      filters: [
        { dataSize: 432 },
        { memcmp: { offset: 40, bytes: memcmpBytes } },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].program).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(calls[0].config.encoding).toBe("base64");
    expect(calls[0].config.filters).toEqual([
      { dataSize: 432n },
      {
        memcmp: {
          bytes: b64(memcmpBytes),
          encoding: "base64",
          offset: 40n,
        },
      },
    ]);
  });

  it("decodes base64 response data into Uint8Array and keeps addresses", async () => {
    const addr = addrFromByte(0x55);
    const payload = new Uint8Array([1, 2, 3, 250]);
    const { rpc } = makeFakeRpc([
      { pubkey: addr, account: { data: [b64(payload), "base64"] } },
    ]);
    const transport = createRpcProgramAccountsTransport(rpc);
    const out = await transport.getProgramAccounts({ filters: [] });
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe(addr);
    expect(out[0].data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out[0].data)).toEqual([1, 2, 3, 250]);
  });

  it("respects a programAddress override", async () => {
    const { rpc, calls } = makeFakeRpc([]);
    const other = addrFromByte(0x42);
    const transport = createRpcProgramAccountsTransport(rpc, {
      programAddress: other,
    });
    await transport.getProgramAccounts({ filters: [] });
    expect(calls[0].program).toBe(other);
  });
});

describe("helpers detect kit rpc vs transport by shape", () => {
  it("a kit-shaped rpc is auto-wrapped: discriminator + provider memcmp go out base64-encoded", async () => {
    const provider = addrFromByte(0xa1);
    const listing = encodeListing({ state: ListingState.Active });
    const listingAddr = addrFromByte(0x66);
    const { rpc, calls } = makeFakeRpc([
      { pubkey: listingAddr, account: { data: [b64(listing), "base64"] } },
    ]);

    const rows = await listingsByProvider(rpc, provider);
    expect(rows.map((r) => r.address)).toEqual([listingAddr]);
    expect(rows[0].account.providerAgent).toBe(provider);

    expect(calls).toHaveLength(1);
    expect(calls[0].config.filters).toEqual([
      {
        memcmp: {
          bytes: b64(new Uint8Array(SERVICE_LISTING_DISCRIMINATOR)),
          encoding: "base64",
          offset: 0n,
        },
      },
      {
        memcmp: {
          bytes: b64(new Uint8Array(32).fill(0xa1)),
          encoding: "base64",
          offset: 8n,
        },
      },
    ]);
  });

  it("a plain ProgramAccountsTransport is used directly with raw byte filters", async () => {
    const captured: Array<readonly GpaFilter[]> = [];
    const listingAddr = addrFromByte(0x67);
    const transport: ProgramAccountsTransport = {
      async getProgramAccounts({ filters }) {
        captured.push(filters);
        return [{ address: listingAddr, data: encodeListing() }];
      },
    };
    const rows = await listingsByProvider(transport, addrFromByte(0xa1));
    expect(rows.map((r) => r.address)).toEqual([listingAddr]);
    expect(captured).toHaveLength(1);
    const [discFilter, providerFilter] = captured[0];
    expect(discFilter).toEqual({
      memcmp: {
        offset: 0,
        bytes: new Uint8Array(SERVICE_LISTING_DISCRIMINATOR),
      },
    });
    expect(providerFilter).toEqual({
      memcmp: { offset: 8, bytes: new Uint8Array(32).fill(0xa1) },
    });
  });
});

// ---------------------------------------------------------------------------
// Client-side refinements (state / capabilities / minReward) and category
// padding — these cannot be memcmp filters, so they are applied post-fetch.
// ---------------------------------------------------------------------------

function staticTransport(
  rows: Array<{ address: Address; data: Uint8Array }>,
  captured?: Array<readonly GpaFilter[]>,
): ProgramAccountsTransport {
  return {
    async getProgramAccounts({ filters }) {
      captured?.push(filters);
      return rows;
    },
  };
}

describe("client-side refinements", () => {
  it("listActiveListings keeps only the requested state (default Active)", async () => {
    const active = addrFromByte(0x71);
    const paused = addrFromByte(0x72);
    const transport = staticTransport([
      { address: active, data: encodeListing({ state: ListingState.Active }) },
      { address: paused, data: encodeListing({ state: ListingState.Paused }) },
    ]);
    const defaults = await listActiveListings(transport);
    expect(defaults.map((r) => r.address)).toEqual([active]);
    const pausedOnly = await listActiveListings(transport, {
      state: ListingState.Paused,
    });
    expect(pausedOnly.map((r) => r.address)).toEqual([paused]);
  });

  it("listActiveListings NUL-pads a string category into the memcmp filter", async () => {
    const captured: Array<readonly GpaFilter[]> = [];
    const transport = staticTransport([], captured);
    await listActiveListings(transport, { category: "code-generation" });
    const expected = new Uint8Array(32);
    expected.set(new TextEncoder().encode("code-generation"));
    expect(captured[0][1]).toEqual({
      memcmp: { offset: SERVICE_LISTING_CATEGORY_OFFSET, bytes: expected },
    });
    await expect(
      listActiveListings(transport, { category: "x".repeat(33) }),
    ).rejects.toThrow(/max 32/);
    await expect(
      listActiveListings(transport, { category: new Uint8Array(31) }),
    ).rejects.toThrow(/exactly 32 bytes/);
  });

  it("REVERT-SENSITIVE (#9): rejects non-kebab string categories with TypeError instead of silently matching nothing", async () => {
    const captured: Array<readonly GpaFilter[]> = [];
    const transport = staticTransport([], captured);

    // The same strings the facade write path rejects must throw here too —
    // they could only ever memcmp-match nothing.
    await expect(
      listActiveListings(transport, { category: "Code-Generation" }),
    ).rejects.toThrow(TypeError);
    await expect(
      listActiveListings(transport, { category: "Code-Generation" }),
    ).rejects.toThrow(/lowercase-kebab/);
    await expect(
      listActiveListings(transport, { category: "two words" }),
    ).rejects.toThrow(TypeError);
    await expect(
      listActiveListings(transport, { category: "" }),
    ).rejects.toThrow(TypeError);
    await expect(
      listActiveListings(transport, { category: "-leading-dash" }),
    ).rejects.toThrow(TypeError);

    // All rejections happen BEFORE any fetch goes out.
    expect(captured).toEqual([]);

    // The raw 32-byte escape hatch stays unvalidated for non-standard
    // listings written by raw clients (the program stores raw bytes).
    await listActiveListings(transport, {
      category: new Uint8Array(32).fill(0xc3), // not UTF-8 kebab at all
    });
    expect(captured).toHaveLength(1);
  });

  it("listOpenTasks refines capabilities (bitmask superset) and minReward client-side", async () => {
    const cheapEasy = addrFromByte(0x81); // caps 1, reward 4M
    const richHard = addrFromByte(0x82); // caps 0b11, reward 10M
    const transport = staticTransport([
      {
        address: cheapEasy,
        data: encodeTask({
          status: TaskStatus.Open,
          requiredCapabilities: 1n,
          rewardAmount: 4_000_000n,
        }),
      },
      {
        address: richHard,
        data: encodeTask({
          status: TaskStatus.Open,
          requiredCapabilities: 0b11n,
          rewardAmount: 10_000_000n,
        }),
      },
    ]);
    const all = await listOpenTasks(transport);
    expect(all.map((r) => r.address)).toEqual([cheapEasy, richHard]);
    // worker holds only capability bit 0 -> cannot take the 0b11 task.
    const capable = await listOpenTasks(transport, { capabilities: 1n });
    expect(capable.map((r) => r.address)).toEqual([cheapEasy]);
    const lucrative = await listOpenTasks(transport, {
      minReward: 5_000_000n,
    });
    expect(lucrative.map((r) => r.address)).toEqual([richHard]);
    // status goes out as a server-side memcmp at the fixed offset.
    const captured: Array<readonly GpaFilter[]> = [];
    await listOpenTasks(staticTransport([], captured));
    expect(captured[0][1]).toEqual({
      memcmp: { offset: TASK_STATUS_OFFSET, bytes: Uint8Array.of(0) },
    });
  });
});
