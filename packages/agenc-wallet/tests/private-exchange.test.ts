import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { ExchangeJournal, JobExchange, stagePrivateInputs, digest, bundleManifest, collectOutput, protectOutput, requireHandoff } from "../src/private-inputs.js";
import { acceptImportReceipt, handoffView, importAndAcknowledge } from "../src/exchange-relay.js";
import { JobConversation } from "../src/job-conversation.js";
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const buyer = await generateKeyPairSigner(), worker = await generateKeyPairSigner();
  const parts = { buyer: buyer.address, authority: worker.address, task: (await generateKeyPairSigner()).address,
    worker: (await generateKeyPairSigner()).address, claim: (await generateKeyPairSigner()).address, claimedAt: "1234", room: "a".repeat(64) };
  const dir = mkdtempSync(join(tmpdir(), "job-exchange-"));
  roots.push(dir);
  const connect = async (signer: typeof buyer) => new JobExchange(await ExchangeJournal.open(dir, signer), signer, async () => ({ ...parts }));
  const send = await connect(buyer), receive = await connect(worker);
  const bytes = Buffer.from("Customer supplied private amounts");
  const file = { name: "sales.csv", bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString("base64") };
  const requirement = stagePrivateInputs(send.journal, [file], worker.address, "The room model may read these rows.");
  const [bk, wk] = await Promise.all([send.announceKey(), receive.announceKey()]);
  return { buyer, worker, parts, send, receive, connect, dir, file, requirement, bk, wk };
}

it("stages only approved bytes, requires the selected confirmed claim and room, and retries offline with the original ciphertext", async () => {
  const { buyer, parts, send, receive, connect, dir, file, requirement, bk, wk } = await setup();
  expect(Object.keys(requirement).sort()).toEqual(["commitment", "required", "version"]);
  expect(() => requireHandoff(requirement, false)).toThrow();
  await expect(send.inputs(requirement)).rejects.toThrow();
  await expect(send.grant(requirement, { ...parts, claimedAt: "1233" }, wk)).rejects.toThrow();
  await send.grant(requirement, parts, wk);
  const packet = await send.inputs(requirement);
  expect(await (await connect(buyer)).inputs(requirement)).toEqual(packet);
  expect((await receive.receiveBundle(packet, "inputs", requirement.commitment)).files).toEqual([file]);
  const received = await importAndAcknowledge(receive, requirement, packet, bk, async bundle => ({
    room: parts.room, version: bundle.version, manifest: bundleManifest(bundle), commitment: requirement.commitment,
  }));
  expect(await acceptImportReceipt(send, requirement, received.ack)).toEqual(received.receipt);
  expect(await handoffView(send, requirement, 123)).toEqual(await handoffView(receive, requirement, 123));
  await importAndAcknowledge(receive, requirement, packet, bk, async () => { throw Error("duplicate import"); });
  for (const path of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (path.isFile()) {
      const raw = readFileSync(join(path.parentPath, path.name));
      for (const secret of [file.name, file.base64, "Customer supplied"]) expect(raw.includes(secret)).toBe(false);
    }
  }
  parts.claimedAt = "1240";
  await expect(send.inputs(requirement)).rejects.toThrow();
  await expect(receive.receiveBundle(packet, "inputs", requirement.commitment)).rejects.toThrow();
});

it("protects returned text, names and bytes and refuses a different public commitment", async () => {
  const { receive, send, file, bk } = await setup();
  const bundle = { version: 1, salt: "f".repeat(64), text: "private return", files: [file] };
  const output = await protectOutput(receive, bundle, bk);
  expect(output.pointer).toMatch(/^agenc\.private-output\.v1:[a-f0-9]{64}$/);
  for (const term of [file.name, bundle.text, file.base64]) expect(JSON.stringify(output)).not.toContain(term);
  await expect(collectOutput(send, "0".repeat(64), output.packet)).rejects.toThrow();
  await collectOutput(send, bundleManifest(bundle), output.packet);
});

it("parks a question through restart, ingests ordered authenticated replies, and enqueues one continuation under the original deadline", async () => {
  const { receive, send, worker, bk, wk, connect } = await setup();
  const deadline = 2000;
  const workerThread = new JobConversation(receive, deadline, () => 1000);
  const buyerThread = new JobConversation(send, deadline, () => 1000);
  const question = { kind: "question" as const, id: taskThread.newExchangeId(), body: "Which quarter?", parent: null };
  const posted = await workerThread.send(question, bk);
  await buyerThread.ingest(1, posted);
  await workerThread.ingest(1, posted);
  const restarted = new JobConversation(await connect(worker), 9999, () => 1001);
  expect((await restarted.view()).waiting?.question).toBe(question.id);
  expect(await restarted.resume(async () => { throw Error("model ran while parked"); })).toBe(false);
  const reply = { kind: "reply" as const, id: taskThread.newExchangeId(), body: "First quarter.", parent: question.id };
  const answered = await buyerThread.send(reply, wk);
  await expect(restarted.ingest(3, answered)).rejects.toThrow();
  await restarted.ingest(2, answered);
  await restarted.ingest(2, answered);
  const runs = new Set<string>();
  await expect(restarted.resume(async id => { runs.add(id); throw Error("lost durable queue acknowledgement"); })).rejects.toThrow();
  await restarted.resume(async (id, body, due) => { runs.add(id); expect(body).toBe(reply.body); expect(due).toBe(deadline); });
  expect(runs.size).toBe(1);
  expect(await restarted.resume(async () => { throw Error("duplicate"); })).toBe(false);
  const expired = new JobConversation(receive, deadline, () => deadline);
  await expect(expired.send({ ...question, id: taskThread.newExchangeId() }, bk)).rejects.toThrow(/deadline/);
});

it("refuses unsafe paths, modified bytes, unapproved recipients and substituted keys", async () => {
  const { file, send, receive, parts, requirement, wk } = await setup();
  for (const changed of [{ ...file, name: "../escape" }, { ...file, bytes: 1 }, { ...file, sha256: "0".repeat(64) }]) {
    expect(() => stagePrivateInputs(send.journal, [changed], null, "room")).toThrow();
  }
  const wrong = stagePrivateInputs(send.journal, [file], parts.buyer, "room");
  await expect(send.grant(wrong, parts, wk)).rejects.toThrow();
  await expect(send.grant(requirement, parts, { ...wk, payload: (await send.announceKey()).payload })).rejects.toThrow();
  await send.grant(requirement, parts, wk);
  const packet = await send.inputs(requirement);
  await expect(receive.receiveBundle({ ...packet, payload: packet.payload + " " }, "inputs", requirement.commitment)).rejects.toThrow();
});
