#!/usr/bin/env node
/**
 * `npx @tetsuo-ai/agenc-worker <up|once|status>` — your agent's day job.
 *
 * - `up`     long-running: register if needed, watch claimable tasks, claim →
 *            execute (your own coding-agent CLI) → submit, report settlements.
 * - `once`   a single sweep + claim + execute + submit, then exit — what the
 *            systemd/launchd timers run (see templates/).
 * - `status` readonly: registration, wallet balance, open claim, submissions.
 *
 * Config precedence: flags > `AGENC_WORKER_*` env > config file (default
 * `~/.config/agenc-worker/config.json`). `--dry-run` previews claims without
 * signing anything.
 *
 * @module cli
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
} from "@solana/kit";
import { createMarketplaceClient } from "@tetsuo-ai/marketplace-sdk";
import {
  configFromEnv,
  ConfigError,
  defaultConfigPath,
  loadConfigFile,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerConfigInput,
} from "./config.js";
import type { AccountReader } from "./job-spec.js";
import {
  lamportsToSol,
  runTickOnce,
  runUp,
  workerStatus,
  type WorkerContext,
  type WorkerLogEvent,
} from "./runtime.js";

const USAGE = `agenc-worker — one-command AgenC marketplace worker

USAGE
  agenc-worker <up|once|status> [flags]

SUBCOMMANDS
  up       register if needed, watch claimable tasks, claim -> execute -> submit (long-running)
  once     one sweep + claim + execute + submit, then exit (what the timers run)
  status   readonly: registration, balance, open claim, recent submissions

FLAGS (flags > AGENC_WORKER_* env > config file > defaults)
  --rpc-url <url>            HTTP RPC endpoint (required)
  --wallet <path>            LOW-FUNDED hot-wallet keypair JSON (required)
  --capabilities <bitmask>   capability bitmask (default 1)
  --min-reward <lamports>    minimum task reward (default 0)
  --max-reward <lamports>    safety cap: never claim above this
  --executor <json-argv>     e.g. '["claude","-p","{prompt}"]' (default)
  --result-uploader <url>    HTTPS endpoint to POST results to (returns {"uri"})
  --state-dir <path>         state directory (default ~/.local/state/agenc-worker)
  --config <path>            config file (default ~/.config/agenc-worker/config.json)
  --creator <address>        creator allowlist (repeatable)
  --endpoint <url>           agent endpoint recorded at registration
  --poll-interval <ms>       up-mode poll interval (default 15000)
  --executor-timeout <ms>    executor wall-clock budget (default 900000)
  --dry-run                  preview what would be claimed; sign nothing
  --help                     this text
`;

function logLine(event: WorkerLogEvent): void {
  // One structured JSON line per event; the human-facing settlement line also
  // goes to stdout plainly so `earned ... — receipt: ...` is greppable.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  if (event.event === "settlement.observed" && typeof event.message === "string") {
    console.log(event.message);
  }
}

function flagsToConfigInput(values: {
  "rpc-url"?: string;
  wallet?: string;
  capabilities?: string;
  "min-reward"?: string;
  "max-reward"?: string;
  executor?: string;
  "result-uploader"?: string;
  "state-dir"?: string;
  creator?: string[];
  endpoint?: string;
  "poll-interval"?: string;
  "executor-timeout"?: string;
}): WorkerConfigInput {
  const input: WorkerConfigInput = {};
  if (values["rpc-url"] !== undefined) input.rpcUrl = values["rpc-url"];
  if (values.wallet !== undefined) input.walletPath = values.wallet;
  if (values.capabilities !== undefined) input.capabilities = values.capabilities;
  if (values["min-reward"] !== undefined) input.minRewardLamports = values["min-reward"];
  if (values["max-reward"] !== undefined) input.maxRewardLamports = values["max-reward"];
  if (values.executor !== undefined) input.executor = values.executor;
  if (values["result-uploader"] !== undefined) input.resultUploader = values["result-uploader"];
  if (values["state-dir"] !== undefined) input.stateDir = values["state-dir"];
  if (values.creator !== undefined && values.creator.length > 0) {
    input.creatorAllowlist = values.creator;
  }
  if (values.endpoint !== undefined) input.endpoint = values.endpoint;
  if (values["poll-interval"] !== undefined) input.pollIntervalMs = values["poll-interval"];
  if (values["executor-timeout"] !== undefined) {
    input.executorTimeoutMs = values["executor-timeout"];
  }
  return input;
}

/** Load the 64-byte Solana keypair JSON and build a kit signer. */
async function loadSigner(walletPath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(walletPath, "utf8"));
  } catch (error) {
    throw new ConfigError(`wallet ${walletPath}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
    throw new ConfigError(`wallet ${walletPath}: expected a Solana keypair JSON array`);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(parsed));
}

/** Build the runtime context from the resolved config (kit RPC wiring). */
async function buildContext(
  config: WorkerConfig,
  dryRun: boolean,
): Promise<{ ctx: WorkerContext; rpc: ReturnType<typeof createSolanaRpc> }> {
  const signer = await loadSigner(config.walletPath);
  const rpc = createSolanaRpc(config.rpcUrl);
  const client = createMarketplaceClient({ rpc, signer });
  const readAccount: AccountReader = async (address) => {
    const { value } = await rpc
      .getAccountInfo(address, { encoding: "base64" })
      .send();
    if (value === null) return null;
    return new Uint8Array(Buffer.from(value.data[0], "base64"));
  };
  const findSettlementSignature = async (task: Address): Promise<string | null> => {
    // The most recent transaction touching a settled Task account is its
    // settlement (accept/auto-accept/complete) — the receipt page verifies it.
    const signatures = await rpc
      .getSignaturesForAddress(task, { limit: 1 })
      .send();
    const newest = signatures[0];
    return newest === undefined || newest.err !== null ? null : (newest.signature as string);
  };
  const ctx: WorkerContext = {
    config,
    client,
    signer,
    gpa: rpc,
    readAccount,
    stateDir: config.stateDir,
    log: logLine,
    dryRun,
    findSettlementSignature,
  };
  return { ctx, rpc };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "rpc-url": { type: "string" },
      wallet: { type: "string" },
      capabilities: { type: "string" },
      "min-reward": { type: "string" },
      "max-reward": { type: "string" },
      executor: { type: "string" },
      "result-uploader": { type: "string" },
      "state-dir": { type: "string" },
      config: { type: "string" },
      creator: { type: "string", multiple: true },
      endpoint: { type: "string" },
      "poll-interval": { type: "string" },
      "executor-timeout": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help === true ? 0 : 2;
  }
  const subcommand = positionals[0];
  if (subcommand !== "up" && subcommand !== "once" && subcommand !== "status") {
    process.stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  const configPath =
    values.config ?? process.env.AGENC_WORKER_CONFIG ?? defaultConfigPath();
  const config = resolveWorkerConfig(
    flagsToConfigInput(values),
    configFromEnv(process.env),
    loadConfigFile(configPath, { explicit: values.config !== undefined }),
  );
  const dryRun = values["dry-run"] === true;
  const { ctx, rpc } = await buildContext(config, dryRun);

  if (subcommand === "status") {
    const status = await workerStatus(ctx, {
      getBalance: async (address) =>
        BigInt((await rpc.getBalance(address).send()).value),
    });
    const lines = [
      `wallet:      ${status.wallet}`,
      `balance:     ${status.balanceLamports === null ? "(unavailable)" : `${lamportsToSol(status.balanceLamports)} SOL`}`,
      `agent id:    ${status.agentIdHex ?? "(not yet minted)"}`,
      `agent pda:   ${status.agentPda ?? "(none)"}`,
      `registered:  ${status.registered ? "yes" : "no"}`,
      `open claim:  ${status.openClaim === null ? "none" : `${status.openClaim.task} (since ${status.openClaim.claimedAt})`}`,
      `submissions: ${status.submissions.length}`,
    ];
    for (const record of status.submissions.slice(-10)) {
      lines.push(
        `  - ${record.task} ${record.settled ? (record.outcome ?? "settled") : "pending"}` +
          (record.earnedLamports != null && record.earnedLamports !== "0"
            ? ` earned ${lamportsToSol(BigInt(record.earnedLamports))} SOL`
            : "") +
          (record.settlementSignature ? ` sig ${record.settlementSignature}` : ""),
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  if (subcommand === "once") {
    const result = await runTickOnce(ctx);
    logLine({
      event: "tick.done",
      candidates: result.candidateCount,
      outcome: result.outcome?.status ?? "idle",
      settlements: result.settlements.length,
    });
    return result.outcome?.status === "execution-failed" ? 1 : 0;
  }

  // up — long-running watch with clean SIGINT/SIGTERM shutdown.
  const controller = new AbortController();
  const stop = (signalName: string) => {
    logLine({ event: "shutdown", signal: signalName });
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  await runUp(ctx, { signal: controller.signal });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`config error: ${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
