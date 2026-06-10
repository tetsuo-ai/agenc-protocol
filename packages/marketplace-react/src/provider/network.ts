/**
 * Network → endpoint defaults.
 *
 * Reuses the resolution philosophy of the SDK sandbox env seam
 * (`resolveSandboxEnvironment`): explicit config beats a per-network default,
 * and the WebSocket endpoint is derived from the HTTP one when not given. This
 * is intentionally a SMALL, synchronous, SSR-safe mirror — the provider needs
 * no `process`/`fs` access and the sandbox seam's async file-reading path.
 *
 * @module provider/network
 */
import type { AgencNetwork } from "../types.js";

/** Per-network default HTTP RPC endpoints. `mainnet` has no public default. */
const NETWORK_HTTP_DEFAULTS: Record<AgencNetwork, string | null> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  // No public default: mainnet RPC is operator-supplied (rate/cost sensitive).
  mainnet: null,
};

/**
 * `solana-test-validator` serves PubSub on RPC port + 1 (8900), so localnet's
 * WS endpoint is NOT derivable from the HTTP URL by scheme swap alone.
 */
const NETWORK_WS_DEFAULTS: Record<AgencNetwork, string | null> = {
  localnet: "ws://127.0.0.1:8900",
  devnet: "wss://api.devnet.solana.com",
  mainnet: null,
};

/** Derive a ws(s) endpoint from an http(s) one (same host/port/path). */
export function deriveSubscriptionsUrl(rpcUrl: string): string {
  if (/^https:\/\//i.test(rpcUrl)) {
    return `wss://${rpcUrl.slice("https://".length)}`;
  }
  if (/^http:\/\//i.test(rpcUrl)) {
    return `ws://${rpcUrl.slice("http://".length)}`;
  }
  return rpcUrl;
}

/** A resolved pair of RPC endpoints (either may be `null` when unresolvable). */
export interface ResolvedEndpoints {
  rpcUrl: string | null;
  rpcSubscriptionsUrl: string | null;
}

/**
 * Resolve the HTTP + WS RPC endpoints for a network, honoring explicit
 * overrides. Returns `{ rpcUrl: null }` when neither an override nor a default
 * exists (mainnet with no `rpcUrl`) — the provider treats that as "no write
 * client buildable from URLs", not a throw, so a read-only/indexer-only or
 * `client`-override setup still works.
 */
export function resolveEndpoints(
  network: AgencNetwork,
  rpcUrl?: string,
  rpcSubscriptionsUrl?: string,
): ResolvedEndpoints {
  const resolvedRpc = rpcUrl ?? NETWORK_HTTP_DEFAULTS[network];
  const resolvedWs =
    rpcSubscriptionsUrl ??
    (rpcUrl !== undefined
      ? deriveSubscriptionsUrl(rpcUrl)
      : NETWORK_WS_DEFAULTS[network]);
  return { rpcUrl: resolvedRpc, rpcSubscriptionsUrl: resolvedWs };
}
