#!/usr/bin/env node
/**
 * `agenc-worker <up|once|status>` — install a reviewed, exact package version
 * first; timer units never resolve mutable registry state at startup.
 *
 * - `up`     long-running: register if needed, watch claim candidates, claim →
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
import { parseArgs } from "node:util";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
} from "@solana/kit";
import {
  createMarketplaceClient,
  taskThread,
} from "@tetsuo-ai/marketplace-sdk";
import {
  configFromEnv,
  ConfigError,
  defaultConfigPath,
  loadConfigFile,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerConfigInput,
} from "./config.js";
import { createSolanaAccountReaders } from "./account-reader.js";
import { formatDiagnosticError } from "./redact.js";
import { findVerifiedSettlementSignature } from "./settlement.js";
import { loadSolanaKeypairFile } from "./wallet.js";
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
  up       register if needed, watch claim candidates, claim -> execute -> submit (long-running)
  once     one sweep + claim + execute + submit, then exit (what the timers run)
  status   readonly: registration, balance, open claim, recent submissions

FUNDING (registration and recurring work are NOT free)
  Registration stakes live ProtocolConfig.minAgentStake and pays account rent;
  a task pays claim + submission rent and may require a contest deposit. Before
  registration and immediately before every NEW claim, the worker queries live
  rent, checks balance through submission + worst-case deposit + fee headroom,
  and reports the exact lamports/address/delta when short. Recovery of a claim
  that already landed runs first and is never blocked by the fresh-claim gate.

FLAGS (flags > AGENC_WORKER_* env > config file > defaults)
  --rpc-url <url>            HTTP RPC endpoint (required); task discovery polls
                             getProgramAccounts, so the RPC must allow gPA
                             (public mainnet-beta works but is rate-limited)
  --wallet <path>            LOW-FUNDED hot-wallet keypair JSON (required)
  --capabilities <bitmask>   capability bitmask (default 1)
  --min-reward <lamports>    minimum task reward (default 0)
  --max-reward <lamports>    safety cap: never claim above this
  --allow-unbounded-reward   UNSAFE: explicitly disable the reward bait cap
  --executor <json-argv>     custom executor argv (requires --executor-mode)
  --executor-mode <mode>     safe (default), sandboxed, or unsafe
  --executor-env <name>      env var copied into isolated executor (repeatable)
  --result-uploader <url>    HTTPS endpoint to POST results to (returns {"uri"})
  --state-dir <path>         state directory (default ~/.local/state/agenc-worker)
  --config <path>            config file (default ~/.config/agenc-worker/config.json)
  --creator <address>        creator allowlist (repeatable)
  --allow-any-creator        UNSAFE: explicitly disable creator allowlisting
  --endpoint <url>           agent endpoint recorded at registration
  --task-thread-base-url <url>
                             HTTPS content host for request_changes feedback
  --poll-interval <ms>       up-mode poll interval (default 15000)
  --executor-timeout <ms>    executor wall-clock budget (default 900000)
  --dry-run                  preview what would be claimed; sign nothing
  --help                     this text
`;

function logLine(event: WorkerLogEvent): void {
  // One structured JSON line per event; the human-facing settlement line also
  // goes to stdout plainly so `earned ... — receipt: ...` is greppable.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  if (
    event.event === "settlement.observed" &&
    typeof event.message === "string"
  ) {
    console.log(event.message);
  }
}

function flagsToConfigInput(values: {
  "rpc-url"?: string;
  wallet?: string;
  capabilities?: string;
  "min-reward"?: string;
  "max-reward"?: string;
  "allow-unbounded-reward"?: boolean;
  executor?: string;
  "executor-mode"?: string;
  "executor-env"?: string[];
  "result-uploader"?: string;
  "state-dir"?: string;
  creator?: string[];
  "allow-any-creator"?: boolean;
  endpoint?: string;
  "task-thread-base-url"?: string;
  "poll-interval"?: string;
  "executor-timeout"?: string;
}): WorkerConfigInput {
  const input: WorkerConfigInput = {};
  if (values["rpc-url"] !== undefined) input.rpcUrl = values["rpc-url"];
  if (values.wallet !== undefined) input.walletPath = values.wallet;
  if (values.capabilities !== undefined)
    input.capabilities = values.capabilities;
  if (values["min-reward"] !== undefined)
    input.minRewardLamports = values["min-reward"];
  if (values["max-reward"] !== undefined)
    input.maxRewardLamports = values["max-reward"];
  if (values["allow-unbounded-reward"] === true)
    input.allowUnboundedReward = true;
  if (values.executor !== undefined) input.executor = values.executor;
  if (values["executor-mode"] !== undefined)
    input.executorMode = values["executor-mode"];
  if (values["executor-env"] !== undefined)
    input.executorEnvAllowlist = values["executor-env"];
  if (values["result-uploader"] !== undefined)
    input.resultUploader = values["result-uploader"];
  if (values["state-dir"] !== undefined) input.stateDir = values["state-dir"];
  if (values.creator !== undefined && values.creator.length > 0) {
    input.creatorAllowlist = values.creator;
  }
  if (values["allow-any-creator"] === true) input.allowAnyCreator = true;
  if (values.endpoint !== undefined) input.endpoint = values.endpoint;
  if (values["task-thread-base-url"] !== undefined) {
    input.taskThreadBaseUrl = values["task-thread-base-url"];
  }
  if (values["poll-interval"] !== undefined)
    input.pollIntervalMs = values["poll-interval"];
  if (values["executor-timeout"] !== undefined) {
    input.executorTimeoutMs = values["executor-timeout"];
  }
  return input;
}

/** Load the 64-byte Solana keypair JSON and build a kit signer. */
async function loadSigner(walletPath: string) {
  try {
    return createKeyPairSignerFromBytes(loadSolanaKeypairFile(walletPath));
  } catch (error) {
    throw new ConfigError(
      `wallet ${walletPath}: ${formatDiagnosticError(error)}`,
    );
  }
}

/** Build the runtime context from the resolved config (kit RPC wiring). */
async function buildContext(
  config: WorkerConfig,
  dryRun: boolean,
): Promise<{ ctx: WorkerContext; rpc: ReturnType<typeof createSolanaRpc> }> {
  const signer = await loadSigner(config.walletPath);
  const rpc = createSolanaRpc(config.rpcUrl);
  const client = createMarketplaceClient({ rpc, signer });
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
  const ctx: WorkerContext = {
    config,
    client,
    signer,
    gpa: rpc,
    readAccount,
    readAccountInfo,
    stateDir: config.stateDir,
    log: logLine,
    dryRun,
    taskThreadTransport: taskThread.createContentTransport({
      baseUrl: config.taskThreadBaseUrl,
    }),
    findSettlementSignature: (task) =>
      findVerifiedSettlementSignature(rpc, task),
    // Live funding gates: registration checks the complete first-task budget;
    // every later fresh claim rechecks claim/submission rent, worst-case
    // contest deposit, and fee headroom immediately before broadcast.
    getBalance: async (address) =>
      BigInt(
        (await rpc.getBalance(address, { commitment: "confirmed" }).send())
          .value,
      ),
    getMinimumBalanceForRentExemption: async (space) =>
      BigInt(
        await rpc
          .getMinimumBalanceForRentExemption(BigInt(space), {
            commitment: "finalized",
          })
          .send(),
      ),
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
      "allow-unbounded-reward": { type: "boolean" },
      executor: { type: "string" },
      "executor-mode": { type: "string" },
      "executor-env": { type: "string", multiple: true },
      "result-uploader": { type: "string" },
      "state-dir": { type: "string" },
      config: { type: "string" },
      creator: { type: "string", multiple: true },
      "allow-any-creator": { type: "boolean" },
      endpoint: { type: "string" },
      "task-thread-base-url": { type: "string" },
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
          (record.settlementSignature
            ? ` sig ${record.settlementSignature}`
            : ""),
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
      process.stderr.write(`config error: ${formatDiagnosticError(error)}\n`);
    } else {
      process.stderr.write(
        `${formatDiagnosticError(error, { includeStack: true })}\n`,
      );
    }
    process.exitCode = 1;
  },
);
