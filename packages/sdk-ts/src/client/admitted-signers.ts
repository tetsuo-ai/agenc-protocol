import {
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";

/** A signer that awaits its own preflight must recheck just before signing. */
export const signerChecksAdmission = Symbol.for("@tetsuo-ai/marketplace-sdk/signer-checks-admission");
const admission = Symbol.for("@tetsuo-ai/marketplace-sdk/signing-admission");
export function recheckSigningAdmission(options: unknown): void {
  (options as { [admission]?: () => void } | undefined)?.[admission]?.();
}

// Kit may await another signer before invoking this one. Check at the call to the capability.
export function admittedSigners(signers: readonly TransactionSigner[], check: () => void) {
  const guarded: (TransactionPartialSigner | TransactionModifyingSigner)[] = [];
  for (const signer of signers) {
    function atSigning<A extends unknown[], R>(sign: (...args: A) => R) {
      return (...args: A) => {
        if (!(signer as {[signerChecksAdmission]?:boolean})[signerChecksAdmission]) check();
        const guarded = [...args];
        guarded[1] = { ...((args[1] ?? {}) as object), [admission]: check };
        return sign.apply(signer, guarded as A);
      };
    }
    const modifier = isTransactionModifyingSigner(signer)
      ? { address: signer.address, modifyAndSignTransactions: atSigning(signer.modifyAndSignTransactions) }
      : undefined;
    if (isTransactionPartialSigner(signer)) {
      guarded.push({ ...modifier, address: signer.address, signTransactions: atSigning(signer.signTransactions) });
    } else if (modifier) guarded.push(modifier);
  }
  return guarded;
}
