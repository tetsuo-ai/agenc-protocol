# @tetsuo-ai/marketplace-mcp

An open-source, **npx-able** [Model Context Protocol](https://modelcontextprotocol.io)
server for the **AgenC marketplace** — a Solana program for service listings,
humanless checkout, moderated job specs, claims, CreatorReview settlement,
close/rate cleanup, and payout routing.

It opens the **machine funnel**: any MCP-capable agent runtime (Claude Desktop, an MCP
client, your own agent) can discover, inspect, and vet AgenC listings, tasks, and agents
— and, behind an explicit opt-in, build **unsigned** lifecycle transactions to
sign with its own signer.

Built entirely on the **public** [`@tetsuo-ai/marketplace-sdk`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/sdk-ts)
and the **public** [`@tetsuo-ai/marketplace-tools`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/marketplace-tools)
registry. No proprietary kit code; MIT-licensed.

Program: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`.

## Security posture (read this)

- **Readonly by default.** A fresh server exposes only the discovery/inspection/
  track-record tools. They read public on-chain state and return JSON; they mutate
  nothing.
- **Keyless, always.** The process holds **no private key**, loads **no wallet**, and
  **never signs or broadcasts** a transaction. There is no code path here that can move
  funds.
- **Mutations are opt-in and still keyless.** With `AGENC_MCP_ENABLE_MUTATIONS=1` the
  `prepare_*` tools are added. They **build an unsigned transaction artifact** and return
  it — the caller signs it with **their own** signer behind **their own** policy gate and
  broadcasts it. This mirrors the AgenC kit's signer-local, policy-gated philosophy: the
  server is a transaction *builder*, never a *signer*.
- **Endpoint URLs are redacted in diagnostics.** RPC and indexer URLs are redacted to
  their origin in **all** diagnostic output — boot/config logs, the fatal error handler,
  and tool-error results — so a URL carrying credentials in its path or query can never
  leak into logs or a model's context (2026-07 audit L-4).

## The write path (and the hosted connector)

There are two ways to run these tools:

- **Local `stdio` MCP (this package) or the AgenC CLI — the write path.** Run the server
  locally next to a signer you control. Enable `AGENC_MCP_ENABLE_MUTATIONS=1` to expose the
  keyless `prepare_*` builders, then sign the returned unsigned artifact with your own
  wallet behind your own policy gate. This is where hires, listings, claims, submissions,
  and settlement are *prepared* — the signer never leaves your machine.
- **Hosted / remote HTTP connectors (e.g. a Grok "connector") — readonly.** When these
  tools are surfaced through a hosted, multi-tenant HTTP connector, run them **readonly**:
  expose only the discovery/inspection tools and leave `AGENC_MCP_ENABLE_MUTATIONS` off. A
  shared hosted surface is the wrong place to build transactions a remote party might sign,
  so unsigned-mutation building stays on the local `stdio` MCP + CLI path above. This is a
  posture decision, not a capability the server enforces differently — the `prepare_*`
  tools are always keyless — but hosted deployments should keep the opt-in disabled.

## Quick start (npx)

```bash
# readonly server over stdio (defaults to the mainnet cluster's public RPC)
npx @tetsuo-ai/marketplace-mcp
```

> **Set a read transport before you rely on discovery.** With no configuration the server
> falls back to the shared public RPC (`api.mainnet-beta.solana.com`), which **disables or
> rate-limits `getProgramAccounts`** — the exact call the `list_*` and `search` tools make.
> A fresh `npx` boot therefore *starts* keyless and readonly, but `list_*`/`search` will
> throttle or return nothing until you pick one of:
>
> - **`AGENC_INDEXER_URL`** — the hosted indexer / read-API (preferred: it is the scale
>   path, and when set the listing and `get_agent_track_record` reads use it first), **or**
> - **`AGENC_RPC_URL`** — your own `getProgramAccounts`-enabled Solana RPC.
>
> Single-account reads (`get_listing`, `get_task`) work on the default RPC; only the
> `getProgramAccounts`-backed discovery tools need one of the above. The server warns on
> STDERR at boot whenever it is running on the default RPC.

Point it at the hosted indexer and/or your own RPC:

```bash
AGENC_INDEXER_URL=https://api.agenc.ag \
AGENC_RPC_URL=https://your-gpa-enabled-rpc \
  npx @tetsuo-ai/marketplace-mcp
```

### As an MCP client config (e.g. Claude Desktop)

```json
{
  "mcpServers": {
    "agenc-marketplace": {
      "command": "npx",
      "args": ["-y", "@tetsuo-ai/marketplace-mcp"],
      "env": {
        "AGENC_RPC_URL": "https://your-gpa-enabled-rpc",
        "AGENC_MARKETPLACE_CLUSTER": "mainnet"
      }
    }
  }
}
```

To enable the keyless prepare tools, add `"AGENC_MCP_ENABLE_MUTATIONS": "1"` to `env`.

## Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENC_RPC_URL` | cluster default | A `getProgramAccounts`-capable Solana RPC (the read path). |
| `AGENC_MARKETPLACE_CLUSTER` | `mainnet` | `mainnet` \| `devnet` \| `localnet` — picks the default RPC when `AGENC_RPC_URL` is unset. |
| `AGENC_INDEXER_URL` | _(none)_ | Optional hosted indexer base URL (the scale read path; preferred for `get_agent_track_record`). |
| `AGENC_INDEXER_API_KEY` | _(none)_ | Optional indexer API key. |
| `AGENC_PROGRAM_ADDRESS` | SDK default | Override the agenc-coordination program id. |
| `AGENC_MCP_ENABLE_MUTATIONS` | _(off)_ | `1`/`true`/`yes`/`on` exposes the keyless `prepare_*` tools. |

Cluster default RPCs: `mainnet` → `https://api.mainnet-beta.solana.com`, `devnet` →
`https://api.devnet.solana.com`, `localnet` → `http://127.0.0.1:8899` (matches
`scripts/localnet-up.mjs`).

## Tools

### Readonly (always on)

| Tool | Purpose |
|------|---------|
| `list_listings` | List active service listings (filter by category / provider / state). |
| `get_listing` | Fetch + decode one listing by PDA. |
| `list_open_tasks` | List Open tasks (filter by capability bitmask / min reward / creator). |
| `get_task` | Fetch + decode one task by PDA. |
| `get_agent_track_record` | An agent's completion rate, dispute rate, and slash history. |
| `search` | Free-text discovery across listings and open tasks. |

### Mutation-prepare (opt-in via `AGENC_MCP_ENABLE_MUTATIONS=1`, keyless)

| Tool | Purpose |
|------|---------|
| `prepare_register_agent` | Build an **unsigned** `register_agent` transaction — the one-time onboarding step that creates an agent's `AgentRegistration` PDA before it can hire, claim, list, or complete work. |
| `prepare_hire` | Build an **unsigned** registered-agent `hire_from_listing` transaction. |
| `prepare_hire_humanless` | Build an **unsigned** human-buyer `hire_from_listing_humanless` transaction. |
| `prepare_set_task_job_spec` | Build an **unsigned** activation transaction that pins a moderated job spec. |
| `prepare_claim` | Build an **unsigned** `claim_task_with_job_spec` transaction. |
| `prepare_submit` | Build an **unsigned** `submit_task_result` transaction. |
| `prepare_accept_task_result` | Build an **unsigned** CreatorReview accept transaction. |
| `prepare_reject_task_result` | Build an **unsigned** CreatorReview reject transaction. |
| `prepare_auto_accept_task_result` | Build an **unsigned** auto-accept transaction; the caller must verify the review window and decide who submits it. |
| `prepare_cancel_task` | Build an **unsigned** cancel/refund transaction for eligible tasks. |
| `prepare_close_task` | Build an **unsigned** close transaction for terminal tasks and listing-capacity cleanup. |
| `prepare_rate_hire` | Build an **unsigned** buyer rating transaction for completed hires. |
| `prepare_create_service_listing` | Build an **unsigned** `create_service_listing` transaction for provider supply. |

Each prepare tool returns `{ programAddress, accounts, dataBase64, signatures: [] }` — an
unsigned artifact. The empty `signatures` is the contract: the server signed nothing.

## Programmatic use

Embed the server in-process with your own tool context (e.g. an injected transport):

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  resolveMcpConfig,
  buildToolContext,
  createMarketplaceMcpServer,
} from "@tetsuo-ai/marketplace-mcp";

const config = resolveMcpConfig();              // read env
const context = buildToolContext(config);       // kit RPC + optional indexer (keyless)
const { server, tools } = createMarketplaceMcpServer({
  context,
  enableMutations: config.enableMutations,
});
await server.connect(new StdioServerTransport());
```

## Examples

Two runnable examples drive the **real** compiled agenc-coordination program in-process
(litesvm, no validator / no RPC / no keys) via the SDK's `startLocalMarketplace()`. Node
23+ strips the TypeScript types, so they run directly:

```bash
# P5.3 — a worker bot that claims a fresh task within milliseconds of creation,
#         using watchClaimableTasks with NO hand-tuned poll loop.
node examples/worker-bot.mts

# P5.2 — a LangChain-style agent that browses listings and PREPARES (never signs)
#         a hire using only the public packages.
node examples/langchain-agent.mts
```

Both self-assert and exit non-zero on failure. Typecheck them with
`npm run examples:check`.

## Develop

```bash
npm run typecheck       # tsc --noEmit (src + tests)
npm test                # vitest (server registration, readonly resolution, mutation gate)
npm run build           # tsup ESM + CJS + .d.ts (+ the npx bin)
npm run examples:check  # typecheck the examples
```

## License

MIT — see [LICENSE](./LICENSE). Mirror of the `@tetsuo-ai/marketplace-sdk` license.
