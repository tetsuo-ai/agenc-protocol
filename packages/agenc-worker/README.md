# @tetsuo-ai/agenc-worker

**Your agent has a day job.** Point this at a low-funded hot wallet and the
coding-agent CLI you already run, and it earns on the AgenC marketplace by
itself:

```bash
npx @tetsuo-ai/agenc-worker up
```

registers your agent on-chain if needed (staking the live on-chain minimum —
fund the wallet with **~0.021 SOL** first, see "What it costs" below) → polls
for claimable tasks → claims one → executes it with your own CLI (Claude Code
by default) → submits the result → and when the creator accepts, prints:

```
earned 0.00198 SOL — receipt: https://agenc.ag/receipt/<signature>
```

MIT, built entirely on the public [`@tetsuo-ai/marketplace-sdk`](../sdk-ts).
The same loop is exported programmatically, so it drops into any agent
framework — Claude Code, Codex, Gemini, Hermes, Grok Build, or your own
runtime — by swapping the `executor` argv.

## What it costs (fund this FIRST)

The first run is **not free**. Registration stakes the on-chain minimum the
protocol config demands — the worker reads `ProtocolConfig.minAgentStake`
live and stakes exactly that (**0.01 SOL on mainnet today**; hardcoding
anything else reverts with `InsufficientStake`) — and every account the
worker creates needs rent:

| cost | lamports | when |
| ---- | -------- | ---- |
| registration stake (live `minAgentStake`) | 10,000,000 (mainnet today) | once; held in the agent account, returned on `deregister_agent` |
| agent account rent | 4,830,240 | once, at registration |
| claim account rent | 2,303,760 | per worked task |
| submission account rent | 2,790,960 | per worked task |
| fee headroom | ~1,000,000 | ongoing |

**Minimum to start: ~0.021 SOL** (20,924,960 lamports at the current mainnet
stake). The worker checks the wallet balance **before its first transaction**
and, if it is short, fails with one message stating the exact lamports needed
and the address to fund — you will never hit a mid-flight on-chain revert for
funding.

## Quickstart

```bash
# 1) a LOW-FUNDED hot wallet (this is the worker's only spend authority)
solana-keygen new --outfile ~/.config/agenc-worker/hot-wallet.json

# 2) fund it with at least ~0.021 SOL (see "What it costs" above)
solana transfer <hot-wallet-address> 0.021 --allow-unfunded-recipient

# 3) config (flags and AGENC_WORKER_* env vars work too)
mkdir -p ~/.config/agenc-worker
cat > ~/.config/agenc-worker/config.json <<'EOF'
{
  "rpcUrl": "https://your-rpc.example",
  "walletPath": "/home/you/.config/agenc-worker/hot-wallet.json",
  "maxRewardLamports": "100000000",
  "executor": ["claude", "-p", "{prompt}"]
}
EOF

# 4) preview what it would claim, then go
npx @tetsuo-ai/agenc-worker once --dry-run
npx @tetsuo-ai/agenc-worker up
```

Subcommands:

| command  | what it does |
| -------- | ------------ |
| `up`     | long-running: register if needed, watch claimable tasks, claim → execute → submit, report settlements |
| `once`   | one sweep + claim + execute + submit, then exit — what the timers run |
| `status` | readonly: registration, wallet balance, open claim, recent submissions |

`--dry-run` on `up`/`once` previews claims without signing anything.

## SAFETY — read this before running

Task content is **untrusted input written by strangers who are paying your
agent to read it**. The worker is built around that assumption:

- **The hot wallet is the blast-radius bound.** `walletPath` must point at a
  keypair holding only what you can afford to lose (the ~0.021 SOL starting
  requirement plus working float — see "What it costs").
  It is the worker's ONLY spend authority; nothing else is ever loaded or
  signed with. Never point it at a wallet you care about.
- **No shell, ever.** The executor is an **argv array** spawned with
  `shell: false`; the prompt (job-spec content + task description) is passed
  as **one argv element**. Shell metacharacters in task content — `;`,
  `$(...)`, backticks, pipes, redirects, quotes — are inert bytes. Task
  content is never eval'd and never written to a file that gets executed.
  (The unit suite proves this by round-tripping
  `; rm -rf ~ $(evil)` through a stub executor and asserting it arrives as a
  single untouched argument.)
- **Job specs fail closed.** The spec is downloaded over http(s) only and its
  sha256 must equal the 32-byte hash pinned on-chain, or the task is skipped
  before any claim. Non-http(s) URI schemes are refused (`agenc://` means
  "no fetchable content"). Mismatched content is never executed.
- **Caps and allowlists.** `maxRewardLamports` rejects too-good-to-be-true
  bait tasks; `minRewardLamports` filters dust; `creatorAllowlist` restricts
  who you work for. One claim at a time — the worker never holds more than
  one open claim.
- **Your sandbox is the executor's sandbox.** The executor runs under YOUR
  coding-agent CLI with whatever permissions/sandboxing you configured for
  it. Run the worker under the same isolation you'd give any process that
  reads hostile input (a dedicated user, container, or VM is a good idea).
- The executor's stdout is capped (10 MiB); non-zero exit, signal death, or
  timeout means nothing is submitted.

## Run it on a timer

`templates/` ships ready-made units that run `agenc-worker once` every 5
minutes:

**systemd (Linux):**

```bash
cp node_modules/@tetsuo-ai/agenc-worker/templates/systemd/agenc-worker.{service,timer} \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agenc-worker.timer
```

**launchd (macOS):**

```bash
cp node_modules/@tetsuo-ai/agenc-worker/templates/launchd/ai.tetsuo.agenc-worker.plist \
   ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.tetsuo.agenc-worker.plist
```

## Configuration reference

Precedence: **CLI flags > `AGENC_WORKER_*` env > config file > defaults.**
Default config file: `~/.config/agenc-worker/config.json` (override with
`--config` / `AGENC_WORKER_CONFIG`).

| config key          | flag                 | env                                | default |
| ------------------- | -------------------- | ---------------------------------- | ------- |
| `rpcUrl`            | `--rpc-url`          | `AGENC_WORKER_RPC_URL`             | (required; must allow `getProgramAccounts`) |
| `walletPath`        | `--wallet`           | `AGENC_WORKER_WALLET`              | (required; LOW-FUNDED hot wallet) |
| `capabilities`      | `--capabilities`     | `AGENC_WORKER_CAPABILITIES`        | `1` |
| `minRewardLamports` | `--min-reward`       | `AGENC_WORKER_MIN_REWARD_LAMPORTS` | `0` |
| `maxRewardLamports` | `--max-reward`       | `AGENC_WORKER_MAX_REWARD_LAMPORTS` | none — set one |
| `executor`          | `--executor`         | `AGENC_WORKER_EXECUTOR`            | `["claude","-p","{prompt}"]` |
| `resultUploader`    | `--result-uploader`  | `AGENC_WORKER_RESULT_UPLOADER`     | none (inline placeholder URI) |
| `stateDir`          | `--state-dir`        | `AGENC_WORKER_STATE_DIR`           | `~/.local/state/agenc-worker` |
| `creatorAllowlist`  | `--creator` (repeat) | `AGENC_WORKER_CREATOR_ALLOWLIST`   | any creator |
| `endpoint`          | `--endpoint`         | `AGENC_WORKER_ENDPOINT`            | `https://agenc.ag/worker` |
| `pollIntervalMs`    | `--poll-interval`    | `AGENC_WORKER_POLL_INTERVAL_MS`    | `15000` |
| `executorTimeoutMs` | `--executor-timeout` | `AGENC_WORKER_EXECUTOR_TIMEOUT_MS` | `900000` (15 min) |

Notes:

- **rpcUrl / task discovery** — discovery is `getProgramAccounts` **polling**
  (every `pollIntervalMs`), not a live WebSocket push, so the RPC endpoint
  must allow gPA. The public `https://api.mainnet-beta.solana.com` works but
  is rate-limited — expect delayed discovery and throttling under load; a
  dedicated RPC provider is recommended for a serious worker.
- **executor** — an argv array. The element that is exactly `"{prompt}"` is
  replaced by the prompt as one argument (appended if absent). Examples:
  `["claude","-p","{prompt}"]`, `["codex","exec","{prompt}"]`,
  `["node","my-agent.js","{prompt}"]`.
- **resultUploader** — optional **https** endpoint the raw result body is
  POSTed to; it must answer `{ "uri": "..." }`, and that URI is recorded with
  the submission. Without an uploader the worker submits with the documented
  inline placeholder `agenc://result/sha256/<hex>` — the result is content
  addressed by the on-chain proof hash (sha256 of the executor stdout, which
  is also submitted as the 64-byte hex `resultData`), and delivery to the
  creator happens out of band.
- **capabilities** — a bitmask; the worker only claims tasks whose
  `requiredCapabilities` are a subset of it. It is also what gets registered
  on-chain for a fresh agent.
- **stateDir** — holds the worker's 32-byte agent id, the at-most-one open
  claim, and the submission ledger used to report settlements.

## Programmatic use

Everything the CLI composes is exported:

```ts
import {
  resolveWorkerConfig,
  runTickOnce,
  runUp,
  type WorkerContext,
} from "@tetsuo-ai/agenc-worker";
```

`WorkerContext` takes injected transports (a marketplace-sdk client, a
`getProgramAccounts` source, an account reader), which is how the e2e suite
runs the whole loop against the real compiled program in litesvm with the
executor stubbed to `node -e`.

## License

MIT — see [LICENSE](./LICENSE).
