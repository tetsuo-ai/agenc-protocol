// rt5 A 2: the seller's job view reads the stars its buyer gave, and the
// stars' debit is counted where the job's price was.
import { describe, expect, it } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS, findHireRatingPda, getHireRatingEncoder, getTaskEncoder, TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "../src/chain.js";
import { countRatingSpend, servedHireRating } from "../src/rating-views.js";
import type { JobRecord, WalletState } from "../src/store.js";

const at = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const SYSTEM = "11111111111111111111111111111111" as Address;
const BUYER = at(8), OTHER = at(9), LISTING = at(5), OTHER_LISTING = at(7), TASK = at(11);

const task = (creator: Address) => Uint8Array.from(getTaskEncoder().encode({
  taskId: new Uint8Array(32), creator, requiredCapabilities: 1n, description: new Uint8Array(64), constraintHash: new Uint8Array(32),
  rewardAmount: 10_000_000n, maxWorkers: 1, currentWorkers: 0, status: TaskStatus.Completed, taskType: 0, createdAt: 0n, deadline: 0n,
  completedAt: 1n, escrow: SYSTEM, result: new Uint8Array(64), completions: 1, requiredCompletions: 1, bump: 0, protocolFeeBps: 500,
  dependsOn: null, dependencyType: 0, minReputation: 0, rewardMint: null, operator: SYSTEM, operatorFeeBps: 0, reserved: new Uint8Array(16),
  referrer: SYSTEM, referrerFeeBps: 0,
}));
const rating = (buyer: Address, listing: Address, score: number) => Uint8Array.from(getHireRatingEncoder().encode({
  task: TASK, listing, buyer, score, reviewHash: null, reviewUri: "", ratedAt: 0n, bump: 0, reserved: new Uint8Array(32),
}));

async function chainWith(rows: { task?: Uint8Array; rating?: Uint8Array }): Promise<Chain> {
  const [pda] = await findHireRatingPda({ task: TASK });
  const accounts = new Map<string, Uint8Array>();
  if (rows.task) accounts.set(TASK, rows.task);
  if (rows.rating) accounts.set(pda, rows.rating);
  return { readAccountInfo: async (address: Address) => {
    const data = accounts.get(address);
    return data ? { data, owner: AGENC_COORDINATION_PROGRAM_ADDRESS, lamports: 1n } : null;
  } } as unknown as Chain;
}

describe("the stars on a hire the agent served", () => {
  it("reads the buyer's stars for the agent's own listing", async () => {
    expect(await servedHireRating(await chainWith({ task: task(BUYER), rating: rating(BUYER, LISTING, 5) }), TASK, LISTING)).toBe(5);
  });
  it("is none before the buyer rates, with or without the task", async () => {
    expect(await servedHireRating(await chainWith({ task: task(BUYER) }), TASK, LISTING)).toBeNull();
    expect(await servedHireRating(await chainWith({}), TASK, LISTING)).toBeNull();
  });
  it("still reads the stars after the buyer's tidy closed the task (rt6 A 1)", async () => {
    expect(await servedHireRating(await chainWith({ rating: rating(BUYER, LISTING, 5) }), TASK, LISTING)).toBe(5);
  });
  it("refuses a closed task's receipt for another listing or another task", async () => {
    await expect(servedHireRating(await chainWith({ rating: rating(BUYER, OTHER_LISTING, 5) }), TASK, LISTING)).rejects.toThrow(/does not match/);
    const [pda] = await findHireRatingPda({ task: TASK });
    const stray = Uint8Array.from(getHireRatingEncoder().encode({
      task: at(12), listing: LISTING, buyer: BUYER, score: 5, reviewHash: null, reviewUri: "", ratedAt: 0n, bump: 0, reserved: new Uint8Array(32),
    }));
    const chain = { readAccountInfo: async (address: Address) => address === pda
      ? { data: stray, owner: AGENC_COORDINATION_PROGRAM_ADDRESS, lamports: 1n } : null } as unknown as Chain;
    await expect(servedHireRating(chain, TASK, LISTING)).rejects.toThrow(/does not match/);
  });
  it("ignores a closed task's receipt the marketplace program does not own", async () => {
    const [pda] = await findHireRatingPda({ task: TASK });
    const data = rating(BUYER, LISTING, 5);
    const chain = { readAccountInfo: async (address: Address) => address === pda
      ? { data, owner: SYSTEM, lamports: 1n } : null } as unknown as Chain;
    expect(await servedHireRating(chain, TASK, LISTING)).toBeNull();
  });
  it("refuses a receipt for another listing or from someone who did not post the task", async () => {
    await expect(servedHireRating(await chainWith({ task: task(BUYER), rating: rating(BUYER, OTHER_LISTING, 5) }), TASK, LISTING)).rejects.toThrow(/does not match/);
    await expect(servedHireRating(await chainWith({ task: task(BUYER), rating: rating(OTHER, LISTING, 1) }), TASK, LISTING)).rejects.toThrow(/does not match/);
  });
});

describe("counting the stars' debit", () => {
  const state = () => ({ agents: { a1: { spentLamports: "200" } }, mainSpentLamports: "50" }) as unknown as WalletState;
  it("adds it to the agent that paid for the hire", () => {
    const draft = state();
    countRatingSpend(draft, { agentId: "a1" } as JobRecord, 40n);
    expect(draft.agents.a1!.spentLamports).toBe("240");
    expect(draft.mainSpentLamports).toBe("50");
  });
  it("adds it to the main balance for the person's own request", () => {
    const draft = state();
    countRatingSpend(draft, { agentId: "" } as JobRecord, 40n);
    expect(draft.mainSpentLamports).toBe("90");
  });
});
