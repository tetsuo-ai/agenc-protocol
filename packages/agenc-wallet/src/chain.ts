// The one seam between the wallet and a Solana cluster. Everything above this
// file asks for bytes, balances and a signing client; nothing above it knows
// whether the cluster is mainnet over RPC or the in-process sandbox.
import {
  AccountRole,
  address,
  createSolanaRpc,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  createMarketplaceClient,
  type MarketplaceClient,
  type ProgramAccountsSource,
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
  /** Account bytes, or null when the account does not exist. */
  readAccount(account: Address): Promise<Uint8Array | null>;
  /** Bytes plus owner, for accounts whose owner matters. */
  readRawAccount(account: Address): Promise<RawAccount | null>;
  /** Owner/executable-aware reader in the shape the worker runtime expects. */
  readAccountInfo: AccountInfoReader;
  getBalance(account: Address): Promise<bigint>;
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

export interface RpcChainOptions {
  network: Exclude<WalletNetwork, "sandbox">;
  /** HTTP RPC endpoint. */
  rpcUrl: string;
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
  const rpc = createSolanaRpc(options.rpcUrl);
  const fetchInfo = async (account: Address) => {
    const { value } = await rpc
      .getAccountInfo(account, { commitment: "confirmed", encoding: "base64" })
      .send();
    return value;
  };
  const { readAccount, readAccountInfo } = createSolanaAccountReaders(fetchInfo);

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
    getBalance: (account) =>
      network(async () =>
        BigInt((await rpc.getBalance(account, { commitment: "confirmed" }).send()).value),
      ),
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
