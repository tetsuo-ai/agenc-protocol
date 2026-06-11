# VERSIONS — surface-versioning compatibility matrix (P6.5)

One program ID (`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`) serves **two
instruction surfaces**:

- the restricted **25-instruction canary** surface (`--features mainnet-canary`) —
  the only surface live on **mainnet** today;
- the **full surface** (~80 instructions) on **dev / devnet / localnet**.

Because both surfaces share one program ID, a client cannot tell which one is live
just from the address. P6.5 makes that knowable on-chain and answerable from the SDK.

## How a client asks "what is live?"

`ProtocolConfig` carries a `surface_revision: u16` (appended in P6.5):

| `surface_revision` | Meaning | `getDeployedSurface(rpc)` returns |
|--------------------|---------|-----------------------------------|
| `0` | Unstamped / conservative (canary, or a config not yet stamped) | every capability `false` (`listings:false`, …) |
| `1` (`SURFACE_REVISION_FULL`) | The full ~80-instruction surface is live | every capability `true` |

`getDeployedSurface` **tolerates the pre-migration on-chain layout**: the live mainnet
`ProtocolConfig` is the OLD 349-byte layout with no `surface_revision`. The SDK reads
the raw account bytes and treats any account shorter than the new 351-byte layout (or a
missing account) as `surface_revision = 0` — so it returns `listings: false`
**without throwing**, never feeding the old account through the new fixed-size codec.

Facade/client methods that need a full-surface-only capability call `assertCapability`
and throw a typed `SurfaceNotDeployedError` **before** building a transaction that would
otherwise fail with a raw "instruction not found" error.

## ProtocolConfig layout / migration

| | Bytes | Notes |
|---|---|---|
| Pre-P6.5 (`OLD_CONFIG_SIZE`) | **349** | the single live mainnet config account |
| P6.5 (`SIZE`) | **351** | `+2` for `surface_revision: u16`, appended at the END (append-only) |

The live account is brought forward by **`migrate_protocol`** (realloc 349→351,
zero-init `surface_revision = 0`, multisig-gated, idempotent, version-ungated — call it
with `target_version == current_version` = `1` for the realloc-only path). An operator
then stamps the real revision via **`update_launch_controls`** (existing multisig
config-update authority; rejects unknown revisions with `InvalidSurfaceRevision`).

A **fresh full-surface deploy** (dev/devnet) stamps `SURFACE_REVISION_FULL` in
`initialize_protocol`, so it advertises `listings: true` with no manual step; a fresh
**canary** deploy stamps `0`.

## Compatibility matrix (program build ↔ SDK semver ↔ cluster)

> This matrix is the human-maintained source of truth; the release workflow updates it
> in the same window as a deploy or an SDK publish.

| Program build | Live surface | Cluster | `surface_revision` | SDK semver | `getDeployedSurface().listings` |
|---|---|---|---|---|---|
| `mainnet-canary` | 25 ix | **mainnet** (pre-P6.5 migration) | absent (349B) | `@tetsuo-ai/marketplace-sdk` ≥ 0.4.0 | `false` (fallback) |
| `mainnet-canary` | 25 ix | mainnet (post-migration, unstamped) | `0` | ≥ 0.4.0 | `false` |
| full | ~80 ix | **devnet / localnet** | `1` | ≥ 0.4.0 | `true` |
| full | ~80 ix | mainnet (future full deploy, stamped) | `1` | ≥ 0.4.0 | `true` |

Current published versions at the time of writing: `@tetsuo-ai/protocol` `0.2.1`,
`@tetsuo-ai/marketplace-sdk` `0.4.0`. The surface-versioning facade
(`getDeployedSurface`, `SurfaceNotDeployedError`, `CapabilitySet`) lands in the SDK
minor that ships P6.5; bump this row when it is published.

## Release runbook — `anchor idl init` per cluster (fetchable on-chain IDL)

The deployed IDL should be **fetchable truth per cluster**, so a client can confirm the
surface independently of this repo. Wire the following into the release runbook for any
program deploy/upgrade:

1. Build the surface for the target cluster:
   - mainnet canary: `npm run canary:build && npm run canary:idl && npm run canary:check-idl`
     (the IDL surface must stay at exactly **25** instructions — `check-canary-idl.mjs`).
   - dev/devnet full: `anchor build` then `npm run artifacts:refresh && npm run artifacts:check`.
2. Publish the on-chain IDL for that cluster (first deploy) / upgrade it (subsequent):
   ```bash
   # first time on a cluster:
   anchor idl init   <PROGRAM_ID> -f target/idl/agenc_coordination.json --provider.cluster <devnet|mainnet>
   # later upgrades on that cluster:
   anchor idl upgrade <PROGRAM_ID> -f target/idl/agenc_coordination.json --provider.cluster <devnet|mainnet>
   ```
   For the mainnet canary cluster, publish `target/idl/agenc_coordination.canary.json`
   (the 25-instruction IDL) — the on-chain IDL must match the surface that is actually
   live, never the full IDL.
3. Run the **149-task + single-config migration choreography** (binary-first → migrate
   all live accounts → version/surface stamp last). `migrate_protocol` reallocs the
   config; `migrate_task` reallocs the 149 tasks. Both are idempotent and multisig-gated.
4. **Stamp the surface**: `update_launch_controls(..., surface_revision)` —
   `SURFACE_REVISION_FULL` only after the full surface is verified live; otherwise leave
   `0`.
5. Update the matrix above (program build, cluster, `surface_revision`, SDK semver) and
   `docs/MAINNET_MAINLINE.md` in the same release window.

## Deprecation policy (written)

- **Append-only accounts.** `ProtocolConfig` / `Task` fields are never reordered or
  removed; new fields are appended and covered by a `migrate_*` instruction and a size
  `const_assert`. A removed field would invalidate the live-account prefix.
- **Surface revisions are monotonic and additive.** A new `surface_revision` only adds
  capabilities; `getDeployedSurface` maps any revision `≥ SURFACE_REVISION_FULL` to the
  full set, and unknown/lower values fall back to the conservative set. Retiring a
  capability is a NEW revision plus an SDK minor that maps it — never a silent change of
  an existing revision's meaning.
- **Conservative by default.** Any ambiguity (old layout, missing account, unknown
  revision) resolves to the smallest safe surface (`false`). Clients fail-closed via
  `SurfaceNotDeployedError`, never by emitting an instruction the cluster lacks.
- **SDK semver.** Adding `getDeployedSurface` and capability types is a **minor** bump
  (additive). Changing the meaning of an existing `CapabilitySet` field or an existing
  `surface_revision` is a **major** bump.
