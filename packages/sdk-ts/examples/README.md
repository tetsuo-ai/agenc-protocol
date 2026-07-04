# Examples

Runnable, type-checked examples for `@tetsuo-ai/marketplace-sdk`.

Every file here compiles against the real facade + generated builders. They are
covered by the `examples:check` script (`npm run examples:check`), which runs
`tsc --noEmit` over `examples/**/*.ts` + `src/` so the snippets cannot drift from
the published API.

| File | What it shows |
|------|---------------|
| [`embeddable-marketplace.ts`](./embeddable-marketplace.ts) | The first-run marketplace flow as instruction-building only (no RPC): register a provider agent, create a service listing, humanless buyer hire, job-spec activation, claim, submit, accept, rate, and close. |
| [`localnet-first-hire.ts`](./localnet-first-hire.ts) | The REAL end-to-end sandbox hire against the documented localnet stack: faucet → register → list → attest → `hireAndActivate` → claim → settle. Auto-discovers `.localnet/env.json`; the devnet nightly runs the same file cluster-pinned to devnet. |

## Running

`embeddable-marketplace.ts` assembles instructions with `createNoopSigner(...)`
placeholders and `address(...)` constants — it never hits an RPC, so it
type-checks and runs without a wallet or a cluster connection.

```bash
# type-check the examples against the real API
npm run examples:check

# (optional) execute one to see the assembled instruction count
npx tsx examples/embeddable-marketplace.ts
```

`localnet-first-hire.ts` broadcasts REAL transactions against the localnet
stack (throwaway keys, faucet play money — localnet/devnet only). From the
repo root:

```bash
anchor build                                    # once
(cd packages/sdk-ts && npm install && npm run build)
node scripts/localnet-up.mjs                    # validator + program + configs
node packages/sdk-ts/scripts/seed-devnet-sandbox.mjs   # picks up .localnet/env.json
(cd packages/sdk-ts && npx tsx examples/localnet-first-hire.ts)
```

To turn an example into a live integration, swap the noop signers for real
`TransactionSigner`s (a keypair or wallet adapter), then feed each instruction
into a `@solana/kit` transaction message and sign + send it. The instruction
shapes do not change.

See [`../docs/guides/quickstart.md`](../docs/guides/quickstart.md) for a guided
walkthrough of the same flow.
