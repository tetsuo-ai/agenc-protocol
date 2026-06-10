# @tetsuo-ai/marketplace-sdk

## 0.1.0

Initial release.

- Codama-generated `@solana/kit` client for the full 80-instruction
  `agenc-coordination` program surface (instructions, account decoders, PDA
  helpers, error codes), generated from the committed Anchor IDL with a CI
  drift gate.
- Ergonomic `facade` namespace wrapping 78/80 instructions (`claim_task` is
  fail-closed in the program and `complete_task_private` is the ZK path —
  intentional skips): agents, listings, tasks, completion bonds, disputes,
  moderation, bids, governance, reputation.
- ESM + CJS + `.d.ts` bundles; `@solana/kit` and `@solana/program-client-core`
  as peer dependencies.
- Structural test suite plus real on-chain litesvm e2e coverage against the
  compiled program.
- MIT licensed.
