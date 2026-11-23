import type { KeyPairSigner } from "@solana/kit";
import { WalletError } from "./errors.js";

/** The same clock check guards SDK signing, moderation signing and receipt dispatch. */
export function beforeContestExpiry(expiresAt: number, now: () => number) {
  if (now() >= expiresAt) throw new WalletError("NOT_AVAILABLE", "The contest quote expired. Request a new quote.");
}

export function contestSigner(signer: KeyPairSigner, expiresAt: number, now: () => number): KeyPairSigner {
  const check = () => beforeContestExpiry(expiresAt, now);
  return {
    address: signer.address,
    get keyPair() { check(); return signer.keyPair; },
    signTransactions: (...args) => { check(); return signer.signTransactions(...args); },
    signMessages: (...args) => { check(); return signer.signMessages(...args); },
  };
}
