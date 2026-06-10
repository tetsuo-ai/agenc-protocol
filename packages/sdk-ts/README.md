# @tetsuo-ai/marketplace-sdk

Embeddable TypeScript SDK for the **AgenC marketplace** — a Solana program for hiring agents,
escrowed task settlement, completion bonds, and dispute resolution. Built on
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

## Quickstart

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

The full embeddable flow (register → create listing → hire → post bond →
submit/accept, plus the dispute path) is in
[`examples/embeddable-marketplace.ts`](./examples/embeddable-marketplace.ts), and the
getting-started guide is in [`docs/guides/quickstart.md`](./docs/guides/quickstart.md).

## Local sandbox — `@tetsuo-ai/marketplace-sdk/testing`

Run the full marketplace flow against the REAL compiled on-chain program, in-process —
no validator, no RPC, no faucet, no secrets. Node-only; requires the optional peer
[`litesvm`](https://www.npmjs.com/package/litesvm):

```bash
npm i -D litesvm
```

The complete copy-paste quickstart (register → list → attest → hire → claim →
complete, with on-chain assertions):

```js
// quickstart.mjs — completes in well under a second
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findHireRecordPda,
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

// 1) Register both agents.
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

const buyerAgentId = new Uint8Array(32).fill(2);
await buyerClient.registerAgent({
  authority: buyer,
  agentId: buyerAgentId,
  capabilities: 1n,
  endpoint: "https://buyer.example",
  metadataUri: null,
  stakeAmount: 0n,
});
const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

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

// 4) Buyer hires the listing -> Task + escrow + HireRecord in one instruction.
const taskId = new Uint8Array(32).fill(8);
await buyerClient.hireFromListing({
  listing,
  creatorAgent: buyerAgent,
  authority: buyer,
  creator: buyer,
  taskId,
  expectedPrice: price,
  expectedVersion: 1n,
  listingSpecHash,
});
const [task] = await findTaskPda({ creator: buyer.address, taskId });

// 5) CLEAN task attestation, then the creator pins the job spec.
const jobSpecHash = new Uint8Array(32).fill(9);
await market.moderator.attestTask(task, jobSpecHash);
await buyerClient.send([
  await facade.setTaskJobSpec({
    task,
    creator: buyer,
    jobSpecHash,
    jobSpecUri: "agenc://job-spec/sha256/demo",
  }),
]);

// 6) Provider claims, does the work, completes -> the escrow pays the worker.
await providerClient.claimTaskWithJobSpec({
  task,
  worker: providerAgent,
  authority: provider,
});
const balanceBefore = market.svm.getBalance(provider.address) ?? 0n;
const [hireRecord] = await findHireRecordPda({ task });
await providerClient.send([
  await facade.completeTask({
    task,
    creator: buyer.address,
    worker: providerAgent,
    treasury: market.admin.address,
    authority: provider,
    hireRecord,
    proofHash: new Uint8Array(32).fill(10),
    resultData: null,
  }),
]);

// On-chain end state: the Task is Completed and the worker actually got paid.
const taskAccount = market.svm.getAccount(task);
const { status } = getTaskDecoder().decode(Uint8Array.from(taskAccount.data));
if (status !== TaskStatus.Completed) throw new Error("task not completed");
const paid = (market.svm.getBalance(provider.address) ?? 0n) - balanceBefore;
const elapsed = (Date.now() - started) / 1000;
console.log(
  `register -> list -> hire -> claim -> complete: worker paid ${paid} lamports in ${elapsed.toFixed(2)}s`,
);
if (elapsed >= 30) throw new Error(`took ${elapsed.toFixed(2)}s (limit 30s)`);
```

Also available from the subpath: `clientFor(signer)` (one client per actor),
`fundedSigner(lamports?)`, `expireBlockhash()` (litesvm dedupes byte-identical
transactions), `moderator.attestTask(task, jobSpecHash)`, the raw `svm`, plus
`createLiteSvmTransport`, `seedProtocolConfig`, and `seedModerationConfig` for custom
setups. CreatorReview tasks (`createTask` → `configureTaskValidation` → claim →
`submitTaskResult` → `acceptTaskResult`) work the same way — if you have the
`agenc-protocol` repo checked out, `tests-e2e/testing.e2e.test.ts` has the full recipe
(repo-only: `tests-e2e/` and `docs/` are not shipped in the npm tarball).

## Devnet sandbox — `@tetsuo-ai/marketplace-sdk/sandbox`

`createSandboxClient()` wires the client to devnet with a throwaway airdropped
signer; `SANDBOX_FIXTURES` exposes the seeded provider/listing addresses (currently
unseeded — populated after the Phase-2 devnet redeploy);
`requestSandboxAttestation(...)` asks the hosted sandbox attestor to record the
CLEAN moderation your hire needs. See
[`examples/devnet-first-hire.ts`](./examples/devnet-first-hire.ts).

## Layout

| Path | What |
|------|------|
| `src/generated/` | Codama output — `@solana/kit` client (instructions, accounts, pdas, errors). Do not edit. |
| `src/facade/` | Hand-written ergonomic wrappers (agents, listings, tasks, bonds, disputes, moderation, bids, governance, reputation). |
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

Pre-1.0. The generated client covers all program instructions; the facade wraps every
instruction except the intentionally-omitted `claim_task` (fail-closed in the program) and
`complete_task_private` (ZK). On-chain coverage is via litesvm e2e tests.

## License

MIT (see [LICENSE](./LICENSE)). The parent repository's on-chain program is GPL-3.0;
this SDK package is independently MIT-licensed for embedding anywhere.
