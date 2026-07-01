import type { AgencNetwork } from "@tetsuo-ai/marketplace-react";
import {
  signerFromWalletAccount,
  type WalletStandardAccountLike,
  type WalletStandardSignTransaction,
} from "@tetsuo-ai/marketplace-react/signers";
import type { TransactionSigner } from "@solana/kit";

declare global {
  interface Window {
    /**
     * Starter seam: set this from your wallet integration, for example from a
     * Wallet Standard selected account resolved by @solana/react.
     */
    agencWallet?: {
      account: WalletStandardAccountLike;
      signTransaction?: WalletStandardSignTransaction;
    };
  }
}

function chainFor(network: AgencNetwork): string {
  if (network === "mainnet") return "solana:mainnet";
  if (network === "devnet") return "solana:devnet";
  throw new Error("Localnet wallet chains are not wired in this starter.");
}

export async function resolveBrowserWalletSigner(
  network: AgencNetwork,
): Promise<TransactionSigner | null> {
  const wallet = window.agencWallet;
  if (!wallet?.account) return null;
  return signerFromWalletAccount(wallet.account, {
    chain: chainFor(network),
    ...(wallet.signTransaction ? { signTransaction: wallet.signTransaction } : {}),
  });
}
