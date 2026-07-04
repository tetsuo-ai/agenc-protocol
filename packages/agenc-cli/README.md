# @tetsuo-ai/agenc-cli

**The Stripe-4242 moment for AgenC.** Within ~10 minutes of one command you
WATCH money settle four ways: `agenc init` wires the repo you are already in
into an AgenC node, `agenc dev` boots a localnet sandbox and runs counterparty
bots that hire + complete your listing — printing the live 4-way settlement
split (worker / operator / referrer / protocol treasury) with real lamport
deltas read from the chain — and `agenc promote` diffs your project against
the go-live checklist.

```bash
npx @tetsuo-ai/agenc-cli init
npx @tetsuo-ai/agenc-cli dev
```

```text
  == SETTLEMENT: the 4-way split (real lamport deltas from the chain) ==

  leg                payee      Δ lamports     Δ SOL  % of reward
  -----------------  ---------  ----------  --------  -----------
  worker             DDrV…QLW9      825000  0.000825       82.50%
  operator           6Xf3…AmgM      100000    0.0001       10.00%
  referrer           642S…wVu2       50000   0.00005        5.00%
  protocol treasury  DeM9…ugjb       25000  0.000025        2.50%
  -----------------  ---------  ----------  --------  -----------
  total                            1000000     0.001      100.00%
```

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
  `agenc.config.json` with the listing terms.
- **Anything else**: writes `agenc.config.json` + a `worker.mjs` loop wired to
  `@tetsuo-ai/agenc-worker`'s programmatic API (register → watch → claim →
  execute with your own coding-agent CLI → submit → report earnings).

`--kind checkout|worker` overrides detection. Idempotent: identical files are
reported `unchanged`; files whose content differs are **refused** without
`--force`. Everything written lives under paths init owns (`app/agenc/*` or
`pages/agenc*`, `agenc.config.json`, `worker.mjs`).

### `agenc dev`

The show. Ensures a localnet sandbox — if `127.0.0.1:8899` answers and the
program is deployed it reuses the running stack; otherwise it boots one via
the agenc-protocol repo's `scripts/localnet-up.mjs` when discoverable, else
prints the honest one-time setup instructions and exits 1. It **never**
touches mainnet or devnet (non-loopback RPC endpoints are refused outright).

Then, all with throwaway airdropped wallets:

1. registers a provider agent and creates a service listing for **your**
   project (name/price/fee terms from `agenc.config.json`), with an
   **operator** payee + fee on the listing;
2. attests it CLEAN with the localnet moderator keypair from
   `.localnet/env.json` (no HTTP attestor needed — the same direct-moderator
   path the SDK's `localnet-first-hire` example uses);
3. runs in-process counterparty bots: a **buyer bot** that `hireAndActivate`s
   the listing with a **referrer** payee + fee (so the split is genuinely
   4-way) and a **worker bot** — the real `@tetsuo-ai/agenc-worker` runtime,
   reused programmatically with a stub executor — that claims and submits;
   then the buyer accepts (Task Validation V2 submit → accept);
4. prints the settlement as the 4-way split table above, with **real lamport
   deltas read from the chain**, the settlement signature, and the receipt
   URL pattern. (Receipt pages are an agenc.ag **mainnet** surface — on
   localnet the printed split + transaction signature are the proof, and the
   output says so.)

Flags: `--env-file <path>` (explicit `.localnet/env.json`), `--purge`
(kill + re-boot the stack via the sdk tooling first).

One-time prerequisites for the sandbox (from an
[agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol) clone):
`anchor build`, `(cd packages/sdk-ts && npm install && npm run build)`, then
`node scripts/localnet-up.mjs`. On a warm stack the whole bot loop lands in
well under a minute (~9s typical).

### `agenc promote`

READONLY diff against the go-live checklist — it never signs, never flips
anything with money. Checks: `agenc.config.json` present/valid, production
RPC configured (and not localhost), wallet path set + existing + **not** a
`.localnet` throwaway key, installed `@tetsuo-ai/*` pins inside the
[`docs/VERSIONING.md`](../../docs/VERSIONING.md) support matrix (stale pins
fail closed against the live mainnet program), a fee-leg rent-exemption
advisory, and the receipts surface. Prints pass/fail with the exact next
action per gap; `--json` for agents. Exit code 0 only when nothing fails.

## Programmatic use

Everything the CLI composes is exported from the package root: `runInit`,
`runDev`, `runDevLoop` (the dependency-injected bot loop — the e2e suite runs
it against litesvm), `runPromoteChecks`, `detectProject`, `formatSplitTable`,
and the config helpers.

## Scope (v1)

Local in-process bots only — no hosted daemon; the counterparty bots run
inside `agenc dev` and exit with it. `dev` is localnet-only by design.

## License

MIT
