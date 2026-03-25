# Protocol Docs Index

This is the developer-documentation entrypoint for `agenc-protocol`.

## Start Here

- [../README.md](../README.md) - repo overview, ownership, and top-level layout
- [./CODEBASE_MAP.md](./CODEBASE_MAP.md) - path-by-path map for programs, artifacts, packages, scripts, migrations, zkVM, and workflows
- [./PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md) - grouped instruction and account model for the Anchor program
- [./MARKETPLACE_V2_BID_PROTOCOL.md](./MARKETPLACE_V2_BID_PROTOCOL.md) - RFC for bid-book accounts, lifecycle, settlement hooks, and anti-spam controls
- [./ARTIFACT_PIPELINE.md](./ARTIFACT_PIPELINE.md) - how `anchor build` output becomes committed and published artifacts
- [./VALIDATION.md](./VALIDATION.md) - local toolchain and CI-equivalent commands
- [./TASK_VALIDATION_V2.md](./TASK_VALIDATION_V2.md) - reviewed public-task completion and validation-account model
- [./ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md) - private-completion and zk-config flow

## Other Active Docs

- [../programs/agenc-coordination/README.md](../programs/agenc-coordination/README.md) - program-specific entrypoint
- [../packages/protocol/README.md](../packages/protocol/README.md) - npm package consumer view
- [../migrations/README.md](../migrations/README.md) - migration authority and current-state guidance
- [./audit/THREAT_MODEL.md](./audit/THREAT_MODEL.md) - security assumptions referenced by the fuzz harness

## Read By Task

- I need the repo layout: [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- I need the on-chain surface: [PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md)
- I need the Marketplace V2 bid design: [MARKETPLACE_V2_BID_PROTOCOL.md](./MARKETPLACE_V2_BID_PROTOCOL.md)
- I need artifact sync rules: [ARTIFACT_PIPELINE.md](./ARTIFACT_PIPELINE.md)
- I need CI or local validation: [VALIDATION.md](./VALIDATION.md)
- I need reviewed public-task completion: [TASK_VALIDATION_V2.md](./TASK_VALIDATION_V2.md)
- I need private completion or zk-config context: [ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md)
