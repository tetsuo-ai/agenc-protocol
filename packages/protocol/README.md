# @tetsuo-ai/protocol

Public protocol artifact package for AgenC.

This package is the installable npm contract exported from the public
`tetsuo-ai/agenc-protocol` repository. It exposes:

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
