import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { KeyPairSigner } from "@solana/kit";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";

// This runs against solana-test-validator with the production-feature build.
// See docs/VALIDATION.md for bootstrap, commands, evidence, and time-bound cases.
describe.skipIf(!RPC_ENABLED)(
  "AGNC-01: SDK -> RPC dispute settlement and stake recovery",
  () => {
    for (const scenario of [
      { name: "expiry", resolutionType: 0, approve: true, peerCount: 3 },
      { name: "complete", resolutionType: 1, approve: true, peerCount: 3 },
      { name: "split", resolutionType: 2, approve: true, peerCount: 3 },
      { name: "reject", resolutionType: 0, approve: false, peerCount: 3 },
      { name: "refund", resolutionType: 0, approve: true, peerCount: 3 },
    ]) {
      it(`${scenario.name}: reserves all peer claims, drains them once, and returns stake`, async () => {
        const h = await localRpcHarness(`agnc01-${scenario.name}`);
        const expiry = scenario.name === "expiry";
        if (expiry && h.config.votingPeriod > 300n) {
          throw new Error(
            "Expiry RPC test requires localnet-up --dev-ready --short-disputes (real elapsed time, unchanged production SBF)",
          );
        }
        const stake =
          h.config.minAgentStake > 2n * h.config.minStakeForDispute
            ? h.config.minAgentStake
            : 2n * h.config.minStakeForDispute;
        async function actor() {
          const signer = await h.fundedSigner();
          const agentId = id32();
          const [agent] = await sdk.findAgentPda({ agentId });
          await h.send("register funded agent", signer, [
            await sdk.facade.registerAgent({
              authority: signer,
              agentId,
              capabilities: 1n,
              endpoint: "https://example.invalid/agnc01",
              metadataUri: null,
              stakeAmount: stake,
            }),
          ]);
          expect(
            (await h.read(agent, sdk.getAgentRegistrationDecoder())).stake,
          ).toBe(stake);
          const account = await h.info(agent);
          const rent = await h.rpc
            .getMinimumBalanceForRentExemption(
              BigInt(Buffer.from(account!.data[0], "base64").length),
            )
            .send();
          expect(account!.lamports - rent).toBe(stake);
          return { signer, agent };
        }
        const creator = await actor();
        const defendant = await actor();
        const peers = [];
        for (let i = 0; i < scenario.peerCount; i++) peers.push(await actor());
        const crank = await h.fundedSigner();
        const taskId = id32();
        const [task] = await sdk.findTaskPda({
          creator: creator.signer.address,
          taskId,
        });
        const jobSpecHash = id32();
        const [moderationBlock] = await sdk.findModerationBlockPda({
          contentHash: jobSpecHash,
        });
        const reward = 4_000_000n;
        await h.send("fund collaborative task", creator.signer, [
          await sdk.facade.createTask({
            taskId,
            creator: creator.signer,
            authority: creator.signer,
            creatorAgent: creator.agent,
            requiredCapabilities: 1n,
            description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
            rewardAmount: reward,
            maxWorkers: peers.length + 1,
            deadline: (await h.clock()) + 259_200n,
            taskType: 1,
            constraintHash: null,
            minReputation: 0,
            rewardMintArg: null,
          }),
        ]);
        await h.send("attest job spec", h.moderator, [
          await sdk.facade.recordTaskModeration({
            moderator: h.moderator,
            task,
            jobSpecHash,
            status: 0,
            riskScore: 0,
            categoryMask: 0n,
            policyHash: id32(),
            scannerHash: id32(),
            expiresAt: 0n,
          }),
        ]);
        const [validation] = await sdk.findTaskValidationConfigPda({ task });
        await h.send("configure CreatorReview", creator.signer, [
          await sdk.facade.configureTaskValidation({
            task,
            creator: creator.signer,
            mode: 1,
            reviewWindowSecs: 3600n,
            validatorQuorum: 0,
            attestor: null,
          }),
        ]);
        await h.send("publish job spec", creator.signer, [
          await sdk.facade.setTaskJobSpec({
            task,
            creator: creator.signer,
            jobSpecHash,
            jobSpecUri: "agenc://job-spec/agnc01-rpc",
            moderator: h.moderator.address,
          }),
        ]);
        for (const worker of [defendant, ...peers]) {
          await h.send("claim", worker.signer, [
            await sdk.facade.claimTaskWithJobSpec({
              task,
              worker: worker.agent,
              authority: worker.signer,
              moderationBlock,
            }),
          ]);
        }
        const [defendantClaim] = await sdk.findClaimPda({
          task,
          bidder: defendant.agent,
        });
        const disputeId = id32();
        const [dispute] = await sdk.findDisputePda({ disputeId });
        h.evidence.accounts = {
          task,
          dispute,
          creator: creator.agent,
          defendant: defendant.agent,
          peers: peers.map((peer) => peer.agent),
        };
        await h.send("initiate dispute", creator.signer, [
          await sdk.facade.initiateDispute({
            task,
            disputeId,
            taskId,
            agent: creator.agent,
            initiatorClaim: sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
            authority: creator.signer,
            workerAgent: defendant.agent,
            workerClaim: defendantClaim,
            evidenceHash: id32(),
            evidence: "AGNC-01 RPC regression",
            resolutionType: scenario.resolutionType,
          }),
        ]);
        const exit = expiry
          ? await sdk.facade.expireDispute({
              dispute,
              task,
              creator: creator.signer.address,
              worker: defendant.agent,
              workerClaim: defendantClaim,
              workerWallet: defendant.signer.address,
              authority: crank,
              taskValidationConfig: validation,
            })
          : await sdk.facade.resolveDispute({
              dispute,
              task,
              creator: creator.signer.address,
              worker: defendant.agent,
              workerClaim: defendantClaim,
              workerWallet: defendant.signer.address,
              authority: h.admin,
              multisigSigners: [h.admin, h.moderator],
              approve: scenario.approve,
              rationaleHash: id32(),
              rationaleUri: "agenc://ruling/agnc01-rpc",
              bondTreasury: h.config.treasury,
              taskValidationConfig: validation,
            });
        const reclaim = async (
          worker: typeof defendant,
          authority: KeyPairSigner = crank,
        ) =>
          sdk.facade.reclaimTerminalClaim({
            authority,
            task,
            worker: worker.agent,
            treasury: h.config.treasury,
            rentRecipient: worker.signer.address,
            taskValidationConfig: validation,
          });
        const refund = scenario.name === "refund";
        const rejection = refund
          ? sdk.AGENC_COORDINATION_ERROR__CLAIM_SLASH_PENDING
          : sdk.AGENC_COORDINATION_ERROR__CLAIM_SETTLEMENT_PENDING;
        if (expiry) {
          await h.reject(
            "expiry before deadline",
            crank,
            [exit],
            sdk.AGENC_COORDINATION_ERROR__DISPUTE_NOT_EXPIRED,
          );
          const state = await h.read(dispute, sdk.getDisputeDecoder());
          const deadline = state.votingDeadline + 121n;
          const watchdog = Date.now() + 480_000;
          let lastNotice = 0;
          while ((await h.clock()) < deadline) {
            if (Date.now() > watchdog)
              throw new Error(
                "validator clock did not reach the dispute expiry boundary",
              );
            if (Date.now() - lastNotice > 30_000) {
              console.log(
                `AGNC-01 expiry: waiting for validator clock ${deadline}; now ${await h.clock()}`,
              );
              lastNotice = Date.now();
            }
            await delay(1_000);
          }
        }
        // Both instructions are signed and BROADCAST. Failed metadata plus exact
        // account comparisons prove atomic rollback, including the preceding payout.
        const taskBefore = await h.info(task);
        const disputeBefore = await h.info(dispute);
        const creatorBefore = await h.balance(creator.signer.address);
        const defendantBefore = await h.balance(defendant.signer.address);
        await h.reject(
          "atomic dispute exit + premature reclaim",
          crank,
          [exit, await reclaim(peers[0]!)],
          rejection,
        );
        expect(await h.info(task)).toEqual(taskBefore);
        expect(await h.info(dispute)).toEqual(disputeBefore);
        expect(await h.balance(creator.signer.address)).toBe(creatorBefore);
        expect(await h.balance(defendant.signer.address)).toBe(defendantBefore);

        await h.send(expiry ? "expire" : "resolve", expiry ? crank : h.admin, [
          exit,
        ]);
        const finalizer = await sdk.facade.applyInitiatorSlash({
          dispute,
          initiatorAgent: creator.agent,
          treasury: h.config.treasury,
          authority: crank,
        });
        await h.reject(
          "premature initiator finalization",
          crank,
          [finalizer],
          sdk.AGENC_COORDINATION_ERROR__DISPUTE_NOT_RESOLVED,
        );
        await h.reject(
          "premature stake withdrawal",
          creator.signer,
          [
            await sdk.facade.deregisterAgent({
              agent: creator.agent,
              authority: creator.signer,
            }),
          ],
          sdk.AGENC_COORDINATION_ERROR__ACTIVE_DISPUTE_VOTES,
        );
        for (let i = 0; i < peers.length; i++) {
          const peer = peers[i]!;
          const state = await h.read(dispute, sdk.getDisputeDecoder());
          expect(state.status).toBe(sdk.DisputeStatus.SettlementPending);
          expect(state.peerWorkersTotal).toBe(peers.length);
          expect(state.peerWorkersSettled).toBe(i);
          expect((await h.read(task, sdk.getTaskDecoder())).reserved[11]).toBe(
            1,
          );
          await h.reject(
            "separate premature reclaim",
            crank,
            [await reclaim(peer)],
            rejection,
          );
          const [claim] = await sdk.findClaimPda({ task, bidder: peer.agent });
          const claimBalance = (await h.info(claim))!.lamports;
          const agentBalance = (await h.info(peer.agent))!.lamports;
          await h.send("settle peer", crank, [
            await sdk.facade.settleDisputeClaim({
              dispute,
              task,
              claim,
              worker: peer.agent,
              authority: crank,
              taskValidationConfig: validation,
            }),
          ]);
          expect((await h.info(claim))?.lamports ?? 0n).toBe(0n);
          expect((await h.info(peer.agent))!.lamports - agentBalance).toBe(
            claimBalance,
          );
          expect(
            (await h.read(peer.agent, sdk.getAgentRegistrationDecoder()))
              .activeTasks,
          ).toBe(0);
        }
        const settled = await h.read(dispute, sdk.getDisputeDecoder());
        expect(settled.peerWorkersSettled).toBe(peers.length);
        expect(settled.status).toBe(
          expiry ? sdk.DisputeStatus.Expired : sdk.DisputeStatus.Resolved,
        );
        const settledTask = await h.read(task, sdk.getTaskDecoder());
        expect(settledTask.reserved[11]).toBe(0);
        expect(settledTask.currentWorkers).toBe(refund ? 1 : 0);
        await h.send("finalize initiator", crank, [finalizer]);
        const expectedStake = scenario.approve
          ? stake
          : stake - (stake * BigInt(h.config.slashPercentage)) / 100n;
        const creatorAfter = await h.read(
          creator.agent,
          sdk.getAgentRegistrationDecoder(),
        );
        expect(creatorAfter.activeDisputeVotes).toBe(0);
        expect(creatorAfter.stake).toBe(expectedStake);
        const before = await h.balance(creator.signer.address);
        const retirement = await h.send(
          "recover registration stake",
          creator.signer,
          [
            await sdk.facade.deregisterAgent({
              agent: creator.agent,
              authority: creator.signer,
            }),
          ],
        );
        expect(
          (await h.balance(creator.signer.address)) -
            before +
            retirement.meta!.fee,
        ).toBe(expectedStake);
        expect(
          (await h.read(creator.agent, sdk.getAgentRegistrationDecoder()))
            .stake,
        ).toBe(0n);
        // Claim rent credited to peer PDAs must be withdrawable too.
        for (const peer of peers) {
          const account = (await h.info(peer.agent))!;
          const rent = await h.rpc
            .getMinimumBalanceForRentExemption(
              BigInt(Buffer.from(account.data[0], "base64").length),
            )
            .send();
          const balance = await h.balance(peer.signer.address);
          const result = await h.send(
            "recover peer stake and claim rent",
            peer.signer,
            [
              await sdk.facade.deregisterAgent({
                agent: peer.agent,
                authority: peer.signer,
              }),
            ],
          );
          expect(
            (await h.balance(peer.signer.address)) - balance + result.meta!.fee,
          ).toBe(account.lamports - rent);
        }
        h.evidence.assertions = {
          peers: peers.length,
          expectedStake,
          atomicRollback: true,
          settlementCompleted: true,
          stakeRecovered: true,
        };
        h.finish();
      }, 660_000);
    }
  },
);
