import { expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { facade, findAgentPda, findTaskPda, findHireRecordPda, findClaimPda, findTaskSubmissionPda, getTaskClaimDecoder, getTaskDecoder, getTaskEncoder, TaskStatus, TaskType } from "@tetsuo-ai/marketplace-sdk";
import { readProtocolConfig } from "../src/market.js";
import { startSandbox } from "../src/sandbox.js";
import { readReviewHistory } from "../src/review-history.js";
import { reviewRpc } from "./review-rpc.js";

it.each(["collaborative", "no fixed deadline"] as const)("recovers the %s claim deadline after closure", async kind => {
  const history = reviewRpc();
  const { market, chain, advanceClock } = await startSandbox({ transport: history.transport, followWallClock: false });
  const { svm, admin } = market;
  const creator = await market.fundedSigner();
  const worker = await market.fundedSigner();
  const client = chain.clientFor(creator);
  const { minAgentStake } = await readProtocolConfig(chain);
  const register = async (authority: typeof creator, fill: number): Promise<Address> => {
    const agentId = new Uint8Array(32).fill(fill);
    await chain.clientFor(authority).send([
      await facade.registerAgent({
        authority,
        agentId,
        capabilities: 1n,
        endpoint: `http://agent-${fill}.test`,
        metadataUri: null,
        stakeAmount: minAgentStake,
      }),
    ]);
    return (await findAgentPda({ agentId }))[0];
  };
  const creatorAgent = await register(creator, 11);
  const workerAgent = await register(worker, 22);

  const taskId = new Uint8Array(32).fill(33);
  const now = svm.getClock().unixTimestamp;
  const terms = {
    authority: creator, creator, creatorAgent, taskId, requiredCapabilities: 1n,
    description: new Uint8Array(64).fill(7, 0, 32), rewardAmount: 100_000_000n,
    maxWorkers: 2, deadline: now + 3600n, taskType: TaskType.Collaborative,
    constraintHash: null, minReputation: 0, rewardMintArg: null,
  };
  let parentTask: Address | undefined;
  if (kind === "no fixed deadline") {
    const parentId = new Uint8Array(32).fill(34);
    [parentTask] = await findTaskPda({ creator: creator.address, taskId: parentId });
    await client.send([await facade.createTask({ ...terms, taskId: parentId })]);
    // Seed the completed dependency. The child, its claim and its receipts are all program-created.
    const raw = svm.getAccount(parentTask)!;
    if (!raw.exists) throw new Error("Missing parent");
    const data = Uint8Array.from(raw.data);
    data.set(getTaskEncoder().encode({ ...getTaskDecoder().decode(data), status: TaskStatus.Completed }));
    svm.setAccount({ ...raw, data } as never);
    await client.send([await facade.createDependentTask({ ...terms, deadline: 0n, parentTask, dependencyType: 1 })]);
  } else {
    await client.send([await facade.createTask(terms)]);
  }
  const [task] = await findTaskPda({ creator: creator.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  await client.send([
    await facade.configureTaskValidation({
      task,
      creator,
      hireRecord,
      mode: 1, // CreatorReview
      reviewWindowSecs: 3600n,
      validatorQuorum: 0,
      attestor: null,
    }),
  ]);
  const jobSpecHash = new Uint8Array(32).fill(44);
  await market.moderator.attestTask(task, jobSpecHash);
  await client.send([
    await facade.setTaskJobSpec({
      task,
      creator,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/accountable-review",
      moderator: market.moderator.address,
    }),
  ]);

  const [claim] = await findClaimPda({ task, bidder: workerAgent });
  const [submission] = await findTaskSubmissionPda({ claim });
  advanceClock(200);
  const takeClaim = (authority: typeof worker, agent: Address) => chain.clientFor(authority).claimTaskWithJobSpec({
    task, worker: agent, authority, jobSpecHash, ...(parentTask && { parentTask }),
  });
  const submit = (authority: typeof worker, agent: Address) => chain.clientFor(authority).submitTaskResult({
    task, worker: agent, authority, proofHash: new Uint8Array(32).fill(55), resultData: new Uint8Array(64).fill(9),
  });

  await takeClaim(worker, workerAgent);
  await submit(worker, workerAgent);
  await client.send([await facade.requestChanges({ task, claim, creator, changesHash: new Uint8Array(32).fill(70) })]);
  const taskDue = getTaskDecoder().decode((await chain.readAccount(task))!).deadline;
  const claimDue = getTaskClaimDecoder().decode((await chain.readAccount(claim))!).expiresAt;
  const revisedDeadline = 1000 * Number(taskDue > 0n && taskDue < claimDue ? taskDue : claimDue);
  expect(revisedDeadline).toBeGreaterThan(Number(now + 3600n) * 1000);
  if (kind === "collaborative") {
    // A second worker extends the shared task, but the first claim still expires at its own deadline.
    const peer = await market.fundedSigner();
    const peerAgent = await register(peer, 23);
    const [peerClaim] = await findClaimPda({ task, bidder: peerAgent });
    advanceClock(300);
    await takeClaim(peer, peerAgent);
    await submit(peer, peerAgent);
    await client.send([await facade.requestChanges({ task, claim: peerClaim, creator, changesHash: new Uint8Array(32).fill(71) })]);
    expect(getTaskDecoder().decode((await chain.readAccount(task))!).deadline).toBeGreaterThan(claimDue);
  }
  svm.expireBlockhash();
  await submit(worker, workerAgent);
  await client.send([await facade.acceptTaskResult({ task, worker: workerAgent, creator, treasury: admin.address, workerAuthority: worker.address, ...(parentTask && { dependencyParent: parentTask }) })]);
  expect(await chain.readAccount(submission)).toBeNull();
  expect(await chain.readAccount(claim)).toBeNull();
  const cold = await readReviewHistory(history.rpc, task, claim, undefined, undefined, async () => (await readProtocolConfig(chain)).maxClaimDuration);
  expect(cold.entries).toHaveLength(1);
  expect(cold.entries[0]?.action).toBe("change");
  expect(cold.entries[0]?.deadline).toBe(revisedDeadline);
  expect(cold.complete).toBe(true);
  const practice = await chain.reviewHistory!(task, claim);
  expect(practice.entries.find(entry => entry.action === "change")?.deadline).toBe(revisedDeadline);
});
