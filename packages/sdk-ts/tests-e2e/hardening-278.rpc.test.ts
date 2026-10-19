import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcAgent, rpcListing, rpcPublish } from "./rpc-fixtures.js";

describe.skipIf(!RPC_ENABLED)(
  "#278: protocol hardening through SDK -> RPC",
  () => {
    it("preserves funded listing capacity and lets suspended workers settle existing work", async () => {
      const h = await localRpcHarness("issue-278-capacity-suspension");
      const provider = await rpcAgent(h);
      const buyers = [await rpcAgent(h), await rpcAgent(h), await rpcAgent(h)];
      const l = await rpcListing(h, provider, { maxOpenJobs: 3 });
      const unchanged = {
        price: null,
        specHash: null,
        specUri: null,
        tags: null,
        requiredCapabilities: null,
        defaultDeadlineSecs: null,
        operator: null,
        operatorFeeBps: null,
      };
      async function hire(index: number) {
        const buyer = buyers[index]!;
        const taskId = id32();
        const [task] = await sdk.findTaskPda({
          creator: buyer.signer.address,
          taskId,
        });
        const [escrow] = await sdk.findEscrowPda({ task });
        const [hireRecord] = await sdk.findHireRecordPda({ task });
        const listing = await h.read(l.listing, sdk.getServiceListingDecoder());
        const common = {
          taskId,
          creator: buyer.signer,
          listing: l.listing,
          providerAgent: provider.agent,
          expectedPrice: l.price,
          expectedVersion: listing.version,
          listingSpecHash: l.spec,
          taskJobSpecHash: l.spec,
          moderator: h.moderator.address,
        };
        const ix =
          index === 0
            ? await sdk.facade.hireFromListingHumanless({
                ...common,
                reviewWindowSecs: 3600n,
              })
            : await sdk.facade.hireFromListing({
                ...common,
                authority: buyer.signer,
                creatorAgent: buyer.agent,
              });
        return { task, escrow, hireRecord, buyer, ix };
      }
      const first = await hire(0);
      const second = await hire(1);
      for (const job of [first, second])
        await h.send("fund hire", job.buyer.signer, [job.ix]);
      const before = await h.info(l.listing);
      await h.reject(
        "capacity below funded jobs",
        provider.signer,
        [
          await sdk.facade.updateServiceListing({
            ...unchanged,
            listing: l.listing,
            providerAgent: provider.agent,
            authority: provider.signer,
            maxOpenJobs: 1,
            price: l.price + 1000n,
          }),
        ],
        sdk.AGENC_COORDINATION_ERROR__LISTING_CAPACITY_BELOW_OPEN_JOBS,
      );
      expect(await h.info(l.listing)).toEqual(before);
      await h.send("capacity equal to outstanding jobs", provider.signer, [
        await sdk.facade.updateServiceListing({
          ...unchanged,
          listing: l.listing,
          providerAgent: provider.agent,
          authority: provider.signer,
          maxOpenJobs: 2,
        }),
      ]);
      await h.reject(
        "finite capacity still enforces full listing",
        buyers[2]!.signer,
        [(await hire(2)).ix],
        sdk.AGENC_COORDINATION_ERROR__LISTING_CAPACITY_REACHED,
      );
      await h.send("zero retains unlimited sentinel", provider.signer, [
        await sdk.facade.updateServiceListing({
          ...unchanged,
          listing: l.listing,
          providerAgent: provider.agent,
          authority: provider.signer,
          maxOpenJobs: 0,
        }),
      ]);
      const third = await hire(2);
      await h.send(
        "hire succeeds after unlimited capacity",
        third.buyer.signer,
        [third.ix],
      );
      const [block] = await sdk.findModerationBlockPda({ contentHash: l.spec });
      for (const job of [first, second])
        await rpcPublish(h, job.task, job.buyer.signer, l.spec);
      await h.send("claim before suspension", provider.signer, [
        await sdk.facade.claimTaskWithJobSpec({
          task: first.task,
          worker: provider.agent,
          authority: provider.signer,
          moderationBlock: block,
        }),
      ]);
      await h.send("suspend worker", h.admin, [
        await sdk.facade.suspendAgent({
          agent: provider.agent,
          authority: h.admin,
        }),
      ]);
      await h.reject(
        "suspended worker cannot take another claim",
        provider.signer,
        [
          await sdk.facade.claimTaskWithJobSpec({
            task: second.task,
            worker: provider.agent,
            authority: provider.signer,
            moderationBlock: block,
          }),
        ],
        sdk.AGENC_COORDINATION_ERROR__AGENT_NOT_ACTIVE,
      );
      await h.send("suspended worker submits in-flight work", provider.signer, [
        await sdk.facade.submitTaskResult({
          task: first.task,
          worker: provider.agent,
          authority: provider.signer,
          proofHash: id32(),
          resultData: null,
        }),
      ]);
      const [claim] = await sdk.findClaimPda({
        task: first.task,
        bidder: provider.agent,
      });
      const [submission] = await sdk.findTaskSubmissionPda({ claim });
      const rent =
        (await h.info(claim))!.lamports + (await h.info(submission))!.lamports;
      const workerBefore = await h.balance(provider.signer.address);
      const treasuryBefore = await h.balance(h.config.treasury);
      const task = await h.read(first.task, sdk.getTaskDecoder());
      const fee = (l.price * BigInt(task.protocolFeeBps)) / 10_000n;
      await h.send(
        "settle suspended worker's existing claim",
        first.buyer.signer,
        [
          await sdk.facade.acceptTaskResult({
            task: first.task,
            worker: provider.agent,
            creator: first.buyer.signer,
            workerAuthority: provider.signer.address,
            treasury: h.config.treasury,
            hireRecord: first.hireRecord,
          }),
        ],
      );
      expect(await h.balance(provider.signer.address)).toBe(
        workerBefore + l.price - fee + rent,
      );
      expect(await h.balance(h.config.treasury)).toBe(treasuryBefore + fee);
      expect(
        (await h.read(provider.agent, sdk.getAgentRegistrationDecoder()))
          .status,
      ).toBe(sdk.AgentStatus.Suspended);
      expect((await h.read(first.task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.Completed,
      );
      for (const job of [second, third]) {
        const deposit = (await h.info(job.escrow))!.lamports;
        const buyerBefore = await h.balance(job.buyer.signer.address);
        const cancelled = await h.send(
          "refund unclaimed hire",
          job.buyer.signer,
          [
            await sdk.facade.cancelTask({
              task: job.task,
              authority: job.buyer.signer,
              workerBondAuthority: provider.signer.address,
            }),
          ],
        );
        expect(await h.balance(job.buyer.signer.address)).toBe(
          buyerBefore + deposit - cancelled.meta!.fee,
        );
      }
      for (const job of [first, second, third]) {
        await h.send("release listing capacity", job.buyer.signer, [
          await sdk.facade.closeTask({
            task: job.task,
            authority: job.buyer.signer,
            listing: l.listing,
            hireRecord: job.hireRecord,
            taskJobSpec: job === third ? null : undefined,
            creatorCompletionBond: (
              await sdk.findCreatorCompletionBondPda({
                task: job.task,
                creator: job.buyer.signer.address,
              })
            )[0],
          }),
        ]);
      }
      expect(
        (await h.read(l.listing, sdk.getServiceListingDecoder())).openJobs,
      ).toBe(0);
      h.evidence.assertions = {
        finiteCapacityRollback: true,
        unlimitedSentinelPreserved: true,
        suspendedEntryRejected: true,
        suspendedWorkPaid: true,
        depositsAndCapacityRecovered: true,
      };
      h.finish();
    }, 120_000);

    it("bounds reordered demotion/promotion and preserves the real five-minute acceptance grace", async () => {
      const h = await localRpcHarness("issue-278-bid-reordering");
      const creator = await rpcAgent(h);
      const bidders = [await rpcAgent(h), await rpcAgent(h), await rpcAgent(h)];
      const crank = await h.fundedSigner();
      const taskId = id32();
      const [task] = await sdk.findTaskPda({
        creator: creator.signer.address,
        taskId,
      });
      await h.send("fund bid task", creator.signer, [
        await sdk.facade.createTask({
          taskId,
          creator: creator.signer,
          authority: creator.signer,
          creatorAgent: creator.agent,
          requiredCapabilities: 1n,
          description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
          rewardAmount: 4_000_000n,
          maxWorkers: 1,
          deadline: (await h.clock()) + 3600n,
          taskType: 3,
          constraintHash: null,
          minReputation: 0,
          rewardMintArg: null,
        }),
      ]);
      const jobHash = id32();
      await rpcPublish(h, task, creator.signer, jobHash);
      await h.send("initialize lowest-price book", creator.signer, [
        await sdk.facade.initializeBidBook({
          task,
          creator: creator.signer,
          policy: 0,
          priceWeightBps: 0,
          etaWeightBps: 0,
          confidenceWeightBps: 0,
          reliabilityWeightBps: 0,
        }),
      ]);
      const [bidBook] = await sdk.findBidBookPda({ task });
      const [jobSpec] = await sdk.findTaskJobSpecPda({ task });
      const job = await h.read(jobSpec, sdk.getTaskJobSpecDecoder());
      const bids = [];
      for (const [index, bidder] of bidders.entries()) {
        const [bid] = await sdk.findBidPda({ task, bidder: bidder.agent });
        const [market] = await sdk.findBidderMarketStatePda({
          bidder: bidder.agent,
        });
        await h.send("place bonded bid", bidder.signer, [
          await sdk.facade.createBid({
            task,
            bidder: bidder.agent,
            authority: bidder.signer,
            requestedRewardLamports: BigInt(index + 1) * 1_000_000n,
            etaSeconds: 900,
            confidenceBps: 5000,
            qualityGuaranteeHash: id32(),
            metadataHash: id32(),
            expiresAt: (await h.clock()) + 1800n,
            expectedJobSpecHash: jobHash,
            expectedJobSpecUpdatedAt: job.updatedAt,
          }),
        ]);
        bids.push({ ...bidder, bid, market });
      }
      const [best, middle, worst] = bids as [
        (typeof bids)[number],
        (typeof bids)[number],
        (typeof bids)[number],
      ];
      const book = () => h.read(bidBook, sdk.getTaskBidBookDecoder());
      const promote = (bid: typeof best) =>
        sdk.facade.promoteBid({ task, bidder: bid.agent, authority: crank });
      const demote = (bid: typeof best) =>
        sdk.facade.demoteIneligibleBest({
          task,
          bidder: bid.agent,
          authority: crank,
        });
      async function accept(bid: typeof best) {
        const stored = await h.read(bid.bid, sdk.getTaskBidDecoder());
        return sdk.facade.acceptBid({
          task,
          bidder: bid.agent,
          creator: creator.signer,
          jobSpecHash: jobHash,
          expectedBidTermsHash: await sdk.facade.calculateBidTermsHash({
            ...stored,
            task,
            bid: bid.bid,
            bidTask: stored.task,
            jobSpecHash: jobHash,
            jobSpecUpdatedAt: job.updatedAt,
            qualityGuaranteeHash: new Uint8Array(stored.qualityGuaranteeHash),
            metadataHash: new Uint8Array(stored.metadataHash),
          }),
        });
      }
      expect((await book()).bestBid).toBe(best.bid);
      await h.reject(
        "eligible leader cannot be demoted",
        crank,
        [await demote(best)],
        sdk.AGENC_COORDINATION_ERROR__BID_WINNER_STILL_ELIGIBLE,
      );
      await h.send("make current leader ineligible", h.admin, [
        await sdk.facade.suspendAgent({
          agent: best.agent,
          authority: h.admin,
        }),
      ]);
      await h.reject(
        "ineligible leader cannot be accepted",
        creator.signer,
        [await accept(best)],
        sdk.AGENC_COORDINATION_ERROR__AGENT_NOT_ACTIVE,
      );
      await h.reject(
        "promotion before stale-leader demotion",
        crank,
        [await promote(middle)],
        sdk.AGENC_COORDINATION_ERROR__BID_NOT_BETTER_THAN_TRACKED_BEST,
      );
      await h.send("permissionless demotion", crank, [await demote(best)]);
      const graceStarted = (await book()).winnerStaleSince;
      await h.reject(
        "duplicate demotion cannot restart grace",
        crank,
        [await demote(best)],
        sdk.AGENC_COORDINATION_ERROR__BID_NOT_BOOK_BEST,
      );
      await h.send("worse contender arrives first", crank, [
        await promote(worst),
      ]);
      await h.send("better contender repairs order", crank, [
        await promote(middle),
      ]);
      await h.reject(
        "stale contender cannot demote current winner",
        crank,
        [await demote(best)],
        sdk.AGENC_COORDINATION_ERROR__BID_NOT_BOOK_BEST,
      );
      await h.reject(
        "ineligible contender cannot promote",
        crank,
        [await promote(best)],
        sdk.AGENC_COORDINATION_ERROR__BID_DOES_NOT_SATISFY_MATCHING_POLICY,
      );
      await h.reject(
        "current eligible winner cannot reset grace",
        crank,
        [await demote(middle)],
        sdk.AGENC_COORDINATION_ERROR__BID_WINNER_STILL_ELIGIBLE,
      );
      await h.reject(
        "promotion does not erase acceptance grace",
        creator.signer,
        [await accept(middle)],
        sdk.AGENC_COORDINATION_ERROR__BID_REPROMOTION_GRACE_ACTIVE,
      );
      expect((await book()).winnerStaleSince).toBe(graceStarted);
      expect((await book()).bestBid).toBe(middle.bid);
      const watchdog = Date.now() + 330_000;
      while ((await h.clock()) < graceStarted + 300n) {
        if (Date.now() > watchdog)
          throw new Error(
            "validator did not reach production bid grace boundary",
          );
        await delay(500);
      }
      await h.reject(
        "worse contender cannot race acceptance",
        creator.signer,
        [await accept(worst)],
        sdk.AGENC_COORDINATION_ERROR__BID_NOT_BOOK_BEST,
      );
      await h.send("accept recovered policy winner", creator.signer, [
        await accept(middle),
      ]);
      for (const losing of [best, worst]) {
        const state = await h.read(losing.bid, sdk.getTaskBidDecoder());
        const before = await h.balance(losing.signer.address);
        const cancelled = await h.send(
          "loser exits and recovers bond",
          losing.signer,
          [
            await sdk.facade.cancelBid({
              task,
              bidder: losing.agent,
              authority: losing.signer,
            }),
          ],
        );
        expect(await h.balance(losing.signer.address)).toBe(
          before + state.bondLamports - cancelled.meta!.fee,
        );
        expect(
          (await h.read(losing.bid, sdk.getTaskBidDecoder())).bondLamports,
        ).toBe(0n);
      }
      const [claim] = await sdk.findClaimPda({ task, bidder: middle.agent });
      const [stats] = await sdk.findExpireClaimAgentStatsPda({
        worker: middle.agent,
      });
      const claimRent = (await h.info(claim))!.lamports;
      const statsRent = (await h.info(stats))?.lamports ?? 0n;
      const accepted = await h.read(middle.bid, sdk.getTaskBidDecoder());
      const workerBefore = await h.balance(middle.signer.address);
      const treasuryBefore = await h.balance(h.config.treasury);
      const fee =
        (accepted.requestedRewardLamports *
          BigInt((await h.read(task, sdk.getTaskDecoder())).protocolFeeBps)) /
        10_000n;
      const completed = await h.send(
        "winner completes and recovers bond",
        middle.signer,
        [
          await sdk.facade.completeTask({
            task,
            worker: middle.agent,
            authority: middle.signer,
            creator: creator.signer.address,
            treasury: h.config.treasury,
            proofHash: id32(),
            resultData: null,
            bidSettlement: {
              acceptedBid: middle.bid,
              bidderMarketState: middle.market,
            },
          }),
        ],
      );
      const newStatsRent = ((await h.info(stats))?.lamports ?? 0n) - statsRent;
      expect(await h.balance(middle.signer.address)).toBe(
        workerBefore +
          accepted.requestedRewardLamports -
          fee +
          accepted.bondLamports +
          claimRent -
          newStatsRent -
          completed.meta!.fee,
      );
      expect(await h.balance(h.config.treasury)).toBe(treasuryBefore + fee);
      expect((await h.read(task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.Completed,
      );
      expect(
        (await h.read(middle.agent, sdk.getAgentRegistrationDecoder()))
          .activeTasks,
      ).toBe(0);
      expect(
        (await h.read(middle.bid, sdk.getTaskBidDecoder())).bondLamports,
      ).toBe(0n);
      h.evidence.assertions = {
        invalidReorderingsRejected: true,
        graceCannotBeResetOrErased: true,
        policyWinnerRecovered: true,
        losingBondsRefunded: true,
        workerAndTreasuryPaid: true,
      };
      h.evidence.graceStarted = graceStarted;
      h.finish();
    }, 480_000);
  },
);
