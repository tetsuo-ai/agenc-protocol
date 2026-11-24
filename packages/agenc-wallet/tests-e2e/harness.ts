// Shared setup for the end-to-end suite: a sandbox marketplace (the real
// compiled program in litesvm) plus a wallet opened on a throwaway folder.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCompiledTransactionMessageDecoder, isOffCurveAddress, type Address } from "@solana/kit";
import { lighthouse } from "@tetsuo-ai/marketplace-sdk";
import { expect } from "vitest";
import { APPROVAL_FEE_LAMPORTS, approvalCost } from "../src/approval.js";
import type { Chain } from "../src/chain.js";
import type { EarnOptions } from "../src/earn.js";
import { startSandbox, type HouseService, type Sandbox, type StartSandboxOptions } from "../src/sandbox.js";
import type { MarketServices } from "../src/services.js";
import { AgencWallet, type WalletConfig } from "../src/wallet.js";

/** Play money: one cent is exactly this many lamports in the sandbox. */
export const CENT = 100_000n;
export const SOL = 1_000_000_000n;

/** Simulate the owner reviewing and approving any above-budget startup funding. */
export async function setEarnWithApproval(wallet: AgencWallet, agentId: string, enabled: boolean, minPayCents?: number) {
  if (enabled) {
    const quote = await wallet.quoteEarn(agentId);
    if (quote.requiresApproval) await wallet.approveEarnFunding(quote.quoteId);
  }
  return wallet.setEarn(agentId, enabled, minPayCents);
}

/** Simulate the owner approving the complete offer quote before saving the service. */
export async function setOfferWithApproval(wallet: AgencWallet, ...args: Parameters<AgencWallet["setOffer"]>) {
  const [agentId, offer, offerId] = args;
  if (offer !== null) {
    const quote = await wallet.quoteEarn(agentId, offer, offerId);
    if (quote.requiresApproval) await wallet.approveEarnFunding(quote.quoteId);
  }
  return wallet.setOffer(...args);
}

export const HAIKU: HouseService = {
  name: "Haiku Writer",
  category: "writing",
  summary: "A three-line poem about anything you name.",
  priceLamports: 20n * CENT,
  replyPrefix: "old pond / a frog jumps in / the sound of water",
};

export interface World {
  sandbox: Sandbox;
  wallet: AgencWallet;
  dataDir: string;
  secret: Uint8Array;
  /** The wallet's clock, moved by hand. */
  clock: { now: number };
  listing: Address;
  /** Reopen the wallet on the same folder (a restart). */
  reopen(overrides?: Partial<WalletConfig>): Promise<AgencWallet>;
  balance(account: string): Promise<bigint>;
}

export async function startWorld(options: {
  mainLamports?: bigint;
  transport?: StartSandboxOptions["transport"];
  earn?: EarnOptions;
  /** Disable the fixture host self-test to exercise the configured probe. */
  hostReady?: boolean;
  chain?: (chain: Chain, sandbox: Sandbox) => Chain;
  /** Stand between the wallet and the marketplace's services (a faulty or dishonest one). */
  services?: (services: MarketServices, sandbox: Sandbox) => MarketServices;
  config?: Partial<WalletConfig>;
} = {}): Promise<World> {
  const sandbox: Sandbox = await startSandbox({ followWallClock: false, transport: base => {
    const decorated = options.transport?.(base) ?? base;
    return { ...decorated, async sendAndConfirm(tx) {
      const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      if (msg.version === 0) for (const ix of msg.instructions) {
        if (msg.staticAccounts[ix.programAddressIndex] !== lighthouse.LIGHTHOUSE) continue;
        expect.soft(ix.accountIndices).toHaveLength(1);
        for (const index of ix.accountIndices ?? []) {
          const key = msg.staticAccounts[index]!;
          expect.soft(index).toBeGreaterThanOrEqual(msg.header.numSignerAccounts);
          expect.soft(key).not.toBe(msg.staticAccounts[0]);
          // Absent PDAs are loaded by the runtime as empty system accounts.
          const account = sandbox.market.svm.getAccount(key);
          const sysvar = account.exists && account.programAddress === "Sysvar1111111111111111111111111111111111111";
          const program = account.exists && account.executable;
          expect.soft(sysvar || program || isOffCurveAddress(key), `Wallet address passed to Lighthouse: ${key}`).toBe(true);
          expect.soft(account.exists ? account.programAddress : "11111111111111111111111111111111").not.toBe(lighthouse.LIGHTHOUSE);
        }
      }
      return decorated.sendAndConfirm(tx);
    } };
  } });
  const listing = await sandbox.addService(HAIKU);
  const dataDir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-"));
  const secret = randomBytes(32);
  const clock = { now: 1_800_000_000_000 };
  const chain = options.chain ? options.chain(sandbox.chain, sandbox) : sandbox.chain;
  const config: WalletConfig = {
    dataDir,
    unlockSecret: secret,
    chain,
    services: options.services ? options.services(sandbox.services, sandbox) : sandbox.services,
    prices: sandbox.prices,
    now: () => clock.now,
    ...(options.earn ? { earn: { ...(options.hostReady === false ? {} : { checkExecutionReady: async () => {} }), ...options.earn } } : {}),
    ...options.config,
  };
  const wallet = await AgencWallet.open(config);
  sandbox.fund(wallet.mainAddress, options.mainLamports ?? 5n * SOL);
  return {
    sandbox,
    wallet,
    dataDir,
    secret,
    clock,
    listing,
    reopen: (overrides = {}) => AgencWallet.open({ ...config, ...overrides }),
    balance: (account) => sandbox.chain.getBalance(account as Address),
  };
}

/**
 * What the safety check of one job's request costs the buyer who asked for
 * it while the job is open: the deposit behind its record and the fee of the
 * two signatures on its transaction. Revision 9: the deposit comes back when
 * the job is tidied; the fee does not ({@link CHECK_FEE}).
 */
export function checkCost(world: World): Promise<bigint> {
  return approvalCost(world.sandbox.chain, "task");
}

/** The part of a job's safety check that never comes back: its two signatures. */
export const CHECK_FEE = APPROVAL_FEE_LAMPORTS;

/** Size of the marker a tidied job's record is compacted into (revision 9). */
export const MARKER_SPACE = 56;

/** Poll `check` until it returns a value, or fail after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function approvedPost(wallet: AgencWallet, params: Parameters<AgencWallet["quotePost"]>[0]) {
  const { job, approval } = await wallet.quotePost(params);
  if (approval) return wallet.decideApproval(approval.id, true);
  return job;
}

export const REVIEW_ALLOWANCE = { enabled: true, topUpToCents: 0, perDayCents: 1000 };

export async function confirmPayout(wallet: AgencWallet, jobId: string, rating?: number) {
  const { quote } = await wallet.reviewRecord(jobId, undefined, { termsOnly: true });
  return wallet.approveJob(jobId, rating, true, undefined, quote!.id);
}

export async function confirmDecision(wallet: AgencWallet, jobId: string, action: "change" | "reject" | "dispute",
  note = "The delivered work is missing the requested heading.") {
  return wallet.confirmReview(jobId, await wallet.draftReview(jobId, action, note), true);
}
