# @tetsuo-ai/protocol

Public protocol artifact package for AgenC.

## What This Package Is

This is the installable npm contract exported from `agenc-protocol`. It is derived from the committed canonical artifacts at the repo root; it is not the source of truth itself.

It exposes:

- `AGENC_COORDINATION_IDL`
- `AGENC_PROTOCOL_MANIFEST`
- `VERIFIER_ROUTER_IDL`
- `AGENC_COORDINATION_PROGRAM_ADDRESS`
- `AgencCoordination` type

Canonical source-of-truth artifacts still live at the repository root:

- `artifacts/anchor/idl/agenc_coordination.json`
- `artifacts/anchor/types/agenc_coordination.ts`
- `artifacts/anchor/manifest.json`
- `scripts/idl/verifier_router.json`

This package's generated inputs are synchronized from those canonical artifacts
via `npm run sync:artifacts`.

The root package export preserves the canonical JSON IDL object from
`artifacts/anchor/idl/agenc_coordination.json`. The exported `AgencCoordination`
type is the Anchor-generated camelCase helper copied from
`artifacts/anchor/types/agenc_coordination.ts`.

Raw artifact subpaths are also exported:

- `@tetsuo-ai/protocol/idl/agenc_coordination.json`
- `@tetsuo-ai/protocol/manifest.json`
- `@tetsuo-ai/protocol/verifier-router.json`
- `@tetsuo-ai/protocol/daemon-json-rpc.schema.json`

**Workspace version:** `0.3.0` pending a coordinated release bump. The committed
workspace IDL is the **97-instruction revision-5 candidate**; the already-published
`0.3.0` package contains the live revision-4 **99-instruction** IDL. Do not publish
the candidate under the existing version. Requires **Node ≥ 18**.

## Consumer Guidance

Use this package when you need released protocol artifacts in downstream repos
(marketplace-sdk, prover tooling, or external integrations).

Use the repo-root artifacts when you are maintaining protocol source of truth inside `agenc-protocol`.

## License

MIT (see [LICENSE](./LICENSE)). The parent repository's on-chain program is GPL-3.0;
this artifacts package is independently MIT-licensed.
