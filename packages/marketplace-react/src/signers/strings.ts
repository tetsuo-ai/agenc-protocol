/**
 * Signer-adapter string catalog (the `signer.*` namespace).
 *
 * Kept local to `src/signers/**` so the adapters route every user-facing string
 * through the package's {@link t} resolver (the PLAN_2 Part A locale contract)
 * WITHOUT cross-editing the shared `src/strings` catalog owned by another
 * surface. A future locale can extend `EN_SIGNER_STRINGS` the same way.
 *
 * @module signers/strings
 */
import { t, type StringCatalog } from "../strings/index.js";

/** English `signer.*` strings used by the wallet/embedded adapters. */
export const EN_SIGNER_STRINGS = {
  "signer.walletNoSignFeature":
    "Wallet account {address} does not expose a solana:signTransaction feature. Pass options.signTransaction explicitly, or use a Wallet Standard account that supports transaction signing.",
  "signer.walletNoSignature":
    "The wallet returned no signature for account {address}. The wallet may have rejected or modified the transaction so the fee-payer signature is absent.",
  "signer.embeddedSignatureCount":
    "Embedded wallet returned {got} signatures for {expected} transactions; expected one per transaction.",
  "signer.walletAdapterDisconnected":
    "The wallet adapter is not connected (publicKey is null). Connect the wallet before creating a signer.",
  "signer.walletAdapterNoSign":
    "The wallet adapter does not expose signTransaction. Use a wallet that supports transaction signing, or migrate to the Wallet Standard path (signerFromWalletAccount).",
} as const satisfies StringCatalog;

/** A `signer.*` message id. */
export type SignerStringId = keyof typeof EN_SIGNER_STRINGS;

/**
 * `t()` bound to the signer catalog: resolves `signer.*` ids while preserving
 * the shared resolver's interpolation + verbatim-fallback behavior.
 */
export function ts(
  id: SignerStringId,
  vars?: Record<string, string | number | bigint>,
): string {
  return t(id, vars, { catalog: EN_SIGNER_STRINGS });
}
