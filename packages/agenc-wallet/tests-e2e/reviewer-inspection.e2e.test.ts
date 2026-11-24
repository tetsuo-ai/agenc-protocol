// The approving reviewer must be the one that read every byte of the current delivery.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { address } from "@solana/kit";
import { findClaimPda, findTaskSubmissionPda, getTaskSubmissionDecoder, getTaskSubmissionEncoder } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { deliveryChunkAck, type EvidenceChunk } from "../src/client/job-exchange.js";
import { connectWallet, type WalletClient } from "../src/client/socket-client.js";
import type { MethodResult } from "../src/client/protocol.js";
import { runMarketTool } from "../src/client/tools.js";
import { PRACTICE_SERVICES } from "../src/sandbox.js";
import { readTask } from "../src/market.js";
import { agentToken, serveWallet, type WalletServer } from "../src/server.js";
import { REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let world: World | undefined;
let server: WalletServer | undefined;
const clients: WalletClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  await world?.wallet.close();
  server = world = undefined;
});

/** An outside harness paired through the installed broker (one connection). */
function outside(invitation: MethodResult<"connections.invite">) {
  const pair = generateKeyPairSync("ed25519");
  const key = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return async (method: string, params: Record<string, unknown>) => {
    const socket = connect(invitation.socket);
    const input = createInterface({ input: socket });
    const lines = input[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value!);
    const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
    try {
      const probe = randomBytes(32).toString("base64url");
      send({ probe });
      const hello = await next();
      expect(verify(null, Buffer.from(JSON.stringify(["agenc.market.broker.v1", probe, hello.challenge])),
        createPublicKey({ key: Buffer.from(invitation.brokerKey, "base64"), format: "der", type: "spki" }),
        Buffer.from(hello.proof, "base64"))).toBe(true);
      const message = Buffer.from(JSON.stringify(["agenc.market.pair.v1", invitation.id, hello.challenge, key]));
      send({ id: invitation.id, key, code: invitation.code, signature: sign(null, message, pair.privateKey).toString("base64") });
      const auth = await next();
      if (!auth.ok) throw new Error(auth.error);
      send({ id: 1, method, params });
      const reply = await next();
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.result;
    } finally {
      input.close();
      socket.destroy();
    }
  };
}

async function open() {
  world = await startWorld();
  const ownerToken = randomBytes(32).toString("hex");
  const socketPath = join(world.dataDir, "sock", "wallet.sock");
  const w = world;
  server = await serveWallet({ wallet: w.wallet, ownerToken, socketPath, grantFile: join(w.dataDir, "connections.json"),
    agentExists: (id: string) => w.wallet.hasAgent(id) });
  const owner = await connectWallet({ socketPath, token: ownerToken });
  clients.push(owner);
  const chat = async (agentId: string) => {
    const c = await connectWallet({ socketPath, token: agentToken(ownerToken, agentId), actAs: agentId });
    clients.push(c);
    return c;
  };
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Buyer");
  const other = await wallet.createAgent("Other buyer");
  await wallet.fundAgent(agent.id, { usdCents: 900 });
  await wallet.setPolicy(agent.id, { askAboveCents: 500, refill: REVIEW_ALLOWANCE });
  const listing = await sandbox.addService(PRACTICE_SERVICES.find(service => service.picture)!);
  const { job } = await wallet.hire({ agentId: agent.id, request: "Draw the postcard.", listing });
  await sandbox.workOnce();
  const delivered = await wallet.getJob(job.id, true);
  expect(delivered.status).toBe("delivered");
  // Item 7: parties carry the stock task's claim generation (Task._reserved[3..11]).
  const account = await readTask(w.sandbox.chain, address(job.task!));
  expect(delivered.parties?.claimGeneration).toBe(Buffer.from(account!.reserved).readBigUInt64LE(3).toString());
  expect(delivered.parties?.claimGeneration).not.toBe("0");
  return { w, owner, chat, agent, other, job, delivered };
}

/** Read and acknowledge every listed part, the way chat's market_job does. */
async function inspectAll(client: WalletClient, jobId: string, parts: string[]) {
  for (const part of parts) {
    let offset = 0;
    for (;;) {
      const chunk = await client.call("jobs.readDeliveryChunk", { jobId, part, offset }) as EvidenceChunk;
      const { inspected } = await client.call("jobs.acknowledgeDeliveryChunk", { jobId, ack: await deliveryChunkAck(chunk) }) as { inspected: boolean };
      offset += Buffer.from(chunk.base64, "base64").length;
      if (offset >= chunk.totalBytes) { if (part === parts.at(-1)) expect(inspected).toBe(true); break; }
    }
  }
}

it("pays only the reviewer that read the current delivery itself, never a room import, another agent, another connection or a newer round", async () => {
  const { w, owner, chat, agent, other, job, delivered } = await open();
  const { wallet, sandbox } = w;
  const parts = ["text", ...delivered.result!.files.map(f => f.name)];
  const buyer = await chat(agent.id);
  const before = await w.balance(agent.address);
  const unpaid = async () => {
    expect(await w.balance(agent.address)).toBe(before);
    expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
  };
  const approve = async (client: WalletClient, quoteId: string) =>
    runMarketTool(client, agent.id, "market_review", { action: "approve", job_id: job.id, quote_id: quoteId });
  let quote = (await wallet.reviewRecord(job.id)).quote!;

  // 1. A room import is bound to a supplier job and its room grant (child-hire.e2e covers the real import).
  const [claim] = await findClaimPda({ task: address(job.task!), bidder: address(delivered.provider!) });
  await expect(wallet.readRoomImportEvidence(job.id,
    { kind: "room-import", parentTask: job.task!, sellerAgentId: agent.id, claimedAt: "1", roomId: "f".repeat(64) }, parts)).rejects.toThrow();

  // 2. Another agent can neither read nor approve.
  const stranger = await chat(other.id);
  await expect(stranger.call("jobs.readDeliveryChunk", { jobId: job.id, part: "text", offset: 0 })).rejects.toThrow();
  expect((await runMarketTool(stranger, other.id, "market_review", { action: "approve", job_id: job.id, quote_id: quote.id })).ok).toBe(false);
  await unpaid();

  // 3. The agent's own chat reads every byte. A different outside connection for the same agent still cannot approve.
  await inspectAll(buyer, job.id, parts);
  const invitation = await owner.call("connections.invite", { agentId: agent.id, project: "Outside", label: "Terminal", access: "trade" });
  const harness = outside(invitation);
  const outsideApproval = await harness("connections.tool", { name: "market_review", args: { action: "approve", job_id: job.id, quote_id: quote.id } });
  expect(outsideApproval.ok).toBe(false);
  await unpaid();

  // 4. A newer submission needs a fresh inspection of that round.
  const [pda] = await findTaskSubmissionPda({ claim });
  const original = sandbox.market.svm.getAccount(pda)!;
  if (!original.exists) throw new Error("Missing submission");
  const submission = getTaskSubmissionDecoder().decode(original.data);
  sandbox.market.svm.setAccount({ ...original, data: getTaskSubmissionEncoder().encode({ ...submission, submissionCount: submission.submissionCount + 1 }) } as never);
  const newer = (await wallet.reviewRecord(job.id)).quote!;
  expect(newer.submissionCount).toBe(quote.submissionCount + 1);
  expect((await approve(buyer, newer.id)).ok).toBe(false);
  await unpaid();
  sandbox.market.svm.setAccount(original as never);

  // 5. Stars without their rating quote pay nothing. With it, one payment and the rating lands.
  quote = (await wallet.reviewRecord(job.id)).quote!;
  const starsOnly = await runMarketTool(buyer, agent.id, "market_review", { action: "approve", job_id: job.id, quote_id: quote.id, rating: 5 });
  expect(starsOnly.ok).toBe(false);
  const ratingQuote = (starsOnly as { rating_quote?: { rating_quote_id: string } }).rating_quote!;
  expect(ratingQuote.rating_quote_id).toMatch(/^[a-f0-9-]{36}$|^[a-f0-9]{64}$/);
  await unpaid();
  const paid = await runMarketTool(buyer, agent.id, "market_review",
    { action: "approve", job_id: job.id, quote_id: quote.id, rating: 5, rating_quote_id: ratingQuote.rating_quote_id });
  expect(paid.ok).toBe(true);
  const settled = await wallet.getJob(job.id, true);
  expect(settled.status).toBe("paid");
  expect(settled.rating).toBe(5);
  const after = await w.balance(agent.address);
  expect(after).not.toBe(before);
  // A retry pays nothing more.
  await runMarketTool(buyer, agent.id, "market_review", { action: "approve", job_id: job.id, quote_id: quote.id });
  expect(await w.balance(agent.address)).toBe(after);
}, 90000);
