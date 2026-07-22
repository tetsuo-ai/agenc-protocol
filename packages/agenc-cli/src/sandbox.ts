// `agenc dev`'s in-process fallback — the cold-machine path. When no localnet
// stack is discoverable (or `--sandbox` forces it), boot the REAL compiled
// agenc-coordination program in litesvm via the sdk's
// `@tetsuo-ai/marketplace-sdk/testing` sandbox (the compiled `.so` ships in
// the sdk's testing-assets — zero toolchain, no validator, no anchor build)
// and run the SAME `runDevLoop` counterparty-bot lifecycle the localnet path
// runs, printing the same 4-way settlement split.
import { generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import {
  findProtocolConfigPda,
  getProtocolConfigDecoder,
  getProtocolConfigEncoder,
} from "@tetsuo-ai/marketplace-sdk";
import type { LocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  runDevLoop,
  type DevListingTerms,
  type DevLoopResult,
} from "./bots.js";
import { GpaSimulator } from "./gpa-sim.js";
import { LocalnetError } from "./localnet.js";

/**
 * Protocol fee stamped into the sandbox `ProtocolConfig` — 500 bps (5%),
 * matching the LIVE mainnet fee, so the printed treasury leg mirrors what a
 * real settlement pays.
 */
export const SANDBOX_PROTOCOL_FEE_BPS = 500;

/** Rent-exempt-plus funding for the pure payee wallets (operator/referrer). */
const PAYEE_FUNDING_LAMPORTS = 10_000_000n;

type TestingModule = typeof import("@tetsuo-ai/marketplace-sdk/testing");

async function importTesting(): Promise<TestingModule> {
  try {
    return await import("@tetsuo-ai/marketplace-sdk/testing");
  } catch (error) {
    throw new LocalnetError(
      [
        "the in-process sandbox could not load `@tetsuo-ai/marketplace-sdk/testing`:",
        `  ${error instanceof Error ? error.message : String(error)}`,
        "",
        "It needs the `litesvm` native module (an optional peer of the sdk,",
        "normally installed alongside this CLI):",
        "",
        "  npm install litesvm",
        "",
        "or run against a real localnet stack instead (see `agenc dev --localnet`).",
      ].join("\n"),
    );
  }
}

/**
 * Re-stamp the sandbox's seeded `ProtocolConfig.protocolFeeBps` at the live
 * mainnet fee ({@link SANDBOX_PROTOCOL_FEE_BPS}) so the demo's treasury leg
 * is production-truthful. Decode → patch one field → re-encode; every other
 * seeded value is preserved.
 */
async function stampLiveProtocolFee(market: LocalMarketplace): Promise<void> {
  const [pda] = await findProtocolConfigPda();
  const account = market.svm.getAccount(pda);
  if (!account || !account.exists) {
    throw new LocalnetError(
      "sandbox ProtocolConfig missing after boot — the sdk testing sandbox did not seed it",
    );
  }
  const config = getProtocolConfigDecoder().decode(
    Uint8Array.from(account.data),
  );
  if (config.protocolFeeBps === SANDBOX_PROTOCOL_FEE_BPS) return;
  const data = getProtocolConfigEncoder().encode({
    ...config,
    protocolFeeBps: SANDBOX_PROTOCOL_FEE_BPS,
  });
  market.svm.setAccount({
    address: pda,
    data: data as Uint8Array,
    executable: false,
    lamports: account.lamports,
    programAddress: account.programAddress,
    space: BigInt(data.length),
  });
}

export interface SandboxRunOptions {
  listing: DevListingTerms;
  /** Scratch dir for the worker bot's state files. */
  stateDir: string;
  log: (line: string) => void;
}

/**
 * Boot the in-process sandbox and run the full `agenc dev` bot loop once.
 * Same lifecycle, same split table inputs as the localnet path — just no
 * validator process and no RPC.
 */
export async function runDevSandbox(
  options: SandboxRunOptions,
): Promise<DevLoopResult> {
  const { log } = options;
  const testing = await importTesting();
  const market = await testing.startLocalMarketplace();
  await stampLiveProtocolFee(market);
  log(
    "sandbox: REAL compiled agenc-coordination program booted in-process " +
      `(litesvm) — protocol fee stamped at ${SANDBOX_PROTOCOL_FEE_BPS} bps (live mainnet parity)`,
  );

  // Throwaway in-VM actors: buyer + provider sign transactions; operator +
  // referrer are pure payees (funded so the fee legs land on rent-exempt
  // accounts — a mainnet requirement the sandbox mirrors).
  const buyerSigner = await market.fundedSigner();
  const providerSigner = await market.fundedSigner();
  const operator = await generateKeyPairSigner();
  const referrer = await generateKeyPairSigner();
  market.svm.airdrop(operator.address, lamports(PAYEE_FUNDING_LAMPORTS));
  market.svm.airdrop(referrer.address, lamports(PAYEE_FUNDING_LAMPORTS));
  log(
    `buyer bot ${buyerSigner.address}, worker bot ${providerSigner.address}, ` +
      "operator + referrer payees: throwaway wallets funded in-VM",
  );
  log(`moderator: sandbox moderation authority ${market.moderator.address}`);

  const gpa = new GpaSimulator(market.svm);
  const readAccount = async (address: Address): Promise<Uint8Array | null> => {
    const account = market.svm.getAccount(address);
    if (!account || !account.exists) return null;
    return Uint8Array.from(account.data);
  };
  const readAccountInfo = async (address: Address) => {
    const account = market.svm.getAccount(address);
    if (!account || !account.exists) return null;
    return {
      data: Uint8Array.from(account.data),
      owner: account.programAddress,
      executable: account.executable,
    };
  };

  return runDevLoop({
    buyer: { signer: buyerSigner, client: market.clientFor(buyerSigner) },
    provider: {
      signer: providerSigner,
      client: market.clientFor(providerSigner),
    },
    moderator: {
      signer: market.moderator.signer,
      client: market.clientFor(market.moderator.signer),
    },
    operator: operator.address,
    referrer: referrer.address,
    readAccount,
    readAccountInfo,
    getBalance: async (address: Address) =>
      market.svm.getBalance(address) ?? 0n,
    getMinimumBalanceForRentExemption: async (space: number) =>
      market.svm.minimumBalanceForRentExemption(BigInt(space)),
    gpa,
    stateDir: options.stateDir,
    log,
    listing: options.listing,
    registerGpaAddress: (...addresses) => gpa.register(...addresses),
    pollIntervalMs: 10, // litesvm state is synchronous — no real waiting
    timeoutMs: 30_000,
  });
}
