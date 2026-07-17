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
  — built on the plain-SDK `hireAndActivate` orchestration
  (`@tetsuo-ai/marketplace-sdk`; marketplace-react is NOT required), plus an
  `agenc.config.json` with the listing terms. The scaffolded checkout route is
  **fail-closed** on BOTH the App Router and Pages Router variants: it refuses
  to run unless `AGENC_CHECKOUT_SECRET` is configured (2026-07 audit M-5).
- **Anything else**: writes `agenc.config.json` + a `worker.mjs` loop wired to
  `@tetsuo-ai/agenc-worker`'s programmatic API (register → watch → claim →
  execute with your own coding-agent CLI → submit → report earnings).

When the project has **no `package.json`**, init scaffolds a minimal one
(name from the directory, `private: true`, the AgenC deps pre-pinned inside
the support matrix) so `npm install` puts `node_modules` in THIS project —
never hoisted into an ancestor package where `agenc promote` and the wired
templates would not find the sdk. An existing `package.json` is never touched.

`--kind checkout|worker` overrides detection. Idempotent: identical files are
reported `unchanged`; files whose content differs are **refused** without
`--force`. Everything written lives under paths init owns (`app/agenc/*` or
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
`.localnet/env.json`; implies `--localnet`), `--purge` (kill + re-boot the
stack via the sdk tooling first; implies `--localnet`).

Optional localnet setup, for the full-validator experience (from an
[agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol) clone):
`anchor build`, `(cd packages/sdk-ts && npm install && npm run build)`, then
`node scripts/localnet-up.mjs`. On a warm stack the bot loop lands in well
under a minute (~9s typical); the in-process fallback needs none of this and
lands in seconds.

### `agenc promote`

READONLY diff against the go-live checklist — it never signs, never flips
anything with money. Checks: `agenc.config.json` present/valid, production
RPC configured (and not localhost), wallet path set + existing + **not** a
`.localnet` throwaway key, installed `@tetsuo-ai/*` pins inside the
[`docs/VERSIONING.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/docs/VERSIONING.md)
support matrix (a package may have multiple compatible minor lines — sdk
0.8.x through 0.11.x all speak the live wire (see `docs/VERSIONING.md` §1.1); genuinely stale pins fail closed
against the live mainnet program), a fee-leg rent-exemption advisory, and the
receipts surface. Prints pass/fail with the exact next action per gap —
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
