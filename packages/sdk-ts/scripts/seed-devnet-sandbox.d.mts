// Hand-written declarations for the pure, unit-tested exports of
// seed-devnet-sandbox.mjs (the script itself is plain Node ESM).

/** Parsed CLI arguments for the seeding script. */
export interface SeedArgs {
  help: boolean;
  keypair: string | null;
  /** Explicit --rpc value; null until {@link mergeEnvFileConfig} applies the
   * env-file rpcUrl and then the devnet default. */
  rpc: string | null;
  attestorUrl: string | null;
  moderatorKeypair: string | null;
  /** Explicit --env-file path (the .localnet/env.json convention). */
  envFile: string | null;
  /** Validation problems; empty when the invocation is runnable. */
  errors: string[];
}

/** A sandbox environment cluster per the .localnet/env.json convention. */
export type SeedEnvCluster = "localnet" | "devnet" | "mainnet";

/** The parsed .localnet/env.json convention file (keypair PATHS only). */
export interface SeedEnvFile {
  cluster: SeedEnvCluster;
  rpcUrl: string;
  rpcSubscriptionsUrl?: string;
  programId?: string;
  attestorUrl?: string | null;
  fixturesPath?: string | null;
  keypairs?: {
    authority?: string;
    moderator?: string;
    seeder?: string;
  } | null;
}

/** Effective seeding config after CLI > env-file > defaults merging. */
export interface SeedConfig {
  cluster: SeedEnvCluster;
  rpc: string;
  attestorUrl: string | null;
  keypair: string | null;
  moderatorKeypair: string | null;
  fixturesPath: string | null;
}

/** One sandbox provider/listing blueprint baked into the script. */
export interface SeedBlueprint {
  name: string;
  category: string;
  tags: string[];
  priceLamports: number;
  description: string;
}

/** One seeded provider+listing produced by a run. */
export interface SeededEntry {
  name: string;
  category: string;
  priceLamports: number;
  authority: string;
  agent: string;
  listing: string;
}

/** The JSON object written to the fixtures file (shipped devnet or localnet). */
export interface SeededFixturesFile {
  seeded: true;
  cluster: "devnet" | "localnet";
  programId: string;
  seededAtSlot: number;
  providers: { authority: string; agent: string; name: string }[];
  listings: {
    address: string;
    provider: string;
    name: string;
    category: string;
    priceLamports: number;
  }[];
}

export declare const SANDBOX_PROVIDER_BLUEPRINTS: readonly SeedBlueprint[];
export declare function usage(): string;
export declare function parseSeedArgs(
  argv: readonly string[],
  options?: { hasDefaultEnvFile?: boolean },
): SeedArgs;
export declare function buildFixturesFile(input: {
  programId: string;
  seededAtSlot: number;
  entries: readonly SeededEntry[];
  cluster?: "devnet" | "localnet";
}): SeededFixturesFile;

/** Parses + validates the .localnet/env.json convention file. */
export declare function parseEnvFile(raw: string, filePath: string): SeedEnvFile;

/** CLI flags > env-file values > defaults. `envFile` may be null. */
export declare function mergeEnvFileConfig(input: {
  args: SeedArgs;
  envFile: SeedEnvFile | null;
}): SeedConfig;

/** Validates the merged config; returns human-readable errors (empty = ok). */
export declare function validateSeedConfig(config: SeedConfig): string[];

/** Resolves where fixtures are written; refuses the shipped path on localnet. */
export declare function resolveFixturesOutPath(input: {
  cluster: SeedEnvCluster;
  fixturesPath: string | null;
  shippedPath?: string;
}): string;

/** Parses a solana-keygen keypair file; throws a fixed message (never echoing
 * file contents / parse-error text) on any malformed input. */
export declare function parseKeypairBytes(
  raw: string,
  filePath: string,
): Uint8Array;

/** Atomic JSON write: `${filePath}.tmp` then rename() over the target. */
export declare function writeJsonAtomic(
  filePath: string,
  value: unknown,
  fsImpl?: {
    writeFile: (file: string, data: string) => Promise<unknown>;
    rename: (from: string, to: string) => Promise<unknown>;
  },
): Promise<void>;

/** Skip-path guard: existing agent must belong to the runner keypair.
 * Returns the on-chain authority recorded in fixtures. */
export declare function verifyExistingAgent(input: {
  name: string;
  agent: string;
  onChainAuthority: string;
  runnerAuthority: string;
}): string;

/** Decoded on-chain listing fields compared on the skip path. */
export interface ExistingListingOnChain {
  authority: string;
  price: bigint;
  state: number;
  category: string;
  specHashHex: string;
}

/** Blueprint-derived expectations for an existing listing. */
export interface ExistingListingExpected {
  authority: string;
  priceLamports: number;
  activeState: number;
  category: string;
  specHashHex: string;
}

/** Skip-path guard: existing listing must match the blueprint; returns the
 * fixture fields FROM CHAIN. */
export declare function verifyExistingListing(input: {
  name: string;
  listing: string;
  onChain: ExistingListingOnChain;
  expected: ExistingListingExpected;
}): { authority: string; priceLamports: number; category: string };

/** Skip-path guard: existing ListingModeration must be CLEAN (0). */
export declare function verifyExistingModeration(input: {
  name: string;
  listing: string;
  onChainStatus: number;
}): void;
