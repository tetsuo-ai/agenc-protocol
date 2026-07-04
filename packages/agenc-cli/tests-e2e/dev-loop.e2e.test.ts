// REAL on-chain execution of the `agenc dev` bot-loop core against the
// compiled agenc-coordination program in litesvm (mirroring the WP-D4
// localnet-first-hire flow): provider lists WITH an operator, moderator
// attests, buyer bot `hireAndActivate`s WITH a referrer, the reused
// @tetsuo-ai/agenc-worker runtime claims + executes (stub) + submits, the
// buyer accepts — and the asserted payoff is a completed hire whose 4-way
// split legs sum correctly with the worker keeping ≥60%.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import {
  createMarketplaceClient,
  getTaskDecoder,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import { runDevLoop, type DevActor } from "../src/bots.js";
import { formatSplitTable } from "../src/split.js";
import {
  accountData,
  freshSvm,
  fundedSigner,
  seedModerationConfig,
  seedProtocolConfig,
} from "./harness.js";
import { createLiteSvmTransport } from "./litesvm-transport.js";
import { GpaSimulator } from "./gpa-sim.js";

const REWARD = 1_000_000n; // the listing price the buyer bot escrows
const OPERATOR_FEE_BPS = 1000; // 10%
const REFERRER_FEE_BPS = 500; // 5%
const PROTOCOL_FEE_BPS = 100n; // seeded in harness ProtocolConfig (1%)

describe("e2e: the agenc dev bot loop settles a genuinely 4-way split", () => {
  it("hire -> claim -> submit -> accept with worker/operator/referrer/treasury legs", async () => {
    const svm = freshSvm();

    const admin = await fundedSigner(svm); // ProtocolConfig treasury
    await seedProtocolConfig(svm, admin.address);
    const moderatorSigner = await fundedSigner(svm);
    await seedModerationConfig(svm, admin.address, moderatorSigner.address, true);

    const buyerSigner = await fundedSigner(svm);
    const providerSigner = await fundedSigner(svm);
    // Pure payee wallets — funded so the fee legs land on rent-exempt
    // accounts (the mainnet requirement the sandbox mirrors).
    const operator = await generateKeyPairSigner();
    const referrer = await generateKeyPairSigner();
    svm.airdrop(operator.address, lamports(10_000_000n));
    svm.airdrop(referrer.address, lamports(10_000_000n));

    const transport = createLiteSvmTransport(svm);
    const actor = (signer: Awaited<ReturnType<typeof fundedSigner>>): DevActor => ({
      signer,
      client: createMarketplaceClient({ transport, signer }),
    });
    const gpa = new GpaSimulator(svm);
    const logs: string[] = [];

    const result = await runDevLoop({
      buyer: actor(buyerSigner),
      provider: actor(providerSigner),
      moderator: actor(moderatorSigner),
      operator: operator.address,
      referrer: referrer.address,
      readAccount: async (address: Address) => accountData(svm, address),
      getBalance: async (address: Address) => svm.getBalance(address) ?? 0n,
      gpa,
      stateDir: mkdtempSync(path.join(tmpdir(), "agenc-cli-e2e-")),
      log: (line) => logs.push(line),
      listing: {
        name: "agenc-cli e2e service",
        priceLamports: REWARD,
        operatorFeeBps: OPERATOR_FEE_BPS,
        referrerFeeBps: REFERRER_FEE_BPS,
      },
      registerGpaAddress: (...addresses) => gpa.register(...addresses),
      pollIntervalMs: 10, // litesvm state is synchronous — no real waiting
      timeoutMs: 30_000,
    });

    // The hire completed on-chain.
    const taskBytes = accountData(svm, result.task);
    expect(taskBytes).not.toBeNull();
    const task = getTaskDecoder().decode(taskBytes!);
    expect(task.status).toBe(TaskStatus.Completed);

    // Fee legs are bps-exact fractions of the escrowed reward.
    const legs = result.legs;
    expect(legs.operator.deltaLamports).toBe(
      (REWARD * BigInt(OPERATOR_FEE_BPS)) / 10_000n,
    );
    expect(legs.referrer.deltaLamports).toBe(
      (REWARD * BigInt(REFERRER_FEE_BPS)) / 10_000n,
    );
    // Protocol fee: positive, and never above the configured bps (reputation
    // can only discount it).
    expect(legs.treasury.deltaLamports > 0n).toBe(true);
    expect(legs.treasury.deltaLamports <= (REWARD * PROTOCOL_FEE_BPS) / 10_000n).toBe(true);

    // The worker keeps at least 60% of the reward (the program-invariant
    // floor at the fee caps), and at least the exact residual cut.
    const residual =
      REWARD -
      legs.operator.deltaLamports -
      legs.referrer.deltaLamports -
      legs.treasury.deltaLamports;
    expect(legs.worker.deltaLamports >= residual).toBe(true);
    expect(legs.worker.deltaLamports >= (REWARD * 60n) / 100n).toBe(true);
    // The result separates the worker's reward cut from its rent refunds.
    expect(result.workerRewardCutLamports).toBe(residual);
    expect(result.workerRentRefundLamports).toBe(
      legs.worker.deltaLamports - residual,
    );
    expect(result.workerRewardCutLamports >= (REWARD * 60n) / 100n).toBe(true);

    // The legs sum correctly: everything escrowed was disbursed (the worker
    // side may additionally reclaim its claim/submission account rents).
    const total =
      legs.worker.deltaLamports +
      legs.operator.deltaLamports +
      legs.referrer.deltaLamports +
      legs.treasury.deltaLamports;
    expect(total >= REWARD).toBe(true);

    // All four payees are distinct actors — a genuinely 4-way settlement.
    const payees = new Set([
      legs.worker.address,
      legs.operator.address,
      legs.referrer.address,
      legs.treasury.address,
    ]);
    expect(payees.size).toBe(4);

    // And the payoff table renders from the real deltas.
    const table = formatSplitTable(
      [legs.worker, legs.operator, legs.referrer, legs.treasury],
      result.rewardLamports,
    );
    expect(table).toContain("worker");
    expect(table).toContain("10.00%");
    expect(table).toContain("5.00%");

    // The worker bot ran through the reused agenc-worker runtime.
    expect(logs.some((line) => line.includes("worker bot: task.claimed"))).toBe(true);
    expect(logs.some((line) => line.includes("worker bot: task.submitted"))).toBe(true);
  });
});
