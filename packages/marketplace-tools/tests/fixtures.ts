// Test fixtures: encode valid on-chain account bytes with the SDK's generated
// encoders, and a fake ProgramAccountsTransport / fake kit RPC that serve them.
//
// This exercises the real decode path the readonly tools use (the same
// generated decoders) WITHOUT a validator — the bytes are byte-true.
import {
  getServiceListingEncoder,
  getTaskEncoder,
  getTaskJobSpecEncoder,
  ListingState,
  TaskStatus,
  TaskType,
  DependencyType,
  values,
  type ProgramAccountsTransport,
  type GpaFilter,
} from "@tetsuo-ai/marketplace-sdk";
import { none, some, type Address } from "@solana/kit";

/** A throwaway but valid-looking base58 address (32-byte all-1s → "4Nd1m..."). */
export const A_PROVIDER = "11111111111111111111111111111112" as Address;
export const A_AUTHORITY = "So11111111111111111111111111111111111111112" as Address;
export const A_CREATOR = "Vote111111111111111111111111111111111111111" as Address;
export const A_ESCROW = "SysvarRent111111111111111111111111111111111" as Address;
export const A_LISTING_PDA =
  "Stake11111111111111111111111111111111111111" as Address;
export const A_TASK_PDA =
  "Config1111111111111111111111111111111111111" as Address;
/** A throwaway moderator pubkey (the P1.2 moderator instruction arg). */
export const A_MODERATOR =
  "SysvarC1ock11111111111111111111111111111111" as Address;

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

export interface EncodedListingOptions {
  pda?: Address;
  name?: string;
  category?: string;
  tags?: string[];
  price?: bigint;
  state?: ListingState;
  version?: bigint;
}

/** Encode a valid ServiceListing account and return `{ address, data }`. */
export function encodeListing(opts: EncodedListingOptions = {}): {
  address: Address;
  data: Uint8Array;
} {
  const data = getServiceListingEncoder().encode({
    providerAgent: A_PROVIDER,
    authority: A_AUTHORITY,
    listingId: zeros(32),
    name: values.encodeListingName(opts.name ?? "Acme Coder"),
    category: values.encodeListingCategory(opts.category ?? "code-generation"),
    tags: values.encodeListingTags(opts.tags ?? ["rust", "solana"]),
    specHash: new Uint8Array(32).fill(7),
    specUri: "agenc://job-spec/sha256/" + "07".repeat(32),
    price: opts.price ?? 50_000_000n,
    priceMint: none<Address>(),
    requiredCapabilities: 3n,
    defaultDeadlineSecs: 0n,
    operator: A_PROVIDER,
    operatorFeeBps: 0,
    state: opts.state ?? ListingState.Active,
    maxOpenJobs: 0,
    openJobs: 1,
    totalHires: 12n,
    totalRating: 40n,
    ratingCount: 10,
    version: opts.version ?? 4n,
    createdAt: 1_700_000_000n,
    updatedAt: 1_700_000_500n,
    bump: 254,
    reserved: zeros(32),
  });
  return { address: opts.pda ?? A_LISTING_PDA, data: new Uint8Array(data) };
}

export interface EncodedTaskOptions {
  pda?: Address;
  status?: TaskStatus;
  reward?: bigint;
  requiredCapabilities?: bigint;
  creator?: Address;
}

/** Encode a valid Task account and return `{ address, data }`. */
export function encodeTask(opts: EncodedTaskOptions = {}): {
  address: Address;
  data: Uint8Array;
} {
  const data = getTaskEncoder().encode({
    taskId: new Uint8Array(32).fill(9),
    creator: opts.creator ?? A_CREATOR,
    requiredCapabilities: opts.requiredCapabilities ?? 1n,
    description: new Uint8Array(64).fill(3),
    constraintHash: zeros(32),
    rewardAmount: opts.reward ?? 25_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: opts.status ?? TaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1_700_000_000n,
    deadline: 0n,
    completedAt: 0n,
    escrow: A_ESCROW,
    result: zeros(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 253,
    protocolFeeBps: 250,
    dependsOn: none<Address>(),
    dependencyType: DependencyType.None,
    minReputation: 0,
    rewardMint: none<Address>(),
    operator: A_PROVIDER,
    operatorFeeBps: 0,
    reserved: zeros(16),
    referrer: A_PROVIDER,
    referrerFeeBps: 0,
  });
  return { address: opts.pda ?? A_TASK_PDA, data: new Uint8Array(data) };
}

/**
 * Encode a valid TaskJobSpec account (the "pinned job spec" account that lives
 * at PDA `["task_job_spec", task]`). The mere existence of this account is what
 * `get_task` treats as `jobSpecPinned: true`.
 */
export function encodeTaskJobSpec(task: Address): Uint8Array {
  const data = getTaskJobSpecEncoder().encode({
    task,
    creator: A_CREATOR,
    jobSpecHash: new Uint8Array(32).fill(5),
    jobSpecUri: "agenc://job-spec/sha256/" + "05".repeat(32),
    createdAt: 1_700_000_000n,
    updatedAt: 1_700_000_500n,
    bump: 252,
    reserved: zeros(7),
  });
  return new Uint8Array(data);
}

/**
 * A fake {@link ProgramAccountsTransport} backed by a fixed set of
 * `{ address, data }` accounts. It honors the leading discriminator memcmp
 * filter (offset 0) AND the status memcmp (so `list_open_tasks` discriminates)
 * by exact byte match — enough to exercise the tools' decode + filter paths.
 */
export function fakeTransport(
  accounts: Array<{ address: Address; data: Uint8Array }>,
): ProgramAccountsTransport {
  return {
    async getProgramAccounts({ filters }) {
      const matches = accounts.filter((acct) =>
        (filters as readonly GpaFilter[]).every((f) => filterMatches(f, acct.data)),
      );
      return matches.map((a) => ({ address: a.address, data: a.data }));
    },
  };
}

function filterMatches(f: GpaFilter, data: Uint8Array): boolean {
  if ("dataSize" in f) return data.length === f.dataSize;
  const { offset, bytes } = f.memcmp;
  if (offset + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * A fake kit RPC exposing the methods the single-account fetch path uses:
 * `getAccountInfo(address).send()` returning a base64 account, plus a
 * `getProgramAccounts` shim so it can double as a `read` source if needed.
 */
export function fakeRpc(
  accounts: Array<{ address: Address; data: Uint8Array }>,
): { getAccountInfo: (addr: Address) => { send: () => Promise<unknown> } } {
  const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  return {
    getAccountInfo(addr: Address) {
      const hit = accounts.find((a) => a.address === addr);
      return {
        async send() {
          if (!hit) return { value: null };
          return {
            value: {
              data: [toBase64(hit.data), "base64"],
              executable: false,
              lamports: 1_000_000n,
              owner: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
              rentEpoch: 0n,
              space: BigInt(hit.data.length),
            },
          };
        },
      };
    },
  };
}

export { some };
