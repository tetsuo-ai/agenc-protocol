// Races between a signed buyer decision and the chain state it was quoted on,
// run on the stock revision 9 program and the frozen Lighthouse fixture.
import { expect, it } from "vitest";
import { lamports, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { facade, lighthouse, findAgentPda, findProtocolConfigPda, findClaimPda, findCreatorStatsPda, findWorkerStatsPda, findHireRecordPda, findTaskPda, getTaskDecoder,
  SubmissionStatus, TaskStatus, TaskType, type Transport } from "@tetsuo-ai/marketplace-sdk";
import { readProtocolConfig, readSubmission, readTask, sendApproval, sendChangesRequest, sendRejectAndFreeze } from "../src/market.js";
import { startSandbox } from "../src/sandbox.js";

const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const memo = (text: string): Instruction => ({ programAddress: MEMO, data: Buffer.from(text) });
const HASH = "55".repeat(32);

/** A creator-reviewed single-worker task with one delivery waiting, and a transport that can hold one send. */
async function reviewedTask() {
  let hold: (() => void) | null = null;
  let parked: (() => void) | null = null;
  let held!: Promise<void>;
  const transport = (base: Transport): Transport => ({ ...base, async sendAndConfirm(tx) {
    if (hold) {
      const signal = hold;
      hold = null;
      const gate = new Promise<void>(resolve => { parked = resolve; });
      signal();
      await gate;
    }
    return base.sendAndConfirm(tx);
  } });
  const sandbox = await startSandbox({ transport, followWallClock: false });
  const { market, chain, advanceClock } = sandbox;
  const creator = await market.fundedSigner();
  const worker = await market.fundedSigner();
  const { minAgentStake } = await readProtocolConfig(chain);
  const register = async (authority: KeyPairSigner, fill: number) => {
    const agentId = new Uint8Array(32).fill(fill);
    await chain.clientFor(authority).send([await facade.registerAgent({
      authority, agentId, capabilities: 1n, endpoint: `http://agent-${fill}.test`, metadataUri: null, stakeAmount: minAgentStake,
    })]);
    return (await findAgentPda({ agentId }))[0];
  };
  const creatorAgent = await register(creator, 11);
  const workerAgent = await register(worker, 22);
  const taskId = new Uint8Array(32).fill(33);
  const now = market.svm.getClock().unixTimestamp;
  const client = chain.clientFor(creator);
  await client.send([await facade.createTask({
    authority: creator, creator, creatorAgent, taskId, requiredCapabilities: 1n,
    description: new Uint8Array(64).fill(7, 0, 32), rewardAmount: 100_000_000n, maxWorkers: 1, deadline: now + 86_400n,
    taskType: TaskType.Exclusive, constraintHash: null, minReputation: 0, rewardMintArg: null,
  })]);
  const [task] = await findTaskPda({ creator: creator.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  await client.send([await facade.configureTaskValidation({
    task, creator, hireRecord, mode: 1, reviewWindowSecs: 3600n, validatorQuorum: 0, attestor: null,
  })]);
  const jobSpecHash = new Uint8Array(32).fill(44);
  await market.moderator.attestTask(task, jobSpecHash);
  await client.send([await facade.setTaskJobSpec({
    task, creator, jobSpecHash, jobSpecUri: "agenc://job-spec/sha256/money-races", moderator: market.moderator.address,
  })]);
  const [claim] = await findClaimPda({ task, bidder: workerAgent });
  const workerClient = chain.clientFor(worker);
  const take = async (round: string) => workerClient.send([
    await facade.claimTaskWithJobSpec({ task, worker: workerAgent, authority: worker, jobSpecHash }), memo(`claim ${round}`)]);
  const submit = async (round: string) => workerClient.send([await facade.submitTaskResult({
    task, worker: workerAgent, authority: worker, proofHash: Buffer.from(HASH, "hex"), resultData: new Uint8Array(64).fill(9),
  }), memo(`submit ${round}`)]);
  advanceClock(60);
  await take("first");
  advanceClock(60);
  await submit("first");
  const generation = () => readTask(chain, task).then(t => Buffer.from(t!.reserved).readBigUInt64LE(3).toString());
  const delivery = async () => ({ submissionCount: 1, deliveryHash: HASH, claimGeneration: await generation() });
  /** Park the next send until `release` runs; resolves once it is parked (signed). */
  const parkNext = () => { held = new Promise<void>(resolve => { hold = resolve; }); return held; };
  const release = () => { parked?.(); parked = null; };
  /** Change request, give-back and a fresh claim that delivers the same hash as a new round one. */
  const replaceClaim = async () => {
    await client.send([await facade.requestChanges({ task, claim, creator, changesHash: new Uint8Array(32).fill(70) }), memo("change")]);
    advanceClock(60);
    await workerClient.send([await facade.releaseClaim({ task, worker: workerAgent, creator: creator.address, authority: worker }), memo("release")]);
    advanceClock(60);
    await take("second");
    advanceClock(60);
    await submit("second");
    const replaced = await readSubmission(chain, task, workerAgent);
    expect(replaced?.account).toMatchObject({ status: SubmissionStatus.Submitted, submissionCount: 1 });
    expect(Buffer.from(replaced!.account.proofHash).toString("hex")).toBe(HASH);
  };
  return { sandbox, chain, market, creator, worker, workerAgent, task, claim, delivery, generation, parkNext, release, replaceClaim };
}

it.each(["approve", "change", "reject"] as const)("refuses a signed %s that lands on a replacement claim with the same round and hash", async action => {
  const t = await reviewedTask();
  const expected = await t.delivery();
  const parked = t.parkNext();
  const decision = (action === "approve" ? sendApproval(t.chain, t.creator, t.task, t.workerAgent, expected)
    : action === "change" ? sendChangesRequest(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(71), expected)
      : sendRejectAndFreeze(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(72), undefined, expected, 10n ** 9n))
    .then(() => null, (error: unknown) => error);
  await parked;
  await t.replaceClaim();
  expect(await t.generation()).not.toBe(expected.claimGeneration);
  const paidBefore = await t.chain.getBalance(t.worker.address);
  t.release();
  expect(await decision).toBeInstanceOf(Error);
  expect(await t.chain.getBalance(t.worker.address)).toBe(paidBefore);
  const after = await readSubmission(t.chain, t.task, t.workerAgent);
  expect(after?.account.status).toBe(SubmissionStatus.Submitted);
  expect((await readTask(t.chain, t.task))?.status).toBe(TaskStatus.PendingValidation);
  // The same decision for the replacement claim, quoted fresh, applies.
  const fresh = await t.delivery();
  if (action === "approve") await sendApproval(t.chain, t.creator, t.task, t.workerAgent, fresh);
  else if (action === "change") await sendChangesRequest(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(73), fresh);
  else await sendRejectAndFreeze(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(74), undefined, fresh, 10n ** 9n);
  const status = (await readTask(t.chain, t.task))?.status;
  expect(status).toBe(action === "approve" ? TaskStatus.Completed : action === "change" ? TaskStatus.InProgress : TaskStatus.RejectFrozen);
}, 60_000);

it("refuses a signed rejection when the record rent rises before it lands, and charges exactly the quote otherwise", async () => {
  const t = await reviewedTask();
  const svm = t.market.svm;
  const [record] = await findCreatorStatsPda({ authority: t.creator.address });
  expect(svm.getAccount(record).exists).toBe(false);
  // Keep the worker's existing record exempt at a higher rate, so only the new creator record depends on rent.
  svm.airdrop((await findWorkerStatsPda({ worker: t.workerAgent }))[0], lamports(1_000_000n));
  const quoted = await facade.missingRecordCost(async key => t.chain.readRawAccount(key), size => t.chain.getMinimumBalanceForRentExemption(size),
    { creator: t.creator.address, workerAgent: t.workerAgent });
  expect(quoted.lamports).toBeGreaterThan(0n);
  const expected = await t.delivery();
  // A rent rise after quoting but before signing is refused before anything is sent.
  const setRate = (delta: bigint) => { const rent = svm.getRent(); rent.lamportsPerByteYear += delta; svm.setRent(rent); };
  setRate(1n);
  const before = await t.chain.getBalance(t.creator.address);
  await expect(sendRejectAndFreeze(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(72), undefined, expected, quoted.lamports))
    .rejects.toThrow(/costs more|review it again/i);
  expect(await t.chain.getBalance(t.creator.address)).toBe(before);
  setRate(-1n);
  // A rise after signing fails in the transaction: only the network fee is spent.
  const parked = t.parkNext();
  const rejection = sendRejectAndFreeze(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(72), undefined, expected, quoted.lamports)
    .then(() => null, (error: unknown) => error);
  await parked;
  setRate(1n);
  t.release();
  expect(await rejection).toBeInstanceOf(Error);
  expect(before - await t.chain.getBalance(t.creator.address)).toBe(t.chain.transferFeeLamports);
  expect(svm.getAccount(record).exists).toBe(false);
  expect((await readTask(t.chain, t.task))?.status).toBe(TaskStatus.PendingValidation);
  setRate(-1n);
  // A top-up of the record address only lowers the shortfall: the rejection still lands, within the quote.
  svm.airdrop(record, lamports(1_000_000n));
  svm.expireBlockhash();
  const settled = await t.chain.getBalance(t.creator.address);
  const sent = await sendRejectAndFreeze(t.chain, t.creator, t.task, t.workerAgent, new Uint8Array(32).fill(72), undefined, expected, quoted.lamports);
  expect(sent.recordLamports).toBe(quoted.lamports - 1_000_000n);
  expect(settled - await t.chain.getBalance(t.creator.address)).toBe(quoted.lamports - 1_000_000n + t.chain.transferFeeLamports);
  expect((await readTask(t.chain, t.task))?.status).toBe(TaskStatus.RejectFrozen);
  const raw = svm.getAccount(t.task);
  if (raw.exists) expect(getTaskDecoder().decode(raw.data).status).toBe(TaskStatus.RejectFrozen);
}, 60_000);

it("evaluates the at-least checks as landing value at or above the bound", async () => {
  const { market, chain } = await startSandbox({ followWallClock: false });
  const payer = await market.fundedSigner();
  // A program-owned account, never a wallet key.
  const [target] = await findProtocolConfigPda();
  const now = Number(market.svm.getClock().unixTimestamp);
  const held = await chain.getBalance(target);
  const send = (ix: Instruction, tag: string) => chain.clientFor(payer).send([ix, memo(tag)]).then(() => true, () => false);
  expect(await send(lighthouse.assertClockAtLeast(now), "a")).toBe(true);
  expect(await send(lighthouse.assertClockAtLeast(now + 1), "b")).toBe(false);
  expect(await send(lighthouse.assertClockBefore(now + 1), "c")).toBe(true);
  expect(await send(lighthouse.assertLamportsAtLeast(target, held), "d")).toBe(true);
  expect(await send(lighthouse.assertLamportsAtLeast(target, held - 1n), "e")).toBe(true);
  expect(await send(lighthouse.assertLamportsAtLeast(target, held + 1n), "f")).toBe(false);
});
