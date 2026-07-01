import type { AgencNetwork, ReferrerConfig } from "@tetsuo-ai/marketplace-react";

function envString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envNetwork(value: string | undefined): AgencNetwork {
  const network = envString(value) ?? "devnet";
  if (network === "mainnet" || network === "devnet") return network;
  if (network === "localnet") {
    throw new Error(
      "VITE_AGENC_NETWORK=localnet is not wired in this browser-wallet starter.",
    );
  }
  throw new Error(
    `Unsupported VITE_AGENC_NETWORK=${JSON.stringify(network)}. Use "devnet" or "mainnet".`,
  );
}

function envReferrer(): ReferrerConfig | undefined {
  const wallet = envString(starterEnv.VITE_AGENC_REFERRER_WALLET);
  const feeRaw = envString(starterEnv.VITE_AGENC_REFERRER_FEE_BPS);
  if (!wallet || !feeRaw) return undefined;
  const feeBps = Number.parseInt(feeRaw, 10);
  return Number.isFinite(feeBps) ? { wallet, feeBps } : undefined;
}

const starterEnv =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export const starterConfig = {
  network: envNetwork(starterEnv.VITE_AGENC_NETWORK),
  rpcUrl: envString(starterEnv.VITE_AGENC_RPC_URL),
  rpcSubscriptionsUrl: envString(starterEnv.VITE_AGENC_RPC_SUBSCRIPTIONS_URL),
  indexerUrl: envString(starterEnv.VITE_AGENC_INDEXER_URL),
  backendUrl: envString(starterEnv.VITE_AGENC_BACKEND_URL) ?? "",
  referrer: envReferrer(),
} as const;
