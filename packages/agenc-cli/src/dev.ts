// `agenc dev` — the show: ensure a localnet sandbox, spin up throwaway
// funded wallets, list the project's service, and run in-process
// counterparty bots (buyer + worker) until the settlement lands — then print
// the live 4-way split read from the chain.
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64Encoder,
  lamports,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  createMarketplaceClient,
  settlementReceiptUrl,
} from "@tetsuo-ai/marketplace-sdk";
import { loadConfig, defaultConfig, type AgencConfig } from "./config.js";
import { detectProject } from "./detect.js";
import { runDevLoop, type DevActor, type DevLoopResult } from "./bots.js";
import {
  bootLocalnet,
  checkLocalnetHealth,
  findLocalnetEnv,
  localnetTooling,
  LocalnetError,
  SETUP_INSTRUCTIONS,
  type LocalnetEnv,
} from "./localnet.js";
import { formatSplitTable, lamportsToSol } from "./split.js";

export interface DevOptions {
  /** Explicit `.localnet/env.json` path (beats discovery). */
  envFile?: string;
  /** Kill + re-boot the localnet stack before running the bots. */
  purge?: boolean;
  log?: (line: string) => void;
}

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
  await (rpc as AirdropRpc).requestAirdrop(signer.address, lamports(target)).send();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { value } = await rpc
      .getBalance(signer.address, { commitment: "confirmed" })
      .send();
    if (BigInt(value) >= target) break;
    if (Date.now() >= deadline) {
      throw new LocalnetError(`airdrop for the ${label} wallet did not land in 30s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(`${label}: throwaway wallet ${signer.address} funded with ${AIRDROP_SOL} localnet SOL`);
  return signer;
}

async function loadKeypairSigner(filePath: string): Promise<KeyPairSigner> {
  const bytes = Uint8Array.from(
    JSON.parse(await readFile(filePath, "utf8")) as number[],
  );
  return createKeyPairSignerFromBytes(bytes);
}

/** Resolve a healthy localnet stack, booting/purging when possible. */
async function ensureLocalnet(
  dir: string,
  options: DevOptions,
  log: (line: string) => void,
): Promise<LocalnetEnv> {
  const env = findLocalnetEnv(dir, options.envFile);
  if (env === null) {
    throw new LocalnetError(`no localnet sandbox found.\n\n${SETUP_INSTRUCTIONS}`);
  }
  if (options.purge === true) {
    await bootLocalnet(env.repoRoot, { purge: true, log });
    return findLocalnetEnv(dir, options.envFile) ?? env;
  }
  const health = await checkLocalnetHealth(env);
  if (health.rpcHealthy && health.programDeployed) {
    log(`localnet: healthy stack at ${env.rpcUrl} (program deployed) — reusing it`);
    return env;
  }
  if (localnetTooling(env.repoRoot) !== null) {
    log(
      `localnet: stack at ${env.rpcUrl} is ${health.rpcHealthy ? "missing the program" : "down"} — booting via ${env.repoRoot}/scripts/localnet-up.mjs`,
    );
    await bootLocalnet(env.repoRoot, { log });
    return findLocalnetEnv(dir, options.envFile) ?? env;
  }
  throw new LocalnetError(
    `localnet stack at ${env.rpcUrl} is not healthy and no tooling was found to boot it.\n\n${SETUP_INSTRUCTIONS}`,
  );
}

export interface DevRunSummary {
  result: DevLoopResult;
  config: AgencConfig;
  rpcUrl: string;
}

/** Run `agenc dev` against `dir`. Prints progress + the split via `log`. */
export async function runDev(
  dir: string,
  options: DevOptions = {},
): Promise<DevRunSummary> {
  const log = options.log ?? ((line: string) => console.log(line));

  // Listing terms come from agenc.config.json; fall back to detection so
  // `agenc dev` still demos in a repo that skipped `agenc init`.
  const loaded = loadConfig(dir);
  let config: AgencConfig;
  if (loaded !== null) {
    config = loaded.config;
  } else {
    const detection = detectProject(dir);
    config = defaultConfig(detection.name, detection.kind);
    log(`no ${path.join(dir, "agenc.config.json")} — using defaults (run \`agenc init\` to pin them)`);
  }

  const env = await ensureLocalnet(dir, options, log);
  const moderatorPath = env.keypairs?.moderator;
  if (moderatorPath === undefined || moderatorPath === null) {
    throw new LocalnetError(
      `${env.envPath} has no keypairs.moderator — re-run scripts/localnet-up.mjs`,
    );
  }

  const rpc = createSolanaRpc(env.rpcUrl);
  const readAccount = async (address: Address): Promise<Uint8Array | null> => {
    const { value } = await rpc
      .getAccountInfo(address, { commitment: "confirmed", encoding: "base64" })
      .send();
    if (value === null) return null;
    return new Uint8Array(getBase64Encoder().encode(value.data[0]));
  };
  const getBalance = async (address: Address): Promise<bigint> =>
    BigInt(
      (await rpc.getBalance(address, { commitment: "confirmed" }).send()).value,
    );

  // Throwaway funded actors: buyer + provider sign transactions; operator +
  // referrer are pure payees (funded so the fee legs land on rent-exempt
  // accounts — a mainnet requirement the sandbox mirrors).
  const buyerSigner = await airdropped(rpc, "buyer bot", log);
  const providerSigner = await airdropped(rpc, "worker bot", log);
  const operatorSigner = await airdropped(rpc, "operator payee", log);
  const referrerSigner = await airdropped(rpc, "referrer payee", log);
  const moderatorSigner = await loadKeypairSigner(moderatorPath);
  log(`moderator: localnet moderation authority ${moderatorSigner.address} (from ${env.envPath})`);

  const actor = (signer: KeyPairSigner): DevActor => ({
    signer,
    client: createMarketplaceClient({ rpcUrl: env.rpcUrl, signer }),
  });

  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-dev-worker-"));
  const result = await runDevLoop({
    buyer: actor(buyerSigner),
    provider: actor(providerSigner),
    moderator: actor(moderatorSigner),
    operator: operatorSigner.address,
    referrer: referrerSigner.address,
    readAccount,
    getBalance,
    gpa: rpc,
    stateDir,
    log,
    listing: {
      name: config.name,
      priceLamports: BigInt(config.listing.priceLamports),
      operatorFeeBps: config.listing.operatorFeeBps,
      referrerFeeBps: config.listing.referrerFeeBps,
    },
  });

  log("");
  log("  == SETTLEMENT: the 4-way split (real lamport deltas from the chain) ==");
  log("");
  log(
    formatSplitTable(
      [
        // The worker row shows the reward cut; the raw delta additionally
        // includes claim/submission rent refunds, itemized below the table.
        { ...result.legs.worker, deltaLamports: result.workerRewardCutLamports },
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
  log(`  reward escrowed:  ${lamportsToSol(result.rewardLamports)} SOL ("${config.name}")`);
  log(`  settlement tx:    ${result.acceptSignature}`);
  log(
    `  receipt:          on mainnet this settlement gets a shareable receipt at ` +
      `${settlementReceiptUrl(result.acceptSignature)}`,
  );
  log(
    "                    (receipts are an agenc.ag mainnet surface — on localnet the " +
      "split above + the tx signature ARE the proof)",
  );
  log(`  bot loop wall-clock: ${(result.durationMs / 1000).toFixed(1)}s`);
  return { result, config, rpcUrl: env.rpcUrl };
}
