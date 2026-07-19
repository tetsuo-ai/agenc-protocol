// `agenc.config.json` — the one file every `agenc` command shares. `init`
// writes it, `dev` reads the listing defaults from it, `promote` audits it.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { values } from "@tetsuo-ai/marketplace-sdk";

export const CONFIG_FILENAME = "agenc.config.json";
export const AGENC_NETWORKS = ["localnet", "devnet", "mainnet-beta"] as const;
export type AgencNetwork = (typeof AGENC_NETWORKS)[number];

/** The service listing `agenc dev` creates for this project. */
export interface AgencListingConfig {
  /** Listing price in lamports (decimal string — JSON-safe u64). */
  priceLamports: string;
  /** Operator fee routed to the listing operator at settlement (bps, ≤2000). */
  operatorFeeBps: number;
  /** Demand-side referral fee set on the hire (bps, ≤2000). */
  referrerFeeBps: number;
  category: string;
  tags: string[];
}

export interface AgencConfig {
  /** Human-readable project/service name (defaults from package.json). */
  name: string;
  /** What `init` wired: a Next.js checkout surface or a worker loop. */
  kind: "checkout" | "worker";
  /** Target network. `init` always writes "localnet"; promote flips nothing. */
  network: AgencNetwork;
  /** Production RPC endpoint (null until you configure one for promote). */
  rpcUrl: string | null;
  /** Signer keypair path for production flows (null until configured). */
  walletPath: string | null;
  listing: AgencListingConfig;
}

export class AgencConfigError extends Error {
  override name = "AgencConfigError";
}

export const DEFAULT_PRICE_LAMPORTS = "1000000"; // 0.001 SOL
export const DEFAULT_OPERATOR_FEE_BPS = 1000; // 10% — MAX_OPERATOR_FEE_BPS is 2000
export const DEFAULT_REFERRER_FEE_BPS = 500; // 5% — MAX_REFERRER_FEE_BPS is 2000
const U64_MAX = 18_446_744_073_709_551_615n;
const MIN_LISTING_PRICE_LAMPORTS = 1_000n;
const MAX_CONFIG_BYTES = 64 * 1024;

function defaultListingName(name: string): string {
  const source = name.replace(/\u0000/gu, "").trim();
  let result = "";
  for (const character of source) {
    if (
      new TextEncoder().encode(result + character).byteLength >
      values.LISTING_NAME_BYTES
    ) {
      break;
    }
    result += character;
  }
  return result === "" ? "agenc-project" : result;
}

export function defaultConfig(
  name: string,
  kind: "checkout" | "worker",
): AgencConfig {
  return {
    // The dev listing uses this name on-chain. Bound by UTF-8 bytes without
    // splitting surrogate pairs; JavaScript code-unit slicing is not safe.
    name: defaultListingName(name),
    kind,
    network: "localnet",
    rpcUrl: null,
    walletPath: null,
    listing: {
      priceLamports: DEFAULT_PRICE_LAMPORTS,
      operatorFeeBps: DEFAULT_OPERATOR_FEE_BPS,
      referrerFeeBps: DEFAULT_REFERRER_FEE_BPS,
      category: "other",
      tags: ["agenc"],
    },
  };
}

export function serializeConfig(config: AgencConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  filePath: string,
  label = "root",
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    const property = label === "root" ? unknown : `${label}.${unknown}`;
    throw new AgencConfigError(
      `${filePath}: unknown property "${property}"`,
    );
  }
}

/** Parse + minimally validate an agenc.config.json body. */
export function parseConfig(body: string, filePath: string): AgencConfig {
  if (new TextEncoder().encode(body).byteLength > MAX_CONFIG_BYTES) {
    throw new AgencConfigError(
      `${filePath}: config exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new AgencConfigError(
      `${filePath}: not valid JSON — ${(error as Error).message}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new AgencConfigError(`${filePath}: expected a JSON object`);
  }
  assertExactKeys(
    parsed,
    ["name", "kind", "network", "rpcUrl", "walletPath", "listing"],
    filePath,
  );
  const name = parsed.name;
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.includes("\u0000") ||
    new TextEncoder().encode(name).byteLength > values.LISTING_NAME_BYTES
  ) {
    throw new AgencConfigError(
      `${filePath}: "name" must be non-empty and fit ${values.LISTING_NAME_BYTES} UTF-8 bytes without NUL`,
    );
  }
  const kind = parsed.kind;
  if (kind !== "checkout" && kind !== "worker") {
    throw new AgencConfigError(
      `${filePath}: "kind" must be "checkout" or "worker"`,
    );
  }
  const base = defaultConfig(name, kind);
  if ("network" in parsed) {
    if (!AGENC_NETWORKS.includes(parsed.network as AgencNetwork)) {
      throw new AgencConfigError(
        `${filePath}: "network" must be "localnet", "devnet", or "mainnet-beta"`,
      );
    }
    base.network = parsed.network as AgencNetwork;
  }
  for (const key of ["rpcUrl", "walletPath"] as const) {
    if (key in parsed) {
      const value = parsed[key];
      if (value !== null && (typeof value !== "string" || value.trim() === "")) {
        throw new AgencConfigError(
          `${filePath}: "${key}" must be null or a non-empty string`,
        );
      }
      base[key] = value as string | null;
    }
  }
  if (base.rpcUrl !== null) {
    let rpcUrl: URL;
    try {
      rpcUrl = new URL(base.rpcUrl);
    } catch {
      throw new AgencConfigError(
        `${filePath}: "rpcUrl" must be an absolute credential-free HTTPS URL`,
      );
    }
    if (
      rpcUrl.protocol !== "https:" ||
      rpcUrl.username !== "" ||
      rpcUrl.password !== "" ||
      rpcUrl.search !== "" ||
      rpcUrl.hash !== ""
    ) {
      throw new AgencConfigError(
        `${filePath}: "rpcUrl" is committed configuration and must be credential-free HTTPS with no query or fragment; inject provider secrets with AGENC_RPC_URL`,
      );
    }
  }
  const listing = parsed.listing;
  if ("listing" in parsed) {
    if (!isRecord(listing)) {
      throw new AgencConfigError(`${filePath}: "listing" must be an object`);
    }
    assertExactKeys(
      listing,
      [
        "priceLamports",
        "operatorFeeBps",
        "referrerFeeBps",
        "category",
        "tags",
      ],
      filePath,
      "listing",
    );
    if ("priceLamports" in listing) {
      if (typeof listing.priceLamports !== "string") {
        throw new AgencConfigError(
          `${filePath}: "listing.priceLamports" must be a canonical decimal string`,
        );
      }
      if (
        listing.priceLamports.length > 20 ||
        !/^(0|[1-9]\d*)$/u.test(listing.priceLamports) ||
        BigInt(listing.priceLamports) < MIN_LISTING_PRICE_LAMPORTS ||
        BigInt(listing.priceLamports) > U64_MAX
      ) {
        throw new AgencConfigError(
          `${filePath}: "listing.priceLamports" must be a canonical decimal string (${MIN_LISTING_PRICE_LAMPORTS}..${U64_MAX})`,
        );
      }
      base.listing.priceLamports = listing.priceLamports;
    }
    for (const key of ["operatorFeeBps", "referrerFeeBps"] as const) {
      const value = listing[key];
      if (value !== undefined) {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 2000
        ) {
          throw new AgencConfigError(
            `${filePath}: "listing.${key}" must be an integer 0..2000 (bps)`,
          );
        }
        base.listing[key] = value;
      }
    }
    if ("category" in listing) {
      if (
        typeof listing.category !== "string" ||
        !values.isListingCategory(listing.category) ||
        new TextEncoder().encode(listing.category).byteLength >
          values.LISTING_CATEGORY_BYTES
      ) {
        throw new AgencConfigError(
          `${filePath}: "listing.category" must be a canonical lowercase-kebab LISTING_METADATA category fitting ${values.LISTING_CATEGORY_BYTES} UTF-8 bytes`,
        );
      }
      base.listing.category = listing.category;
    }
    if ("tags" in listing) {
      if (
        !Array.isArray(listing.tags) ||
        !listing.tags.every(
          (tag): tag is string =>
            typeof tag === "string" && values.LISTING_KEBAB_PATTERN.test(tag),
        ) ||
        new Set(listing.tags).size !== listing.tags.length ||
        new TextEncoder().encode(listing.tags.join(",")).byteLength >
          values.LISTING_TAGS_BYTES
      ) {
        throw new AgencConfigError(
          `${filePath}: "listing.tags" must be unique lowercase-kebab tokens whose joined UTF-8 encoding fits ${values.LISTING_TAGS_BYTES} bytes`,
        );
      }
      base.listing.tags = listing.tags;
    }
  }
  return base;
}

/** Load `<dir>/agenc.config.json`; `null` when the file does not exist. */
export function loadConfig(
  dir: string,
): { config: AgencConfig; path: string } | null {
  const filePath = path.join(dir, CONFIG_FILENAME);
  if (!existsSync(filePath)) return null;
  const size = statSync(filePath).size;
  if (size > MAX_CONFIG_BYTES) {
    throw new AgencConfigError(
      `${filePath}: config exceeds ${MAX_CONFIG_BYTES} bytes`,
    );
  }
  return {
    config: parseConfig(readFileSync(filePath, "utf8"), filePath),
    path: filePath,
  };
}
