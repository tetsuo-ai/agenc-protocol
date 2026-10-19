import { describe, expect, it } from "vitest";
import { lamports } from "@solana/kit";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcAgent, rpcPublish } from "./rpc-fixtures.js";

describe.skipIf(!RPC_ENABLED)(
  "#124: real funded tasks beyond the legacy u8 ceiling",
  () => {
    it("creates 256 tasks across two agents of one wallet, enforces N+1, and settles/refunds the funded work", async () => {
      const h = await localRpcHarness("issue-124-task-creation-quota");
      const surface = await sdk.getDeployedSurface(h.rpc);
      expect(surface.taskCreationQuotas).toBe(true);
      // Avoid crossing a real calendar-day boundary during the volume assertion.
      // Near midnight, wait for the next day; never warp Clock or inject counters.
      const waitStarted = Date.now();
      while ((await h.clock()) % 86400n > 84600n) await delay(1000);
      h.evidence.calendarBoundaryWaitMs = Date.now() - waitStarted;
      const wallet = await h.fundedSigner();
      const topup = await h.rpc
        .requestAirdrop(wallet.address, lamports(10_000_000_000n))
        .send();
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = (await h.rpc.getSignatureStatuses([topup]).send())
          .value[0];
        if (
          status &&
          ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
        ) {
          expect(status.err).toBeNull();
          break;
        }
        await delay(250);
      }
      expect(await h.balance(wallet.address)).toBeGreaterThan(10_000_000_000n);
      h.evidence.additionalLocalFaucetSignature = topup;
      const agents = [await rpcAgent(h, wallet), await rpcAgent(h, wallet)];
      const [legacy] = await sdk.findAuthorityRateLimitPda({
        authority: wallet.address,
      });
      const [quota] = await sdk.findTaskQuotaPda({
        taskAuthority: wallet.address,
      });
      const grant = (enabled = true, approvers = [h.admin, h.moderator]) =>
        sdk.facade.configureTaskCreationQuota({
          taskAuthority: wallet.address,
          maxTasksPer24h: 256,
          enabled,
          authority: h.admin,
          multisigSigners: approvers,
        });
      await h.reject(
        "one owner cannot grant extra capacity",
        h.admin,
        [await grant(true, [h.admin])],
        sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS,
      );
      expect(await h.info(quota)).toBeNull();
      await h.send(
        "set finite legacy daily cap and production minimum cooldown",
        h.admin,
        [
          await sdk.facade.updateRateLimits({
            authority: h.admin,
            multisigSigners: [h.admin, h.moderator],
            taskCreationCooldown: 1n,
            maxTasksPer24h: 255,
            disputeInitiationCooldown: h.config.disputeInitiationCooldown,
            maxDisputesPer24h: h.config.maxDisputesPer24h,
            minStakeForDispute: h.config.minStakeForDispute,
          }),
        ],
      );
      const reward = 1_000_000n;
      const build = async (
        agent: (typeof agents)[number],
        extended: boolean,
      ) => {
        const taskId = id32();
        const [task] = await sdk.findTaskPda({
          creator: agent.signer.address,
          taskId,
        });
        const [escrow] = await sdk.findEscrowPda({ task });
        const ix = await sdk.facade.createTask({
          taskId,
          creator: agent.signer,
          authority: agent.signer,
          creatorAgent: agent.agent,
          requiredCapabilities: 1n,
          description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
          rewardAmount: reward,
          maxWorkers: 1,
          deadline: (await h.clock()) + 3600n,
          taskType: 0,
          constraintHash: null,
          minReputation: 0,
          rewardMintArg: null,
          ...(extended ? { taskQuotaSurface: surface } : {}),
        });
        return { task, escrow, ix };
      };
      const waitCooldown = async () => {
        if (!(await h.info(legacy))) return;
        const last = (await h.read(legacy, sdk.getAuthorityRateLimitDecoder()))
          .lastTaskCreated;
        while ((await h.clock()) < last + 1n) await delay(100);
      };
      const jobs: Awaited<ReturnType<typeof build>>[] = [];
      for (let i = 0; i < 256; i++) {
        if (i === 10) {
          await h.send(
            "approve quota after ten actual legacy creations",
            h.admin,
            [await grant()],
          );
          expect(
            (await h.read(quota, sdk.getAuthorityTaskQuotaDecoder()))
              .taskCount24h,
          ).toBe(10);
          await waitCooldown();
          const first = await build(agents[0]!, true),
            second = await build(agents[1]!, true);
          const before = await h.balance(wallet.address);
          const failed = await h.reject(
            "same-wallet atomic batch shares one-second cooldown",
            wallet,
            [first.ix, second.ix],
            sdk.AGENC_COORDINATION_ERROR__COOLDOWN_NOT_ELAPSED,
          );
          expect(await h.balance(wallet.address)).toBe(
            before - failed.meta!.fee,
          );
          for (const job of [first, second]) {
            expect(await h.info(job.task)).toBeNull();
            expect(await h.info(job.escrow)).toBeNull();
          }
          expect(
            (await h.read(quota, sdk.getAuthorityTaskQuotaDecoder()))
              .taskCount24h,
          ).toBe(10);
        }
        await waitCooldown();
        if (i === 255) {
          const old = await build(agents[1]!, false);
          await h.reject(
            "legacy wire still stops at 255",
            wallet,
            [old.ix],
            sdk.AGENC_COORDINATION_ERROR__RATE_LIMIT_EXCEEDED,
          );
          expect(await h.info(old.task)).toBeNull();
        }
        const job = await build(
          agents[i % 2]!,
          i >= 10 && (i >= 20 || i % 2 === 0),
        );
        await h.send(
          `fund task ${i + 1} through shared wallet budget`,
          wallet,
          [job.ix],
        );
        expect((await h.read(job.task, sdk.getTaskDecoder())).status).toBe(
          sdk.TaskStatus.Open,
        );
        expect(
          (await h.read(job.escrow, sdk.getTaskEscrowDecoder())).amount,
        ).toBe(reward);
        jobs.push(job);
      }
      const used = await h.read(quota, sdk.getAuthorityTaskQuotaDecoder());
      expect(used.taskCount24h).toBe(256);
      const legacyState = await h.read(
        legacy,
        sdk.getAuthorityRateLimitDecoder(),
      );
      expect(legacyState.taskCount24h).toBe(255);
      expect(legacyState.disputeCount24h).toBe(0);
      for (const actor of agents) {
        await waitCooldown();
        const blocked = await build(actor, true);
        await h.reject(
          "N+1 fails for either agent",
          wallet,
          [blocked.ix],
          sdk.AGENC_COORDINATION_ERROR__RATE_LIMIT_EXCEEDED,
        );
        expect(await h.info(blocked.task)).toBeNull();
      }
      await h.send("disable grant without replenishment", h.admin, [
        await grant(false),
      ]);
      await h.send("re-enable grant without replenishment", h.admin, [
        await grant(true),
      ]);
      await h.reject(
        "disable/re-enable does not reset usage",
        wallet,
        [(await build(agents[0]!, true)).ix],
        sdk.AGENC_COORDINATION_ERROR__RATE_LIMIT_EXCEEDED,
      );
      expect(
        (await h.read(quota, sdk.getAuthorityTaskQuotaDecoder())).taskCount24h,
      ).toBe(256);

      const unrelated = await rpcAgent(h);
      const unrelatedJob = await build(unrelated, false);
      await h.send(
        "another wallet has an independent legacy allowance",
        unrelated.signer,
        [unrelatedJob.ix],
      );
      // Complete one actual moderated job after reaching the creation cap: exits
      // remain possible and the quota does not interfere with earned payouts.
      const worker = await rpcAgent(h),
        first = jobs[0]!;
      const spec = id32();
      await rpcPublish(h, first.task, wallet, spec);
      await h.send(
        "claim funded work after creator exhausted quota",
        worker.signer,
        [
          await sdk.facade.claimTaskWithJobSpec({
            task: first.task,
            worker: worker.agent,
            authority: worker.signer,
            moderationBlock: (
              await sdk.findModerationBlockPda({ contentHash: spec })
            )[0],
          }),
        ],
      );
      const treasuryBefore = await h.balance(h.config.treasury);
      await h.send("complete funded work", worker.signer, [
        await sdk.facade.completeTask({
          task: first.task,
          worker: worker.agent,
          authority: worker.signer,
          creator: wallet.address,
          treasury: h.config.treasury,
          proofHash: id32(),
          resultData: null,
        }),
      ]);
      expect((await h.read(first.task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.Completed,
      );
      expect(await h.balance(h.config.treasury)).toBe(
        treasuryBefore + (reward * BigInt(h.config.protocolFeeBps)) / 10000n,
      );
      // Refund the other 255 funded tasks through actual signed cancellation.
      for (let i = 1; i < jobs.length; i += 2) {
        const batch = jobs.slice(i, i + 2);
        let refundable = 0n;
        for (const job of batch)
          refundable += (await h.info(job.escrow))!.lamports;
        const before = await h.balance(wallet.address);
        const cancelled = await h.send(
          "refund unclaimed quota work",
          wallet,
          await Promise.all(
            batch.map((job) =>
              sdk.facade.cancelTask({
                task: job.task,
                authority: wallet,
                workerBondAuthority: wallet.address,
              }),
            ),
          ),
        );
        expect(await h.balance(wallet.address)).toBe(
          before + refundable - cancelled.meta!.fee,
        );
        for (const job of batch) expect(await h.info(job.escrow)).toBeNull();
      }
      await h.send("refund unrelated wallet's control task", unrelated.signer, [
        await sdk.facade.cancelTask({
          task: unrelatedJob.task,
          authority: unrelated.signer,
          workerBondAuthority: unrelated.signer.address,
        }),
      ]);
      expect(
        (await h.read(quota, sdk.getAuthorityTaskQuotaDecoder())).taskCount24h,
      ).toBe(256);
      await h.reject(
        "completion and refunds do not replenish creation allowance",
        wallet,
        [(await build(agents[1]!, true)).ix],
        sdk.AGENC_COORDINATION_ERROR__RATE_LIMIT_EXCEEDED,
      );
      await h.send(
        "restore local global rate controls and disable grant",
        h.admin,
        [
          await grant(false),
          await sdk.facade.updateRateLimits({
            authority: h.admin,
            multisigSigners: [h.admin, h.moderator],
            taskCreationCooldown: h.config.taskCreationCooldown,
            maxTasksPer24h: h.config.maxTasksPer24h,
            disputeInitiationCooldown: h.config.disputeInitiationCooldown,
            maxDisputesPer24h: h.config.maxDisputesPer24h,
            minStakeForDispute: h.config.minStakeForDispute,
          }),
        ],
      );
      h.evidence.assertions = {
        actualCreations: jobs.length,
        actualFundedLamports: BigInt(jobs.length) * reward,
        legacyAndExtendedBudgetShared: true,
        twoAgentsOneWallet: true,
        cooldownActuallyEnforced: true,
        nPlusOneRejected: true,
        noResetByToggle: true,
        unrelatedWalletIndependent: true,
        oneTaskCompletedAnd255Refunded: true,
        disputePolicyPreserved: true,
        noClockOrCounterInjection: true,
      };
      h.finish();
    }, 3_600_000);
  },
);
