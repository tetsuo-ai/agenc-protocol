import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { ExchangeJournal, JobExchange, stagePrivateInputs, digest, bundleManifest, openBuyerOutput, protectOutput, requireHandoff } from "../src/private-inputs.js";
import { acceptImportReceipt, handoffView, importAndAcknowledge } from "../src/exchange-relay.js";
import { JobConversation } from "../src/job-conversation.js";
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const buyer = await generateKeyPairSigner(), worker = await generateKeyPairSigner();
  const parts = { buyer: buyer.address, authority: worker.address, task: (await generateKeyPairSigner()).address,
    worker: (await generateKeyPairSigner()).address, claim: (await generateKeyPairSigner()).address, generation: "1", claimedAt: "1234", room: "a".repeat(64) };
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
  parts.generation = "2"; // Same claimant, PDA, room and chain second.
  expect((await receive.announceKey()).payload).not.toBe(wk.payload);
  await expect(send.grant(requirement, parts, wk)).rejects.toThrow();
  await expect(send.inputs(requirement)).rejects.toThrow();
  await expect(receive.receiveBundle(packet, "inputs", requirement.commitment)).rejects.toThrow();
});

it("protects returned text, names and bytes and refuses a different public commitment", async () => {
  const { receive, send, file, bk, parts } = await setup();
  const bundle = { version: 1, salt: "f".repeat(64), text: "private return", files: [file] };
  const output = await protectOutput(receive, bundle, bk);
  expect(output.pointer).toMatch(/^agenc\.private-output\.v2:[a-f0-9]{64}$/);
  for (const term of [file.name, bundle.text, file.base64]) expect(JSON.stringify(output)).not.toContain(term);
  await expect(openBuyerOutput(send.journal, parts, "0".repeat(64), output.packet)).rejects.toThrow();
  await openBuyerOutput(send.journal, parts, digest(output.pointer), output.packet);
});

it.each(["compact", "UUID"])("resumes each question once and advances past a second %s question after restart", async format => {
  const messageId = () => format === "compact" ? taskThread.newExchangeId() : crypto.randomUUID();
  const { receive, send, worker, bk, wk, connect } = await setup();
  const deadline = 2000;
  const workerThread = new JobConversation(receive, deadline, () => 1000);
  const buyerThread = new JobConversation(send, deadline, () => 1000);
  const question = { kind: "question" as const, id: messageId(), body: "Which quarter?", parent: null };
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
  await buyerThread.ingest(2, answered);
  const next = { ...question, id: messageId(), body: "Which currency?" };
  const second = await restarted.send(next, bk);
  await buyerThread.ingest(3, second);
  expect((await buyerThread.view()).waiting?.question).toBe(next.id);
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

it("stages eight full-size files through bounded owner requests and binds the final set to the same consent", async () => {
  const { send, receive, parts, wk } = await setup();
  const { stageInputSelection } = await import("../src/client/job-exchange.js");
  const bytes = Buffer.alloc(256 * 1024, 37);
  const files = Array.from({ length: 8 }, (_, i) => ({
    name: i + ".csv", bytes: bytes.length, base64: bytes.toString("base64"), sha256: digest(bytes),
  }));
  const consent = "Only the report room.";
  const calls: number[] = [];
  const approved = await stageInputSelection(files, async input => {
    calls.push(Buffer.byteLength(JSON.stringify(input)));
    return stagePrivateInputs(send.journal, input, parts.authority, consent);
  });
  expect(calls).toHaveLength(9);
  expect(Math.max(...calls)).toBeLessThan(1024 * 1024);
  await send.grant(approved, parts, wk);
  const bundle = await receive.receiveBundle(await send.inputs(approved), "inputs", approved.commitment);
  expect(bundle.files.map(f => f.name)).toEqual(files.map(f => f.name));
  const one = stagePrivateInputs(send.journal, [files[0]!], parts.authority, consent);
  const ref = { stagedCommitment: one.commitment };
  expect(() => stagePrivateInputs(send.journal, [ref], null, consent)).toThrow();
  expect(() => stagePrivateInputs(send.journal, [ref], parts.authority, "Different model")).toThrow();
  expect(() => stagePrivateInputs(send.journal, [ref, ref], parts.authority, consent)).toThrow();
});

it("pages persisted conversations by entry and claim within the wallet frame", async () => {
  const { send, parts } = await setup();
  const { localExchangeHistory, rememberExchange } = await import("../src/exchange-history.js");
  const entries = Array.from({ length: 34 }, (_, i) => ({ author: parts.buyer,
    message: { kind: "progress", parent: null, id: i.toString(16).padStart(32, "0"), body: "\u0001".repeat(8000) } }));
  for (const claimedAt of ["99", parts.claimedAt]) {
    const party = { ...parts, claimedAt };
    rememberExchange(send.journal, "job", party);
    send.journal.write("thread/" + taskThread.exchangeContext(party), { entries, cursor: 35, waiting: null, deadline: 2000 });
  }
  const [last] = localExchangeHistory(send.journal, "job", parts.task);
  expect(last!.entries).toEqual(entries.slice(18));
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(1024 * 1024);
  const [earlier] = localExchangeHistory(send.journal, "job", parts.task, last!.contextIndex, last!.beforeEntry!);
  expect(earlier!.entries).toEqual(entries.slice(2,18));
  expect(localExchangeHistory(send.journal, "job", parts.task, last!.previousContext!)[0]!.parties.claimedAt).toBe("99");
});

it("opens an exact paid v1 output with its original key without reactivating its grant", async () => {
  const { openLegacyBuyerOutput } = await import("../src/private-inputs.js");
  const archived = JSON.parse(readFileSync(new URL("./fixtures/paid-exchange-v1.json", import.meta.url), "utf8"));
  const { pointer, key, packet, parties } = archived;
  const { send } = await setup();
  expect((await openLegacyBuyerOutput(send.journal, parties, pointer, key, packet)).text).toBe("Paid archive fixture");
  await expect(openLegacyBuyerOutput(send.journal, parties, pointer, key, { ...packet, signature: "" })).rejects.toThrow();
  await expect(openLegacyBuyerOutput(send.journal, parties, pointer + "0", key, packet)).rejects.toThrow();
  expect(() => taskThread.exchangeContext(parties)).toThrow();
});
