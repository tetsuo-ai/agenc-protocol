import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";

describe.skipIf(!RPC_ENABLED)(
  "#274: disabled moderation through SDK -> RPC",
  () => {
    for (const humanless of [false, true]) {
      it(`${humanless ? "humanless" : "registered"}: rejects disabled hires, recovers existing funds, and resumes work`, async () => {
        const h = await localRpcHarness(
          `issue-274-${humanless ? "humanless" : "registered"}`,
        );
        // The config changes below are signed authority transactions, not injected
        // state. Only the shared disposable ProtocolConfig genesis is a fixture.
        async function enabled(value: boolean) {
          await h.send(`moderation enabled=${value}`, h.admin, [
            await sdk.facade.configureTaskModeration({
              authority: h.admin,
              moderationAuthority: h.moderator.address,
              enabled: value,
            }),
          ]);
        }
        await enabled(true);
        try {
          const provider = await h.fundedSigner();
          const buyer = await h.fundedSigner();
          const providerId = id32();
          const buyerId = id32();
          const [providerAgent] = await sdk.findAgentPda({
            agentId: providerId,
          });
          const [buyerAgent] = await sdk.findAgentPda({ agentId: buyerId });
          for (const [signer, agentId] of (humanless
            ? [[provider, providerId]]
            : [
                [provider, providerId],
                [buyer, buyerId],
              ]) as [typeof provider, Uint8Array][]) {
            await h.send("register", signer, [
              await sdk.facade.registerAgent({
                authority: signer,
                agentId,
                capabilities: 1n,
                endpoint: "https://example.invalid/274",
                metadataUri: null,
                stakeAmount: h.config.minAgentStake,
              }),
            ]);
          }
          const listingId = id32();
          const spec = id32();
          const price = 10_000_000n;
          const [listing] = await sdk.facade.findListingPda({
            providerAgent,
            listingId,
          });
          await h.send("list", provider, [
            await sdk.facade.createServiceListing({
              providerAgent,
              authority: provider,
              listingId,
              name: id32(),
              category: id32(),
              tags: new Uint8Array(64).fill(1),
              specHash: spec,
              specUri: "agenc://job-spec/274",
              price,
              priceMint: null,
              requiredCapabilities: 1n,
              defaultDeadlineSecs: 3600n,
              maxOpenJobs: 2,
              operator: null,
              operatorFeeBps: 0,
            }),
          ]);
          await h.send("CLEAN listing", h.moderator, [
            await sdk.facade.recordListingModeration({
              moderator: h.moderator,
              listing,
              jobSpecHash: spec,
              status: 0,
              riskScore: 0,
              categoryMask: 0n,
              policyHash: id32(),
              scannerHash: id32(),
              expiresAt: 0n,
            }),
          ]);
          async function hire() {
            const taskId = id32();
            const [task] = await sdk.findTaskPda({
              creator: buyer.address,
              taskId,
            });
            const [escrow] = await sdk.findEscrowPda({ task });
            const [hireRecord] = await sdk.findHireRecordPda({ task });
            const base = {
              taskId,
              creator: buyer,
              listing,
              providerAgent,
              expectedPrice: price,
              expectedVersion: 1n,
              listingSpecHash: spec,
              taskJobSpecHash: spec,
              moderator: h.moderator.address,
            };
            const ix = humanless
              ? await sdk.facade.hireFromListingHumanless({
                  ...base,
                  reviewWindowSecs: 3600n,
                })
              : await sdk.facade.hireFromListing({
                  ...base,
                  authority: buyer,
                  creatorAgent: buyerAgent,
                });
            return { task, escrow, hireRecord, ix };
          }
          // Existing deposits must still have their cancellation exit after disable.
          const existing = await hire();
          await h.send("hire before disable", buyer, [existing.ix]);
          await enabled(false);
          const [rateLimit] = await sdk.findAuthorityRateLimitPda({
            authority: buyer.address,
          });
          const lastHire = await h.read(
            rateLimit,
            sdk.getAuthorityRateLimitDecoder(),
          );
          const allowedAt =
            lastHire.lastTaskCreated + h.config.taskCreationCooldown;
          const watchdog = Date.now() + 90_000;
          while ((await h.clock()) < allowedAt) {
            if (Date.now() > watchdog)
              throw new Error("validator did not reach task creation cooldown");
            await delay(500);
          }
          const forbidden = await hire();
          const beforeListing = await h.info(listing);
          const beforeBuyer = await h.balance(buyer.address);
          const rejected = await h.reject(
            "disabled hire with existing CLEAN attestation",
            buyer,
            [forbidden.ix],
            sdk.AGENC_COORDINATION_ERROR__TASK_MODERATION_REQUIRED,
          );
          expect(await h.balance(buyer.address)).toBe(
            beforeBuyer - rejected.meta!.fee,
          );
          expect(await h.info(listing)).toEqual(beforeListing);
          for (const key of [
            forbidden.task,
            forbidden.escrow,
            forbidden.hireRecord,
          ])
            expect(await h.info(key)).toBeNull();

          const escrowLamports = (await h.info(existing.escrow))!.lamports;
          const beforeCancel = await h.balance(buyer.address);
          const cancelled = await h.send(
            "cancel existing deposit while disabled",
            buyer,
            [
              await sdk.facade.cancelTask({
                task: existing.task,
                authority: buyer,
                workerBondAuthority: provider.address,
              }),
            ],
          );
          expect(await h.balance(buyer.address)).toBe(
            beforeCancel + escrowLamports - cancelled.meta!.fee,
          );
          expect(await h.info(existing.escrow)).toBeNull();
          expect(
            (await h.read(existing.task, sdk.getTaskDecoder())).status,
          ).toBe(sdk.TaskStatus.Cancelled);
          await h.send("release cancelled listing capacity", buyer, [
            await sdk.facade.closeTask({
              task: existing.task,
              authority: buyer,
              listing,
              hireRecord: existing.hireRecord,
              taskJobSpec: null,
              creatorCompletionBond: (
                await sdk.findCreatorCompletionBondPda({
                  task: existing.task,
                  creator: buyer.address,
                })
              )[0],
            }),
          ]);
          expect(
            (await h.read(listing, sdk.getServiceListingDecoder())).openJobs,
          ).toBe(0);

          // The BLOCK floor wins even while moderation is disabled; authority must
          // explicitly clear it with threshold signatures before a subsequent hire.
          await h.send("BLOCK listing", h.admin, [
            await sdk.facade.setModerationBlock({
              authority: h.admin,
              multisigSigners: [h.admin, h.moderator],
              contentHash: spec,
              rationaleHash: id32(),
              rationaleUri: "agenc://ruling/274",
            }),
          ]);
          await h.reject(
            "BLOCK cannot be bypassed by disabled moderation",
            buyer,
            [(await hire()).ix],
            sdk.AGENC_COORDINATION_ERROR__CONTENT_BLOCKED,
          );
          await h.send("clear BLOCK", h.admin, [
            await sdk.facade.clearModerationBlock({
              authority: h.admin,
              multisigSigners: [h.admin, h.moderator],
              contentHash: spec,
            }),
          ]);

          await enabled(true);
          const resumed = await hire();
          await h.send("hire after re-enable", buyer, [resumed.ix]);
          await h.send("CLEAN task", h.moderator, [
            await sdk.facade.recordTaskModeration({
              task: resumed.task,
              moderator: h.moderator,
              jobSpecHash: spec,
              status: 0,
              riskScore: 0,
              categoryMask: 0n,
              policyHash: id32(),
              scannerHash: id32(),
              expiresAt: 0n,
            }),
          ]);
          await h.send("publish", buyer, [
            await sdk.facade.setTaskJobSpec({
              task: resumed.task,
              creator: buyer,
              jobSpecHash: spec,
              jobSpecUri: "agenc://job-spec/274",
              moderator: h.moderator.address,
            }),
          ]);
          const [moderationBlock] = await sdk.findModerationBlockPda({
            contentHash: spec,
          });
          await h.send("claim", provider, [
            await sdk.facade.claimTaskWithJobSpec({
              task: resumed.task,
              worker: providerAgent,
              authority: provider,
              moderationBlock,
            }),
          ]);
          // Disabling after a live claim must not strand its worker's payout.
          await enabled(false);
          const [claim] = await sdk.findClaimPda({
            task: resumed.task,
            bidder: providerAgent,
          });
          if (humanless) {
            await h.send("submit", provider, [
              await sdk.facade.submitTaskResult({
                task: resumed.task,
                worker: providerAgent,
                authority: provider,
                proofHash: id32(),
                resultData: null,
              }),
            ]);
          }
          const claimRent = (await h.info(claim))!.lamports;
          const [submission] = await sdk.findTaskSubmissionPda({ claim });
          const submissionRent = (await h.info(submission))?.lamports ?? 0n;
          const workerBefore = await h.balance(provider.address);
          const treasuryBefore = await h.balance(h.config.treasury);
          const fee =
            (price *
              BigInt(
                (await h.read(resumed.task, sdk.getTaskDecoder()))
                  .protocolFeeBps,
              )) /
            10_000n;
          const settlement = await h.send(
            "settle while disabled",
            humanless ? buyer : provider,
            [
              humanless
                ? await sdk.facade.acceptTaskResult({
                    task: resumed.task,
                    worker: providerAgent,
                    creator: buyer,
                    treasury: h.config.treasury,
                    workerAuthority: provider.address,
                    hireRecord: resumed.hireRecord,
                  })
                : await sdk.facade.completeTask({
                    task: resumed.task,
                    worker: providerAgent,
                    authority: provider,
                    creator: buyer.address,
                    treasury: h.config.treasury,
                    hireRecord: resumed.hireRecord,
                    proofHash: id32(),
                    resultData: null,
                  }),
            ],
          );
          expect(await h.balance(h.config.treasury)).toBe(treasuryBefore + fee);
          expect(await h.balance(provider.address)).toBe(
            workerBefore +
              price -
              fee +
              claimRent +
              submissionRent -
              (humanless ? 0n : settlement.meta!.fee),
          );
          expect(
            (await h.read(resumed.task, sdk.getTaskDecoder())).status,
          ).toBe(sdk.TaskStatus.Completed);
          expect(
            (await h.read(providerAgent, sdk.getAgentRegistrationDecoder()))
              .activeTasks,
          ).toBe(0);
          expect(await h.info(resumed.escrow)).toBeNull();
          await h.send("release completed listing capacity", buyer, [
            await sdk.facade.closeTask({
              task: resumed.task,
              authority: buyer,
              listing,
              hireRecord: resumed.hireRecord,
              creatorCompletionBond: (
                await sdk.findCreatorCompletionBondPda({
                  task: resumed.task,
                  creator: buyer.address,
                })
              )[0],
            }),
          ]);
          expect(
            (await h.read(listing, sdk.getServiceListingDecoder())).openJobs,
          ).toBe(0);
          h.evidence.assertions = {
            disabledHireRolledBack: true,
            cancellationRefunded: true,
            blockFloorEnforced: true,
            resumedAndPaid: true,
            listingCapacityRecovered: true,
          };
          h.finish();
        } finally {
          await enabled(true);
        }
      }, 180_000);
    }
  },
);
