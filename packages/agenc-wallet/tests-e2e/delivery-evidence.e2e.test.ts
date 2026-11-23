import { address } from "@solana/kit";
import { findClaimPda, findTaskSubmissionPda, getTaskSubmissionDecoder, getTaskSubmissionEncoder } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { PRACTICE_SERVICES } from "../src/sandbox.js";
import { REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => world?.wallet.close());

it.each(["post", "hire"] as const)("inspects every byte of a %s on stock revision 9 and refuses corruption and a newer round", async kind => {
  let corrupt = false, unavailable = false;
  world = await startWorld({ services: service => ({ ...service,
    fetchFile: async hash => corrupt ? Buffer.from("wrong file") : service.fetchFile(hash),
    fetchResult: async input => unavailable ? null : service.fetchResult(input),
  }) });
  const { sandbox } = world;
  let wallet = world.wallet;
  const agent = await wallet.createAgent("Buyer");
  await wallet.fundAgent(agent.id, { usdCents: 900 });
  await wallet.setPolicy(agent.id, { askAboveCents: 500, refill: REVIEW_ALLOWANCE });
  const listing = await sandbox.addService(PRACTICE_SERVICES.find(service => service.picture)!);
  const { job } = kind === "hire" ? await wallet.hire({ agentId: agent.id, request: "Draw the postcard.", listing }) :
    await wallet.post({ agentId: agent.id, request: "Write one sentence.", reward: { usdCents: 30 } });
  await expect(wallet.jobExchange(job.id, "0".repeat(64))).rejects.toThrow();
  await sandbox.workOnce();
  const delivered = await wallet.getJob(job.id, true);
  const quote = (await wallet.reviewRecord(job.id)).quote!;
  const guard = () => wallet.requireDeliveryInspection(job.id, agent.id, quote.deliveryHash, quote.submissionCount);
  const balance = await world.balance(agent.address);
  await expect(guard()).rejects.toThrow();
  await expect(wallet.readDeliveryChunk(job.id, "other", "text", 0)).rejects.toThrow();
  await expect(wallet.readDeliveryChunk(job.id, agent.id, "text", 1)).rejects.toThrow();
  const text = await wallet.readDeliveryChunk(job.id, agent.id, "text", 0);
  expect(Buffer.from(text.base64, "base64").toString()).toEqual(delivered.result!.text);
  for (const file of delivered.result!.files) {
    await expect(guard()).rejects.toThrow();
    const chunk = await wallet.readDeliveryChunk(job.id, agent.id, file.name, 0);
    expect(chunk.totalBytes).toEqual(file.bytes);
  }
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  await guard();
  unavailable = true;
  await expect(guard()).rejects.toThrow();
  unavailable = false;
  if (kind === "hire") {
    corrupt = true;
    await expect(guard()).rejects.toThrow();
    corrupt = false;
  }
  const [claim] = await findClaimPda({ task: address(job.task!), bidder: address(delivered.provider!) });
  const [pda] = await findTaskSubmissionPda({ claim });
  const account = sandbox.market.svm.getAccount(pda)!;
  if (!account.exists) throw new Error("Missing submission");
  const submission = getTaskSubmissionDecoder().decode(account.data);
  sandbox.market.svm.setAccount({ ...account, data: getTaskSubmissionEncoder().encode({ ...submission, submissionCount: submission.submissionCount + 1 }) } as never);
  await expect(guard()).rejects.toThrow();
  expect(await world.balance(agent.address)).toBe(balance);
  expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
});
