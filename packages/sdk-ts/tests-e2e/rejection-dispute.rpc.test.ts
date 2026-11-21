import { describe, expect, it } from "vitest";
import type { Address, KeyPairSigner } from "@solana/kit";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";
import { rpcAgent, rpcListing, rpcPublish, type RpcHarness } from "./rpc-fixtures.js";

// Revision 9 (A, B): a turn-down on a single-worker review task, through the
// SDK and a real RPC, with exact lamports at every exit. It needs a program
// built with `validation-timings`, whose dispute and ruling windows are 300
// seconds (production: 72 hours each); set AGENC_RPC_VALIDATION_TIMINGS=1.
const ENABLED =
  RPC_ENABLED && process.env.AGENC_RPC_VALIDATION_TIMINGS === "1";
const WINDOW_SECS = 300n;
const PRICE = 20_000_000n; // 0.02 SOL: the bond is the 0.01 SOL floor

type TurnDown = {
  label: string;
  buyer: KeyPairSigner;
  task: Address;
  escrow: Address;
  claim: Address;
  submission: Address;
};

async function turnDown(
  h: RpcHarness,
  label: string,
  listing: Awaited<ReturnType<typeof rpcListing>>,
  provider: Awaited<ReturnType<typeof rpcAgent>>,
): Promise<TurnDown> {
  const buyer = await h.fundedSigner();
  const taskId = id32();
  const [task] = await sdk.findTaskPda({ creator: buyer.address, taskId });
  const [escrow] = await sdk.findEscrowPda({ task });
  const lv = await h.read(listing.listing, sdk.getServiceListingDecoder());
  await h.send(`${label}: hire`, buyer, [
    await sdk.facade.hireFromListingHumanless({
      taskId,
      creator: buyer,
      listing: listing.listing,
      providerAgent: provider.agent,
      expectedPrice: PRICE,
      expectedVersion: lv.version,
      reviewWindowSecs: 3_600n,
      listingSpecHash: listing.spec,
      taskJobSpecHash: listing.spec,
      moderator: h.moderator.address,
    }),
  ]);
  await rpcPublish(h, task, buyer, listing.spec);
  const [moderationBlock] = await sdk.findModerationBlockPda({
    contentHash: listing.spec,
  });
  await h.send(`${label}: claim`, provider.signer, [
    await sdk.facade.claimTaskWithJobSpec({
      task,
      worker: provider.agent,
      authority: provider.signer,
      moderationBlock,
    }),
  ]);
  await h.send(`${label}: deliver`, provider.signer, [
    await sdk.facade.submitTaskResult({
      task,
      worker: provider.agent,
      authority: provider.signer,
      proofHash: id32(),
      resultData: null,
    }),
  ]);
  await h.send(`${label}: turn down`, buyer, [
    await sdk.facade.rejectAndFreeze({
      task,
      worker: provider.agent,
      creator: buyer,
      rejectionHash: id32(),
    }),
  ]);
  const [claim] = await sdk.findClaimPda({ task, bidder: provider.agent });
  const [submission] = await sdk.findTaskSubmissionPda({ claim });
  const frozen = await h.read(submission, sdk.getTaskSubmissionDecoder());
  expect(sdk.values.isDisputableFreeze(frozen)).toBe(true);
  // The program's window on this build is the validation-timings one: the
  // deadline sits 300 seconds after the freeze, read just after it landed.
  const left = frozen.reviewDeadlineAt - (await h.clock());
  expect(left).toBeLessThanOrEqual(WINDOW_SECS);
  expect(left).toBeGreaterThanOrEqual(WINDOW_SECS - 5n);
  return { label, buyer, task, escrow, claim, submission };
}

describe.skipIf(!ENABLED)(
  "revision 9 turn-downs through SDK -> RPC (validation-timings)",
  () => {
    it("refunds an undisputed turn-down, rules a disputed one both ways, and refunds an unruled one with the bond back", async () => {
      const h = await localRpcHarness("rev9-rejection-dispute");
      if (h.programProfile !== null && h.programProfile !== "validation-timings")
        throw new Error(
          `the localnet runs a ${h.programProfile} build; this suite needs validation-timings`,
        );
      const provider = await rpcAgent(h);
      const listing = await rpcListing(h, provider, { price: PRICE });
      const crank = await h.fundedSigner();
      const owners = [h.admin, h.moderator];
      const treasury = h.config.treasury;
      const fee = (PRICE * BigInt(h.config.protocolFeeBps)) / 10_000n;
      const [bondRent] = [
        await h.rpc.getMinimumBalanceForRentExemption(186n).send(),
      ];
      const bondAmount = sdk.values.disputeBondLamports(PRICE);
      expect(bondAmount).toBe(10_000_000n);

      const quiet = await turnDown(h, "undisputed", listing, provider);
      const forWorker = await turnDown(h, "ruled for the worker", listing, provider);
      const forBuyer = await turnDown(h, "ruled for the buyer", listing, provider);
      const unruled = await turnDown(h, "unruled", listing, provider);
      const quietSubmission = await h.read(quiet.submission, sdk.getTaskSubmissionDecoder());

      const dispute = async (t: TurnDown) => {
        const before = await h.balance(provider.signer.address);
        const landed = await h.send(`${t.label}: dispute`, provider.signer, [
          await sdk.facade.disputeRejection({
            task: t.task,
            worker: provider.agent,
            creator: t.buyer.address,
            authority: provider.signer,
            evidenceHash: id32(),
            evidenceUri: "",
          }),
        ]);
        const bond = await sdk.facade.findRejectionDisputeBondPda(t.task);
        expect(await h.balance(bond)).toBe(bondRent + bondAmount);
        expect(await h.balance(provider.signer.address)).toBe(
          before - bondRent - bondAmount - landed.meta!.fee,
        );
        return bond;
      };
      const exits = (t: TurnDown) => ({
        task: t.task,
        claim: t.claim,
        worker: provider.agent,
        treasury,
        creator: t.buyer.address,
        workerAuthority: provider.signer.address,
      });
      const snapshot = async (t: TurnDown, bond?: Address) => ({
        buyer: await h.balance(t.buyer.address),
        worker: await h.balance(provider.signer.address),
        treasury: await h.balance(treasury),
        escrow: await h.balance(t.escrow),
        claim: await h.balance(t.claim),
        submission: await h.balance(t.submission),
        bond: bond === undefined ? 0n : await h.balance(bond),
      });

      const bondForWorker = await dispute(forWorker);
      const bondForBuyer = await dispute(forBuyer);
      const bondUnruled = await dispute(unruled);

      // A lone owner cannot rule.
      await h.reject(
        "a ruling by one owner",
        crank,
        [
          await sdk.facade.resolveRejectFrozen({
            ...exits(forWorker),
            authority: crank,
            approveCompletion: true,
            rationaleHash: id32(),
            rationaleUri: "",
            multisigSigners: [h.admin],
          }),
        ],
        sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS,
      );

      // Ruled for the worker: paid as on accept, and its bond comes back.
      let before = await snapshot(forWorker, bondForWorker);
      await h.send("ruled for the worker", crank, [
        await sdk.facade.resolveRejectFrozen({
          ...exits(forWorker),
          authority: crank,
          approveCompletion: true,
          rationaleHash: id32(),
          rationaleUri: "agenc://ruling/rpc",
          multisigSigners: owners,
        }),
      ]);
      expect(await h.balance(provider.signer.address)).toBe(
        before.worker + (PRICE - fee) + before.claim + before.submission + before.bond,
      );
      expect(await h.balance(forWorker.buyer.address)).toBe(
        before.buyer + (before.escrow - PRICE),
      );
      expect(await h.balance(treasury)).toBe(before.treasury + fee);
      expect(await h.info(bondForWorker)).toBeNull();

      // Ruled for the buyer: refunded, and the bond's principal goes to it.
      before = await snapshot(forBuyer, bondForBuyer);
      await h.send("ruled for the buyer", crank, [
        await sdk.facade.resolveRejectFrozen({
          ...exits(forBuyer),
          authority: crank,
          approveCompletion: false,
          rationaleHash: id32(),
          rationaleUri: "agenc://ruling/rpc",
          multisigSigners: owners,
        }),
      ]);
      expect(await h.balance(forBuyer.buyer.address)).toBe(
        before.buyer + before.escrow + bondAmount,
      );
      expect(await h.balance(provider.signer.address)).toBe(
        before.worker + before.claim + before.submission + (before.bond - bondAmount),
      );
      expect(await h.balance(treasury)).toBe(before.treasury);
      expect(await h.info(bondForBuyer)).toBeNull();

      // Neither the quiet nor the unruled one can be expired early.
      await h.reject(
        "an expiry inside the dispute window",
        crank,
        [await sdk.facade.expireRejectFrozen({ ...exits(quiet), authority: crank })],
        sdk.AGENC_COORDINATION_ERROR__REJECTION_WINDOW_STILL_OPEN,
      );
      await h.reject(
        "an expiry inside the ruling window",
        crank,
        [await sdk.facade.expireRejectFrozen({ ...exits(unruled), authority: crank })],
        sdk.AGENC_COORDINATION_ERROR__REJECTION_WINDOW_STILL_OPEN,
      );

      // Wait out both windows on the cluster clock.
      const unruledBond = await h.read(bondUnruled, sdk.getDisputeBondDecoder());
      const latest = [
        quietSubmission.reviewDeadlineAt,
        unruledBond.rulingDeadline,
      ].reduce((a, b) => (a > b ? a : b));
      await h.waitForClock(latest, "rejection windows", 1_200_000);

      // No dispute: the buyer is refunded in full; the worker gets its rents.
      before = await snapshot(quiet);
      await h.send("undisputed expiry", crank, [
        await sdk.facade.expireRejectFrozen({ ...exits(quiet), authority: crank }),
      ]);
      expect(await h.balance(quiet.buyer.address)).toBe(before.buyer + before.escrow);
      expect(await h.balance(provider.signer.address)).toBe(
        before.worker + before.claim + before.submission,
      );
      expect((await h.read(quiet.task, sdk.getTaskDecoder())).status).toBe(
        sdk.TaskStatus.Cancelled,
      );

      // Nobody ruled: the buyer is refunded and the whole bond goes back.
      before = await snapshot(unruled, bondUnruled);
      await h.send("unruled expiry", crank, [
        await sdk.facade.expireRejectFrozen({ ...exits(unruled), authority: crank }),
      ]);
      expect(await h.balance(unruled.buyer.address)).toBe(before.buyer + before.escrow);
      expect(await h.balance(provider.signer.address)).toBe(
        before.worker + before.claim + before.submission + before.bond,
      );
      expect(await h.info(bondUnruled)).toBeNull();

      // The worker's record: four turn-downs, one dispute won, one lost.
      const [stats] = await sdk.findWorkerStatsPda({ worker: provider.agent });
      expect(await h.read(stats, sdk.getAgentStatsDecoder())).toMatchObject({
        tasksRejected: 4n,
        disputesWon: 1n,
        disputesLost: 1n,
      });
      h.evidence.assertions = {
        undisputedRefund: true,
        ruledForWorker: true,
        ruledForBuyer: true,
        unruledRefundWithBond: true,
      };
      h.finish();
    }, 1_500_000);
  },
);
