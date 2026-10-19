import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { signature, type KeyPairSigner } from "@solana/kit";
import * as sdk from "../src/index.js";
import { id32, localRpcHarness, RPC_ENABLED } from "./rpc-harness.js";

describe.skipIf(!RPC_ENABLED)(
  "#82: claim expiry events through SDK -> RPC",
  () => {
    for (const manual of [false, true]) {
      // Separate funded accounts; concurrent cases share no mutable authority config.
      it.concurrent(
        `${manual ? "manual collaborative" : "automatic exclusive"}: reports committed expiry and exact recovery`,
        async () => {
          const h = await localRpcHarness(
            `issue-82-${manual ? "manual" : "auto"}`,
          );
          async function actor() {
            const signer = await h.fundedSigner();
            const agentId = id32();
            const [agent] = await sdk.findAgentPda({ agentId });
            await h.send("register", signer, [
              await sdk.facade.registerAgent({
                authority: signer,
                agentId,
                capabilities: 1n,
                endpoint: "https://example.invalid/82",
                metadataUri: null,
                stakeAmount: h.config.minAgentStake,
              }),
            ]);
            return { signer, agent };
          }
          const creator = await actor();
          const workers = [await actor()];
          if (manual) workers.push(await actor());
          const crank = await h.fundedSigner();
          const taskId = id32();
          const [task] = await sdk.findTaskPda({
            creator: creator.signer.address,
            taskId,
          });
          const [escrow] = await sdk.findEscrowPda({ task });
          const [validation] = await sdk.findTaskValidationConfigPda({ task });
          const reward = 1_000_000n;
          await h.send("fund task", creator.signer, [
            await sdk.facade.createTask({
              taskId,
              creator: creator.signer,
              authority: creator.signer,
              creatorAgent: creator.agent,
              requiredCapabilities: 1n,
              description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
              rewardAmount: reward,
              maxWorkers: workers.length,
              deadline: (await h.clock()) + 60n,
              taskType: manual ? 1 : 0,
              constraintHash: null,
              minReputation: 0,
              rewardMintArg: null,
            }),
          ]);
          if (manual) {
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
          }
          const jobSpecHash = id32();
          await h.send("CLEAN task", h.moderator, [
            await sdk.facade.recordTaskModeration({
              task,
              moderator: h.moderator,
              jobSpecHash,
              status: 0,
              riskScore: 0,
              categoryMask: 0n,
              policyHash: id32(),
              scannerHash: id32(),
              expiresAt: 0n,
            }),
          ]);
          await h.send("publish", creator.signer, [
            await sdk.facade.setTaskJobSpec({
              task,
              creator: creator.signer,
              jobSpecHash,
              jobSpecUri: "agenc://job-spec/82",
              moderator: h.moderator.address,
            }),
          ]);
          const [moderationBlock] = await sdk.findModerationBlockPda({
            contentHash: jobSpecHash,
          });
          for (const worker of workers) {
            await h.send("claim", worker.signer, [
              await sdk.facade.claimTaskWithJobSpec({
                task,
                worker: worker.agent,
                authority: worker.signer,
                moderationBlock,
              }),
            ]);
          }
          async function expire(
            worker: typeof creator,
            authority: KeyPairSigner,
          ) {
            return sdk.facade.expireClaim({
              task,
              worker: worker.agent,
              authority,
              rentRecipient: worker.signer.address,
              taskValidationConfig: manual
                ? validation
                : sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
              workerCompletionBond: (
                await sdk.findWorkerCompletionBondPda({
                  task,
                  workerAuthority: worker.signer.address,
                })
              )[0],
              bondCreator: creator.signer.address,
              treasury: h.config.treasury,
            });
          }
          const events = (logs: readonly string[]) =>
            sdk
              .parseAgencCoordinationEvents(logs)
              .filter((event) => event.eventName === "TaskClaimExpired");
          const tooEarly = await h.reject(
            "claim cannot expire early",
            crank,
            [await expire(workers[0]!, crank)],
            sdk.AGENC_COORDINATION_ERROR__CLAIM_NOT_EXPIRED,
          );
          expect(events(tooEarly.meta!.logMessages ?? [])).toEqual([]);

          // New tasks require a positive deadline, and production claim expiry adds
          // a one-hour completion buffer. Wait for actual validator time; do not
          // rewrite lifecycle accounts, warp Clock, or compile shorter constants.
          const [firstClaim] = await sdk.findClaimPda({
            task,
            bidder: workers[0]!.agent,
          });
          const firstExpiry = (
            await h.read(firstClaim, sdk.getTaskClaimDecoder())
          ).expiresAt;
          h.evidence.expiresAt = firstExpiry;
          const expiryWatchdog = Date.now() + 3_900_000;
          let lastNotice = 0;
          while ((await h.clock()) <= firstExpiry) {
            if (Date.now() > expiryWatchdog)
              throw new Error(
                "validator did not reach production claim expiry",
              );
            if (Date.now() - lastNotice >= 60_000) {
              console.log(
                `#82 ${manual ? "manual" : "auto"}: waiting for actual validator claim expiry ${firstExpiry}; now ${await h.clock()}`,
              );
              lastNotice = Date.now();
            }
            await delay(1000);
          }

          // Exercise the real SDK polling subscriber against the real RPC. Two
          // watched addresses see each transaction; deduplication must yield once.
          const seen: sdk.AgencEvent[] = [];
          const abort = new AbortController();
          const baselined = new Set<string>();
          // Adapt the public subscriber's string cursors to Kit's branded types;
          // every request still goes to the running validator.
          const watchedRpc: sdk.MarketplaceEventsPollingRpc = {
            getSignaturesForAddress(account, config) {
              const request = h.rpc.getSignaturesForAddress(account, {
                commitment: "confirmed",
                until: config?.until ? signature(config.until) : undefined,
                before: config?.before ? signature(config.before) : undefined,
              });
              return {
                async send(options) {
                  const result = await request.send(options);
                  baselined.add(account);
                  return result;
                },
              };
            },
            getTransaction(sig, config) {
              return h.rpc.getTransaction(signature(sig), {
                encoding: "json",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              });
            },
          };
          const listener = (async () => {
            for await (const event of sdk.subscribeMarketplaceEventsViaPolling(
              watchedRpc,
              {
                addresses: [task, escrow],
                events: ["TaskClaimExpired"],
                abortSignal: abort.signal,
                pollIntervalMs: 500,
              },
            ))
              seen.push(event);
          })();
          // Attach immediately so a subscription error cannot become unhandled.
          let listenerError: unknown;
          const listening = listener.catch((error: unknown) => {
            listenerError = error;
          });
          async function waitUntil(
            predicate: () => boolean | Promise<boolean>,
            timeoutMs: number,
          ) {
            const deadline = Date.now() + timeoutMs;
            while (!(await predicate())) {
              if (listenerError) throw listenerError;
              if (Date.now() > deadline)
                throw new Error("RPC expiry observation timed out");
              await delay(100);
            }
          }
          try {
            await waitUntil(() => baselined.size === 2, 10_000);
            for (const [index, worker] of workers.entries()) {
              const [claim] = await sdk.findClaimPda({
                task,
                bidder: worker.agent,
              });
              const [stats] = await sdk.findExpireClaimAgentStatsPda({
                worker: worker.agent,
              });
              const state = await h.read(claim, sdk.getTaskClaimDecoder());
              await waitUntil(
                async () => (await h.clock()) > state.expiresAt,
                90_000,
              );
              const noGrace = await h.reject(
                "third party cannot expire during worker grace",
                crank,
                [await expire(worker, crank)],
                sdk.AGENC_COORDINATION_ERROR__GRACE_PERIOD_NOT_PASSED,
              );
              expect(events(noGrace.meta!.logMessages ?? [])).toEqual([]);
              const caller = index === 0 ? worker.signer : crank;
              if (index > 0) {
                await waitUntil(
                  async () => (await h.clock()) > state.expiresAt + 60n,
                  90_000,
                );
              }
              const ix = await expire(worker, caller);
              const accounts = [task, escrow, claim, worker.agent, stats];
              const beforeRollback = await Promise.all(accounts.map(h.info));
              // The first instruction emits, the duplicate fails, and Solana rolls
              // everything back. Consumers must ignore even well-formed log events
              // from this failed transaction (not just reject malformed payloads).
              const rolledBack = await h.reject(
                "atomic duplicate expiry rolls back",
                caller,
                [ix, ix],
                3012,
              );
              expect(events(rolledBack.meta!.logMessages ?? [])).toHaveLength(
                1,
              );
              expect(await Promise.all(accounts.map(h.info))).toEqual(
                beforeRollback,
              );
              await delay(1200);
              expect(seen).toHaveLength(index);

              const claimRent = (await h.info(claim))!.lamports;
              const statsBefore = (await h.info(stats))?.lamports ?? 0n;
              const callerBefore = await h.balance(caller.address);
              const workerBefore = await h.balance(worker.signer.address);
              const escrowBefore = await h.info(escrow);
              const completed = await h.send("expire once", caller, [ix]);
              const decoded = events(completed.meta!.logMessages ?? []);
              expect(decoded).toHaveLength(1);
              const event = decoded[0]!.data;
              const after = await h.read(task, sdk.getTaskDecoder());
              expect(event).toMatchObject({
                task,
                worker: worker.agent,
                expiredBy: caller.address,
                cleanupReward: 1000n,
                taskReopened: index === workers.length - 1,
              });
              expect(event.timestamp).toBeGreaterThan(state.expiresAt);
              expect(event.timestamp).toBeLessThanOrEqual(await h.clock());
              expect(event.taskReopened).toBe(
                after.status === sdk.TaskStatus.Open,
              );
              expect(after.currentWorkers).toBe(workers.length - index - 1);
              expect(
                (await h.read(worker.agent, sdk.getAgentRegistrationDecoder()))
                  .activeTasks,
              ).toBe(0);
              expect(await h.info(claim)).toBeNull();
              const newStatsRent =
                (await h.info(stats))!.lamports - statsBefore;
              expect(await h.balance(caller.address)).toBe(
                callerBefore +
                  event.cleanupReward +
                  (caller.address === worker.signer.address ? claimRent : 0n) -
                  newStatsRent -
                  completed.meta!.fee,
              );
              if (caller.address !== worker.signer.address) {
                expect(await h.balance(worker.signer.address)).toBe(
                  workerBefore + claimRent,
                );
              }
              expect((await h.info(escrow))!.lamports).toBe(
                escrowBefore!.lamports - event.cleanupReward,
              );
              expect(
                (await h.read(escrow, sdk.getTaskEscrowDecoder())).distributed,
              ).toBe(BigInt(index + 1) * 1000n);
              await waitUntil(() => seen.length === index + 1, 10_000);
              expect(seen[index]).toEqual(decoded[0]);
              const replay = await h.reject(
                "closed claim cannot expire twice",
                caller,
                [ix],
                3012,
              );
              expect(events(replay.meta!.logMessages ?? [])).toEqual([]);
            }
            await delay(1200);
            expect(seen).toHaveLength(workers.length);
            h.evidence.assertions = {
              emittedEventsMatchStateAndPayouts: true,
              prematureAndGraceExpiryRejected: true,
              rolledBackEventsExcludedFromSubscriber: true,
              duplicateWatchesYieldExactlyOnce: true,
              repeatedExpiryRejected: true,
            };
            h.evidence.expiryEvents = seen;
            h.finish();
          } finally {
            abort.abort();
            await listening;
            if (listenerError) throw listenerError;
          }
        },
        4_200_000,
      );
    }
  },
);
