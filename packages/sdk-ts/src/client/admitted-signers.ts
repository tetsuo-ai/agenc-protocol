import {
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";

// Kit may await another signer before invoking this one. Check at the call to the capability.
export function admittedSigners(signers: readonly TransactionSigner[], check: () => void) {
  const guarded: (TransactionPartialSigner | TransactionModifyingSigner)[] = [];
  for (const signer of signers) {
    function atSigning<A extends unknown[], R>(sign: (...args: A) => R) {
      return (...args: A) => {
        check();
        return sign.apply(signer, args);
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
