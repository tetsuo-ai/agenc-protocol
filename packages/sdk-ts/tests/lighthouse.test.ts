import { describe, expect, it } from "vitest";
import { AccountRole, address, createNoopSigner, getAddressDecoder, compileTransactionMessage, createTransactionMessage, appendTransactionMessageInstructions, setTransactionMessageFeePayer } from "@solana/kit";
import { facade, findClaimPda, findTaskSubmissionPda } from "../src/index.js";
import * as lighthouse from "../src/lighthouse.js";

const target = address("So11111111111111111111111111111111111111112");
const clock = address("SysvarC1ock11111111111111111111111111111111");
const payer = address("Vote111111111111111111111111111111111111111");

describe("Lighthouse assertion accounts", () => {
  it("declares only the inspected account, read-only and without a signer", () => {
    const builders = {
      assertClockBefore: [lighthouse.assertClockBefore(1), clock],
      assertLamports: [lighthouse.assertLamports(target, 1n), target],
      assertDataHash: [lighthouse.assertDataHash(target, new Uint8Array(32), 0), target],
      assertBytes: [lighthouse.assertBytes(target, 0, new Uint8Array([1])), target],
    } as const;
    // New builders must join the privilege test.
    expect(Object.keys(builders).sort()).toEqual(Object.keys(lighthouse).filter(k => k.startsWith("assert")).sort());
    for (const [ix, key] of Object.values(builders)) {
      expect(ix.programAddress).toBe(lighthouse.LIGHTHOUSE);
      expect(ix.accounts).toEqual([{ address: key, role: AccountRole.READONLY }]);
    }
  });

  it("keeps Clock in the unsigned read-only section of a compiled transaction", () => {
    const ix = lighthouse.assertClockBefore(10);
    const message = compileTransactionMessage(appendTransactionMessageInstructions([ix],
      setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 }))));
    const index = message.instructions[0]!.accountIndices![0]!;
    expect(message.staticAccounts[index]).toBe(clock);
    expect(index).toBeGreaterThanOrEqual(message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts);
  });
  it("resolves privileges from the compiled revision 9 message for each money action", async () => {
    const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
    const creator = createNoopSigner(key(1));
    const [task, worker, listing, workerAuthority, treasury] = [key(2), key(3), key(4), key(5), key(6)] as const;
    const [claim] = await findClaimPda({ task, bidder: worker });
    const [submission] = await findTaskSubmissionPda({ claim });
    const bytes = new Uint8Array(32).fill(7);
    const cases = [
      [listing, await facade.hireFromListingHumanless({ listing, providerAgent: worker, creator, taskId: bytes,
        expectedPrice: 1000n, expectedVersion: 1n, reviewWindowSecs: 3600n,
        listingSpecHash: bytes, taskJobSpecHash: bytes, moderator: key(8) })],
      [submission, await facade.acceptTaskResult({ creator, task, worker, treasury, workerAuthority })],
      [submission, await facade.rejectAndFreeze({ creator, task, worker, rejectionHash: bytes })],
      [submission, await facade.requestChanges({ creator, task, claim, changesHash: bytes })],
    ] as const;
    for (const [account, action] of cases) {
      const guard = lighthouse.assertBytes(account, 0, bytes);
      const message = compileTransactionMessage(appendTransactionMessageInstructions([guard, action],
        setTransactionMessageFeePayer(creator.address, createTransactionMessage({ version: 0 }))));
      const indices = message.instructions[0]!.accountIndices!;
      expect(indices).toHaveLength(1);
      const index = indices[0]!;
      expect(message.staticAccounts[index]).toBe(account);
      expect(index).toBeGreaterThanOrEqual(message.header.numSignerAccounts);
      // A top-level assertion would receive this account writable at runtime.
      // This is why builder-level READONLY cannot establish effective isolation.
      expect(index).toBeLessThan(message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts);
    }
  });

});
