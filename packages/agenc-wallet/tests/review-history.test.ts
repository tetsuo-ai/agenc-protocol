import { address } from "@solana/kit";
import { expect, it, vi } from "vitest";
import { readReviewHistory, type ReviewAnchor } from "../src/review-history.js";
import type { SettlementHistoryRpc } from "../src/settlement.js";

it("retries unavailable receipts while reusing confirmed reads from the same claim", async () => {
  const task = address("11111111111111111111111111111111");
  const rows = ["missing", "seen", "failed"].map(signature => ({ signature, err: signature === "failed" ? {} : null }));
  const read = vi.fn(async (signature: string) => signature === "missing" ? null : {
    meta: { err: null, logMessages: [] }, transaction: { signatures: [signature], message: { instructions: [] } },
  });
  const rpc: SettlementHistoryRpc = {
    getSignaturesForAddress: () => ({ send: async () => rows }),
    getTransaction: signature => ({ send: () => read(signature) }),
  };
  const cache = new Map<string, readonly ReviewAnchor[]>();
  for (let i = 0; i < 2; i++) expect(await readReviewHistory(rpc, task, task, cache)).toEqual({ entries: [], complete: false });
  expect(read.mock.calls.flat()).toEqual(["missing", "seen", "missing"]);
});
