// rt11 (A bug 1, B): a worker's setup funding read "Other change · Money out" beside
// "Transfer · Money in", and its claim and delivery read "Other change". The wallet
// keeps a record of what it sent, so each of these rows has its own name.
import { afterEach, expect, it } from "vitest";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });
const executor = { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
  mode: "sandboxed" as const, timeoutMs: 3000, envAllowlist: [] };

it("names the setup funding, the registration, the claim and the delivery", async () => {
  world = await startWorld({ earn: { executor, chosenRoomEnabled: () => true, checkExecutionReady: async () => {}, pollIntervalMs: 100 } });
  const { wallet, sandbox } = world;
  const { id, address } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const { task } = await sandbox.postOpenJob({ title: "House job", instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  await wallet.setPolicy(id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 2000 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 1);
  const claim = await wallet.quoteWork(id, task, "claim");
  expect(await wallet.decideWork(claim.id, true)).toEqual({ approved: true });
  await eventually(async () => (await wallet.openWork(id)).held?.canSubmit);
  const submit = await wallet.quoteWork(id, task, "submit");
  expect(await wallet.decideWork(submit.id, true)).toEqual({ approved: true });
  await wallet.tick();
  const rows = wallet.moneyHistory().rows;
  const main = rows.filter(r => r.account === wallet.mainAddress);
  const agent = rows.filter(r => r.account === address);
  // The setup funding: both sides are a transfer between the person's own balances.
  const funding = main.find(r => r.delta.startsWith("-") && agent.some(a => a.signature === r.signature));
  expect(funding?.kind).toBe("transfer");
  expect(agent.find(a => a.signature === funding!.signature)?.kind).toBe("transfer");
  const agentKinds = agent.map(r => r.kind);
  expect(agentKinds).toContain("registration");
  expect(agentKinds).toContain("job claim");
  expect(agentKinds).toContain("job delivery");
  expect(agent.find(r => r.kind === "job claim")?.jobId).toBe(task);
  expect(rows.filter(r => r.kind === "other")).toEqual([]);
}, 60000);
