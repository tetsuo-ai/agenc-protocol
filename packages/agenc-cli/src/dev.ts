// `agenc dev` — the show: run counterparty bots (buyer + worker) against a
// sandbox until the settlement lands, then print the live 4-way split read
// from the chain. Two sandbox modes, SAME lifecycle, SAME table:
//
//   - "localnet": the WP-D4 solana-test-validator stack (reused when healthy,
//     booted via the sdk repo's tooling when discoverable).
//   - "sandbox": the in-process litesvm fallback — the REAL compiled program
//     shipped inside the sdk, zero toolchain, seconds on a cold machine.
//     This is what a fresh `npx @tetsuo-ai/agenc-cli dev` hits.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  createMarketplaceClient,
  settlementReceiptUrl,
} from "@tetsuo-ai/marketplace-sdk";
import {
  createSolanaAccountReaders,
  loadSolanaKeypairFile,
} from "@tetsuo-ai/agenc-worker";
import { loadConfig, defaultConfig, type AgencConfig } from "./config.js";
import { detectProject } from "./detect.js";
import {
  runDevLoop,
  type DevActor,
  type DevListingTerms,
  type DevLoopResult,
} from "./bots.js";
import {
  bootLocalnet,
  checkLocalnetHealth,
  findLocalnetEnv,
  localnetTooling,
  LocalnetError,
  SETUP_INSTRUCTIONS,
  type LocalnetEnv,
} from "./localnet.js";
import { runDevSandbox } from "./sandbox.js";
import { formatSplitTable, lamportsToSol } from "./split.js";

export interface DevOptions {
  /** Explicit `.localnet/env.json` path (beats discovery; implies localnet). */
  envFile?: string;
  /** Kill + re-boot the localnet stack before running the bots (implies localnet). */
  purge?: boolean;
  /** Force the in-process litesvm sandbox, skipping localnet discovery. */
  sandbox?: boolean;
  /** Require the localnet stack — fail instead of falling back in-process. */
  localnet?: boolean;
  log?: (line: string) => void;
}

/** Which sandbox `agenc dev` settled in. */
export type DevMode = "localnet" | "sandbox";

const MODE_LABEL: Record<DevMode, string> = {
  localnet: "localnet",
  sandbox: "in-process sandbox (litesvm)",
};

const AIRDROP_SOL = 5n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

type Rpc = ReturnType<typeof createSolanaRpc>;

/**
 * kit's cluster-typed RPC union only exposes `requestAirdrop` for test
 * clusters, and a plain 127.0.0.1 URL types as the general union. `agenc dev`
 * is hard-gated to loopback endpoints (assertLocalOnly in localnet.ts), so
 * narrowing to the airdrop-capable shape here is sound.
 */
type AirdropRpc = Rpc & {
  requestAirdrop(
    address: Address,
    amount: ReturnType<typeof lamports>,
  ): { send(): Promise<unknown> };
};

async function airdropped(
  rpc: Rpc,
  label: string,
  log: (line: string) => void,
): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  const target = AIRDROP_SOL * LAMPORTS_PER_SOL;
  await (rpc as AirdropRpc)
    .requestAirdrop(signer.address, lamports(target))
    .send();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { value } = await rpc
      .getBalance(signer.address, { commitment: "confirmed" })
      .send();
    if (BigInt(value) >= target) break;
    if (Date.now() >= deadline) {
      throw new LocalnetError(
        `airdrop for the ${label} wallet did not land in 30s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(
    `${label}: throwaway wallet ${signer.address} funded with ${AIRDROP_SOL} localnet SOL`,
  );
  return signer;
}

async function loadKeypairSigner(filePath: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(loadSolanaKeypairFile(filePath));
}

/**
 * Resolve a healthy localnet stack. Returns `null` when `agenc dev` should
 * fall back to the in-process litesvm sandbox instead: no stack discoverable,
 * or a dead stack with no tooling to boot it. When localnet was explicitly
 * required (`--localnet`, `--purge`, or `--env-file`) those cases keep the
 * old fail-with-instructions behavior instead of falling back.
 */
async function resolveLocalnet(
  dir: string,
  options: DevOptions,
  log: (line: string) => void,
): Promise<LocalnetEnv | null> {
  const required =
    options.localnet === true ||
    options.purge === true ||
    options.envFile !== undefined;
  const env = findLocalnetEnv(dir, options.envFile);
  if (env === null) {
    if (required) {
      throw new LocalnetError(
        `no localnet sandbox found.\n\n${SETUP_INSTRUCTIONS}`,
      );
    }
    log(
      "localnet: no stack discoverable — falling back to the in-process sandbox (litesvm)",
    );
    return null;
  }
  if (options.purge === true) {
    await bootLocalnet(env.repoRoot, { purge: true, log });
    return findLocalnetEnv(dir, options.envFile) ?? env;
  }
  const health = await checkLocalnetHealth(env);
  if (health.rpcHealthy && health.programDeployed && health.marketplaceReady) {
    log(
      `localnet: operational stack at ${env.rpcUrl} (surface revision ${health.surfaceRevision}) — reusing it`,
    );
    return env;
  }
  if (health.rpcHealthy && health.programDeployed) {
    const detail =
      `paused=${String(health.protocolPaused)} ` +
      `surfaceRevision=${String(health.surfaceRevision)}`;
    if (required) {
      throw new LocalnetError(
        `localnet stack at ${env.rpcUrl} has integrity but is not ready for marketplace writes (${detail}).\n` +
          "Use `agenc dev --purge --localnet` to replace it with a fresh disposable developer stack.",
      );
    }
    log(
      `localnet: discovered stack is production-frozen (${detail}) — ` +
        "falling back to the in-process sandbox; use --purge --localnet for a disposable local validator",
    );
    return null;
  }
  if (localnetTooling(env.repoRoot) !== null) {
    log(
      `localnet: stack at ${env.rpcUrl} is ${health.rpcHealthy ? "missing the program" : "down"} — booting via ${env.repoRoot}/scripts/localnet-up.mjs`,
    );
    await bootLocalnet(env.repoRoot, { log });
    return findLocalnetEnv(dir, options.envFile) ?? env;
  }
  if (required) {
    throw new LocalnetError(
      `localnet stack at ${env.rpcUrl} is not healthy and no tooling was found to boot it.\n\n${SETUP_INSTRUCTIONS}`,
    );
  }
  log(
    `localnet: stack at ${env.rpcUrl} is down and no tooling was found to boot it — ` +
      "falling back to the in-process sandbox (litesvm)",
  );
  return null;
}

export interface DevRunSummary {
  result: DevLoopResult;
  config: AgencConfig;
  /** Which sandbox ran: the localnet stack or the in-process litesvm fallback. */
  mode: DevMode;
  /** Localnet RPC endpoint, or `null` in in-process sandbox mode. */
  rpcUrl: string | null;
}

function printSettlement(
  log: (line: string) => void,
  config: AgencConfig,
  result: DevLoopResult,
  mode: DevMode,
): void {
  log("");
  log(
    "  == SETTLEMENT: the 4-way split (real lamport deltas from the chain) ==",
  );
  log("");
  log(
    formatSplitTable(
      [
        // The worker row shows the reward cut; the raw delta additionally
        // includes claim/submission rent refunds, itemized below the table.
        {
          ...result.legs.worker,
          deltaLamports: result.workerRewardCutLamports,
        },
        result.legs.operator,
        result.legs.referrer,
        result.legs.treasury,
      ],
      result.rewardLamports,
    ),
  );
  if (result.workerRentRefundLamports > 0n) {
    log(
      `  + ${lamportsToSol(result.workerRentRefundLamports)} SOL rent refunded to the worker ` +
        `(its claim/submission accounts close at settlement; raw worker delta ` +
        `${lamportsToSol(result.legs.worker.deltaLamports)} SOL)`,
    );
  }
  log("");
  log(`  mode:             ${MODE_LABEL[mode]}`);
  log(
    `  reward escrowed:  ${lamportsToSol(result.rewardLamports)} SOL ("${config.name}")`,
  );
  log(`  settlement tx:    ${result.acceptSignature}`);
  log(
    `  receipt:          on mainnet this settlement gets a shareable receipt at ` +
      `${settlementReceiptUrl(result.acceptSignature)}`,
  );
  log(
    "                    (receipts are an agenc.ag mainnet surface — in the dev " +
      "sandbox the split above + the tx signature ARE the proof)",
  );
  log(`  bot loop wall-clock: ${(result.durationMs / 1000).toFixed(1)}s`);
}

/** Run `agenc dev` against `dir`. Prints progress + the split via `log`. */
export async function runDev(
  dir: string,
  options: DevOptions = {},
): Promise<DevRunSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (
    options.sandbox === true &&
    (options.localnet === true ||
      options.purge === true ||
      options.envFile !== undefined)
  ) {
    throw new LocalnetError(
      "--sandbox cannot be combined with --localnet, --purge, or --env-file (those force the localnet stack)",
    );
  }

  // Listing terms come from agenc.config.json; fall back to detection so
  // `agenc dev` still demos in a repo that skipped `agenc init`.
  const loaded = loadConfig(dir);
  let config: AgencConfig;
  if (loaded !== null) {
    config = loaded.config;
  } else {
    const detection = detectProject(dir);
    config = defaultConfig(detection.name, detection.kind);
    log(
      `no ${path.join(dir, "agenc.config.json")} — using defaults (run \`agenc init\` to pin them)`,
    );
  }
  const listing: DevListingTerms = {
    name: config.name,
    category: config.listing.category,
    tags: config.listing.tags,
    priceLamports: BigInt(config.listing.priceLamports),
    operatorFeeBps: config.listing.operatorFeeBps,
    referrerFeeBps: config.listing.referrerFeeBps,
  };
  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-dev-worker-"));

  const env =
    options.sandbox === true ? null : await resolveLocalnet(dir, options, log);

  if (env === null) {
    // ---- in-process sandbox (litesvm) — the zero-toolchain cold path ----
    if (options.sandbox === true) {
      log("sandbox: --sandbox forced the in-process litesvm mode");
    }
    log(
      "sandbox: nothing to install or boot — the compiled program ships with the sdk " +
        "(for the full validator experience set up the localnet stack; `agenc dev --localnet` prints setup)",
    );
    const result = await runDevSandbox({ listing, stateDir, log });
    printSettlement(log, config, result, "sandbox");
    return { result, config, mode: "sandbox", rpcUrl: null };
  }

  // ---- localnet stack ----
  const moderatorPath = env.keypairs?.moderator;
  if (moderatorPath === undefined || moderatorPath === null) {
    throw new LocalnetError(
      `${env.envPath} has no keypairs.moderator — re-run scripts/localnet-up.mjs`,
    );
  }

  const rpc = createSolanaRpc(env.rpcUrl);
  const { readAccount, readAccountInfo } = createSolanaAccountReaders(
    async (address) => {
      const { value } = await rpc
        .getAccountInfo(address, {
          commitment: "confirmed",
          encoding: "base64",
        })
        .send();
      return value;
    },
  );
  const getBalance = async (address: Address): Promise<bigint> =>
    BigInt(
      (await rpc.getBalance(address, { commitment: "confirmed" }).send()).value,
    );
  const getMinimumBalanceForRentExemption = async (
    space: number,
  ): Promise<bigint> =>
    BigInt(
      await rpc
        .getMinimumBalanceForRentExemption(BigInt(space), {
          commitment: "finalized",
        })
        .send(),
    );

  // Throwaway funded actors: buyer + provider sign transactions; operator +
  // referrer are pure payees (funded so the fee legs land on rent-exempt
  // accounts — a mainnet requirement the sandbox mirrors).
  const buyerSigner = await airdropped(rpc, "buyer bot", log);
  const providerSigner = await airdropped(rpc, "worker bot", log);
  const operatorSigner = await airdropped(rpc, "operator payee", log);
  const referrerSigner = await airdropped(rpc, "referrer payee", log);
  const moderatorSigner = await loadKeypairSigner(moderatorPath);
  log(
    `moderator: localnet moderation authority ${moderatorSigner.address} (from ${env.envPath})`,
  );

  const actor = (signer: KeyPairSigner): DevActor => ({
    signer,
    client: createMarketplaceClient({ rpcUrl: env.rpcUrl, signer }),
  });

  const result = await runDevLoop({
    buyer: actor(buyerSigner),
    provider: actor(providerSigner),
    moderator: actor(moderatorSigner),
    operator: operatorSigner.address,
    referrer: referrerSigner.address,
    readAccount,
    readAccountInfo,
    getBalance,
    getMinimumBalanceForRentExemption,
    gpa: rpc,
    stateDir,
    log,
    listing,
  });

  printSettlement(log, config, result, "localnet");
  return { result, config, mode: "localnet", rpcUrl: env.rpcUrl };
}
