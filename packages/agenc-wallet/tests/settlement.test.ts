// Reading which agent a finished job paid from the transaction that settled
// it: only the program's own settlement of that very job counts, and only
// when the transaction went through.
import { describe, expect, it } from "vitest";
import {
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBytesEncoder,
  getI64Encoder,
  getOptionEncoder,
  getStructEncoder,
  getU16Encoder,
  getU64Encoder,
  type Address,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findTaskPda,
  OPERATOR_FEE_PAID_EVENT_DISCRIMINATOR,
  REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR,
  SERVICE_LISTING_HIRED_EVENT_DISCRIMINATOR,
  TASK_COMPLETED_EVENT_DISCRIMINATOR,
  getAcceptTaskResultInstructionDataEncoder,
  getAutoAcceptTaskResultInstructionDataEncoder,
  getCloseTaskInstructionDataEncoder,
  getCompleteTaskInstructionDataEncoder,
} from "@tetsuo-ai/marketplace-sdk";
import {
  readSettlementFacts,
  readSettlementWorker,
  settlementFactsIn,
  settlementOf,
  settlementWorkerIn,
  type SentInstruction,
  type SettlementHistoryRpc,
} from "../src/settlement.js";

import { readSettledDelivery, settledDeliveryFromLogs } from "../src/delivery-history.js";

const PROGRAM = AGENC_COORDINATION_PROGRAM_ADDRESS;
const at = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const TASK = at(1);
const WORKER = at(2);
const OTHER_TASK = at(3);

/** `count` accounts with the job first and the agent at `workerAt`. */
function accounts(count: number, workerAt: number, task: Address = TASK): Address[] {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? task : index === workerAt ? WORKER : at(100 + index),
  );
}

const accept = (task: Address = TASK): SentInstruction => ({
  programAddress: PROGRAM,
  accounts: accounts(21, 5, task),
  data: Uint8Array.from(getAcceptTaskResultInstructionDataEncoder().encode({})),
});
const autoAccept = (): SentInstruction => ({
  programAddress: PROGRAM,
  accounts: accounts(22, 5),
  data: Uint8Array.from(getAutoAcceptTaskResultInstructionDataEncoder().encode({})),
});
const complete = (): SentInstruction => ({
  programAddress: PROGRAM,
  accounts: accounts(19, 4),
  data: Uint8Array.from(
    getCompleteTaskInstructionDataEncoder().encode({ proofHash: new Uint8Array(32).fill(7), resultData: null }),
  ),
});
const tidy = (): SentInstruction => ({
  programAddress: PROGRAM,
  accounts: accounts(9, 99),
  data: Uint8Array.from(getCloseTaskInstructionDataEncoder().encode({})),
});

/** An instruction as JSON-RPC sends one of a program it cannot read. */
const asSent = (instruction: SentInstruction) => ({
  programId: instruction.programAddress,
  accounts: instruction.accounts,
  data: getBase58Decoder().decode(instruction.data),
  stackHeight: null,
});

/** A "jsonParsed" getTransaction answer. */
function answer(
  instructions: unknown[],
  options: { err?: unknown; signature?: string; inner?: unknown[] } = {},
): unknown {
  return {
    meta: {
      err: options.err ?? null,
      innerInstructions: options.inner === undefined ? [] : [{ index: 0, instructions: options.inner }],
    },
    transaction: {
      signatures: [options.signature ?? "settled"],
      message: { accountKeys: [], instructions },
    },
  };
}

describe("a settlement's instruction", () => {
  it("names the job and the agent an approval, a late approval or a job without review paid", () => {
    for (const instruction of [accept(), autoAccept(), complete()]) {
      expect(settlementOf(instruction)).toEqual({ task: TASK, worker: WORKER });
    }
  });

  it("settles nothing when it is another instruction, another program's, or short of accounts", () => {
    expect(settlementOf(tidy())).toBeNull();
    expect(settlementOf({ ...accept(), programAddress: at(9) })).toBeNull();
    expect(settlementOf({ ...accept(), accounts: accept().accounts.slice(0, 20) })).toBeNull();
    expect(settlementOf({ ...accept(), data: Uint8Array.of(1, 2, 3) })).toBeNull();
  });
});

describe("a settlement's transaction", () => {
  it("says which agent it paid for the job asked about", () => {
    expect(settlementWorkerIn(answer([asSent(tidy()), asSent(accept())]), TASK, "settled")).toBe(WORKER);
    // A settlement another program asked for counts the same.
    expect(settlementWorkerIn(answer([], { inner: [asSent(accept())] }), TASK, "settled")).toBe(WORKER);
  });

  it("says nothing when it failed, is another transaction, or settles another job", () => {
    expect(settlementWorkerIn(answer([asSent(accept())], { err: { InstructionError: [0, "Custom"] } }), TASK, "settled")).toBeNull();
    expect(settlementWorkerIn(answer([asSent(accept())]), TASK, "another")).toBeNull();
    expect(settlementWorkerIn(answer([asSent(accept(OTHER_TASK))]), TASK, "settled")).toBeNull();
    // Instructions the endpoint read itself (a transfer, say) are not the program's.
    expect(settlementWorkerIn(answer([{ program: "system", programId: at(0), parsed: {} }]), TASK, "settled")).toBeNull();
    expect(settlementWorkerIn(null, TASK, "settled")).toBeNull();
  });
});

describe("a job's history", () => {
  function history(entries: Array<{ signature: string; err?: unknown; transaction: unknown }>) {
    const fetched: string[] = [];
    const rpc: SettlementHistoryRpc = {
      getSignaturesForAddress: () => ({
        send: async () => entries.map((entry) => ({ signature: entry.signature, err: entry.err ?? null })),
      }),
      getTransaction: (signature) => ({
        send: async () => {
          fetched.push(signature);
          return entries.find((entry) => entry.signature === signature)?.transaction ?? null;
        },
      }),
    };
    return { rpc, fetched };
  }

  it("is read newest first until the settlement, skipping transactions that failed", async () => {
    const { rpc, fetched } = history([
      { signature: "tidied", transaction: answer([asSent(tidy())], { signature: "tidied" }) },
      { signature: "failed", err: { InstructionError: [0, "Custom"] }, transaction: null },
      { signature: "settled", transaction: answer([asSent(accept())], { signature: "settled" }) },
      { signature: "claimed", transaction: answer([], { signature: "claimed" }) },
    ]);
    expect(await readSettlementWorker(rpc, TASK)).toBe(WORKER);
    expect(fetched).toEqual(["tidied", "settled"]);
  });

  it("names nobody when none of it settles the job", async () => {
    const { rpc } = history([{ signature: "tidied", transaction: answer([asSent(tidy())], { signature: "tidied" }) }]);
    expect(await readSettlementWorker(rpc, TASK)).toBeNull();
  });
});

// Revision 9: a tidied job's record is compacted into a marker without its
// price, so what it paid is read from the events the program logged when it
// settled, and its service from the event of its hire.
const BUYER = at(4);
const TASK_ID = new Uint8Array(32).fill(9);
const LISTING = at(5);
const [PAID_TASK] = await findTaskPda({ creator: BUYER, taskId: TASK_ID });

function eventLine(discriminator: ArrayLike<number>, payload: Uint8Array): string {
  const bytes = new Uint8Array(8 + payload.length);
  bytes.set(discriminator, 0);
  bytes.set(payload, 8);
  return `Program data: ${Buffer.from(bytes).toString("base64")}`;
}

const rewardPayload = (taskId: Uint8Array, recipient: Address, amount: bigint, fee: bigint) =>
  Uint8Array.from(
    getStructEncoder([
      ["taskId", fixEncoderSize(getBytesEncoder(), 32)],
      ["recipient", getAddressEncoder()],
      ["amount", getU64Encoder()],
      ["protocolFee", getU64Encoder()],
      ["timestamp", getI64Encoder()],
    ]).encode({ taskId, recipient, amount, protocolFee: fee, timestamp: 1n }),
  );

const operatorPayload = (taskId: Uint8Array, amount: bigint) =>
  Uint8Array.from(
    getStructEncoder([
      ["taskId", fixEncoderSize(getBytesEncoder(), 32)],
      ["operator", getAddressEncoder()],
      ["amount", getU64Encoder()],
      ["operatorFeeBps", getU16Encoder()],
      ["timestamp", getI64Encoder()],
    ]).encode({ taskId, operator: at(6), amount, operatorFeeBps: 100, timestamp: 1n }),
  );

const hiredPayload = (task: Address, buyer: Address, provider: Address) =>
  Uint8Array.from(
    getStructEncoder([
      ["listing", getAddressEncoder()],
      ["task", getAddressEncoder()],
      ["providerAgent", getAddressEncoder()],
      ["buyer", getAddressEncoder()],
      ["price", getU64Encoder()],
      ["totalHires", getU64Encoder()],
      ["openJobs", getU16Encoder()],
      ["moderationAttestor", getOptionEncoder(getAddressEncoder())],
      ["timestamp", getI64Encoder()],
    ]).encode({
      listing: LISTING,
      task,
      providerAgent: provider,
      buyer,
      price: 2_000_000n,
      totalHires: 1n,
      openJobs: 1,
      moderationAttestor: null,
      timestamp: 1n,
    }),
  );

/** Lines the program itself logged, inside its own invocation. */
const byProgram = (...lines: string[]) => [`Program ${PROGRAM} invoke [1]`, ...lines, `Program ${PROGRAM} success`];

function paidAnswer(logs: string[], signature = "settled", task: Address = PAID_TASK): unknown {
  const settled = answer([asSent(accept(task))], { signature }) as { meta: Record<string, unknown> };
  settled.meta.logMessages = logs;
  return settled;
}

describe("what a settlement paid (revision 9)", () => {
  it("is the agent's share, the fee and any operator share, from the program's own events", async () => {
    const logs = byProgram(
      eventLine(REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR, rewardPayload(TASK_ID, WORKER, 1_850_000n, 100_000n)),
      eventLine(OPERATOR_FEE_PAID_EVENT_DISCRIMINATOR, operatorPayload(TASK_ID, 50_000n)),
    );
    expect(await settlementFactsIn(paidAnswer(logs), PAID_TASK, "settled", BUYER)).toEqual({
      worker: WORKER,
      priceLamports: 2_000_000n,
      feeLamports: 100_000n,
      listing: null,
    });
  });

  it("counts nothing another program logged, nor an event of another job or another agent", async () => {
    const reward = eventLine(REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR, rewardPayload(TASK_ID, WORKER, 1n, 1n));
    const foreign = [`Program ${at(7)} invoke [1]`, reward, `Program ${at(7)} success`];
    expect(await settlementFactsIn(paidAnswer(foreign), PAID_TASK, "settled", BUYER)).toBeNull();
    const otherJob = byProgram(
      eventLine(REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR, rewardPayload(new Uint8Array(32).fill(8), WORKER, 1n, 1n)),
    );
    expect(await settlementFactsIn(paidAnswer(otherJob), PAID_TASK, "settled", BUYER)).toBeNull();
    const otherAgent = byProgram(
      eventLine(REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR, rewardPayload(TASK_ID, at(8), 1n, 1n)),
    );
    expect(await settlementFactsIn(paidAnswer(otherAgent), PAID_TASK, "settled", BUYER)).toBeNull();
    // Another buyer gives another job address for the same id.
    const logs = byProgram(reward);
    expect(await settlementFactsIn(paidAnswer(logs), PAID_TASK, "settled", at(9))).toBeNull();
  });

  it("names the service its hire's event names, reading back only when asked", async () => {
    const settledLogs = byProgram(
      eventLine(REWARD_DISTRIBUTED_EVENT_DISCRIMINATOR, rewardPayload(TASK_ID, WORKER, 1_900_000n, 100_000n)),
    );
    const hiredLogs = byProgram(eventLine(SERVICE_LISTING_HIRED_EVENT_DISCRIMINATOR, hiredPayload(PAID_TASK, BUYER, WORKER)));
    const entries = [
      { signature: "tidied", transaction: answer([asSent(tidy())], { signature: "tidied" }) },
      { signature: "settled", transaction: paidAnswer(settledLogs) },
      { signature: "hired", transaction: { ...(answer([], { signature: "hired" }) as object), meta: { err: null, logMessages: hiredLogs } } },
    ];
    const fetched: string[] = [];
    const rpc: SettlementHistoryRpc = {
      getSignaturesForAddress: () => ({
        send: async () => entries.map((entry) => ({ signature: entry.signature, err: null })),
      }),
      getTransaction: (signature) => ({
        send: async () => {
          fetched.push(signature);
          return entries.find((entry) => entry.signature === signature)?.transaction ?? null;
        },
      }),
    };
    expect(await readSettlementFacts(rpc, PAID_TASK, BUYER)).toMatchObject({ listing: null, priceLamports: 2_000_000n });
    expect(fetched).toEqual(["tidied", "settled"]);
    fetched.length = 0;
    expect(await readSettlementFacts(rpc, PAID_TASK, BUYER, { listing: true })).toMatchObject({
      worker: WORKER,
      listing: LISTING,
    });
    expect(fetched).toEqual(["tidied", "settled", "hired"]);
  });
});


describe("delivery recovery after automatic payment", () => {
  const proofHash = new Uint8Array(32).fill(7);
  const resultData = new Uint8Array(64).fill(8);
  const completed = (taskId = TASK_ID, worker = WORKER) => eventLine(TASK_COMPLETED_EVENT_DISCRIMINATOR,
    Uint8Array.from(getStructEncoder([
      ["taskId", fixEncoderSize(getBytesEncoder(), 32)], ["worker", getAddressEncoder()],
      ["proofHash", fixEncoderSize(getBytesEncoder(), 32)], ["resultData", fixEncoderSize(getBytesEncoder(), 64)],
      ["rewardPaid", getU64Encoder()], ["timestamp", getI64Encoder()],
    ]).encode({ taskId, worker, proofHash, resultData, rewardPaid: 1900000n, timestamp: 1n })),
  );

  it("recovers a commitment from the matching successful settlement transaction", async () => {
    const rpc: SettlementHistoryRpc = {
      getSignaturesForAddress: () => ({ send: async () => [{ signature: "settled", err: null }] }),
      getTransaction: () => ({ send: async () => paidAnswer(byProgram(completed())) }),
    };
    expect(await readSettledDelivery(rpc, PAID_TASK, BUYER)).toEqual({
      worker: WORKER, proofHashHex: Buffer.from(proofHash).toString("hex"), resultData,
    });
    rpc.getTransaction = () => ({ send: async () => paidAnswer(byProgram(completed()), "different") });
    expect(await readSettledDelivery(rpc, PAID_TASK, BUYER)).toBeNull();
  });

  it("rejects another program, task, buyer, worker or failed transaction", async () => {
    const foreign = [`Program ${at(7)} invoke [1]`, completed(), `Program ${at(7)} success`];
    expect(await settledDeliveryFromLogs(foreign, PAID_TASK, BUYER, WORKER)).toBeNull();
    expect(await settledDeliveryFromLogs(byProgram(completed(new Uint8Array(32).fill(30))), PAID_TASK, BUYER, WORKER)).toBeNull();
    expect(await settledDeliveryFromLogs(byProgram(completed()), PAID_TASK, at(9), WORKER)).toBeNull();
    expect(await settledDeliveryFromLogs(byProgram(completed(TASK_ID, at(9))), PAID_TASK, BUYER, WORKER)).toBeNull();
    const failed = paidAnswer(byProgram(completed())) as { meta: Record<string, unknown> };
    failed.meta.err = { InstructionError: [0, "Custom"] };
    const rpc: SettlementHistoryRpc = {
      getSignaturesForAddress: () => ({ send: async () => [{ signature: "settled", err: null }] }),
      getTransaction: () => ({ send: async () => failed }),
    };
    expect(await readSettledDelivery(rpc, PAID_TASK, BUYER)).toBeNull();
  });
});
