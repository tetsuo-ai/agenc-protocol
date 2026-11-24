import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CENT, eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";
import type { WalletState } from "../src/store.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });

it("reads a released job's parties from the chain once, then lists it from the journal", async () => {
  const reads = new Map<string, number>();
  world = await startWorld({
    chain: (base) => ({ ...base, readAccountInfo: (account) => {
      reads.set(account, (reads.get(account) ?? 0) + 1);
      return base.readAccountInfo(account);
    } }),
    earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('Room output')", "{prompt}"],
      mode: "sandboxed", timeoutMs: 3000, envAllowlist: [] }, chosenRoomEnabled: () => true, pollIntervalMs: 100 },
  });
  const { sandbox } = world;
  let wallet = world.wallet;
  const { id } = await wallet.createAgent("Worker");
  wallet.chooseWork(id, true);
  const { task } = await sandbox.postOpenJob({ title: "One job", instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  await wallet.fundAgent(id, { usdCents: 2000 });
  await wallet.setPolicy(id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, id, true);
  await eventually(async () => (await wallet.openWork(id).catch(() => null))?.jobs.length === 1);
  await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
  await eventually(async () => { const held = (await wallet.openWork(id)).held; return held?.canSubmit && held.canRelease; });
  await wallet.decideWork((await wallet.quoteWork(id, task, "release")).id, true);
  await eventually(async () => (await wallet.openWork(id)).held === null || (await wallet.openWork(id)).held === undefined);
  await wallet.close();
  // A record saved before parties carried a registration (released, cleaned up or older).
  const statePath = path.join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(statePath, "utf8"));
  for (const record of Object.values(state.workRecords ?? {})) delete record.parties;
  writeFileSync(statePath, JSON.stringify(state));
  world.wallet = wallet = await world.reopen();
  const listed = async () => {
    reads.set(task, 0);
    const rows = await wallet.listJobs({ role: "working" }, true);
    expect(rows.find((row) => row.task === task)?.parties?.creatorWallet).toBeTruthy();
    return reads.get(task) ?? 0;
  };
  expect(await listed()).toBeGreaterThan(0);
  expect(await listed()).toBe(0);
  await wallet.close();
  world.wallet = wallet = await world.reopen();
  expect(await listed()).toBe(0);
}, 60000);
