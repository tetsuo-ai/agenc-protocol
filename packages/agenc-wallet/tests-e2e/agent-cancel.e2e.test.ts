// An agent connection cancels only what the agent paid for itself. A job the
// owner approved and the main balance paid is the owner's purchase: no agent
// credential makes the main key sign its cancel.
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { connectWallet, type WalletClient } from "../src/client/socket-client.js";
import { runMarketTool } from "../src/client/tools.js";
import { agentToken, serveWallet, type WalletServer } from "../src/server.js";
import { REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let w: World | undefined;
let server: WalletServer | undefined;
const clients: WalletClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
  await w?.wallet.close();
  server = undefined;
  w = undefined;
});

const TOKEN = "agent-cancel-owner-credential-0123456789";

async function serve(world: World, agentId: string) {
  const { wallet } = world;
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "agcn-")), "w.sock");
  server = await serveWallet({ wallet, socketPath, ownerToken: TOKEN, agentExists: id => wallet.hasAgent(id) });
  const agent = await connectWallet({ socketPath, token: agentToken(TOKEN, agentId), actAs: agentId });
  const owner = await connectWallet({ socketPath, token: TOKEN });
  clients.push(agent, owner);
  return { agent, owner };
}

const code = (error: unknown) => (error as { code: string }).code;

it("refuses an agent's cancel of a hire the main balance paid, and leaves it to the owner", async () => {
  w = await startWorld();
  const { wallet } = w;
  const a = await wallet.createAgent("A");
  const { agent, owner } = await serve(w, a.id);
  const asked = await agent.call("market.hire", { agentId: a.id, listing: w.listing, request: "A main-funded poem." });
  const job = await wallet.decideApproval(asked.approval!.id, true);
  expect(await w.balance(a.address)).toBe(0n);
  const funded = await w.balance(wallet.mainAddress);

  // The agent's own view does not offer the cancel; the owner's does.
  expect((await agent.call("jobs.get", { jobId: job.id })).job).toMatchObject({ status: "waiting", canRefund: false, approvalInMarket: true });
  expect((await owner.call("jobs.get", { jobId: job.id })).job.canRefund).toBe(true);

  await expect(agent.call("jobs.refund", { jobId: job.id })).rejects.toMatchObject({ code: "NOT_ALLOWED", message: expect.stringMatching(/Market/) });
  // The chat tool reaches the same refusal (a paired connection calls this table too).
  const tool = await runMarketTool(agent, a.id, "market_review", { job_id: job.id, action: "refund" });
  expect(tool.ok).toBe(false);
  // The wallet function itself refuses, with or without a named agent.
  await expect(wallet.refundJob(job.id, false, a.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  await expect(wallet.refundJob(job.id, false)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  for (let n = 0; n < 3; n++) await wallet.tick();
  expect(await w.balance(wallet.mainAddress)).toBe(funded);
  expect((await wallet.getJob(job.id, true)).status).toBe("waiting");

  // The owner still cancels it, and the price comes back to the main balance.
  const { job: cancelled } = await owner.call("jobs.refund", { jobId: job.id });
  expect(cancelled.status).toBe("refunded");
  expect(await w.balance(wallet.mainAddress)).toBeGreaterThan(funded);
  // Asking again as the agent stays refused and moves nothing.
  const after = await w.balance(wallet.mainAddress);
  await expect(agent.call("jobs.refund", { jobId: job.id })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect(await w.balance(wallet.mainAddress)).toBe(after);
});

it("refuses an agent's cancel of a request the main balance paid", async () => {
  w = await startWorld();
  const { wallet } = w;
  const a = await wallet.createAgent("A");
  const { agent, owner } = await serve(w, a.id);
  const asked = await agent.call("market.post", { agentId: a.id, request: "Draw a main-funded map.", reward: { usdCents: 50 } });
  const job = await wallet.decideApproval(asked.approval!.id, true);
  expect(await w.balance(a.address)).toBe(0n);
  const funded = await w.balance(wallet.mainAddress);
  expect((await agent.call("jobs.get", { jobId: job.id })).job.canRefund).toBe(false);
  await expect(agent.call("jobs.refund", { jobId: job.id })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  for (let n = 0; n < 3; n++) await wallet.tick();
  expect(await w.balance(wallet.mainAddress)).toBe(funded);
  expect((await owner.call("jobs.refund", { jobId: job.id })).job.status).toBe("refunded");
});

it("does not let another agent reach the job at all", async () => {
  w = await startWorld();
  const { wallet } = w;
  const a = await wallet.createAgent("A");
  const b = await wallet.createAgent("B");
  const { agent } = await serve(w, a.id);
  const asked = await agent.call("market.hire", { agentId: a.id, listing: w.listing, request: "A poem." });
  const job = await wallet.decideApproval(asked.approval!.id, true);
  const funded = await w.balance(wallet.mainAddress);
  expect(await wallet.refundJob(job.id, false, b.id).catch(code)).toBe("NOT_FOUND");
  expect(await w.balance(wallet.mainAddress)).toBe(funded);
});

it("still lets an agent withdraw its own pending ask", async () => {
  w = await startWorld();
  const { wallet } = w;
  const a = await wallet.createAgent("A");
  const { agent } = await serve(w, a.id);
  const before = await w.balance(wallet.mainAddress);
  const asked = await agent.call("market.hire", { agentId: a.id, listing: w.listing, request: "A poem to think over." });
  expect(asked.job.status).toBe("needs_approval");
  expect(asked.job.canRefund).toBe(true);
  const { job } = await agent.call("jobs.refund", { jobId: asked.job.id });
  expect(job.status).toBe("declined");
  expect(await w.balance(wallet.mainAddress)).toBe(before);
  await expect(wallet.decideApproval(asked.approval!.id, true)).resolves.toMatchObject({ status: "declined" });
  expect(await w.balance(wallet.mainAddress)).toBe(before);
});

it("still lets an agent cancel a job it paid itself, from its own balance", async () => {
  w = await startWorld();
  const { wallet } = w;
  const a = await wallet.createAgent("A");
  await wallet.setPolicy(a.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(a.id, { usdCents: 300 });
  const { agent } = await serve(w, a.id);
  const main = await w.balance(wallet.mainAddress);
  const hired = await agent.call("market.hire", { agentId: a.id, listing: w.listing, request: "A haiku." });
  expect(hired.approval).toBeNull();
  expect(hired.job).toMatchObject({ status: "waiting", canRefund: true });
  const paid = await w.balance(a.address);
  const { job } = await agent.call("jobs.refund", { jobId: hired.job.id });
  expect(job.status).toBe("refunded");
  expect(await w.balance(a.address)).toBeGreaterThan(paid);
  // The agent's own key signed and paid: the main balance did not move.
  expect(await w.balance(wallet.mainAddress)).toBe(main);
});
