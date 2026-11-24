import { getCompiledTransactionMessageDecoder, type Address, type KeyPairSigner } from "@solana/kit";
import type { Chain } from "./chain.js";
import { WalletError } from "./errors.js";
import { reservedLamports } from "./child-hire-store.js";
import type { StateStore } from "./store.js";

export function reservedForPayer(store: StateStore, payer: Address, ownJob?: string) {
  const agent = Object.values(store.state.agents).find((a) => a.address === payer);
  return agent ? reservedLamports(agent, ownJob) : 0n;
}

/** Worker, seller, transfer and review builders all use the same agent signer.
 * Check the complete debit (including rent and fees), even on paths which
 * otherwise have no funding preflight. The wallet serializes the sends per payer. */
export function reservationSigner(signer: KeyPairSigner, chain: Chain, held: () => bigint): KeyPairSigner {
  return {
    ...signer,
    async signTransactions(transactions, options) {
      if (held() > 0n) {
        if (transactions.length !== 1)
          throw new WalletError("NOT_ALLOWED", "Review one transaction while this payer has reserved funds.");
        const after = await chain.balanceAfter?.(transactions[0]!, signer.address);
        if (after == null || after < held())
          throw new WalletError(
            "NOT_ENOUGH_MONEY",
            "This transaction would use SOL reserved for another job.",
          );
      }
      return signer.signTransactions(transactions, options);
    },
  };
}

export function spendingChain(
  chain: Chain,
  store: StateStore,
  ownJob: () => string | undefined,
  lock: <T>(payer: Address, run: () => Promise<T>) => Promise<T>,
): Chain {
  const balance = async (payer: Address) => {
    const raw = await chain.getBalance(payer);
    const held = reservedForPayer(store, payer, ownJob());
    return raw > held ? raw - held : 0n;
  };
  const clientFor: Chain["clientFor"] = (signer, options) => {
    const client = chain.clientFor(signer, options);
    return new Proxy({} as typeof client, {
      get(_, key) {
        const method = Reflect.get(client, key, client);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => lock(signer.address, () => method.apply(client, args));
      },
    });
  };
  const sendSigned: Chain["sendSigned"] = (tx) => {
    const payer = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts[0]!;
    return lock(payer, async () => {
      const held = reservedForPayer(store, payer, ownJob());
      if (held) {
        const after = await chain.balanceAfter?.(tx, payer);
        if (after == null || after < held)
          throw new WalletError("NOT_ENOUGH_MONEY", "This approval would use reserved SOL.");
      }
      return chain.sendSigned(tx);
    });
  };
  // Preserve inherited adapters and dynamic receipt readers on injected chains.
  return Object.create(chain, {
    getBalance: { value: balance },
    clientFor: { value: clientFor },
    sendSigned: { value: sendSigned },
  }) as Chain;
}
