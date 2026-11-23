// Dollars per SOL, so the panel can speak in dollars.
//
// The default source reads Pyth's sponsored SOL/USD price account straight
// from the chain through the RPC the wallet already uses: no price API, no
// account, no key. The account is checked (owner, layout, feed id, age)
// before a number is believed; anything odd yields "no price", and the panel
// then shows SOL amounts instead of a wrong dollar figure.
import { address, type Address } from "@solana/kit";
import type { Chain } from "./chain.js";

export interface PriceSource {
  /** Dollars per SOL, or null when no trustworthy price is available. */
  solUsd(options?: { fresh?: boolean }): Promise<number | null>;
}

/** A constant price (sandbox play money, tests). */
export function fixedPrice(usdPerSol: number): PriceSource {
  return { solUsd: async () => usdPerSol };
}

/** Pyth "SOL/USD" price feed account (sponsored, mainnet). */
export const PYTH_SOL_USD_ACCOUNT = address("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
/** The Pyth receiver program that owns price accounts. */
export const PYTH_RECEIVER_PROGRAM = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/** Feed id of SOL/USD. */
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PRICE_UPDATE_DISCRIMINATOR = "22f123639d7ef4cd";
/** A price older than this is not shown as current. */
const MAX_PRICE_AGE_SECS = 15 * 60;
const CACHE_MS = 60_000;

/**
 * Decode a Pyth `PriceUpdateV2` account. Returns null unless every check
 * passes. Layout: 8 discriminator, 32 write authority, verification level
 * (1 byte, or 2 for the `Partial` variant), then the price message: 32 feed
 * id, i64 price, u64 confidence, i32 exponent, i64 publish time.
 */
export function decodePythPrice(
  data: Uint8Array,
  options: { feedIdHex: string; nowSecs: number; maxAgeSecs?: number },
): number | null {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8) return null;
  if (buffer.subarray(0, 8).toString("hex") !== PRICE_UPDATE_DISCRIMINATOR) return null;
  let offset = 8 + 32;
  const level = buffer[offset];
  if (level === 0) offset += 2;
  else if (level === 1) offset += 1;
  else return null;
  if (buffer.length < offset + 32 + 8 + 8 + 4 + 8) return null;
  if (buffer.subarray(offset, offset + 32).toString("hex") !== options.feedIdHex) return null;
  offset += 32;
  const price = buffer.readBigInt64LE(offset);
  const confidence = buffer.readBigUInt64LE(offset + 8);
  const exponent = buffer.readInt32LE(offset + 16);
  const publishTime = Number(buffer.readBigInt64LE(offset + 20));
  if (price <= 0n || exponent > 0 || exponent < -18) return null;
  const age = options.nowSecs - publishTime;
  if (age > (options.maxAgeSecs ?? MAX_PRICE_AGE_SECS) || age < -120) return null;
  // Refuse a price whose stated uncertainty is more than 2% of the price.
  if (confidence * 50n > price) return null;
  const value = Number(price) * 10 ** exponent;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Read SOL/USD from the Pyth price account on `chain`. */
export function pythPrice(
  chain: Pick<Chain, "readRawAccount">,
  options: { account?: Address; now?: () => number } = {},
): PriceSource {
  const account = options.account ?? PYTH_SOL_USD_ACCOUNT;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: number | null } | null = null;
  return {
    async solUsd(read) {
      if (!read?.fresh && cached !== null && now() - cached.at < CACHE_MS) return cached.value;
      let value: number | null = null;
      try {
        const raw = await chain.readRawAccount(account);
        if (raw !== null && raw.owner === PYTH_RECEIVER_PROGRAM) {
          value = decodePythPrice(raw.data, {
            feedIdHex: PYTH_SOL_USD_FEED_ID,
            nowSecs: Math.floor(now() / 1000),
          });
        }
      } catch {
        value = null;
      }
      cached = { at: now(), value };
      return value;
    },
  };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Lamports to US cents at `usdPerSol`, or null without a price. */
export function lamportsToCents(lamports: bigint, usdPerSol: number | null): number | null {
  if (usdPerSol === null) return null;
  const cents = (Number(lamports) / LAMPORTS_PER_SOL) * usdPerSol * 100;
  return Math.round(cents * 100) / 100;
}

/** US cents to lamports at `usdPerSol`, rounded up so a cap is never undershot. */
export function centsToLamports(cents: number, usdPerSol: number): bigint {
  if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(usdPerSol) || usdPerSol <= 0) {
    return 0n;
  }
  return BigInt(Math.ceil((cents / 100 / usdPerSol) * LAMPORTS_PER_SOL));
}
