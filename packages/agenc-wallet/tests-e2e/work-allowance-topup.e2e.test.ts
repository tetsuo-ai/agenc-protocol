import { afterEach, expect, it } from "vitest";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });
const executor = { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
  mode: "sandboxed" as const, timeoutMs: 3000, envAllowlist: [] };

// Found on the owner's Mac (0.1.16 candidate): raising an agent's daily amount
// tops its own money up by that amount, and the claim card then read
// "$0.00 remaining" because the top-up itself was counted as spent.
it("lets an agent take a hand-picked job with money its daily top-up moved in", async () => {
  world = await startWorld({ earn: { executor, chosenRoomEnabled: () => true, checkExecutionReady: async () => {}, pollIntervalMs: 100 } });
  const { wallet, sandbox } = world;
  const { id, address } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const { task } = await sandbox.postOpenJob({ title: "House job", instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  await wallet.fundAgent(id, { usdCents: 2000 });
  await wallet.setPolicy(id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 1);
  // Most of the agent's own money goes back to the main balance first.
  const spare = await world.balance(address) - 3_000_000n;
  await wallet.reclaimFromAgent(id, { lamports: spare.toString() });
  const before = await world.balance(address);
  // The person raises the daily amount: the wallet tops the agent up at once.
  await wallet.setBudget(id, 2000);
  const after = await world.balance(address);
  expect(after).toBeGreaterThan(before);
  const quote = await wallet.quoteWork(id, task, "claim");
  expect(BigInt(quote.charge.lamports)).toBeGreaterThan(0n);
  expect(BigInt(quote.dailyRemaining.lamports)).toBeGreaterThanOrEqual(BigInt(quote.charge.lamports));
  expect(await wallet.decideWork(quote.id, true)).toEqual({ approved: true });
  const held = await eventually(async () => { const job = (await wallet.openWork(id)).held; return job?.canSubmit && job; });
  expect(held).toMatchObject({ task, preview: "Room output" });
  const submit = await wallet.quoteWork(id, task, "submit");
  expect(BigInt(submit.dailyRemaining.lamports)).toBeGreaterThanOrEqual(BigInt(submit.charge.lamports));
  expect(await wallet.decideWork(submit.id, true)).toEqual({ approved: true });
  expect(sandbox.deliveries.size).toBe(1);
}, 60000);

it("still counts a hand-picked job's own spending against the day", async () => {
  world = await startWorld({ earn: { executor, chosenRoomEnabled: () => true, checkExecutionReady: async () => {}, pollIntervalMs: 100 } });
  const { wallet, sandbox } = world;
  const { id } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const { task } = await sandbox.postOpenJob({ title: "House job", instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  await wallet.fundAgent(id, { usdCents: 2000 });
  // A day this small cannot cover the claim, top-up or not.
  await wallet.setPolicy(id, { askAboveCents: 1, refill: { enabled: true, topUpToCents: 1, perDayCents: 1 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 1);
  const quote = await wallet.quoteWork(id, task, "claim");
  expect(BigInt(quote.dailyRemaining.lamports)).toBeLessThan(BigInt(quote.charge.lamports));
  await expect(wallet.decideWork(quote.id, true)).rejects.toThrow(/allowance/);
}, 60000);
