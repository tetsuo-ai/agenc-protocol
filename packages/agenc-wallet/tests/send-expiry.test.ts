// The proof that a saved signed transaction never landed and never can. It
// releases a payer and an allowance, so every doubt must answer "not proven".
import { expect, it } from "vitest";
import {
  appendTransactionMessageInstruction, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type Blockhash, type Instruction, type RpcTransport,
} from "@solana/kit";
import { createRpcChain, transferInstruction } from "../src/chain.js";
import type { PendingListingSend } from "../src/transport-scope.js";

const LAST_VALID = 250;
const HASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Blockhash;

async function signed(first?: (payer: Address) => Instruction): Promise<PendingListingSend & { payer: Address }> {
  const payer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: HASH, lastValidBlockHeight: BigInt(LAST_VALID) }, m),
    m => first ? appendTransactionMessageInstruction(first(payer.address), m) : m,
    m => appendTransactionMessageInstruction(transferInstruction(payer, payer.address, 1n), m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  return { signature: getSignatureFromTransaction(tx), lastValidBlockHeight: String(LAST_VALID),
    signedTransaction: getBase64EncodedWireTransaction(tx), payer: payer.address };
}

interface Node {
  /** Finalized tip. */
  slot: number; height: number;
  blockhashValid: boolean;
  status: unknown;
  /** The payer's history, newest first. */
  history: Array<{ signature: string; slot: number }>;
  /** Block height by slot; a missing slot is a block the node no longer has. */
  blocks: Record<number, number>;
  down?: string;
}

function chainOn(node: Node) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899", transport: (async config => {
    const { id, method, params } = config.payload as { id: string; method: string; params: unknown[] };
    calls.push({ method, params });
    if (node.down === method) throw new Error("fetch failed");
    const option = (params.at(-1) ?? {}) as { before?: string; limit?: number };
    const from = option.before ? node.history.findIndex(row => row.signature === option.before) + 1 : 0;
    const result =
      method === "getEpochInfo" ? { absoluteSlot: node.slot, blockHeight: node.height } :
      method === "isBlockhashValid" ? { context: { slot: node.slot }, value: node.blockhashValid } :
      method === "getSignatureStatuses" ? { context: { slot: node.slot }, value: [node.status] } :
      method === "getSignaturesForAddress" ? node.history.slice(from, from + Number(option.limit)).map(row => ({ ...row, err: null, memo: null, blockTime: null, confirmationStatus: "finalized" })) :
      method === "getBlock" ? (node.blocks[Number(params[0])] === undefined ? null : { blockHeight: node.blocks[Number(params[0])], blockhash: HASH, previousBlockhash: HASH, parentSlot: 0, blockTime: null }) :
      undefined;
    if (result === undefined) throw new Error("unexpected " + method);
    return { jsonrpc: "2.0", id, result };
  }) as RpcTransport });
  return { chain, calls };
}

/** A node that proves expiry: the tip is past the last valid height and the payer's history starts before signing. */
const expired = (): Node => ({ slot: 9000, height: LAST_VALID + 1, blockhashValid: false, status: null,
  history: [{ signature: "older", slot: 700 }], blocks: { 700: LAST_VALID - 150 } });

it("proves expiry on finalized state at one slot, with history reaching back before signing", async () => {
  const receipt = await signed();
  const { chain, calls } = chainOn(expired());
  expect(await chain.sendNeverLands!(receipt)).toBe(true);
  const options = (method: string) => (calls.find(call => call.method === method)!.params.at(-1) ?? {}) as Record<string, unknown>;
  // The client leaves out "finalized" because it is the node's default: no weaker level is ever named.
  for (const call of calls) {
    const named = (call.params.at(-1) as { commitment?: string } | undefined)?.commitment;
    if (call.method !== "getSignatureStatuses") expect([call.method, named ?? "finalized"]).toEqual([call.method, "finalized"]);
  }
  for (const method of ["isBlockhashValid", "getSignaturesForAddress"]) expect(Number(options(method).minContextSlot)).toBe(9000);
  expect(calls.find(call => call.method === "getSignaturesForAddress")!.params[0]).toBe(receipt.payer);
  expect(options("getSignatureStatuses")).toMatchObject({ searchTransactionHistory: true });
});

it.each<[string, (node: Node) => void]>([
  ["the finalized height has not passed the last valid height", node => { node.height = LAST_VALID; }],
  ["the blockhash is still valid", node => { node.blockhashValid = true; }],
  ["the signature has a status, even an unconfirmed one", node => { node.status = { confirmationStatus: "processed", err: null }; }],
  ["the node has no history for the payer (pruned)", node => { node.history = []; }],
  ["the payer's history starts after the transaction could first land", node => { node.blocks[700] = LAST_VALID - 149; }],
  ["the witness block is gone from the node", node => { node.blocks = {}; }],
])("does not prove expiry when %s", async (_name, change) => {
  const node = expired();
  change(node);
  expect(await chainOn(node).chain.sendNeverLands!(await signed())).toBe(false);
});

it("does not prove expiry when the payer's history names the signature the status lookup missed", async () => {
  const receipt = await signed();
  const node = expired();
  node.history.unshift({ signature: receipt.signature, slot: 8000 });
  expect(await chainOn(node).chain.sendNeverLands!(receipt)).toBe(false);
});

it("reads the payer's history page by page until it reaches a block from before signing", async () => {
  const receipt = await signed();
  const node = expired();
  node.history = Array.from({ length: 30 }, (_, n) => ({ signature: "s" + n, slot: 8000 - n }));
  for (const row of node.history) node.blocks[row.slot] = LAST_VALID - 100;
  // Thirty newer transactions and nothing older: the history proves nothing.
  expect(await chainOn(node).chain.sendNeverLands!(receipt)).toBe(false);
  node.history.push({ signature: "older", slot: 700 });
  node.blocks[700] = LAST_VALID - 151;
  const { chain, calls } = chainOn(node);
  expect(await chain.sendNeverLands!(receipt)).toBe(true);
  const pages = calls.filter(call => call.method === "getSignaturesForAddress").map(call => (call.params[1] as { before?: string }).before);
  expect(pages).toEqual([undefined, "s24"]);
  // The signature on a later page is found too.
  node.history.splice(27, 0, { signature: receipt.signature, slot: 7973 });
  expect(await chainOn(node).chain.sendNeverLands!(receipt)).toBe(false);
});

it("proves nothing without the saved bytes, for other bytes, or for a durable nonce", async () => {
  const receipt = await signed();
  const { signedTransaction: _bytes, ...bare } = receipt;
  expect(await chainOn(expired()).chain.sendNeverLands!(bare)).toBe(false);
  expect(await chainOn(expired()).chain.sendNeverLands!({ ...receipt, signature: (await signed()).signature })).toBe(false);
  const nonce = await signed(payer => ({ programAddress: "11111111111111111111111111111111" as Address,
    accounts: [{ address: payer, role: 1 }], data: new Uint8Array([4, 0, 0, 0]) }));
  expect(await chainOn(expired()).chain.sendNeverLands!(nonce)).toBe(false);
});

it.each(["getEpochInfo", "isBlockhashValid", "getSignatureStatuses", "getSignaturesForAddress", "getBlock"])(
  "fails closed when %s cannot be reached", async method => {
    const node = { ...expired(), down: method };
    await expect(chainOn(node).chain.sendNeverLands!(await signed())).rejects.toThrow();
  });

it("settles an approved funding decision as failed only on that proof", async () => {
  const receipt = await signed();
  const decision = { ...receipt, operation: { kind: "funding", decision: {}, lamports: "1", text: "", mainBalance: "2", priorObservation: null } } as unknown as PendingListingSend;
  expect(await chainOn(expired()).chain.listingSendOutcome!(decision)).toBe("failed");
  // Height passed at "confirmed" and no status, but no proof: it stays pending.
  expect(await chainOn({ ...expired(), history: [] }).chain.listingSendOutcome!(decision)).toBe("pending");
  expect(await chainOn({ ...expired(), down: "getSignaturesForAddress" }).chain.listingSendOutcome!(decision)).toBe("pending");
  const { signedTransaction: _bytes, ...bare } = decision;
  expect(await chainOn(expired()).chain.listingSendOutcome!(bare)).toBe("pending");
  expect(await chainOn({ ...expired(), status: { confirmationStatus: "finalized", err: null } }).chain.listingSendOutcome!(decision)).toBe("landed");
});
