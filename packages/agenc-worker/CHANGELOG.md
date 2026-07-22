# Changelog

All notable changes to `@tetsuo-ai/agenc-worker` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 (unreleased candidate)

This candidate depends on `@tetsuo-ai/marketplace-sdk@^0.12.0` and belongs to
the coordinated revision-5 release train. Published worker 0.1.1 remains the
current npm release while mainnet is on revision 4.

This candidate raises the runtime floor to Node 22.23.1; Node 20 is EOL and
unsupported.

### Security

- Registered workers now perform a live pre-claim balance gate covering exact
  claim/submission rent, the worst-case refundable contest deposit, and fee
  headroom. New claims fail closed without live balance/rent hooks, while
  recovery and reconciliation of already-landed claims remain available.
- Job-spec verification now follows the protocol's canonical envelope
  contract: the `json-stable-v1` payload hash must match both
  `integrity.payloadHash` and the on-chain commitment. `agenc://` no longer
  bypasses fetching with empty content; it fails closed unless an embedder
  injects a trusted resolver, and resolved envelopes receive the same checks.
- The built-in job-spec downloader now permits public HTTP(S) destinations
  only, validates every redirect, rejects private/loopback/link-local/metadata
  and other non-global IPv4/IPv6 ranges, rejects mixed DNS answers, and pins
  the validated address into the socket to prevent DNS rebinding between
  lookup and connect.
- The default Claude executor is now tool-less and customization-free
  (`--bare`, `--safe-mode`, no skills, MCP, tools, or session persistence) and
  runs in a one-use scratch cwd/HOME with a scrubbed environment. Custom
  executors require an explicit `sandboxed` or `unsafe` mode.
- Active workers now require a finite maximum reward and creator allowlist,
  unless the operator uses named, explicit risk opt-outs.
- Job specs are capped at 64 KiB and the fully framed executor prompt is
  byte-capped before claim, preventing an oversized pinned spec from landing a
  claim and then failing with `E2BIG`. Executor stderr is drained through a
  256 KiB cap, and safe/sandboxed process groups are killed after normal exit
  as well as on timeout/overflow.
- Timer templates no longer run mutable `npx` installs. The systemd unit uses
  an absolute preinstalled binary and adds host hardening directives.
- Worker and CLI diagnostics now use bounded, linear URL detection and redact
  credentials plus path/query/fragment material without returning ambiguous
  suffixes. The scanner also catches every WHATWG-repaired special-scheme
  spelling, including missing or backslash authority markers. Static AgenC URI
  labels remain structured prose, while malformed, whitespace-bearing, and
  punctuation-only URL secrets fail closed.
- Claims created from a service listing are now provider-bound. The worker
  runtime reads the task's `HireRecord` before building a claim and, for the
  live revision-4 records that predate the immutable provider field, supplies
  the exact stored listing as migration evidence. This keeps existing open
  hires claimable without allowing a different registered agent to take them.
- Canonical hire-PDA reads now retain RPC owner and executable metadata. The
  runtime accepts only an absent account or a System-owned, non-executable,
  zero-data placeholder as a direct task; a program-owned hire must have the
  exact `HireRecord` size, discriminator, task, and PDA bump. Wrong owners,
  executable accounts, non-empty System data, and malformed program data fail
  before funding checks or signing. This also fixes direct tasks being skipped
  when permissionless lamport dust creates the valid empty System placeholder.
  A valid hire designated to another agent now returns the stable
  `not-designated-provider` skip before external content fetches, funding
  hooks, WAL creation, or transaction send. CLI account and balance reads pin
  `confirmed`, matching SDK discovery and transaction defaults explicitly.

### Breaking Changes

- Ambient Claude OAuth/keychain auth is intentionally unavailable in safe
  mode; provide `ANTHROPIC_API_KEY`.
- Existing custom executors must select `executorMode: "sandboxed"` or the
  explicit legacy `"unsafe"` mode. Existing unrestricted creator/reward
  policies must be replaced with limits or explicit opt-outs.
- Revision-5 hired tasks are accepted only when the pinned job-spec hash equals
  the buyer commitment stored at funding. Open revision-4 hires have a zero
  commitment tail and are reported as `legacy-hire-requires-rehire` instead of
  being claimed; their creator must cancel/refund and hire again after cutover.
- Task descriptions are always rendered as opaque hash labels. The worker never
  interprets either 32-byte commitment as UTF-8 prompt text.
- Programmatic contexts should add the new optional `readAccountInfo` callback;
  `createSolanaAccountReaders` builds it alongside the backward-compatible raw
  reader. Shipped worker CLIs/templates wire it automatically. Bytes-only
  embedders remain source-compatible but cannot preflight owner/executable
  metadata, so they should migrate before signing production claims.

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
  agent if needed, watches claim candidates (`watchClaimableTasks`), verifies
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
