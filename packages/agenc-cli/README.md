# @tetsuo-ai/agenc-cli

**The Stripe-4242 moment for AgenC.** Within a minute of one command you
WATCH money settle four ways: `agenc init` wires the repo you are already in
into an AgenC node, `agenc dev` runs counterparty bots that hire + complete
your listing — printing the live 4-way settlement split (worker / operator /
referrer / protocol treasury) with real lamport deltas read from the chain —
and `agenc promote` diffs your project against the go-live checklist.

On a cold machine `agenc dev` needs **zero setup**: when no localnet stack is
discoverable it runs the REAL compiled agenc-coordination program in-process
(litesvm, shipped inside the sdk) — no validator, no anchor build, no RPC.

```bash
npx @tetsuo-ai/agenc-cli init
npx @tetsuo-ai/agenc-cli dev
```

```text
  == SETTLEMENT: the 4-way split (real lamport deltas from the chain) ==

  leg                payee      Δ lamports    Δ SOL  % of reward
  -----------------  ---------  ----------  -------  -----------
  worker             DDrV…QLW9      800000   0.0008       80.00%
  operator           6Xf3…AmgM      100000   0.0001       10.00%
  referrer           642S…wVu2       50000  0.00005        5.00%
  protocol treasury  DeM9…ugjb       50000  0.00005        5.00%
  -----------------  ---------  ----------  -------  -----------
  total                            1000000    0.001      100.00%
```

(The protocol-treasury leg is the live mainnet 5% fee — both dev sandboxes
seed 500 bps so the demo split is production-truthful.)

> **Bin-name note:** an older runtime package, `@tetsuo-ai/agenc`, also
> installs a bin named `agenc`. The two coexist: when both are installed (or
> to be unambiguous in scripts), invoke this one as
> `npx @tetsuo-ai/agenc-cli <cmd>`.

## Commands

### `agenc init`

Framework-detects the **current** repo (never greenfield-only):

- **Next.js detected** (`next` in deps): injects a minimal, clearly-marked
  checkout surface — `app/agenc/page.tsx` + `app/agenc/checkout/route.ts`
  (pages-router fallback: `pages/agenc.tsx` + `pages/api/agenc/checkout.ts`)
  plus server-only content-addressed job-spec storage and a public GET route
  — built on the plain-SDK `hireAndActivate` orchestration
  (`@tetsuo-ai/marketplace-sdk`; marketplace-react is NOT required), plus an
  `agenc.config.json` with the listing terms. The scaffolded checkout route is
  **local-development only and fail-closed** on BOTH router variants. It accepts
  the checkout secret only through `x-agenc-checkout-secret` (never a form/body
  field), requires `AGENC_ENABLE_DEV_CHECKOUT=1`, `AGENC_NETWORK=localnet`, and a
  loopback `AGENC_RPC_URL`, and always refuses `NODE_ENV=production`. Its
  in-memory admission policy is not a production authorization system. Replace
  it with authenticated, durable, atomic idempotency/recovery and audited
  total-wallet-debit controls before launch. The development route also requires
  explicit per-checkout/hourly/transaction-fee debit budgets, validates the live
  listing/provider/operator/fee/deadline/capability/version terms, and stores then reads back a canonical
  worker-verifiable envelope before signing the hire. A post-send recovery is
  bound to the same idempotency key only when the SDK returns a genuine typed
  recovery token. The route requires the SDK's stable hire-intent digest and a
  canonical attributable transaction signature where the token carries one
  (decoded to exactly 64 bytes, including valid shorter leading-zero encodings),
  then resumes through the SDK's transaction-proof reconciliation rail. It
  never fabricates recovery from bare account state, and generic preflight
  errors release the key for a clean retry. If finalized transaction evidence
  proves an atomic execution failure, the stale recovery and its debit
  reservation are explicitly discarded so the key can be retried safely. An
  invalid terminal proof is never treated as retry-safe: the key and its
  conservative debit reservation remain permanently blocked for manual review.
  Set
  `AGENC_MODERATOR` to the separate wallet funded by the local attestor (the
  checkout signer is deliberately rejected so external moderation rent/fees
  cannot escape its wallet-debit reservation),
  `AGENC_JOB_SPEC_DIR` to durable shared storage and
  `AGENC_JOB_SPEC_PUBLIC_BASE_URL` to the generated route's public HTTPS URL
  (`/agenc/job-specs` for App Router, `/api/agenc/job-specs` for Pages Router).
- **Anything else**: writes `agenc.config.json` + a `worker.mjs` loop wired to
  `@tetsuo-ai/agenc-worker`'s programmatic API (register → watch → claim →
  execute with your own coding-agent CLI → submit → report earnings).
  Generated workers require explicit usable `AGENC_WORKER_ENDPOINT` and private,
  project-specific `AGENC_WORKER_STATE_DIR` values; there is no unusable
  `example.invalid` endpoint or repository-local state fallback.

When the project has **no `package.json`**, init scaffolds a minimal one
(name from the directory, `private: true`, the AgenC deps pre-pinned inside
the support matrix) so `npm install` puts `node_modules` in THIS project —
never hoisted into an ancestor package where `agenc promote` and the wired
templates would not find the sdk. An existing `package.json` is never touched.

`--kind checkout|worker` overrides detection and `--router app|pages` selects a
reviewed Next router migration. Idempotent: identical files are
reported `unchanged`; files whose content differs are **refused** without
`--force`. A forced kind/router migration removes obsolete outputs only when
they still carry the exact `agenc init` marker; edited, non-regular, or symlinked
stale outputs refuse the entire batch and are never deleted. Everything written
lives under paths init owns (`app/agenc/*` or
`pages/agenc*`, `agenc.config.json`, `worker.mjs`, plus the one-time
`package.json` scaffold when none existed).

### `agenc dev`

The show. Resolves a sandbox in this order — it **never** touches mainnet or
devnet (non-loopback RPC endpoints are refused outright):

1. **localnet** — if a `.localnet/env.json` stack is discoverable and
   `127.0.0.1:8899` answers with the program deployed, it reuses the running
   stack; a dead stack is re-booted via the agenc-protocol repo's
   `scripts/localnet-up.mjs` when discoverable.
2. **in-process sandbox (litesvm)** — otherwise it falls back to the REAL
   compiled agenc-coordination program run in-process (the `.so` ships inside
   `@tetsuo-ai/marketplace-sdk`'s testing assets). Zero toolchain, zero
   validator: this is what a fresh `npx @tetsuo-ai/agenc-cli dev` hits, and
   the whole loop lands in seconds. The output labels which mode ran
   (`mode: localnet` vs `mode: in-process sandbox (litesvm)`).

Then, all with throwaway funded wallets:

1. registers a provider agent and creates a service listing for **your**
   project (name/price/fee terms from `agenc.config.json`), with an
   **operator** payee + fee on the listing;
2. attests it CLEAN with the sandbox moderation authority (the localnet
   moderator keypair from `.localnet/env.json`, or the in-process sandbox's
   seeded moderator — no HTTP attestor needed either way; the same
   direct-moderator path the SDK's `localnet-first-hire` example uses);
3. runs in-process counterparty bots: a **buyer bot** that `hireAndActivate`s
   the listing with a **referrer** payee + fee (so the split is genuinely
   4-way) and a **worker bot** — the real `@tetsuo-ai/agenc-worker` runtime,
   reused programmatically with a stub executor — that claims and submits;
   then the buyer accepts (Task Validation V2 submit → accept);
4. prints the settlement as the 4-way split table above, with **real lamport
   deltas read from the chain**, the settlement signature, and the receipt
   URL pattern. (Receipt pages are an agenc.ag **mainnet** surface — in the
   dev sandboxes the printed split + transaction signature are the proof, and
   the output says so.)

Flags: `--sandbox` (force the in-process litesvm mode, skip localnet
discovery), `--localnet` (require the localnet stack — fail with setup
instructions instead of falling back), `--env-file <path>` (explicit
`.localnet/env.json`; implies `--localnet`), `--purge` (run the SDK tooling's
verified stop-and-ledger-purge rail to completion, then re-boot; implies
`--localnet`).

Optional localnet setup, for the full-validator experience (from an
[agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol) clone):
`anchor build`, `(cd packages/sdk-ts && npm install && npm run build)`, then
`node scripts/localnet-up.mjs --dev-ready`. On a warm stack the bot loop lands in well
under a minute (~9s typical); the in-process fallback needs none of this and
lands in seconds.

### `agenc promote`

READONLY diff against the go-live checklist — it never signs, never flips
anything with money. Checks: `agenc.config.json` present/valid, production
RPC configured (and not localhost; inject secret-bearing provider URLs with
`AGENC_RPC_URL` rather than committing API keys), wallet path set + existing + **not** a
`.localnet` throwaway key, installed `@tetsuo-ai/*` pins inside the
[`docs/VERSIONING.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/docs/VERSIONING.md)
support matrix (a package may have multiple compatible minor lines — sdk
0.8.x through 0.11.x all speak the revision-4 wire (see `docs/VERSIONING.md`
§1.1); revision 5 instead requires the coordinated SDK 0.12.x / React 0.5.x
client train, and a directly installed `@tetsuo-ai/protocol` artifact must be
0.3.x for revision 4 or 0.4.x for revision 5). Those version buckets are not a
permissive Cartesian product: `promote` also reads each installed first-party
manifest and checks its actual npm dependency/peer ranges against the installed
SDK and other first-party packages. A truly absent optional package is ignored;
a present but missing, malformed, unreadable, or mutually incompatible manifest
fails closed. See `docs/VERSIONING.md` §1.1.2 for coherent combinations.
`promote` selects exactly one package set from the finalized on-chain surface
revision and rejects both directions of client/program skew; it never treats the
revision-4 and revision-5 sets as one permissive union. Project-local
CLI/scaffolder packages are not used as evidence for the version of a command
that may be running from npx, a global install, or an embedding process. It also
checks a fee-leg rent-exemption advisory and the receipts surface. Chain
evidence is finalized and pinned to one minimum context slot; it verifies the
upgradeable Program/ProgramData relationship, reviewed ProgramData
address/deployment slot, retained upgrade authority, executable SHA-256, and
reviewed source commit in addition to ProtocolConfig ownership and surface
revision. Broad wire compatibility is checked separately from the newer
SDK/runtime APIs required by generated templates.

Revision-5 promotion deliberately remains blocked after the surface byte first
changes. Operators must capture the actual finalized post-upgrade deployment
identity, patch it into the CLI's reviewed release table, rebuild/repack the CLI,
and independently re-audit that artifact before publishing it. Candidate or
predicted deployment values are never accepted as release evidence.

`promote` deliberately cannot return production-ready for a generated checkout
or worker based on local files alone. It reports an explicit blocker until an
operator has evidenced production auth, durable admission/recovery, public
job-spec readback, reviewed moderation/listing binding and deployed checkout
canaries (or effective worker endpoints/private state/bounds and a deployed
worker canary). This prevents a local-only checkout that always returns 503 in
production from being reported ready. Prints pass/fail with the exact next action per gap —
including where to get a wallet (`solana-keygen new`) and which RPC to use;
`--json` for agents. Exit code 0 only when nothing fails.

## Programmatic use

Everything the CLI composes is exported from the package root: `runInit`,
`runDev`, `runDevLoop` (the dependency-injected bot loop — the e2e suite runs
it against litesvm), `runDevSandbox` (the in-process fallback), `GpaSimulator`,
`runPromoteChecks`, `detectProject`, `formatSplitTable`, and the config
helpers.

## Scope (v1)

Local in-process bots only — no hosted daemon; the counterparty bots run
inside `agenc dev` and exit with it. `dev` is local-only by design (localnet
stack or the in-process litesvm sandbox — never a public cluster).

## License

MIT
