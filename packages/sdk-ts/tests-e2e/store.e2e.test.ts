import { describe, it, expect } from "vitest";
import { address } from "@solana/kit";
import {
  facade,
  findStorePda,
  getStoreDecoder,
} from "../src/index.js";
import {
  STORE_REGISTRATION_BOND_LAMPORTS,
} from "../src/facade/stores.js";
import { decodeStoreHandle } from "../src/values/index.js";
import { freshSvm, fundedSigner, send, accountData } from "./harness.js";

// REAL on-chain execution of the batch-2 store-identity lifecycle: build
// register_store / update_store / close_store with the SDK facade, run them
// through the compiled program in litesvm with real signatures, and decode the
// resulting on-chain Store account with the SDK's own decoder. Also proves the
// money path: the 0.05 SOL bond is CPI-deposited on register and refunded in
// full (with rent) on close.
const NO_OPERATOR = address("11111111111111111111111111111111");

describe("e2e: store identity lifecycle executes on the real program", () => {
  it("registers (bond deposited), updates (version bump), and closes (full refund)", async () => {
    const svm = freshSvm();
    const owner = await fundedSigner(svm);
    const [storePda] = await findStorePda({ owner: owner.address });

    // --- register_store (permissionless: no config, no authority) ---
    const registerIx = await facade.registerStore({
      owner,
      handle: "acme-agents",
      metadataHash: new Uint8Array(32).fill(7),
      metadataUri: "https://acme.example/agenc-store.json",
      referrerFeeBps: 250,
      operator: NO_OPERATOR, // default pubkey <=> fee 0 (on-chain pairing rule)
      operatorFeeBps: 0,
      domain: "acme.example",
    });
    await send(svm, owner, [registerIx]);

    const registered = accountData(svm, storePda);
    expect(registered).not.toBeNull();
    const decoded = getStoreDecoder().decode(registered!);
    expect(decoded.owner).toBe(owner.address);
    expect(decodeStoreHandle(new Uint8Array(decoded.handle))).toBe(
      "acme-agents",
    );
    expect(decoded.metadataUri).toBe("https://acme.example/agenc-store.json");
    expect(decoded.referrerFeeBps).toBe(250);
    expect(decoded.domain).toBe("acme.example");

    // The bond is ENFORCED by an in-handler CPI: the PDA holds rent + bond.
    const rent = svm.minimumBalanceForRentExemption(
      BigInt(registered!.length),
    );
    const storeLamports = svm.getBalance(storePda)!;
    expect(storeLamports).toBe(rent + STORE_REGISTRATION_BOND_LAMPORTS);

    // --- update_store (owner-only, in-place, monotonic version) ---
    const versionBefore = decoded.version;
    const updateIx = await facade.updateStore({
      owner,
      handle: "acme-agents-v2",
      metadataHash: new Uint8Array(32).fill(9),
      metadataUri: "https://acme.example/agenc-store-v2.json",
      referrerFeeBps: 300,
      operator: NO_OPERATOR,
      operatorFeeBps: 0,
      domain: "",
    });
    await send(svm, owner, [updateIx]);

    const updated = getStoreDecoder().decode(accountData(svm, storePda)!);
    expect(decodeStoreHandle(new Uint8Array(updated.handle))).toBe(
      "acme-agents-v2",
    );
    expect(updated.referrerFeeBps).toBe(300);
    expect(updated.version).toBe(versionBefore + 1n);
    // The bond stays untouched on the PDA across updates.
    expect(svm.getBalance(storePda)!).toBe(storeLamports);

    // --- close_store (owner-only; rent + bond refunded in one step) ---
    const ownerBefore = svm.getBalance(owner.address)!;
    const closeIx = await facade.closeStore({ owner });
    await send(svm, owner, [closeIx]);

    expect(accountData(svm, storePda)).toBeNull();
    const ownerAfter = svm.getBalance(owner.address)!;
    // Full refund: rent + bond back to the owner, minus only the tx fee.
    const txFee = 5000n;
    expect(ownerAfter).toBe(ownerBefore + storeLamports - txFee);
  });
});
