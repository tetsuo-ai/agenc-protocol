// createSandboxClient: one call from nothing to a funded, devnet-wired
// MarketplaceClient. Browser-safe (kit RPC + WebCrypto keygen only).
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  type Address,
  type Commitment,
  type KeyPairSigner,
  type Lamports,
  type Signature,
} from "@solana/kit";
import {
  createMarketplaceClient,
  type MarketplaceClient,
  type RpcTransportRpc,
  type RpcTransportSubscriptions,
} from "../client/index.js";
import type { WaitForTaskStatusRpc } from "../events/index.js";
import {
  resolveSandboxEnvironment,
  SANDBOX_DEVNET_RPC_URL,
} from "./environment.js";
import { SANDBOX_FIXTURES } from "./fixtures.js";

/** Default airdrop request: 2 SOL of devnet play money. */
export const DEFAULT_SANDBOX_AIRDROP_LAMPORTS = 2_000_000_000n;

/**
 * The airdrop/balance slice of the devnet RPC that the sandbox needs on top
 * of the transaction-pipeline slice ({@link RpcTransportRpc}).
 */
export type SandboxAirdropRpc = {
  requestAirdrop(
    recipientAccount: Address,
    lamports: Lamports,
    config?: { readonly commitment?: Commitment },
  ): {
    send(options?: { readonly abortSignal?: AbortSignal }): Promise<Signature>;
  };
  getBalance(
    address: Address,
    config?: { readonly commitment?: Commitment },
  ): {
    send(options?: {
      readonly abortSignal?: AbortSignal;
    }): Promise<{ readonly value: Lamports }>;
  };
};

/**
 * The structural RPC surface a sandbox client carries: the client transaction
 * pipeline ({@link RpcTransportRpc}), airdrop + balance
 * ({@link SandboxAirdropRpc}), and base64 `getAccountInfo` (the
 * `WaitForTaskStatusRpc` slice — so `waitForTaskStatus` and account decoding
 * work against `sandbox.rpc` directly). A kit `createSolanaRpc(...)` client
 * for a non-mainnet URL satisfies all three.
 */
export type SandboxRpc = RpcTransportRpc & SandboxAirdropRpc & WaitForTaskStatusRpc;

/** Options for {@link createSandboxClient}. */
export interface CreateSandboxClientOptions {
  /**
   * HTTP RPC endpoint. Defaults through the environment seam
   * (`resolveSandboxEnvironment`): `AGENC_SANDBOX_RPC_URL` /
   * `AGENC_SANDBOX_CLUSTER` when set, otherwise
   * {@link SANDBOX_DEVNET_RPC_URL}. Must look devnet/local — hostname
   * containing `"devnet"`, or localhost/127.0.0.1/::1 — unless
   * `allowCustomRpc` is set; anything else is refused with
   * {@link SandboxClusterError} before any key generation or airdrop.
   */
  rpcUrl?: string;
  /**
   * WebSocket endpoint. Defaults through the environment seam: when `rpcUrl`
   * is overridden (option or env var), derived from it (`http` → `ws`,
   * `https` → `wss`, same host/port/path) so confirmations come from the
   * same cluster the sends go to; otherwise the resolved cluster default
   * ({@link SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL} for devnet).
   */
  rpcSubscriptionsUrl?: string;
  /**
   * Inject a pre-built RPC (tests / custom transports). When set, no network
   * connection is created from `rpcUrl`, and no WebSocket connection is
   * dialed unless `rpcSubscriptions` is also given.
   */
  rpc?: SandboxRpc;
  /** Inject pre-built RPC subscriptions alongside `rpc`. */
  rpcSubscriptions?: RpcTransportSubscriptions;
  /** Bring your own signer instead of a generated throwaway key. */
  signer?: KeyPairSigner;
  /** Airdrop size in lamports (default {@link DEFAULT_SANDBOX_AIRDROP_LAMPORTS}); `0n` skips. */
  airdropLamports?: bigint;
  /** Skip the airdrop entirely (e.g. after funding via https://faucet.solana.com). */
  skipAirdrop?: boolean;
  /**
   * Skip the devnet-hostname guard on `rpcUrl`. By default a custom `rpcUrl`
   * whose hostname does not contain `"devnet"` and is not
   * localhost/127.0.0.1/::1 is refused with {@link SandboxClusterError}
   * before any key generation or airdrop — this module is DEVNET ONLY and a
   * throwaway sandbox key must never sign against a real cluster. Set this
   * only when the endpoint truly fronts devnet or a local validator (e.g. a
   * custom-domain devnet proxy).
   */
  allowCustomRpc?: boolean;
  /** Give up waiting for the airdrop after this many ms (default 90_000). */
  airdropTimeoutMs?: number;
  /** Balance poll interval while waiting for the airdrop (default 1_000 ms). */
  airdropPollIntervalMs?: number;
  /** Commitment for the client pipeline + airdrop polling (default "confirmed"). */
  commitment?: Commitment;
}

/** What {@link createSandboxClient} returns. */
export interface SandboxClient {
  /** A {@link MarketplaceClient} wired to devnet, signing with `signer`. */
  client: MarketplaceClient;
  /** The throwaway (or injected) devnet signer — fee payer for every send. */
  signer: KeyPairSigner;
  /** The underlying RPC, for reads (`getAccountInfo`, `waitForTaskStatus`, queries). */
  rpc: SandboxRpc;
}

/**
 * Thrown when the devnet airdrop cannot be requested or never lands within
 * the bounded wait. The message always points at the manual faucet.
 */
export class SandboxAirdropError extends Error {
  /** The address that needed funding. */
  readonly address: Address;

  constructor(message: string, options: { address: Address; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "SandboxAirdropError";
    this.address = options.address;
  }
}

/**
 * Thrown by {@link createSandboxClient} BEFORE any key generation, signing,
 * or airdrop when `rpcUrl` does not look like a devnet/local endpoint
 * (hostname containing `"devnet"`, or localhost/127.0.0.1/::1) and
 * `allowCustomRpc` was not set. The sandbox is DEVNET ONLY: a throwaway
 * in-memory key must never end up signing transactions on a real cluster.
 */
export class SandboxClusterError extends Error {
  /** The rejected RPC URL. */
  readonly rpcUrl: string;

  constructor(message: string, options: { rpcUrl: string }) {
    super(message);
    this.name = "SandboxClusterError";
    this.rpcUrl = options.rpcUrl;
  }
}

/** Hostnames the devnet guard always accepts (local test validators). */
const SANDBOX_LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/** Throw {@link SandboxClusterError} unless `rpcUrl` looks devnet/local. */
function assertDevnetLikeRpcUrl(rpcUrl: string): void {
  let hostname: string | null;
  try {
    hostname = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    hostname = null; // unparseable — fail closed below
  }
  if (
    hostname !== null &&
    (hostname.includes("devnet") || SANDBOX_LOCAL_HOSTNAMES.has(hostname))
  ) {
    return;
  }
  throw new SandboxClusterError(
    `createSandboxClient is DEVNET ONLY, but rpcUrl ${JSON.stringify(rpcUrl)} ` +
      `does not look like a devnet endpoint (the hostname must contain ` +
      `"devnet" or be localhost/127.0.0.1/::1). Refusing before any key ` +
      `generation or airdrop so a throwaway sandbox key never signs on a ` +
      `real cluster. If this endpoint truly fronts devnet or a local ` +
      `validator, pass { allowCustomRpc: true }.`,
    { rpcUrl },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAUCET_HINT =
  "First confirm rpcUrl points at devnet (this module is devnet-only; the " +
  "faucet does not exist elsewhere). The public devnet faucet rate-limits " +
  "aggressively; if this keeps failing, fund the address manually at " +
  "https://faucet.solana.com and retry with { skipAirdrop: true } (pass the " +
  "same signer back in via { signer }).";

/** Request an airdrop and wait (bounded) until the balance reflects it. */
async function fundViaAirdrop(
  rpc: SandboxRpc,
  recipient: Address,
  amount: bigint,
  commitment: Commitment,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  try {
    await rpc
      .requestAirdrop(recipient, lamports(amount), { commitment })
      .send();
  } catch (cause) {
    throw new SandboxAirdropError(
      `devnet airdrop request for ${recipient} failed (likely faucet ` +
        `rate-limiting). ${FAUCET_HINT}`,
      { address: recipient, cause },
    );
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getBalance(recipient, { commitment }).send();
    if (value >= amount) return;
    if (Date.now() >= deadline) {
      throw new SandboxAirdropError(
        `devnet airdrop for ${recipient} was requested but the balance never ` +
          `reached ${amount} lamports within ${timeoutMs}ms. ${FAUCET_HINT}`,
        { address: recipient },
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Create a funded, devnet-wired {@link MarketplaceClient} in one call:
 * connect to devnet RPC, generate a throwaway `KeyPairSigner`, request a
 * faucet airdrop (default 2 SOL), wait until it lands, and return
 * `{ client, signer, rpc }`.
 *
 * Endpoint defaults flow through the environment seam
 * (`resolveSandboxEnvironment`): with `AGENC_SANDBOX_CLUSTER=localnet` (or
 * `AGENC_SANDBOX_RPC_URL` pointing at a local validator) the same call
 * targets a localnet stack instead of public devnet — localhost URLs pass
 * the cluster guard via the localhost allowlist.
 *
 * ## DEVNET ONLY — throwaway keys, never real funds
 *
 * This is the test-mode entry point (PLAN.md P2.4). The generated key lives
 * only in this process and is NOT persisted anywhere: treat it as disposable,
 * never send real (mainnet) funds to it, and never point `rpcUrl` at mainnet
 * — a `rpcUrl` whose hostname does not contain `"devnet"` and is not
 * localhost/127.0.0.1/::1 is refused with {@link SandboxClusterError} before
 * any key generation or airdrop, unless you explicitly opt out with
 * `allowCustomRpc: true`.
 *
 * @param options - Endpoint, signer, and airdrop overrides; see
 *   {@link CreateSandboxClientOptions}.
 * @returns `{ client, signer, rpc }` — client for sends, rpc for reads.
 * @throws {@link SandboxClusterError} when `rpcUrl` does not look like a
 *   devnet/local endpoint and `allowCustomRpc` is not set.
 * @throws {@link SandboxAirdropError} when the faucet rejects the airdrop or
 *   it never lands within `airdropTimeoutMs`; the message points at
 *   https://faucet.solana.com and the `{ skipAirdrop: true }` escape hatch.
 *
 * @example
 * ```ts
 * import { createSandboxClient } from "@tetsuo-ai/marketplace-sdk/sandbox";
 *
 * const sandbox = await createSandboxClient();
 * const { signature } = await sandbox.client.registerAgent({
 *   authority: sandbox.signer,
 *   agentId: crypto.getRandomValues(new Uint8Array(32)),
 *   capabilities: 1n,
 *   endpoint: "https://example.invalid/devnet-agent",
 *   metadataUri: null,
 *   stakeAmount: 0n,
 * });
 * ```
 */
export async function createSandboxClient(
  options: CreateSandboxClientOptions = {},
): Promise<SandboxClient> {
  // The environment seam resolves the endpoints: explicit options beat the
  // AGENC_SANDBOX_* env vars, which beat the shipped devnet defaults. The
  // shipped fixtures are passed through so client creation never depends on
  // an AGENC_SANDBOX_FIXTURES file it does not use.
  const environment = await resolveSandboxEnvironment({
    rpcUrl: options.rpcUrl,
    rpcSubscriptionsUrl: options.rpcSubscriptionsUrl,
    fixtures: SANDBOX_FIXTURES,
  });
  // Cluster guard FIRST: refuse a non-devnet-looking rpcUrl before any key
  // generation, airdrop, or send. The airdrop failure must never be the only
  // thing standing between a throwaway key and a real cluster. The shipped
  // devnet default needs no check; localnet URLs pass via the localhost
  // allowlist (one source of truth: SANDBOX_LOCAL_HOSTNAMES below).
  if (
    environment.rpcUrl !== SANDBOX_DEVNET_RPC_URL &&
    options.allowCustomRpc !== true
  ) {
    assertDevnetLikeRpcUrl(environment.rpcUrl);
  }
  const commitment = options.commitment ?? "confirmed";
  const rpc: SandboxRpc = options.rpc ?? createSolanaRpc(environment.rpcUrl);
  // Only dial a WebSocket when we also own the HTTP connection; an injected
  // rpc (tests, custom stacks) gets subscriptions only if injected too. The
  // seam already derived a matching ws endpoint for a custom rpcUrl (http→ws
  // / https→wss, same host/port/path) so confirmations come from the SAME
  // cluster the sends go to; the public-devnet wss default applies only when
  // rpcUrl defaulted too.
  const rpcSubscriptions =
    options.rpcSubscriptions ??
    (options.rpc
      ? undefined
      : createSolanaRpcSubscriptions(environment.rpcSubscriptionsUrl));

  const signer = options.signer ?? (await generateKeyPairSigner());

  const airdropLamports =
    options.airdropLamports ?? DEFAULT_SANDBOX_AIRDROP_LAMPORTS;
  if (!options.skipAirdrop && airdropLamports > 0n) {
    await fundViaAirdrop(
      rpc,
      signer.address,
      airdropLamports,
      commitment,
      options.airdropTimeoutMs ?? 90_000,
      options.airdropPollIntervalMs ?? 1_000,
    );
  }

  const client = createMarketplaceClient({
    rpc,
    rpcSubscriptions,
    signer,
    commitment,
  });
  return { client, signer, rpc };
}
