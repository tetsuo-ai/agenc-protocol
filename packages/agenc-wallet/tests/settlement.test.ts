// Reading which agent a finished job paid from the transaction that settled
// it: only the program's own settlement of that very job counts, and only
// when the transaction went through.
import { describe, expect, it } from "vitest";
import { getAddressDecoder, getBase58Decoder, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getAcceptTaskResultInstructionDataEncoder,
  getAutoAcceptTaskResultInstructionDataEncoder,
  getCloseTaskInstructionDataEncoder,
  getCompleteTaskInstructionDataEncoder,
} from "@tetsuo-ai/marketplace-sdk";
import {
  readSettlementWorker,
  settlementOf,
  settlementWorkerIn,
  type SentInstruction,
  type SettlementHistoryRpc,
} from "../src/settlement.js";

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
