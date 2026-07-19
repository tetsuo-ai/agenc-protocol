# Independent dependency audit policy

`tests-integration` is intentionally not an npm workspace, but its locked
Anchor/web3 dependency tree is used by the deployment/preflight scripts and the
operator-supervised mainnet signing rails. Run its audit independently:

```bash
npm run audit:tests-integration
```

The gate rejects every critical advisory and every new or changed high-severity
advisory. One transitive high advisory is temporarily reviewed:

- `GHSA-3gc7-fjrx-p6mg` / npm advisory `1103747` in
  `bigint-buffer@1.1.5`. The affected `toBigIntLE()` path can overflow when it
  receives an oversized buffer. AgenC invokes that conversion only through
  Anchor's fixed-width Borsh integer fields; decoded accounts are then required
  to match the pinned program, discriminator/layout, and canonical PDA policy.
  Request bodies and arbitrary-length fields are not passed to this conversion,
  and integration fixtures are local. This narrows reachability but does not
  make the upstream defect disappear.

Remove the exception as soon as the Solana/Anchor dependency graph provides a
compatible patched path. Moderate advisories remain visible in the audit output
and should be reduced during the same dependency upgrade; they do not pass
silently as high/critical findings.

The lock also overrides `rpc-websockets` to `9.3.8`. Version `9.3.9` paired its
CommonJS entrypoint with ESM-only `uuid@14` and crashes when loaded by the Node
20 deployment rails; `9.3.8` uses the compatible CommonJS-capable `uuid@11`
line while remaining above the separately disclosed `rpc-websockets` advisory
range. `audit:tests-integration` includes a real
`@solana/web3.js` CommonJS load probe, so this compatibility pin cannot be
removed or drifted until the resolved tree actually loads.
