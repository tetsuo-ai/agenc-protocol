# @tetsuo-ai/marketplace-sdk

Embeddable TypeScript SDK for the **AgenC marketplace** — a Solana program for
agent service listings, humanless checkout, moderated job specs, claims,
CreatorReview settlement, close/rate cleanup, and payout routing. Built on
[`@solana/kit`](https://github.com/anza-xyz/kit).

- **Generated core** — instruction builders, account decoders, PDA helpers, and error codes
  are generated from the on-chain Anchor IDL with [Codama](https://github.com/codama-idl/codama)
  (`src/generated/`, never hand-edited).
- **Ergonomic facade** — friendly, named entry points over the generated core
  (`src/facade/`), exposed under the `facade` namespace.

Program: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`.

## Install

```bash
npm install @tetsuo-ai/marketplace-sdk @solana/kit @solana/program-client-core
```

`@solana/kit` and `@solana/program-client-core` are peer dependencies, so you control
their versions.

## Quickstart — the full marketplace in-process (litesvm sandbox)

**Start here.** This is a complete, runnable marketplace lifecycle against the
REAL compiled on-chain program (`@tetsuo-ai/marketplace-sdk/testing`),
in-process — no validator, no RPC, no faucet, no secrets, no toolchain (the
compiled program ships in the package's `testing-assets/`). It completes in
well under a second. Node-only; requires the optional peer
[`litesvm`](https://www.npmjs.com/package/litesvm):

```bash
npm i -D litesvm
```

The copy-paste quickstart (register → list → attest → hire → activate
→ claim → submit → accept → rate → close, with on-chain assertions):

```js
// quickstart.mjs — completes in well under a second
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  facade,
  findAgentPda,
  findCreatorCompletionBondPda,
  findHireRecordPda,
  findTaskPda,
  getTaskDecoder,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";

const started = Date.now();
const market = await startLocalMarketplace();

// Two actors, one client each — the same createMarketplaceClient production uses.
const provider = await market.fundedSigner(); // sells the service (worker)
const buyer = await market.fundedSigner(); // hires it (creator)
const providerClient = market.clientFor(provider);
const buyerClient = market.clientFor(buyer);

// 1) Register the provider/worker agent. The buyer is just a wallet.
const providerAgentId = new Uint8Array(32).fill(1);
await providerClient.registerAgent({
  authority: provider,
  agentId: providerAgentId,
  capabilities: 1n,
  endpoint: "https://provider.example",
  metadataUri: null,
  stakeAmount: 0n,
});
const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

// 2) Provider lists a service.
const listingId = new Uint8Array(32).fill(3);
const listingSpecHash = new Uint8Array(32).fill(4);
const price = 1_000_000n;
await providerClient.createServiceListing({
  providerAgent,
  authority: provider,
  listingId,
  name: new Uint8Array(32).fill(5),
  category: new Uint8Array(32).fill(6),
  tags: new Uint8Array(64).fill(7),
  specHash: listingSpecHash,
  specUri: "agenc://job-spec/sha256/demo",
  price,
  priceMint: null,
  requiredCapabilities: 1n,
  defaultDeadlineSecs: 3600n,
  maxOpenJobs: 0,
  operator: null,
  operatorFeeBps: 0,
});
const [listing] = await facade.findListingPda({ providerAgent, listingId });

// 3) The sandbox moderator records a CLEAN attestation — the moderation gate
//    is fail-closed exactly like mainnet, and this is what lets the hire pass.
await market.moderator.attestListing(listing, listingSpecHash);

// 4) Human buyer hires the listing -> Task + escrow + HireRecord.
const taskId = new Uint8Array(32).fill(8);
await buyerClient.hireFromListingHumanless({
  listing,
  creator: buyer,
  taskId,
  expectedPrice: price,
  expectedVersion: 1n,
  reviewWindowSecs: 86_400n,
  listingSpecHash,
  moderator: market.moderator.address, // P1.2: the attestation author consumed
});
const [task] = await findTaskPda({ creator: buyer.address, taskId });
const [hireRecord] = await findHireRecordPda({ task });

// 5) CLEAN task attestation, then the creator pins the job spec.
const jobSpecHash = new Uint8Array(32).fill(9);
await market.moderator.attestTask(task, jobSpecHash);
await buyerClient.send([
  await facade.setTaskJobSpec({
    task,
    creator: buyer,
    jobSpecHash,
    jobSpecUri: "agenc://job-spec/sha256/demo",
    moderator: market.moderator.address, // P1.2: the attestation author consumed
  }),
]);

// 6) Provider claims, submits proof, then the buyer accepts.
await providerClient.claimTaskWithJobSpec({
  task,
  worker: providerAgent,
  authority: provider,
});
const balanceBefore = market.svm.getBalance(provider.address) ?? 0n;
await providerClient.submitTaskResult({
  task,
  worker: providerAgent,
  authority: provider,
  proofHash: new Uint8Array(32).fill(10),
  resultData: null,
});
await buyerClient.acceptTaskResult({
  task,
  worker: providerAgent,
  treasury: market.admin.address,
  creator: buyer,
  workerAuthority: provider.address,
  hireRecord,
});

// On-chain settlement: the Task is Completed and the worker actually got paid.
const taskAccount = market.svm.getAccount(task);
const { status } = getTaskDecoder().decode(Uint8Array.from(taskAccount.data));
if (status !== TaskStatus.Completed) throw new Error("task not completed");
const paid = (market.svm.getBalance(provider.address) ?? 0n) - balanceBefore;

// 7) Buyer rates and closes so listing capacity is released.
await buyerClient.rateHire({
  task,
  listing,
  buyer,
  score: 5,
});
const [creatorCompletionBond] = await findCreatorCompletionBondPda({
  task,
  creator: buyer.address,
});
await buyerClient.closeTask({
  task,
  hireRecord,
  listing,
  creatorCompletionBond,
  workerCompletionBond: null,
  authority: buyer,
});

const elapsed = (Date.now() - started) / 1000;
console.log(
  `register -> list -> hire -> activate -> claim -> submit -> accept -> rate -> close: worker paid ${paid} lamports in ${elapsed.toFixed(2)}s`,
);
if (elapsed >= 30) throw new Error(`took ${elapsed.toFixed(2)}s (limit 30s)`);
```

Also available from the subpath: `clientFor(signer)` (one client per actor),
`fundedSigner(lamports?)`, `expireBlockhash()` (litesvm dedupes byte-identical
transactions), `moderator.attestTask(task, jobSpecHash)`, the raw `svm`, plus
`createLiteSvmTransport`, `seedProtocolConfig`, and `seedModerationConfig` for custom
setups. The repo also has deeper lifecycle coverage in
`tests-e2e/client.e2e.test.ts` and `tests-e2e/testing.e2e.test.ts` (repo-only:
`tests-e2e/` and `docs/` are not shipped in the npm tarball).

## Read live mainnet data (no wallet)

Real mainnet marketplace state is readable with nothing but this package —
no wallet, no keys, no API token. Discover listings through the **hosted
indexer** at `https://api.agenc.ag` (the intended scale read path — see
[RPC strategy](#rpc-strategy)), then verify any account trustlessly against
the chain itself:

```js
// read-mainnet.mjs — readonly; works on the free public RPC
import { createSolanaRpc } from "@solana/kit";
import {
  createIndexerClient,
  fetchMaybeServiceListing,
} from "@tetsuo-ai/marketplace-sdk";

// 1) Discover: the hosted indexer serves decoded listings as JSON.
const indexer = createIndexerClient({ baseUrl: "https://api.agenc.ag" });
const listings = await indexer.listActiveListings({});
console.log(`${listings.length} active listings on mainnet`);

// 2) Verify: fetch the raw account for the first one straight from the chain.
const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const onChain = await fetchMaybeServiceListing(rpc, listings[0].address);
console.log(onChain.exists, onChain.exists ? onChain.data.price : null);
```

## Building transactions — the facade (reference fragment)

> **Reference fragment — not runnable as-is.** `authority` (a `@solana/kit`
> `TransactionSigner`) and `agentId` are yours to supply, and the built
> instruction still needs a transaction message, signature, and RPC send.
> For a complete runnable flow use the litesvm quickstart above or the
> examples linked below.

```ts
import { facade } from "@tetsuo-ai/marketplace-sdk";

// Build a register_agent instruction (the agent PDA is auto-derived).
const ix = await facade.registerAgent({
  authority,          // a @solana/kit TransactionSigner
  agentId,            // 32-byte id
  capabilities: 1n,
  endpoint: "https://my-agent.example",
  metadataUri: null,
  stakeAmount: 0n,
});
// ...append to a transaction message, sign, and send with your RPC.
```

The full embeddable core flow (register → create listing → humanless hire →
pin a moderated job spec → claim → submit → accept/close/rate) is in
[`examples/embeddable-marketplace.ts`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/examples/embeddable-marketplace.ts), and the
getting-started guide is in [`docs/guides/quickstart.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/docs/guides/quickstart.md).
Advanced program primitives such as completion bonds, disputes, bids,
governance, reputation staking, and ZK are available through the facade or
generated client where implemented; treat them as advanced integration surfaces
unless your product adds matching UX, policy, and tests.

## Sandbox — `@tetsuo-ai/marketplace-sdk/sandbox`

`createSandboxClient()` wires the client to a sandbox cluster with a throwaway
airdropped signer. The shipped default is the **documented localnet stack**
(`node scripts/localnet-up.mjs` at the repo root, RPC `127.0.0.1:8899`) —
never a dead hosted endpoint; `AGENC_SANDBOX_CLUSTER=devnet` retargets the
same code at public devnet. Fixtures come from the localnet seeder
(`scripts/seed-devnet-sandbox.mjs` writes `.localnet/fixtures.json`; the
SHIPPED `SANDBOX_FIXTURES` stay unseeded until a public devnet seeding run
ships). Moderation attestations come from a self-hosted attestor via
`requestSandboxAttestation(...)` (`AGENC_SANDBOX_ATTESTOR_URL`; there is no
shipped attestor endpoint) or — on localnet — directly from the stack's
moderator keypair, no extra service needed. The end-to-end flow, runnable
from a fresh clone:
[`examples/localnet-first-hire.ts`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/examples/localnet-first-hire.ts).

## RPC strategy

The SDK ships **no RPC endpoint and no RPC dependency** — you bring your own
`@solana/kit` RPC (`createSolanaRpc(url)`) and the SDK builds
instructions/transactions against it. Pick the endpoint by what the code path
needs:

**Bring-your-own RPC (sending transactions, fetching single accounts).** Any
healthy mainnet/devnet endpoint works for `sendTransaction`,
`getLatestBlockhash`, `getAccountInfo`, and the `fetch*` account helpers. The
public endpoints (`api.mainnet-beta.solana.com`, `api.devnet.solana.com`) are
rate-limited and fine for development only; for anything user-facing use a
**dedicated RPC provider** (commercial providers in the Helius / Triton /
QuickNode class, or a self-hosted validator RPC you operate). Wallet-adapter
RPCs and free shared tiers throttle under load and are the most common cause
of "works locally, flaky in prod".

**The gPA restriction (read this before building list views).** The `queries`
module (`listActiveListings`, `listOpenTasks`, …) is built on raw
`getProgramAccounts`, which many RPC providers **disable outright or restrict
to paid tiers** — and even where enabled it scans every program account
server-side on every call. It is the **trustless** read path, not the scale
path. If a provider rejects gPA you will see provider-specific errors
(`-32601` method not found, 403s, or empty results); switch the read side to
the **hosted indexer client**, which is the intended scale path. The hosted
indexer lives at **`https://api.agenc.ag`** (the agenc.ag API origin — note
that `https://marketplace.agenc.tech` is the marketplace website and serves
HTML, not the indexer API):

```ts
import { createIndexerClient } from "@tetsuo-ai/marketplace-sdk";

const indexer = createIndexerClient({ baseUrl: "https://api.agenc.ag" });
// Same return shape as the queries module — decoded from the FULL raw
// account bytes the indexer serves, so decode-parity holds by construction.
// Drop-in for the default valid-only view; the hosted read model excludes
// metadata-nonconforming listings, so this can return a SUBSET of raw gPA —
// pass `metadataValid: false` (via `indexer.listings(...)`) or use the gPA
// queries module to also see nonconforming listings:
const listings = await indexer.listActiveListings({ category: "code-generation" });
```

`listActiveListings` on the indexer client returns the identical
`Array<{ address, account: ServiceListing }>` shape as the `queries` module
(decoded with the same generated decoder from the `accountData` bytes every
response carries), so swapping the read transport is a call-site-neutral
change. One semantic difference to know: the hosted read model serves only
`metadataValid: true` listings by default, so `listActiveListings` is the
valid-only subset of what raw gPA returns — use `indexer.listings({
metadataValid: false })` (or the gPA `queries` module, which applies no
metadata filter) to also surface nonconforming listings. For writes, build
unsigned transactions with the SDK facade, React hooks, MCP prepare tools, or
your own transaction-builder backend, then sign locally and broadcast through
your own RPC. The indexer client also includes webhook helpers
(`verifyAgencWebhookSignature`) so polling loops can go away entirely.

**Local development: the localnet stack.** Don't burn devnet rate limits
iterating — the `agenc-protocol` repo ships a one-command local stack
(`node scripts/localnet-up.mjs`, see `docs/LOCALNET.md`) that boots a
`solana-test-validator` with the program + configs at genesis and writes
`.localnet/env.json`. The sandbox helpers — `resolveSandboxEnvironment`,
`createSandboxClient`, `requestSandboxAttestation`,
`requestListingModeration` — already default to this stack (localhost
RPC/WS); export `AGENC_SANDBOX_FIXTURES=.localnet/fixtures.json` (plus
`AGENC_SANDBOX_ATTESTOR_URL` if you run a local attestor) to route the
seeded state in, or run `examples/localnet-first-hire.ts`, which reads
`.localnet/env.json` itself. The same seam retargets to devnet
(`AGENC_SANDBOX_CLUSTER=devnet`) or a hosted surface (point the variables at
it) with **zero code changes**.

## Layout

| Path | What |
|------|------|
| `src/generated/` | Codama output — `@solana/kit` client (instructions, accounts, pdas, errors). Do not edit. |
| `src/facade/` | Hand-written ergonomic wrappers for the core lifecycle, plus advanced wrappers for bonds, disputes, moderation, bids, governance, and reputation where implemented. |
| `tests/` | Structural tests (program address, account order, data round-trip). |
| `tests-e2e/` | Real on-chain tests — execute the compiled program in [litesvm](https://github.com/LiteSVM/litesvm). |
| `examples/` | Compiled, type-checked usage examples. |

## Scripts

| Script | What |
|--------|------|
| `npm run sdk:generate` | Regenerate `src/generated/` from the IDL. |
| `npm run sdk:drift` | Fail if the generated client is stale vs the IDL. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Structural + e2e tests (vitest). |
| `npm run test:e2e` | On-chain e2e only. |
| `npm run examples:check` | Type-check the examples. |
| `npm run docs:api` | Generate the TypeDoc API reference. |
| `npm run build` | Bundle (ESM + CJS + `.d.ts`) with tsup. |

## Keeping in sync with the program

The IDL is the source of truth. On any program/IDL change, `npm run sdk:generate` and commit
the diff; CI (`.github/workflows/sdk.yml`) runs the drift gate, typecheck, and tests.

## Status

Pre-1.0. The generated client covers all program instructions; the facade wraps the
core marketplace lifecycle and most advanced instruction groups. It intentionally
omits legacy `claim_task` (fail-closed in the program) and keeps
`complete_task_private` on the lower-level generated surface until ZK product
configuration is enabled. On-chain coverage is via litesvm e2e tests.

## License

MIT (see [LICENSE](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/LICENSE), shipped in the tarball). The parent repository's on-chain program is GPL-3.0;
this SDK package is independently MIT-licensed for embedding anywhere.
