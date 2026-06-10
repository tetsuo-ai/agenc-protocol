"use client";

/**
 * The client boundary that mounts `<AgencProvider>`. Marked "use client" so the
 * provider's React Query context lives on the client, but the COMPONENT TREE
 * still server-renders (App Router renders client components on the server for
 * the initial HTML) — which is exactly what exercises SSR safety.
 *
 * The config is built with `useMemo` from a stable, SSR-safe transport. No
 * `window`/`document` is touched at module scope or during the first render, so
 * the server HTML and the client hydration match.
 */
import { useMemo, type ReactNode } from "react";
import { createSolanaRpc } from "@solana/kit";
import {
  AgencProvider,
  createReadTransport,
  type AgencProviderConfig,
  type ReadTransport,
} from "@tetsuo-ai/marketplace-react";
import { createFixtureTransport } from "./fixture-transport";

export function Providers({ children }: { children: ReactNode }) {
  const config = useMemo<AgencProviderConfig>(() => {
    // Default: the deterministic static fixture transport (no validator needed),
    // so SSR is stable and the grid is populated identically on server+client.
    //
    // When NEXT_PUBLIC_AGENC_RPC_URL is set (sandbox-up validator running), the
    // gPA path is used instead — same row shape, real on-chain bytes. Both
    // `createSolanaRpc` and `createReadTransport` are SSR-safe (no window
    // access), so they import at module scope without breaking hydration.
    const rpcUrl = process.env.NEXT_PUBLIC_AGENC_RPC_URL;
    const queryTransport: ReadTransport = rpcUrl
      ? createReadTransport({ rpc: createSolanaRpc(rpcUrl) })
      : createFixtureTransport();
    return { network: "localnet", queryTransport };
  }, []);

  return <AgencProvider config={config}>{children}</AgencProvider>;
}
