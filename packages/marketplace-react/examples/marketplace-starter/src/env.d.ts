interface ImportMetaEnv {
  readonly VITE_AGENC_NETWORK?: "mainnet" | "devnet" | "localnet";
  readonly VITE_AGENC_RPC_URL?: string;
  readonly VITE_AGENC_RPC_SUBSCRIPTIONS_URL?: string;
  readonly VITE_AGENC_INDEXER_URL?: string;
  readonly VITE_AGENC_BACKEND_URL?: string;
  readonly VITE_AGENC_MODERATOR?: string;
  readonly VITE_AGENC_REFERRER_WALLET?: string;
  readonly VITE_AGENC_REFERRER_FEE_BPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
