/**
 * `useWalletSigner()` — bridges a browser wallet into the kit `TransactionSigner`
 * the SDK write client expects.
 *
 * ## Adapter seam (the signer-adapters package is not built yet)
 *
 * The dedicated `@tetsuo-ai/signer-adapters` package (the signers agent, PLAN.md
 * P4.1) — which wraps `@solana/react`'s
 * `useWalletAccountTransactionSendingSigner` (Wallet Standard) and the legacy
 * `@solana/wallet-adapter` shim into a kit `TransactionSigner` — does not exist
 * at this hook's build time. So this hook is defined against a **documented
 * adapter interface** ({@link WalletSignerAdapter}) rather than importing that
 * package. A caller passes an adapter (today: a thin wrapper they write, or the
 * signer-adapters hook once it ships) and this hook normalizes it to the
 * `{ signer, connected, connect() }` contract every other hook expects.
 *
 * With NO adapter passed, the hook falls back to the provider's configured
 * `signer` (the `AgencProvider config.signer` slot), so a server-supplied or
 * test signer just works and `connect()` is a no-op.
 *
 * SSR-safe: no `window`/`document`; the adapter (which may touch wallet globals)
 * is the caller's responsibility to gate to the client. This hook only reads
 * what the adapter already resolved.
 *
 * @module hooks/useWalletSigner
 */
import { useCallback } from "react";
import { useAgencContext } from "../provider/context.js";
import type { TransactionSigner } from "../types.js";

/**
 * The minimal adapter shape this hook bridges. The forthcoming
 * `@tetsuo-ai/signer-adapters` hook is expected to return exactly this shape
 * (its `signerFromWalletAccount(...)` resolves the `signer`); until it ships,
 * any object matching this interface works.
 */
export interface WalletSignerAdapter {
  /** The resolved kit signer, or null when no wallet is connected. */
  signer: TransactionSigner | null;
  /** Whether a wallet is currently connected. */
  connected?: boolean;
  /** Trigger the wallet connect flow (browser-only). Optional. */
  connect?: () => void | Promise<void>;
}

/** Options for {@link useWalletSigner}. */
export interface UseWalletSignerOptions {
  /**
   * A wallet adapter (e.g. the signer-adapters hook's result). When omitted the
   * hook falls back to the provider's `config.signer`.
   */
  adapter?: WalletSignerAdapter;
}

/** Return value of {@link useWalletSigner}. */
export interface UseWalletSignerResult {
  /** The resolved kit `TransactionSigner`, or null. */
  signer: TransactionSigner | null;
  /** Whether a signer is available (adapter-connected or provider-configured). */
  connected: boolean;
  /** Trigger the wallet connect flow. No-op when no adapter `connect` exists. */
  connect: () => void | Promise<void>;
}

/**
 * Resolve the active signer for write operations.
 *
 * @param options - Optional wallet adapter; falls back to the provider signer.
 * @returns {@link UseWalletSignerResult}.
 *
 * @example
 * ```tsx
 * // Once @tetsuo-ai/signer-adapters ships:
 * const adapter = useWalletStandardSigner(); // returns WalletSignerAdapter
 * const { signer, connected, connect } = useWalletSigner({ adapter });
 * ```
 */
export function useWalletSigner(
  options?: UseWalletSignerOptions,
): UseWalletSignerResult {
  const ctx = useAgencContext();
  const adapter = options?.adapter;

  // Adapter wins when present; otherwise the provider's configured signer.
  const signer: TransactionSigner | null =
    adapter?.signer ?? ctx.signer ?? null;
  const connected =
    adapter !== undefined
      ? (adapter.connected ?? adapter.signer !== null)
      : ctx.signer !== null;

  const connect = useCallback(() => {
    // No adapter (or no connect on it) => provider-supplied signer is already
    // "connected"; connecting is a no-op rather than an error.
    return adapter?.connect ? adapter.connect() : undefined;
  }, [adapter]);

  return { signer, connected, connect };
}
