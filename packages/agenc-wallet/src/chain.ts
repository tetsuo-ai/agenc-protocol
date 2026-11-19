// The one seam between the wallet and a Solana cluster. Everything above this
// file asks for bytes, balances and a signing client; nothing above it knows
// whether the cluster is mainnet over RPC or the in-process sandbox.
import {
  AccountRole,
  address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getCompiledTransactionMessageDecoder,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address,
  type Blockhash,
  type Instruction,
  type RpcTransport,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import {
  createMarketplaceClient,
  createRpcTransport,
  type MarketplaceClient,
  type ProgramAccountsSource,
  type SignedTransaction,
  type Transport,
} from "@tetsuo-ai/marketplace-sdk";
import {
  createSolanaAccountReaders,
  findVerifiedSettlementSignature,
  type AccountInfoReader,
} from "@tetsuo-ai/agenc-worker";
import type { WalletNetwork } from "./client/types.js";
import { WalletError } from "./errors.js";

export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const CLOCK_SYSVAR_ADDRESS = address("SysvarC1ock11111111111111111111111111111111");

/** A wallet with no data needs this much to exist at all (0-byte account). */
export const WALLET_RENT_FLOOR_SPACE = 0;

export interface RawAccount {
  data: Uint8Array;
  owner: Address;
  lamports: bigint;
}

export interface Chain {
  readonly network: WalletNetwork;
  /** A client that signs and pays fees with `signer`. */
  clientFor(signer: TransactionSigner): MarketplaceClient;
  /**
   * Send a transaction that was built somewhere else, once it carries every
   * signature it needs. Returns its signature when it is confirmed. The
   * caller has already checked what it does (see approval.ts).
   */
  sendSigned(transaction: Transaction): Promise<string>;
  /** Account bytes, or null when the account does not exist. */
  readAccount(account: Address): Promise<Uint8Array | null>;
  /** Bytes plus owner, for accounts whose owner matters. */
  readRawAccount(account: Address): Promise<RawAccount | null>;
  /** Several accounts at once, in the order asked; null for one that does not exist. */
  readRawAccounts(accounts: readonly Address[]): Promise<Array<RawAccount | null>>;
  /** Owner/executable-aware reader in the shape the worker runtime expects. */
  readAccountInfo: AccountInfoReader;
  getBalance(account: Address): Promise<bigint>;
  /** Several balances in one request, in the order asked. */
  getBalances(accounts: readonly Address[]): Promise<bigint[]>;
  getMinimumBalanceForRentExemption(space: number): Promise<bigint>;
  /** The cluster's clock, unix seconds. */
  clusterTime(): Promise<number>;
  /** Program-account scans (task discovery for the earn side). */
  readonly gpa: ProgramAccountsSource;
  /**
   * The most one plain transfer costs in fees on this chain. A wallet that
   * sends "everything" keeps this much back so the transfer itself can pay.
   */
  readonly transferFeeLamports: bigint;
  /** Most recent verified settlement transaction for a task, when known. */
  findSettlementSignature?(task: Address): Promise<string | null>;
}

/** A System Program transfer, built by hand so no extra package is needed. */
export function transferInstruction(
  from: TransactionSigner,
  to: Address,
  lamports: bigint,
): Instruction {
  if (lamports <= 0n || lamports > 0xffff_ffff_ffff_ffffn) {
    throw new WalletError("BAD_REQUEST", "That amount cannot be sent.");
  }
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from } as never,
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Hand a transport a fully signed transaction it did not build. The transport
 * needs to know when to stop waiting for it. The newest blockhash never
 * expires before the one the transaction was built on, so its last valid
 * height is a safe place to stop.
 */
export async function sendThroughTransport(
  transport: Transport,
  transaction: Transaction,
): Promise<string> {
  const latest = await transport.getLatestBlockhash();
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const signed = {
    ...transaction,
    lifetimeConstraint: {
      blockhash: message.lifetimeToken as Blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
  } as SignedTransaction;
  return (await transport.sendAndConfirm(signed)).signature;
}

/**
 * The free public endpoints. They answer anyone, and turn away anyone who
 * asks too fast: 40 calls of one kind per 10 seconds per address.
 */
const PUBLIC_RPC_HOSTS = new Set([
  "api.mainnet-beta.solana.com",
  "api.devnet.solana.com",
  "api.testnet.solana.com",
]);
/** Time between two requests to a public endpoint, to stay under its limit. */
const PUBLIC_RPC_MIN_GAP_MS = 280;
/** How many times a request the endpoint was too busy for is asked again. */
const BUSY_RETRIES = 6;

/** The HTTP status an endpoint refused a request with, when that is what happened. */
function refusedStatus(error: unknown): { status: number; retryAfterMs: number | null } | null {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  const context = error.context as { statusCode?: number; headers?: Headers };
  const seconds = Number(context.headers?.get?.("retry-after") ?? "");
  return {
    status: context.statusCode ?? 0,
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
  };
}

/**
 * True when a request failed because the network was busy, down or out of
 * reach, as opposed to being answered with a no.
 */
export function isNetworkTrouble(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth += 1) {
    const refused = refusedStatus(current);
    if (refused !== null && (refused.status === 429 || refused.status >= 500)) return true;
    if (
      current.name !== "WalletError" &&
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Wrap an RPC transport so it keeps to an endpoint's pace and waits out a
 * "too many requests" instead of failing.
 *
 *  - Requests start at least `minGapMs` apart, in the order they were made.
 *  - A request the endpoint was too busy for (429 or 503) is asked again, up
 *    to `retries` times, after the wait the endpoint names or a growing one.
 *    Every other request waits that out too, so a busy endpoint is not asked
 *    again by ten callers at once.
 *
 * Asking again is safe for everything this wallet sends: a refused request
 * was never looked at, and a signed transaction sent twice lands once.
 */
export function politeTransport(
  base: RpcTransport,
  options: {
    minGapMs: number;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    jitter?: () => number;
  },
): RpcTransport {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const jitter = options.jitter ?? Math.random;
  const retries = options.retries ?? BUSY_RETRIES;
  let nextStart = 0;
  let quietUntil = 0;

  async function turn(): Promise<void> {
    for (;;) {
      const at = Math.max(now(), nextStart, quietUntil);
      nextStart = at + options.minGapMs;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
      // Somebody else may have been told to back off while this one waited.
      if (now() >= quietUntil) return;
    }
  }

  return (async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt += 1) {
      await turn();
      try {
        return await base(config);
      } catch (error) {
        const refused = refusedStatus(error);
        const busy = refused !== null && (refused.status === 429 || refused.status === 503);
        if (!busy || attempt >= retries) throw error;
        const wait =
          refused.retryAfterMs !== null
            ? Math.min(refused.retryAfterMs, 30_000)
            : Math.min(8_000, 500 * 2 ** attempt) + Math.floor(jitter() * 250);
        quietUntil = Math.max(quietUntil, now() + wait);
      }
    }
  }) as RpcTransport;
}

export interface RpcChainOptions {
  network: Exclude<WalletNetwork, "sandbox">;
  /** HTTP RPC endpoint. */
  rpcUrl: string;
  /**
   * Least time between two requests, in milliseconds. Unset: paced for the
   * free public endpoints, unpaced for any other.
   */
  minRequestGapMs?: number;
  /** The transport to wrap (tests). Default: plain HTTP to `rpcUrl`. */
  transport?: RpcTransport;
  /**
   * Priority fee in micro-lamports per compute unit. Unset sends without one.
   * When set, transactions also carry an explicit compute-unit limit.
   */
  computeUnitPrice?: bigint;
}

/** What the network charges per signature. */
export const BASE_FEE_LAMPORTS = 5_000n;

/** Compute-unit ceiling used whenever a priority fee is configured. */
const PRICED_COMPUTE_UNIT_LIMIT = 250_000;

/** Wrap any RPC failure as a plain "cannot reach the network" refusal. */
async function network<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError("NETWORK", "The network could not be reached. Try again in a moment.", {
      cause: error,
    });
  }
}

/** A {@link Chain} over a Solana JSON-RPC endpoint. */
export function createRpcChain(options: RpcChainOptions): Chain {
  let host = "";
  try {
    host = new URL(options.rpcUrl).hostname;
  } catch {
    throw new WalletError("BAD_REQUEST", "The network address is not a valid URL.");
  }
  const rpc = createSolanaRpcFromTransport(
    politeTransport(options.transport ?? createDefaultRpcTransport({ url: options.rpcUrl }), {
      minGapMs: options.minRequestGapMs ?? (PUBLIC_RPC_HOSTS.has(host) ? PUBLIC_RPC_MIN_GAP_MS : 0),
    }),
  );
  const fetchInfo = async (account: Address) => {
    const { value } = await rpc
      .getAccountInfo(account, { commitment: "confirmed", encoding: "base64" })
      .send();
    return value;
  };
  const { readAccount, readAccountInfo } = createSolanaAccountReaders(fetchInfo);
  const transport = createRpcTransport({ rpc });

  const priorityFee =
    options.computeUnitPrice === undefined
      ? 0n
      : (options.computeUnitPrice * BigInt(PRICED_COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n;
  return {
    network: options.network,
    transferFeeLamports: BASE_FEE_LAMPORTS + priorityFee,
    clientFor(signer) {
      return createMarketplaceClient({
        rpc,
        signer,
        ...(options.computeUnitPrice !== undefined
          ? {
              computeUnitPrice: options.computeUnitPrice,
              computeUnitLimit: PRICED_COMPUTE_UNIT_LIMIT,
            }
          : {}),
      });
    },
    sendSigned: (transaction) => sendThroughTransport(transport, transaction),
    readAccount: (account) => network(() => readAccount(account)),
    readAccountInfo: (account) => network(() => readAccountInfo(account)),
    async readRawAccount(account) {
      return network(async () => {
        const value = await fetchInfo(account);
        if (value === null) return null;
        return {
          data: new Uint8Array(Buffer.from(value.data[0], "base64")),
          owner: value.owner,
          lamports: BigInt(value.lamports),
        };
      });
    },
    readRawAccounts: (accounts) =>
      network(async () => {
        const out: Array<RawAccount | null> = [];
        // The endpoint takes at most 100 addresses at a time.
        for (let start = 0; start < accounts.length; start += 100) {
          const { value } = await rpc
            .getMultipleAccounts(accounts.slice(start, start + 100), {
              commitment: "confirmed",
              encoding: "base64",
            })
            .send();
          for (const account of value) {
            out.push(
              account === null
                ? null
                : {
                    data: new Uint8Array(Buffer.from(account.data[0], "base64")),
                    owner: account.owner,
                    lamports: BigInt(account.lamports),
                  },
            );
          }
        }
        return out;
      }),
    getBalance: (account) =>
      network(async () =>
        BigInt((await rpc.getBalance(account, { commitment: "confirmed" }).send()).value),
      ),
    getBalances: (accounts) =>
      network(async () => {
        const out: bigint[] = [];
        // The endpoint takes at most 100 addresses at a time.
        for (let start = 0; start < accounts.length; start += 100) {
          const { value } = await rpc
            .getMultipleAccounts(accounts.slice(start, start + 100), {
              commitment: "confirmed",
              encoding: "base64",
              dataSlice: { offset: 0, length: 0 },
            })
            .send();
          for (const account of value) out.push(account === null ? 0n : BigInt(account.lamports));
        }
        return out;
      }),
    getMinimumBalanceForRentExemption: (space) =>
      network(async () =>
        BigInt(
          await rpc
            .getMinimumBalanceForRentExemption(BigInt(space), { commitment: "confirmed" })
            .send(),
        ),
      ),
    async clusterTime() {
      return network(async () => {
        const value = await fetchInfo(CLOCK_SYSVAR_ADDRESS);
        if (value === null) throw new Error("clock sysvar is missing");
        const bytes = Buffer.from(value.data[0], "base64");
        if (bytes.length < 40) throw new Error("clock sysvar is malformed");
        return Number(bytes.readBigInt64LE(32));
      });
    },
    gpa: rpc,
    findSettlementSignature: (task) => findVerifiedSettlementSignature(rpc, task),
  };
}

/** Default public endpoints. A dedicated RPC is faster and less rate-limited. */
export const DEFAULT_RPC_URLS: Record<Exclude<WalletNetwork, "sandbox">, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};
