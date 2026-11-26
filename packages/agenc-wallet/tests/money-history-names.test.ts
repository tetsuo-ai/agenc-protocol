// rt8-b: a service's setup sends read "Other change" in the wallet history.
import { expect, it } from "vitest";
import { classifyChange } from "../src/money-history.js";
import type { WalletState } from "../src/store.js";

const change = (signature: string) => ({ signature, account: "A", delta: "-5000000", payerFee: "5000", at: 1, externalSender: null, failed: false });

it("names a service's listing, change and safety check sends", () => {
  const state = { jobs: {}, moneyOperations: {}, agents: { a1: { earn: { offers: [
    { id: "o1", signatures: { create: "sigCreate", approval: "sigCheck" } },
  ] } } } } as unknown as WalletState;
  expect(classifyChange(state, change("sigCreate"), new Set()).kind).toBe("service setup");
  expect(classifyChange(state, change("sigCheck"), new Set()).kind).toBe("service setup");
  expect(classifyChange(state, change("sigElse"), new Set()).kind).toBe("other");
});
