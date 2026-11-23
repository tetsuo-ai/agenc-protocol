import { address, getBase58Decoder } from "@solana/kit";
import { expect, it, vi } from "vitest";
import { readReviewHistory, type ReviewAnchor } from "../src/review-history.js";
import type { SettlementHistoryRpc } from "../src/settlement.js";

it("retries unavailable receipts while reusing confirmed reads from the same claim", async () => {
  const task = address("11111111111111111111111111111111");
  const rows = ["missing", "seen", "failed"].map(signature => ({ signature, err: signature === "failed" ? {} : null }));
  const read = vi.fn(async (signature: string) => signature === "missing" ? null : {
    meta: { err: null, logMessages: ["Program 11111111111111111111111111111111 success"] }, transaction: { signatures: [signature], message: { instructions: [] } },
  });
  const rpc: SettlementHistoryRpc = {
    getSignaturesForAddress: () => ({ send: async () => rows }),
    getTransaction: signature => ({ send: () => read(signature) }),
  };
  const cache = new Map<string, readonly ReviewAnchor[]>();
  for (let i = 0; i < 2; i++) expect(await readReviewHistory(rpc, task, task, cache)).toEqual({ entries: [], complete: false });
  expect(read.mock.calls.flat()).toEqual(["missing", "seen", "missing"]);
});

it("continues past eight full pages and retries pruned metadata without caching absence", async () => {
  const task = address("11111111111111111111111111111111");
  const ids = Array.from({ length: 258 }, (_, i) => {
    const bytes = new Uint8Array(64);
    new DataView(bytes.buffer).setUint16(0, i);
    return getBase58Decoder().decode(bytes);
  });
  const oldest: ReviewAnchor = { action: "reject", signature: ids[257]!, at: 1, hash: "a".repeat(64),
    feeLamports: 5000n, rentLamports: 0n, bondLamports: 0n, deadline: 2 };
  const cache = new Map([[task + "/" + task + "/" + oldest.signature, [oldest]]]);
  const receipt = vi.fn(async () => ({ meta: { err: null, logMessages: null } }));
  const rpc: SettlementHistoryRpc = {
    getSignaturesForAddress: (_, { before, limit }) => ({ send: async () => {
      const start = before ? ids.indexOf(before) + 1 : 0;
      return ids.slice(start, start + limit).map((signature, i) => ({ signature, err: start + i >= 256 ? null : {} }));
    } }), getTransaction: () => ({ send: receipt }),
  };
  const first = await readReviewHistory(rpc, task, task, cache);
  expect(first).toMatchObject({ complete: false, continuation: ids[255], missing: false });
  for (let i = 0; i < 2; i++) {
    const last = await readReviewHistory(rpc, task, task, cache, first.continuation);
    expect(last).toEqual({ complete: false, entries: [oldest] });
  }
  expect(receipt).toHaveBeenCalledTimes(2);
});
