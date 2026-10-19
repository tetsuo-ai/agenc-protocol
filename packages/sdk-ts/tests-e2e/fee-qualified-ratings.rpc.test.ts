import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcAgent, rpcListing, rpcPublish } from "./rpc-fixtures.js";

describe.skipIf(!RPC_ENABLED)(
  "#276: actual SOL fee qualification through RPC",
  () => {
    it("rejects cheap cross-wallet cycles, accepts the exact fee floor, and preserves purchase evidence after price edits", async () => {
      const h = await localRpcHarness("issue-276-fee-qualified-ratings");
      expect((await sdk.getDeployedSurface(h.rpc)).feeQualifiedRatings).toBe(
        true,
      );
      const floor = sdk.facade.MIN_RATING_PROTOCOL_FEE_LAMPORTS;
      const bps = BigInt(h.config.protocolFeeBps);
      expect(bps).toBeGreaterThan(0n);
      const qualifyingPrice = (floor * 10_000n + bps - 1n) / bps;
      const cases = [1_001n, qualifyingPrice - 1n, qualifyingPrice];
      h.evidence.ratingPolicy = {
        minimumActualSolFee: String(floor),
        protocolFeeBps: String(bps),
      };
      for (const price of cases) {
        const expectedFee = (price * bps) / 10_000n;
        const qualifies = expectedFee >= floor;
        // Both keys belong to this test: distinct wallets are not proof of distinct
        // economic actors. Every agent, hire, claim and purchase is a real RPC tx.
        const seller = await rpcAgent(h),
          buyer = await rpcAgent(h);
        const listing = await rpcListing(h, seller, { price });
        const taskId = id32();
        const [task] = await sdk.findTaskPda({
          creator: buyer.signer.address,
          taskId,
        });
        const [hireRecord] = await sdk.findHireRecordPda({ task });
        await h.send(`fund cross-wallet hire ${price}`, buyer.signer, [
          await sdk.facade.hireFromListing({
            taskId,
            creator: buyer.signer,
            authority: buyer.signer,
            creatorAgent: buyer.agent,
            listing: listing.listing,
            providerAgent: seller.agent,
            expectedPrice: price,
            expectedVersion: 1n,
            listingSpecHash: listing.spec,
            taskJobSpecHash: listing.spec,
            moderator: h.moderator.address,
          }),
        ]);
        await rpcPublish(h, task, buyer.signer, listing.spec);
        await h.send("claim paid hire", seller.signer, [
          await sdk.facade.claimTaskWithJobSpec({
            task,
            worker: seller.agent,
            authority: seller.signer,
            moderationBlock: (
              await sdk.findModerationBlockPda({ contentHash: listing.spec })
            )[0],
          }),
        ]);
        const treasuryBefore = await h.balance(h.config.treasury);
        await h.send("complete and pay actual SOL fee", seller.signer, [
          await sdk.facade.completeTask({
            task,
            worker: seller.agent,
            authority: seller.signer,
            creator: buyer.signer.address,
            treasury: h.config.treasury,
            hireRecord,
            proofHash: id32(),
            resultData: null,
          }),
        ]);
        expect(await h.balance(h.config.treasury)).toBe(
          treasuryBefore + expectedFee,
        );
        const completed = await h.read(task, sdk.getTaskDecoder());
        expect(completed.status).toBe(sdk.TaskStatus.Completed);
        expect(sdk.facade.isHireRatingFeeQualified(completed)).toBe(qualifies);
        const rating = await sdk.facade.rateHire({
          task,
          listing: listing.listing,
          buyer: buyer.signer,
          score: 5,
        });
        const [hireRating] = await sdk.findHireRatingPda({ task });
        const listingBefore = await h.info(listing.listing);
        if (qualifies) {
          await h.send("count exactly fee-qualified hire", buyer.signer, [
            rating,
          ]);
          const updated = await h.read(
            listing.listing,
            sdk.getServiceListingDecoder(),
          );
          expect(updated.ratingCount).toBe(1);
          expect(updated.totalRating).toBe(5n);
        } else {
          const balanceBefore = await h.balance(buyer.signer.address);
          const rejected = await h.reject(
            "cheap completed cycle cannot move listing aggregate",
            buyer.signer,
            [rating],
            sdk.AGENC_COORDINATION_ERROR__RATING_FEE_NOT_QUALIFIED,
          );
          expect(await h.balance(buyer.signer.address)).toBe(
            balanceBefore - rejected.meta!.fee,
          );
          expect(await h.info(listing.listing)).toEqual(listingBefore);
          expect(await h.info(hireRating)).toBeNull();
        }

        const skillId = id32(),
          contentHash = id32();
        const [skill] = await sdk.findSkillPda({
          author: seller.agent,
          skillId,
        });
        await h.send("register priced skill", seller.signer, [
          await sdk.facade.registerSkill({
            skillId,
            author: seller.agent,
            authority: seller.signer,
            name: id32(),
            contentHash,
            price,
            priceMint: null,
            tags: new Uint8Array(64).fill(1),
          }),
        ]);
        const beforeSkillFee = await h.balance(h.config.treasury);
        await h.send("buy skill with actual fee", buyer.signer, [
          await sdk.facade.purchaseSkill({
            skill,
            buyer: buyer.agent,
            authorAgent: seller.agent,
            authorWallet: seller.signer.address,
            treasury: h.config.treasury,
            authority: buyer.signer,
            expectedPrice: price,
            expectedVersion: 1,
            expectedContentHash: contentHash,
          }),
        ]);
        expect(await h.balance(h.config.treasury)).toBe(
          beforeSkillFee + expectedFee,
        );
        const [purchaseRecord] = await sdk.findPurchaseRecordPda({
          skill,
          buyer: buyer.agent,
        });
        const receipt = await h.read(
          purchaseRecord,
          sdk.getPurchaseRecordDecoder(),
        );
        expect(sdk.facade.isSkillRatingFeeQualified(receipt)).toBe(qualifies);
        const receiptBefore = await h.info(purchaseRecord);
        await h.send("change current price after purchase", seller.signer, [
          await sdk.facade.updateSkill({
            skill,
            author: seller.agent,
            authority: seller.signer,
            contentHash,
            price: qualifies ? 1_001n : qualifyingPrice,
          }),
        ]);
        expect(await h.info(purchaseRecord)).toEqual(receiptBefore);
        const skillRating = await sdk.facade.rateSkill({
          skill,
          rater: buyer.agent,
          authorAgent: seller.agent,
          authority: buyer.signer,
          rating: 5,
        });
        if (qualifies) {
          await h.send(
            "count paid skill even after price reduction",
            buyer.signer,
            [skillRating],
          );
          const updated = await h.read(
            skill,
            sdk.getSkillRegistrationDecoder(),
          );
          expect(updated.ratingCount).toBe(1);
          expect(updated.totalRating).toBe(15_000n);
        } else {
          const before = await h.info(skill);
          await h.reject(
            "price increase cannot qualify an old cheap purchase",
            buyer.signer,
            [skillRating],
            sdk.AGENC_COORDINATION_ERROR__RATING_FEE_NOT_QUALIFIED,
          );
          expect(await h.info(skill)).toEqual(before);
          const [ratingAccount] = await sdk.findRatingAccountPda({
            skill,
            rater: buyer.agent,
          });
          expect(await h.info(ratingAccount)).toBeNull();
        }
      }
      h.finish();
    }, 300_000);
  },
);
