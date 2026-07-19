# Independent dependency audit policy

`tests-integration` is intentionally not an npm workspace, but its locked
Anchor/web3 dependency tree is used by the deployment/preflight scripts and the
operator-supervised mainnet signing rails. Run its audit independently:

```bash
npm run audit:tests-integration
```

The gate rejects every npm advisory, including low and moderate findings. The
suite carries a small local encoder for the exact immutable legacy SPL Token
instructions used by fixtures instead of importing the extension-heavy SPL
helper package into operator tooling. Its byte layouts and account ordering are
pinned by `spl-token-legacy.test.mjs`.

The lock also overrides `rpc-websockets` to `9.3.8`. Version `9.3.9` paired its
CommonJS entrypoint with ESM-only `uuid@14` and crashes when loaded by the Node
20 deployment rails; `9.3.8` uses the compatible CommonJS-capable `uuid@11`
line while remaining above the separately disclosed `rpc-websockets` advisory
range. The vulnerable `jayson` UUID resolution is independently overridden to
`uuid@11.1.1`. `audit:tests-integration` includes a real
`@solana/web3.js` CommonJS load probe, so this compatibility pin cannot be
removed or drifted until the resolved tree actually loads.
