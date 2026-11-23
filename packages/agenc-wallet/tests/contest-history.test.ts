import { expect, it } from "vitest";
import type { Address, Signature } from "@solana/kit";
import { readContestHistory } from "../src/contest-history.js";

it("checkpoints a bounded index page, scans past a pruned transaction and retries it independently", async () => {
  const signatures = Array.from({ length: 37 }, (_, i) => String(37 - i) as Signature);
  let unavailable = true;
  const reads: string[] = [];
  const rpc = {
    getSignaturesForAddress(_task: Address, { before, until, limit }: { before?: Signature; until?: Signature; limit: number }) {
      const start = before ? signatures.indexOf(before) + 1 : 0;
      const end = until ? signatures.indexOf(until) : signatures.length;
      return { send: async () => signatures.slice(start, Math.min(start + limit, end)).map(signature => ({ signature, err: null, slot: BigInt(signature) })) };
    },
    getTransaction(signature: Signature) {
      reads.push(signature);
      return { send: async () => unavailable && signature === "36" ? null : {
        transaction: { signatures: [signature], message: { accountKeys: [] } }, meta: { err: null, logMessages: [], preBalances: [], postBalances: [] },
      } };
    },
  };
  const task = "task" as Address;
  let page = await readContestHistory(rpc, task, null);
  expect(reads.length).toBe(16);
  expect(page.checkpoint?.before).toBe("22");
  expect(page.cursor).toBe("37");
  expect(page.checkpoint?.rows.some(row => row.signature === "36" && !row.events)).toBe(true);
  page = await readContestHistory(rpc, task, page.cursor, structuredClone(page.checkpoint));
  page = await readContestHistory(rpc, task, page.cursor, page.checkpoint);
  expect(reads).toContain("1");
  expect(page.checkpoint?.before).toBeUndefined();
  unavailable = false;
  page = await readContestHistory(rpc, task, page.cursor, page.checkpoint);
  expect(page.checkpoint?.rows.filter(row => !row.events)).toEqual([]);
});
