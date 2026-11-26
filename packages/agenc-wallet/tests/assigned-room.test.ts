import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AssignedRooms } from "../src/assigned-room.js";
import type { AgencWallet } from "../src/wallet.js";
import type { JobView } from "../src/client/types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const room = "c".repeat(64);
const owner = { role: "owner" as const, agentId: null };
const agent = { role: "agent" as const, agentId: "agent_1" };

function setup(generation: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "assigned-room-"));
  dirs.push(dir);
  const job = { id: "job_1", task: "T".repeat(32), parties: { workerRegistration: "W".repeat(32), claimedAt: 5, claimGeneration: generation } } as unknown as JobView;
  const session = { status: vi.fn(async () => ({ ok: "status" })) };
  const wallet = {
    getJob: vi.fn(async () => job),
    jobExchangeSession: vi.fn(async () => session),
    jobExchangeHistory: vi.fn(async () => []),
    collectJobOutput: vi.fn(async () => ({ text: "paid output" })),
  };
  return { rooms: new AssignedRooms(dir, "http://127.0.0.1:9"), job, wallet, session };
}

it("collects the verified output before any room lookup", async () => {
  const { rooms, wallet } = setup("1");
  // No room was ever assigned: collect still works and asks the wallet itself.
  expect(await rooms.dispatch(wallet as unknown as AgencWallet, agent, "job_1", { action: "collect" })).toEqual({ text: "paid output" });
  expect(wallet.collectJobOutput).toHaveBeenCalledWith("job_1", expect.anything(), "agent_1");
  expect(wallet.jobExchangeSession).not.toHaveBeenCalled();
  await expect(rooms.dispatch(wallet as unknown as AgencWallet, agent, "job_1", { action: "status" })).rejects.toThrow(/not been assigned/);
});

it("needs a fresh room assignment for a new claim generation", async () => {
  const { rooms, job, wallet } = setup("1");
  rooms.bind(job, room);
  expect(await rooms.dispatch(wallet as unknown as AgencWallet, owner, "job_1", { action: "status" })).toEqual({ ok: "status" });
  (job.parties as unknown as { claimGeneration: string }).claimGeneration = "2";
  await expect(rooms.dispatch(wallet as unknown as AgencWallet, owner, "job_1", { action: "status" })).rejects.toThrow(/not been assigned/);
});
