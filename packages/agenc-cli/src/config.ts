// `agenc.config.json` — the one file every `agenc` command shares. `init`
// writes it, `dev` reads the listing defaults from it, `promote` audits it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "agenc.config.json";

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
  network: string;
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

export function defaultConfig(
  name: string,
  kind: "checkout" | "worker",
): AgencConfig {
  return {
    name,
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

/** Parse + minimally validate an agenc.config.json body. */
export function parseConfig(body: string, filePath: string): AgencConfig {
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
  const name = parsed.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new AgencConfigError(`${filePath}: "name" must be a non-empty string`);
  }
  const kind = parsed.kind;
  if (kind !== "checkout" && kind !== "worker") {
    throw new AgencConfigError(
      `${filePath}: "kind" must be "checkout" or "worker"`,
    );
  }
  const base = defaultConfig(name, kind);
  if (typeof parsed.network === "string") base.network = parsed.network;
  if (typeof parsed.rpcUrl === "string") base.rpcUrl = parsed.rpcUrl;
  if (typeof parsed.walletPath === "string") base.walletPath = parsed.walletPath;
  const listing = parsed.listing;
  if (isRecord(listing)) {
    if (typeof listing.priceLamports === "string") {
      if (!/^\d+$/u.test(listing.priceLamports)) {
        throw new AgencConfigError(
          `${filePath}: "listing.priceLamports" must be a decimal lamport string`,
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
    if (typeof listing.category === "string") base.listing.category = listing.category;
    if (
      Array.isArray(listing.tags) &&
      listing.tags.every((t): t is string => typeof t === "string")
    ) {
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
  return {
    config: parseConfig(readFileSync(filePath, "utf8"), filePath),
    path: filePath,
  };
}
