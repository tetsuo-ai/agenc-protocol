// A send the network never kept has no history row, ever. Saying "still catching up" about it
// for long would keep Market re-reading the history, and every read asks the network about
// every account (AgenC's connection counts each one). So only the last two minutes count.
import { expect, it } from "vitest";
import { HISTORY_CATCH_UP_WINDOW_MS, historyBehind } from "../src/history-live.js";

const archive = { hasChange: () => false } as never;
const now = 1_800_000_000_000;
const state = (ts: number, rows: Record<string, unknown> = {}) => ({ activity: [{ signature: "sig1", ts }], moneyRows: rows }) as never;

it("counts a recent move of money with no history row as behind", () => {
  expect(historyBehind(state(now - 60_000), archive, ["acct1"], now)).toBe(true);
});

it("stops counting it after two minutes", () => {
  expect(HISTORY_CATCH_UP_WINDOW_MS).toBe(2 * 60_000);
  expect(historyBehind(state(now - HISTORY_CATCH_UP_WINDOW_MS - 1), archive, ["acct1"], now)).toBe(false);
});

it("is not behind once any of the wallet's accounts has its row", () => {
  expect(historyBehind(state(now - 1_000, { "sig1/acct2": {} }), archive, ["acct1", "acct2"], now)).toBe(false);
});
