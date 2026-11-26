// rt8-b: a service's setup sends read "Other change" in the wallet history.
import { expect, it } from "vitest";
import { classifyChange } from "../src/money-history.js";
import type { WalletState } from "../src/store.js";

const change = (signature: string) => ({ signature, account: "A", delta: "-5000000", payerFee: "5000", at: 1, externalSender: null, failed: false });

it("names a service's listing, change and safety check sends", () => {
  const state = { jobs: {}, moneyOperations: {}, agents: { a1: { earn: { offers: [
    { id: "o1", signatures: { create: "sigCreate", approval: "sigCheck" } },
  ] } } } } as unknown as WalletState;
  expect(classifyChange(state, change("sigCreate"), new Set()).kind).toBe("service setup");
  expect(classifyChange(state, change("sigCheck"), new Set()).kind).toBe("service setup");
  expect(classifyChange(state, change("sigElse"), new Set()).kind).toBe("other");
});

it("names what the wallet sent itself and the worker's own marketplace steps", async () => {
  const { recordSent } = await import("../src/sent-records.js");
  const state = { jobs: {}, moneyOperations: {}, agents: {} } as unknown as WalletState;
  recordSent(state, "sigFund", { kind: "funding", agentId: "a1", at: 1 });
  recordSent(state, "sigClaim", { kind: "claim", agentId: "a1", jobId: "T1", at: 2 });
  recordSent(state, "sigSubmit", { kind: "submit", agentId: "a1", jobId: "T1", at: 3 });
  expect(classifyChange(state, change("sigFund"), new Set()).kind).toBe("transfer");
  expect(classifyChange(state, change("sigClaim"), new Set())).toMatchObject({ kind: "job claim", jobId: "T1" });
  expect(classifyChange(state, change("sigSubmit"), new Set()).kind).toBe("job delivery");
  expect(classifyChange(state, { ...change("sigReg"), step: "registration" }, new Set()).kind).toBe("registration");
});

it("reads the marketplace step from the account's own receipt", async () => {
  const { instructionKind } = await import("../src/sent-records.js");
  const sdk = await import("@tetsuo-ai/marketplace-sdk");
  const { getBase58Decoder } = await import("@solana/kit");
  const ix = (tag: ArrayLike<number>, programId: string = sdk.AGENC_COORDINATION_PROGRAM_ADDRESS) =>
    ({ programId, data: getBase58Decoder().decode(new Uint8Array([...Array.from(tag), 1, 2, 3])) });
  expect(instructionKind([ix(sdk.REGISTER_AGENT_DISCRIMINATOR)])).toBe("registration");
  expect(instructionKind([{ parsed: {}, programId: "11111111111111111111111111111111" }, ix(sdk.CLAIM_TASK_DISCRIMINATOR)])).toBe("job claim");
  expect(instructionKind([ix(sdk.SUBMIT_TASK_RESULT_DISCRIMINATOR)])).toBe("job delivery");
  expect(instructionKind([ix(sdk.CLAIM_TASK_DISCRIMINATOR, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")])).toBeNull();
  expect(instructionKind([ix(sdk.CREATE_TASK_DISCRIMINATOR)])).toBeNull();
});

it("names a dispute's bond and deposit, from the wallet's record or from the receipt (rt14-a)", async () => {
  const { instructionKind, recordSent } = await import("../src/sent-records.js");
  const sdk = await import("@tetsuo-ai/marketplace-sdk");
  const { getBase58Decoder } = await import("@solana/kit");
  const data = getBase58Decoder().decode(new Uint8Array([...sdk.DISPUTE_REJECTION_DISCRIMINATOR, 1, 2]));
  expect(instructionKind([{ programId: sdk.AGENC_COORDINATION_PROGRAM_ADDRESS, data }])).toBe("dispute");
  const state = { jobs: {}, agents: {}, moneyOperations: {} } as unknown as WalletState;
  recordSent(state, "sig-dispute", { kind: "dispute", agentId: "a1", jobId: "job-1", at: 1 });
  const row = classifyChange(state, { signature: "sig-dispute", account: "acct", delta: "-12190440", payerFee: "5000", failed: false, at: 1, externalSender: null }, new Set());
  expect(row).toMatchObject({ kind: "dispute", jobId: "job-1" });
});
