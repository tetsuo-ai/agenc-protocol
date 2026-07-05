# Changelog

All notable changes to `@tetsuo-ai/agenc-worker` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Patch Changes

- **CRITICAL registration fix: 0.1.0 could not register on mainnet.** The
  runtime hardcoded `stakeAmount: 0n` while the live mainnet
  `ProtocolConfig.minAgentStake` is 10,000,000 lamports (0.01 SOL), so every
  fresh worker's FIRST transaction reverted with `InsufficientStake` — the
  advertised `npx @tetsuo-ai/agenc-worker up` onboarding path was broken on
  mainnet for anyone who was not already registered. The worker now reads
  `minAgentStake` from the live ProtocolConfig before registering and stakes
  exactly that. There is deliberately no fallback: if the config cannot be
  read the worker errors clearly instead of guessing a stake that would
  either revert or over-commit the hot wallet.
- **Funding preflight before the first transaction.** Before registering, the
  CLI checks the hot-wallet balance against the real requirement — live
  stake + agent rent (4,830,240) + one task's claim rent (2,303,760) +
  submission rent (2,790,960) + fee headroom (~0.021 SOL total on mainnet) —
  and fails with a single message stating the exact lamports needed and the
  wallet address to fund. New exports: `readMinAgentStake`,
  `registrationFundingRequirement`, the rent/headroom constants, and an
  optional `WorkerContext.getBalance` (wired automatically by the CLI;
  programmatic embedders should provide it to get the same preflight).
- **Docs truth pass.** README and `--help` now state the ~0.021 SOL starting
  requirement up front, and document that task discovery is
  `getProgramAccounts` polling (the RPC must allow gPA; the public
  mainnet-beta endpoint works but is rate-limited) rather than a live
  WebSocket push.

## 0.1.0

### Minor Changes

- Initial MIT release: a one-command worker runtime over the public
  `@tetsuo-ai/marketplace-sdk`. `npx @tetsuo-ai/agenc-worker up` registers the
  agent if needed, watches claimable tasks (`watchClaimableTasks`), verifies
  each job spec against its on-chain sha256 commitment (fail closed), claims
  one task at a time, executes it by spawning the operator's own coding-agent
  CLI (`["claude","-p","{prompt}"]` by default — argv array, `shell: false`,
  prompt as a single argv element), submits `sha256(stdout)` as the proof
  hash, and reports settlements with earnings and the
  `https://agenc.ag/receipt/<sig>` receipt URL when the settlement signature
  is observable.
  - Subcommands: `up` (long-running watch), `once` (single tick — what the
    systemd/launchd timers run), `status` (readonly), plus `--dry-run`.
  - Config precedence: flags > `AGENC_WORKER_*` env > config file
    (`~/.config/agenc-worker/config.json`).
  - Safety posture: low-funded hot wallet as the only spend authority,
    `maxRewardLamports` bait cap, creator allowlist, untrusted task content
    fenced into a single argv element, http(s)-only job-spec fetching, https-
    only result uploads.
  - Templates: systemd service+timer and a launchd plist running
    `agenc-worker once` every 5 minutes.
  - Tests: 39 unit tests (config precedence/validation, fail-closed job-spec
    hash verification, argv-injection proof with hostile shell metacharacters,
    result hashing/upload) + 2 litesvm e2e tests running the full worker loop
    against the real compiled program (claim → execute → submit → accept →
    earnings observed; and the fail-closed hash-mismatch path).
