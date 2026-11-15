#!/usr/bin/env node
/**
 * `agenc-wallet <init|serve|status>` — run the wallet as a small local service.
 *
 * - `init`   create a wallet folder with a fresh unlock secret and owner
 *            credential (for hosts without an OS keychain).
 * - `serve`  open the wallet and serve it on a local socket until stopped.
 *            Secrets arrive on stdin (one JSON line) or from the bootstrap
 *            file `init` wrote; never on the command line.
 * - `status` print the balances and agents of a running service.
 *
 * A desktop host starts `serve` as a child process, writes the bootstrap line
 * to its stdin, and keeps that pipe open: when the pipe closes, the service
 * stops. The service therefore never outlives the app that owns the keys'
 * unlock secret.
 *
 * @module cli
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { WalletNetwork } from "./client/types.js";
import { connectWallet } from "./client/socket-client.js";
import { formatMoney } from "./client/format.js";
import { createRpcChain, DEFAULT_RPC_URLS, type Chain } from "./chain.js";
import type { EarnOptions } from "./earn.js";
import { describeError, WalletError } from "./errors.js";
import { fixedPrice, pythPrice, type PriceSource } from "./pricing.js";
import {
  PRACTICE_OPEN_JOB_REWARD,
  PRACTICE_SERVICES,
  startSandbox,
  type OpenJob,
  type Sandbox,
} from "./sandbox.js";
import { defaultSocketPath, serveWallet } from "./server.js";
import { createHostedServices, type MarketServices } from "./services.js";
import { restoreBackup } from "./backup.js";
import { readPrivateFile, writePrivateFileAtomic } from "./vault.js";
import { AgencWallet } from "./wallet.js";

const USAGE = `agenc-wallet — a wallet an agent can use but cannot drain

USAGE
  agenc-wallet init   [--data-dir <dir>]
  agenc-wallet serve  [--data-dir <dir>] [--socket <path>] [--network <name>] [--rpc-url <url>]
  agenc-wallet status [--data-dir <dir>] [--socket <path>]
  agenc-wallet restore --file <backup> [--data-dir <dir>] [--network <name>]

NETWORKS
  mainnet (default), devnet, localnet, or sandbox. The sandbox is a complete
  practice marketplace inside this process with play money: nothing real moves.

SECRETS
  serve reads one JSON line from stdin: {"unlockSecret":"<base64>","ownerToken":"<text>"}.
  Without a pipe on stdin it reads <data-dir>/bootstrap.json, written by init.
  The unlock secret decrypts the keys; whoever holds it and the wallet folder
  holds the money. Prefer an OS keychain over the bootstrap file.

BACKUPS
  A backup is made from the running service (the "backup.export" method) and
  holds every key and the wallet's records, locked with a password. restore
  puts one back. Stop the service first. It reads one JSON line from stdin:
  {"unlockSecret":"<base64>","password":"<the backup's password>"}, or the
  unlock secret from bootstrap.json and the password from AGENC_WALLET_BACKUP_PASSWORD.
  The wallet that was in the folder is moved into replaced-<time>, never deleted.

FLAGS
  --data-dir <dir>   wallet folder (default ~/.local/share/agenc-wallet)
  --file <path>      the backup file to restore
  --socket <path>    socket path (default <data-dir>/wallet.sock, or a private
                     temp folder when that path is too long for a socket)
  --network <name>   mainnet | devnet | localnet | sandbox
  --rpc-url <url>    Solana RPC endpoint (default: the network's public one)
  --help             this text
`;

/** What a host sends on stdin (or keeps in bootstrap.json). */
interface Bootstrap {
  unlockSecret: string;
  ownerToken: string;
  earn?: {
    executor: { argv: string[]; mode: string; envAllowlist?: string[]; timeoutMs?: number } | null;
    maxRewardLamports?: string | null;
    /** Take jobs only from this wallet's own addresses. */
    ownJobsOnly?: boolean;
  } | null;
  hosted?: {
    siteUrl?: string;
    attestUrl?: string;
    artifactBaseUrl?: string | null;
    artifactUploadUrl?: string | null;
  };
  /** Priority fee in micro-lamports per compute unit. */
  computeUnitPrice?: string;
  /**
   * The person's own Solana RPC endpoint. It often carries an API key, so a
   * host hands it over here, on stdin, and never as a flag another process
   * could read. `--rpc-url` wins when both are given.
   */
  rpcUrl?: string;
  /** Play money given to an empty main balance in the sandbox. */
  practiceLamports?: string;
}

function defaultDataDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
  return path.join(base, "agenc-wallet");
}

function parseBootstrap(raw: string): Bootstrap {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WalletError("BAD_REQUEST", "The start-up line is not valid JSON.");
  }
  const data = value as Bootstrap;
  if (
    typeof data !== "object" ||
    data === null ||
    typeof data.unlockSecret !== "string" ||
    typeof data.ownerToken !== "string" ||
    Buffer.from(data.unlockSecret, "base64").length < 32 ||
    data.ownerToken.length < 32
  ) {
    throw new WalletError(
      "BAD_REQUEST",
      "The start-up line needs an unlockSecret (32 or more random bytes, base64) and an ownerToken (32 or more characters).",
    );
  }
  return data;
}

/**
 * Read the first line of stdin and leave the stream open. (Iterating the
 * stream with `for await` and returning early would destroy it, and the
 * service could then never notice its host going away.)
 */
function readStdinLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buffered = "";
    const finish = (line: string): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      resolve(line);
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline !== -1) finish(buffered.slice(0, newline));
      else if (buffered.length > 1024 * 1024) finish("");
    };
    const onEnd = (): void => finish(buffered);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

function earnOptions(bootstrap: Bootstrap): EarnOptions {
  const executor = bootstrap.earn?.executor ?? null;
  if (executor === null) return { executor: null };
  if (
    !Array.isArray(executor.argv) ||
    executor.argv.length === 0 ||
    executor.argv.some((part) => typeof part !== "string") ||
    !executor.argv.includes("{prompt}")
  ) {
    throw new WalletError(
      "BAD_REQUEST",
      'The earn executor needs an argv list that includes "{prompt}".',
    );
  }
  if (executor.mode !== "sandboxed" && executor.mode !== "safe" && executor.mode !== "unsafe") {
    throw new WalletError("BAD_REQUEST", "The earn executor mode is not valid.");
  }
  const maxReward = bootstrap.earn?.maxRewardLamports;
  return {
    executor: {
      argv: executor.argv,
      mode: executor.mode,
      envAllowlist: executor.envAllowlist ?? [],
      timeoutMs: executor.timeoutMs ?? 15 * 60_000,
    },
    ...(maxReward === undefined
      ? {}
      : { maxRewardLamports: maxReward === null ? null : BigInt(maxReward) }),
    ...(bootstrap.earn?.ownJobsOnly === true ? { ownJobsOnly: true } : {}),
  };
}

/** The endpoint a host named at start-up, when it is one this service can use. */
function ownRpcUrl(bootstrap: Bootstrap): string | undefined {
  if (bootstrap.rpcUrl === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(bootstrap.rpcUrl);
  } catch {
    throw new WalletError("BAD_REQUEST", "The Solana connection address is not a web address.");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new WalletError("BAD_REQUEST", "The Solana connection address must start with https://.");
  }
  return bootstrap.rpcUrl;
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

async function serve(values: Record<string, string | boolean | undefined>): Promise<number> {
  const network = (values.network as WalletNetwork | undefined) ?? "mainnet";
  if (!["mainnet", "devnet", "localnet", "sandbox"].includes(network)) {
    throw new WalletError("BAD_REQUEST", `Unknown network: ${String(values.network)}`);
  }
  const baseDir = path.resolve((values["data-dir"] as string | undefined) ?? defaultDataDir());
  // Each network keeps its own journal; play money never shares one with real.
  const dataDir = path.join(baseDir, network === "sandbox" ? "practice" : network);
  const socketPath =
    values.socket === undefined
      ? defaultSocketPath(baseDir)
      : path.resolve(values.socket as string);
  const bootstrapFile = path.join(baseDir, "bootstrap.json");
  // A host that manages this service writes the start-up line to stdin and
  // keeps the pipe open. Anything else (a terminal, a service manager with no
  // stdin) uses the bootstrap file and runs until it is signalled.
  const piped = process.stdin.isTTY ? "" : (await readStdinLine()).trim();
  const hostManaged = piped.length > 0;
  if (!hostManaged && !existsSync(bootstrapFile)) {
    throw new WalletError(
      "NOT_FOUND",
      `No wallet has been set up in ${baseDir}. Run "agenc-wallet init" first.`,
    );
  }
  const bootstrap = parseBootstrap(
    hostManaged ? piped : readPrivateFile(bootstrapFile, 64 * 1024),
  );

  let chain: Chain;
  let services: MarketServices;
  let prices: PriceSource;
  let sandbox: Sandbox | null = null;
  if (network === "sandbox") {
    // The sandbox chain lives in memory, so its journal starts empty each run.
    rmSync(path.join(dataDir, "state.json"), { force: true });
    rmSync(path.join(dataDir, "earn"), { recursive: true, force: true });
    sandbox = await startSandbox({ workDir: path.join(dataDir, "house") });
    for (const service of PRACTICE_SERVICES) await sandbox.addService(service);
    chain = sandbox.chain;
    services = sandbox.services;
    prices = sandbox.prices;
  } else {
    chain = createRpcChain({
      network,
      rpcUrl: (values["rpc-url"] as string | undefined) ?? ownRpcUrl(bootstrap) ?? DEFAULT_RPC_URLS[network],
      ...(bootstrap.computeUnitPrice !== undefined
        ? { computeUnitPrice: BigInt(bootstrap.computeUnitPrice) }
        : {}),
    });
    services = createHostedServices(bootstrap.hosted ?? {});
    prices = network === "mainnet" ? pythPrice(chain) : fixedPrice(0);
    if (network !== "mainnet") prices = { solUsd: async () => null };
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const wallet = await AgencWallet.open({
    dataDir,
    unlockSecret: Buffer.from(bootstrap.unlockSecret, "base64"),
    chain,
    services,
    prices,
    earn: earnOptions(bootstrap),
    log,
  });
  if (sandbox !== null) {
    const practice = BigInt(bootstrap.practiceLamports ?? "500000000");
    if ((await chain.getBalance(wallet.mainAddress)) === 0n && practice > 0n) {
      sandbox.fund(wallet.mainAddress, practice);
    }
  }
  const server = await serveWallet({
    wallet,
    socketPath,
    ownerToken: bootstrap.ownerToken,
    agentExists: (agentId) => wallet.hasAgent(agentId),
    log,
  });
  wallet.start();

  let houseTimer: ReturnType<typeof setInterval> | null = null;
  if (sandbox !== null) {
    const practice = sandbox;
    let working = false;
    // The practice town: house providers deliver what is hired from them, and
    // a house buyer keeps one small public job on offer and pays for it once
    // someone (the person's own earning agent) has delivered.
    let offer: OpenJob | null = null;
    const turn = async (): Promise<void> => {
      await practice.workOnce();
      if (offer === null) {
        offer = await practice.postOpenJob({
          title: "Write one friendly line",
          instructions: "Write one short, friendly sentence welcoming a new neighbour.",
          rewardLamports: PRACTICE_OPEN_JOB_REWARD,
        });
      } else if (await offer.delivered()) {
        await offer.approve();
        offer = null;
      }
    };
    houseTimer = setInterval(() => {
      if (working) return;
      working = true;
      void turn()
        .catch((error) => log(`practice town: ${describeError(error)}`))
        .finally(() => {
          working = false;
        });
    }, 3_000);
  }

  process.stdout.write(
    `${JSON.stringify({ ready: true, socket: server.socketPath, network, mainAddress: wallet.mainAddress })}\n`,
  );

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${reason})`);
    if (houseTimer !== null) clearInterval(houseTimer);
    await server.close();
    await wallet.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  if (hostManaged) {
    // The host keeps stdin open for as long as it wants the service alive.
    process.stdin.on("end", () => void stop("the host went away"));
    process.stdin.on("close", () => void stop("the host went away"));
    process.stdin.resume();
  }
  return new Promise<number>(() => {});
}

function init(values: Record<string, string | boolean | undefined>): number {
  const baseDir = path.resolve((values["data-dir"] as string | undefined) ?? defaultDataDir());
  const file = path.join(baseDir, "bootstrap.json");
  if (existsSync(file)) {
    process.stderr.write(`A wallet already exists in ${baseDir}.\n`);
    return 1;
  }
  const bootstrap: Bootstrap = {
    unlockSecret: randomBytes(32).toString("base64"),
    ownerToken: randomBytes(32).toString("hex"),
  };
  writePrivateFileAtomic(file, `${JSON.stringify(bootstrap, null, 2)}\n`);
  process.stdout.write(
    `Created ${file}\nKeep this file and the wallet folder private: together they hold the money.\n`,
  );
  return 0;
}

async function status(values: Record<string, string | boolean | undefined>): Promise<number> {
  const baseDir = path.resolve((values["data-dir"] as string | undefined) ?? defaultDataDir());
  const socketPath =
    values.socket === undefined
      ? defaultSocketPath(baseDir)
      : path.resolve(values.socket as string);
  const bootstrap = parseBootstrap(
    readPrivateFile(path.join(baseDir, "bootstrap.json"), 64 * 1024),
  );
  const client = await connectWallet({ socketPath, token: bootstrap.ownerToken });
  try {
    const overview = await client.call("overview", {});
    const lines = [
      `network:  ${overview.network}`,
      `balance:  ${formatMoney(overview.main.balance)}`,
      `add money by sending SOL to: ${overview.main.address}`,
      `held in jobs: ${formatMoney(overview.held)}`,
      `waiting for your approval: ${overview.pendingApprovals}`,
    ];
    for (const agent of overview.agents) {
      lines.push(
        `agent ${agent.name}: allowance ${formatMoney(agent.balance)}, spent ${formatMoney(agent.spent)}, earned ${formatMoney(agent.earned)}`,
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    client.close();
  }
}

/** Put a backup back. The service must be stopped: it replaces the wallet. */
async function restore(values: Record<string, string | boolean | undefined>): Promise<number> {
  const network = (values.network as WalletNetwork | undefined) ?? "mainnet";
  if (!["mainnet", "devnet", "localnet"].includes(network)) {
    throw new WalletError("BAD_REQUEST", "A backup can be restored on mainnet, devnet or localnet.");
  }
  if (typeof values.file !== "string" || values.file.length === 0) {
    throw new WalletError("BAD_REQUEST", "Say which backup to restore with --file <path>.");
  }
  const baseDir = path.resolve((values["data-dir"] as string | undefined) ?? defaultDataDir());
  const dataDir = path.join(baseDir, network);
  const piped = process.stdin.isTTY ? "" : (await readStdinLine()).trim();
  let unlockSecret: string;
  let password: string;
  if (piped.length > 0) {
    let line: { unlockSecret?: unknown; password?: unknown };
    try {
      line = JSON.parse(piped) as typeof line;
    } catch {
      throw new WalletError("BAD_REQUEST", "The start-up line is not valid JSON.");
    }
    if (typeof line.unlockSecret !== "string" || typeof line.password !== "string") {
      throw new WalletError("BAD_REQUEST", "The start-up line needs an unlockSecret and a password.");
    }
    unlockSecret = line.unlockSecret;
    password = line.password;
  } else {
    unlockSecret = parseBootstrap(
      readPrivateFile(path.join(baseDir, "bootstrap.json"), 64 * 1024),
    ).unlockSecret;
    password = process.env.AGENC_WALLET_BACKUP_PASSWORD ?? "";
  }
  const secret = Buffer.from(unlockSecret, "base64");
  if (secret.length < 32) {
    throw new WalletError("BAD_REQUEST", "The unlock secret is too short.");
  }
  const { header, replaced } = await restoreBackup({
    dataDir,
    unlockSecret: secret,
    text: readFileSync(path.resolve(values.file), "utf8"),
    password,
    network,
    now: Date.now(),
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, main: header.main, agents: header.agents, createdAt: header.createdAt, replaced })}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      socket: { type: "string" },
      network: { type: "string" },
      "rpc-url": { type: "string" },
      file: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return values.help === true ? 0 : 2;
  }
  if (command === "init") return init(values);
  if (command === "serve") return serve(values);
  if (command === "status") return status(values);
  if (command === "restore") return restore(values);
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `${error instanceof WalletError ? error.message : describeError(error)}\n`,
    );
    process.exitCode = 1;
  },
);
