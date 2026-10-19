import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcAgent, rpcPublish } from "./rpc-fixtures.js";

describe.skipIf(!RPC_ENABLED)(
  "#275: wallet-authority feed votes through real SDK -> RPC",
  () => {
    it("earns eligibility through paid work and rejects same-wallet duplicates and cross-agent self-votes", async () => {
      const h = await localRpcHarness("issue-275-authority-feed-votes");
      const surface = await sdk.getDeployedSurface(h.rpc);
      expect(surface.feedAuthorityVotes).toBe(true);
      const authorWallet = await h.fundedSigner();
      const voterWallet = await h.fundedSigner();
      const author = await rpcAgent(h, authorWallet);
      const authorSibling = await rpcAgent(h, authorWallet);
      const firstVoter = await rpcAgent(h, voterWallet);
      const secondVoter = await rpcAgent(h, voterWallet);
      const workers = [author, authorSibling, firstVoter, secondVoter];
      const targets = [5500, 5200, 5200, 5200];
      const rep = async (worker: typeof author) =>
        (await h.read(worker.agent, sdk.getAgentRegistrationDecoder()))
          .reputation;
      for (const worker of workers) expect(await rep(worker)).toBe(3000);
      const reward = 200_000_000n;
      const fee = (reward * BigInt(h.config.protocolFeeBps)) / 10_000n;
      expect(fee).toBe(10_000_000n); // 100 earned points per irrecoverable SOL fee.
      const treasuryBefore = await h.balance(h.config.treasury);
      let completions = 0;
      for (let round = 0; round < 25; round++) {
        // Separate funded buyer wallets avoid changing the actual creation cooldown.
        await Promise.all(
          workers.map(async (worker, index) => {
            if ((await rep(worker)) >= targets[index]!) return;
            const before = await rep(worker);
            const buyer = await rpcAgent(h);
            const taskId = id32();
            const [task] = await sdk.findTaskPda({
              creator: buyer.signer.address,
              taskId,
            });
            const spec = id32();
            await h.send("fund eligibility work", buyer.signer, [
              await sdk.facade.createTask({
                taskId,
                creator: buyer.signer,
                authority: buyer.signer,
                creatorAgent: buyer.agent,
                requiredCapabilities: 1n,
                description: new Uint8Array([...id32(), ...id32()]),
                rewardAmount: reward,
                maxWorkers: 1,
                deadline: (await h.clock()) + 900n,
                taskType: 0,
                constraintHash: null,
                minReputation: 0,
                rewardMintArg: null,
              }),
            ]);
            await rpcPublish(h, task, buyer.signer, spec);
            const [block] = await sdk.findModerationBlockPda({
              contentHash: spec,
            });
            await h.send("claim eligibility work", worker.signer, [
              await sdk.facade.claimTaskWithJobSpec({
                task,
                worker: worker.agent,
                authority: worker.signer,
                moderationBlock: block,
              }),
            ]);
            await h.send("complete paid eligibility work", worker.signer, [
              await sdk.facade.completeTask({
                task,
                worker: worker.agent,
                authority: worker.signer,
                creator: buyer.signer.address,
                treasury: h.config.treasury,
                proofHash: id32(),
                resultData: null,
              }),
            ]);
            expect(await rep(worker)).toBe(before + 100);
            expect((await h.read(task, sdk.getTaskDecoder())).status).toBe(
              sdk.TaskStatus.Completed,
            );
            expect(
              (await h.read(worker.agent, sdk.getAgentRegistrationDecoder()))
                .activeTasks,
            ).toBe(0);
            completions++;
          }),
        );
      }
      expect(completions).toBe(91);
      expect(await h.balance(h.config.treasury)).toBe(
        treasuryBefore + BigInt(completions) * fee,
      );
      for (let i = 0; i < workers.length; i++)
        expect(await rep(workers[i]!)).toBe(targets[i]);
      h.evidence.eligibility = {
        completions,
        totalProtocolFeesLamports: BigInt(completions) * fee,
        reputation: await Promise.all(workers.map(rep)),
        actorsCreatedBySignedRegistration: true,
      };
      const nonce = id32();
      const [post] = await sdk.findPostPda({ author: author.agent, nonce });
      const postIx = await sdk.facade.postToFeed({
        author: author.agent,
        authority: author.signer,
        contentHash: id32(),
        nonce,
        topic: id32(),
        parentPost: null,
      });
      const registeredAt = (
        await h.read(author.agent, sdk.getAgentRegistrationDecoder())
      ).registeredAt;
      expect(await h.clock()).toBeLessThan(registeredAt + 3600n);
      await h.reject(
        "earned reputation does not bypass author age",
        author.signer,
        [postIx],
        sdk.AGENC_COORDINATION_ERROR__COOLDOWN_NOT_ELAPSED,
      );
      expect(await h.info(post)).toBeNull();
      const watchdog = Date.now() + 3_700_000;
      let notice = 0;
      while ((await h.clock()) < registeredAt + 3600n) {
        if (Date.now() > watchdog)
          throw new Error(
            "validator did not reach actual one-hour feed author age",
          );
        if (Date.now() - notice > 60_000) {
          console.log(
            `#275 waiting for actual author age: ${registeredAt + 3600n}; current ${await h.clock()}`,
          );
          notice = Date.now();
        }
        await delay(1000);
      }
      await h.send("post after real age boundary", author.signer, [postIx]);
      const voteIx = (worker: typeof author, presentedAuthor = author.agent) =>
        sdk.facade.upvotePost({
          post,
          voter: worker.agent,
          author: presentedAuthor,
          authority: worker.signer,
          surface,
        });
      await expect(
        sdk.facade.upvotePost({
          post,
          voter: firstVoter.agent,
          author: author.agent,
          authority: firstVoter.signer,
          surface: sdk.capabilitiesForRevision(5),
        }),
      ).rejects.toThrow(sdk.SurfaceNotDeployedError);
      await h.reject(
        "different agent of author wallet cannot self-vote",
        authorSibling.signer,
        [await voteIx(authorSibling)],
        sdk.AGENC_COORDINATION_ERROR__FEED_SELF_UPVOTE,
      );
      const [authorityVote] = await sdk.findAuthorityVotePda({
        post,
        authority: voterWallet.address,
      });
      const before = await h.balance(voterWallet.address);
      const failed = await h.reject(
        "two same-wallet votes roll back atomically",
        voterWallet,
        [await voteIx(firstVoter), await voteIx(secondVoter)],
        sdk.AGENC_COORDINATION_ERROR__FEED_AUTHORITY_ALREADY_VOTED,
      );
      expect(await h.balance(voterWallet.address)).toBe(
        before - failed.meta!.fee,
      );
      expect(await h.info(authorityVote)).toBeNull();
      expect(
        (await h.read(post, sdk.getFeedPostDecoder())).walletUpvoteCount,
      ).toBe(0);
      // Retired registrations are durable author-identity tombstones.
      await h.send(
        "retire author without losing post ownership provenance",
        author.signer,
        [
          await sdk.facade.deregisterAgent({
            agent: author.agent,
            authority: author.signer,
          }),
        ],
      );
      expect(await h.info(author.agent)).not.toBeNull();
      const landed = await h.send(
        "first wallet vote on retired author's post",
        voterWallet,
        [await voteIx(firstVoter)],
      );
      const decoded = sdk
        .parseAgencCoordinationEvents(landed.meta!.logMessages ?? [])
        .filter((event) => event.eventName === "PostUpvotedByAuthority");
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.data).toMatchObject({
        post,
        authority: voterWallet.address,
        voter: firstVoter.agent,
        walletUpvoteCount: 1,
      });
      const receipt = await h.read(
        authorityVote,
        sdk.getFeedAuthorityVoteDecoder(),
      );
      expect(receipt).toMatchObject({
        post,
        authority: voterWallet.address,
        voter: firstVoter.agent,
      });
      const counted = await h.read(post, sdk.getFeedPostDecoder());
      expect(counted.walletUpvoteCount).toBe(1);
      expect(counted.upvoteCount).toBe(0); // legacy history is not mixed into wallet ranking.
      for (const worker of [secondVoter, firstVoter])
        await h.reject(
          "same wallet cannot add another vote",
          worker.signer,
          [await voteIx(worker)],
          sdk.AGENC_COORDINATION_ERROR__FEED_AUTHORITY_ALREADY_VOTED,
        );
      await h.reject(
        "legacy per-agent wire fails closed",
        voterWallet,
        [
          await sdk.getUpvotePostInstructionAsync({
            post,
            voter: secondVoter.agent,
            authority: voterWallet,
          }),
        ],
        sdk.AGENC_COORDINATION_ERROR__FEED_AGENT_VOTING_RETIRED,
      );
      await h.reject(
        "wrong author account cannot bypass ownership check",
        voterWallet,
        [await voteIx(secondVoter, secondVoter.agent)],
        sdk.AGENC_COORDINATION_ERROR__INVALID_INPUT,
      );
      expect(
        await h.read(authorityVote, sdk.getFeedAuthorityVoteDecoder()),
      ).toEqual(receipt);
      expect(await h.read(post, sdk.getFeedPostDecoder())).toEqual(counted);
      h.evidence.assertions = {
        eligibilityEarnedThroughActualFees: true,
        actualAuthorAgeWaited: true,
        sameWalletDuplicateRejected: true,
        crossAgentSelfVoteRejected: true,
        atomicRollbackIncludesRentAndCounters: true,
        retiredAuthorIdentityPreserved: true,
        legacyWireRejected: true,
        legacyCountKeptSeparate: true,
        originalVoteCannotBeRewritten: true,
      };
      h.finish();
    }, 4_500_000);
  },
);
