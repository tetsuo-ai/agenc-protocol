import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcPublish } from "./rpc-fixtures.js";

describe.skipIf(!RPC_ENABLED)(
  "review clock cancellation through SDK -> RPC",
  () => {
    it("supplies writable review config, records elapsed debt, and restores creator review", async () => {
      const h = await localRpcHarness("review-clock-debt-cancel");
      async function actor() {
        const signer = await h.fundedSigner();
        const agentId = id32();
        const [agent] = await sdk.findAgentPda({ agentId });
        await h.send("register actor", signer, [
          await sdk.facade.registerAgent({
            authority: signer,
            agentId,
            capabilities: 1n,
            endpoint: "https://example.invalid/review-clock",
            metadataUri: null,
            stakeAmount:
              h.config.minAgentStake + 2n * h.config.minStakeForDispute,
          }),
        ]);
        return { signer, agent };
      }
      const creator = await actor();
      const worker = await actor();
      const taskId = id32();
      const [task] = await sdk.findTaskPda({
        creator: creator.signer.address,
        taskId,
      });
      const [validation] = await sdk.findTaskValidationConfigPda({ task });
      const spec = id32();
      await h.send("fund review task", creator.signer, [
        await sdk.facade.createTask({
          taskId,
          creator: creator.signer,
          authority: creator.signer,
          creatorAgent: creator.agent,
          requiredCapabilities: 1n,
          description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
          rewardAmount: 4_000_000n,
          maxWorkers: 1,
          deadline: (await h.clock()) + 86400n,
          taskType: 0,
          constraintHash: null,
          minReputation: 0,
          rewardMintArg: null,
        }),
      ]);
      await h.send("configure review", creator.signer, [
        await sdk.facade.configureTaskValidation({
          task,
          creator: creator.signer,
          mode: 1,
          reviewWindowSecs: 3600n,
          validatorQuorum: 0,
          attestor: null,
        }),
      ]);
      await rpcPublish(h, task, creator.signer, spec);
      const [moderationBlock] = await sdk.findModerationBlockPda({
        contentHash: spec,
      });
      await h.send("claim", worker.signer, [
        await sdk.facade.claimTaskWithJobSpec({
          task,
          worker: worker.agent,
          authority: worker.signer,
          moderationBlock,
        }),
      ]);
      const [claim] = await sdk.findClaimPda({ task, bidder: worker.agent });
      const [submission] = await sdk.findTaskSubmissionPda({ claim });
      await h.send("submit", worker.signer, [
        await sdk.facade.submitTaskResult({
          task,
          worker: worker.agent,
          authority: worker.signer,
          proofHash: id32(),
          resultData: new Uint8Array(64).fill(1),
        }),
      ]);
      const disputeId = id32();
      const [dispute] = await sdk.findDisputePda({ disputeId });
      await h.send("worker disputes", worker.signer, [
        await sdk.facade.initiateDispute({
          task,
          disputeId,
          taskId,
          agent: worker.agent,
          authority: worker.signer,
          initiatorClaim: claim,
          taskSubmission: submission,
          evidenceHash: id32(),
          evidence: "local review-clock regression",
          resolutionType: 1,
        }),
      ]);
      const opened = await h.read(dispute, sdk.getDisputeDecoder());
      const watchdog = Date.now() + 15000;
      while ((await h.clock()) < opened.createdAt + 2n) {
        if (Date.now() > watchdog)
          throw new Error("local clock did not advance");
        await delay(250);
      }
      await h.send("cancel via SDK with review config", worker.signer, [
        await sdk.facade.cancelDispute({
          task,
          dispute,
          authority: worker.signer,
          defendant: worker.agent,
          taskValidationConfig: validation,
        }),
      ]);
      const closed = await h.read(dispute, sdk.getDisputeDecoder());
      const config = await h.read(
        validation,
        sdk.getTaskValidationConfigDecoder(),
      );
      expect(Buffer.from(config.reserved).readUInt32LE(3)).toBe(
        Number(closed.resolvedAt - opened.createdAt),
      );
      expect((await h.read(task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.PendingValidation,
      );
      await h.send("creator rejects after resumed review", creator.signer, [
        await sdk.facade.rejectTaskResult({
          task,
          claim,
          worker: worker.agent,
          creator: creator.signer,
          workerAuthority: worker.signer.address,
          rejectionHash: id32(),
        }),
      ]);
      expect((await h.read(task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.Open,
      );
      h.finish();
    }, 120000);
  },
);
