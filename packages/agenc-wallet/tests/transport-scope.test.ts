import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { generateKeyPairSigner, type RpcTransport } from "@solana/kit";
import { createRpcChain, transferInstruction } from "../src/chain.js";
import { createHostedServices } from "../src/services.js";
import { abortableTransport, inTransportScope, type PendingListingSend } from "../src/transport-scope.js";

function scope(timeoutMs = 30_000) {
  const controller = new AbortController();
  const pending: PendingListingSend[] = [];
  const context = {
    signal: controller.signal, timeoutMs,
    sending: (receipt: PendingListingSend) => { pending.push(receipt); },
    confirmed: (signature: string) => { pending.splice(pending.findIndex((entry) => entry.signature === signature), 1); },
  };
  return { controller, pending, run: <T>(work: () => Promise<T>) => inTransportScope(context, work) };
}
function gate() {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { entered, enter };
}

it("forwards cancellation into RPC reads and queued rate-limit waits without affecting other callers", async () => {
  const active = scope();
  const read = gate();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899", minRequestGapMs: 30_000,
    transport: (async (config) => {
      calls += 1;
      signal = config.signal;
      read.enter();
      return new Promise(() => {});
    }) as RpcTransport,
  });
  const signer = await generateKeyPairSigner();
  const first = active.run(() => chain.readAccount(signer.address));
  const rejectedFirst = expect(first).rejects.toMatchObject({ code: "NETWORK" });
  await read.entered;
  const queued = active.run(() => chain.getBalance(signer.address));
  const rejectedQueued = expect(queued).rejects.toMatchObject({ code: "NETWORK" });
  active.controller.abort();
  await Promise.all([rejectedFirst, rejectedQueued]);
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
  // A cancelled scope must not contaminate an unrelated caller.
  const independent = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899",
    transport: (async (config) => {
      expect(config.signal?.aborted).not.toBe(true);
      const { id } = config.payload as { id: string };
      return { jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 7 } };
    }) as RpcTransport,
  });
  expect(await independent.getBalance(signer.address)).toBe(7n);
});

it("journals a wire signature before a stalled RPC send, aborts HTTP and blocks late confirmation RPCs", async () => {
  const active = scope();
  const send = gate();
  let release!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const methods: string[] = [];
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899",
    transport: (async (config) => {
      const { id, method } = config.payload as { id: string; method: string };
      methods.push(method);
      if (method === "getLatestBlockhash") return { jsonrpc: "2.0", id, result: {
        context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 },
      } };
      expect(method).toBe("sendTransaction");
      expect(active.pending).toHaveLength(1);
      signal = config.signal;
      send.enter();
      return new Promise<unknown>((resolve) => { release = resolve; });
    }) as RpcTransport,
  });
  const signer = await generateKeyPairSigner();
  const sending = active.run(() => chain.clientFor(signer).send([transferInstruction(signer, signer.address, 1n)]));
  const rejected = expect(sending).rejects.toMatchObject({ signature: expect.any(String) });
  await send.entered;
  active.controller.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(active.pending).toEqual([{ signature: expect.any(String), signedTransaction:expect.any(String), lastValidBlockHeight: "100" }]);
  release({ jsonrpc: "2.0", id: "late", result: active.pending[0]!.signature });
  await new Promise((resolve) => setImmediate(resolve));
  expect(methods).toEqual(["getLatestBlockhash", "sendTransaction"]);
  expect(active.pending).toHaveLength(1);
});

it("checks admission after RPC pacing and before a signed claim leaves the wallet", async () => {
  let current=true, sends=0;
  const chain=createRpcChain({network:"localnet",rpcUrl:"http://localhost:8899",minRequestGapMs:120,
    transport:(async c=>{
      const {id,method}=c.payload as {id:string;method:string};
      if (method==="getLatestBlockhash") return {jsonrpc:"2.0",id,result:{context:{slot:1},value:{blockhash:"11111111111111111111111111111111",lastValidBlockHeight:100}}};
      if (method==="sendTransaction") sends++;
      throw new Error("Unexpected transmission.");
    }) as RpcTransport});
  const signer=await generateKeyPairSigner();
  const sending=inTransportScope({signal:new AbortController().signal,sending:()=>{setTimeout(()=>{current=false;},5);},confirmed:()=>{}},
    ()=>chain.clientFor(signer).send([transferInstruction(signer,signer.address,1n)],{maxRetries:0,
      assertAuthorized:()=>{if(!current) throw new Error("Admission changed.");}}));
  await expect(sending).rejects.toMatchObject({signature:expect.any(String)});
  expect(sends).toBe(0);
});

it.each(["request", "body"])("cancels a stalled marketplace HTTP %s", async (where) => {
  const active = scope();
  const started = gate();
  let signal: AbortSignal | null | undefined;
  const services = createHostedServices({ fetchImpl: (async (_url, init) => {
    signal = init?.signal;
    if (where === "request") {
      started.enter();
      return new Promise(() => {});
    }
    return new Response(new ReadableStream({ pull() { started.enter(); return new Promise(() => {}); } }));
  }) as typeof fetch });
  const request = active.run(() => services.trustedModerators());
  const rejected = expect(request).rejects.toBeDefined();
  await started.entered;
  active.controller.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
});

it.each([
  { statuses: [null], height: 100, outcome: "pending" },
  { statuses: [null, null], height: 101, outcome: "failed" },
  { statuses: [null, { confirmationStatus: "processed", err: null }], height: 101, outcome: "pending" },
  { statuses: [{ confirmationStatus: "confirmed", err: null }], height: 99, outcome: "landed" },
  { statuses: [{ confirmationStatus: "finalized", err: { InstructionError: [] } }], height: 99, outcome: "failed" },
])("reconciles an interrupted send from status and expiry: %j", async ({ statuses, height, outcome }) => {
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899",
    transport: (async (config) => {
      const { id, method } = config.payload as { id: string; method: string };
      return { jsonrpc: "2.0", id, result: method === "getEpochInfo" ? { blockHeight: height }
        : { context: { slot: 1 }, value: [statuses.shift()] } };
    }) as RpcTransport,
  });
  expect(await chain.listingSendOutcome!({ signature: "1".repeat(64), lastValidBlockHeight: "100" })).toBe(outcome);
});

it("releases abort listeners after successful and cancelled transport waits", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 100; i++) await abortableTransport(controller.signal, async () => i);
  await new Promise((resolve) => setImmediate(resolve));
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  for (let i = 0; i < 100; i++) {
    const next = new AbortController();
    const pending = abortableTransport(next.signal, () => new Promise(() => {}));
    const rejected = expect(pending).rejects.toBeDefined();
    await Promise.resolve();
    next.abort();
    await rejected;
    expect(getEventListeners(next.signal, "abort")).toHaveLength(0);
  }
});

it("gives a successful RPC send and its confirmation separate deadlines", async () => {
  const active = scope(500);
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899",
    transport: (async ({ payload }) => {
      const { id, method } = payload as { id: string; method: string };
      if (method === "getLatestBlockhash") return { jsonrpc: "2.0", id, result: {
        context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 },
      } };
      await delay(300);
      if (method === "sendTransaction") return { jsonrpc: "2.0", id, result: active.pending[0]!.signature };
      expect(method).toBe("getSignatureStatuses");
      return { jsonrpc: "2.0", id, result: {
        context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }],
      } };
    }) as RpcTransport,
  });
  const signer = await generateKeyPairSigner();
  const result = await active.run(() => chain.clientFor(signer).send([transferInstruction(signer, signer.address, 1n)]));
  expect(result.signature).toBeTruthy();
  expect(active.pending).toEqual([]);
});

it("selects a recent hash with 16 produced blocks left and dispatches a review only once", async () => {
  const active = scope();
  const slots = Array.from({ length: 160 }, (_, i) => 1000 + 2 * i);
  const tipSlot = slots.at(-1)!;
  const selectedSlot = slots[slots.length - 1 - (150 - 16)]!;
  const tipHash = "11111111111111111111111111111111";
  const shortHash = "11111111111111111111111111111112";
  let sent = 0;
  const chain = createRpcChain({ network: "localnet", rpcUrl: "http://localhost:8899",
    transport: (async ({ payload }) => {
      const { method, id, params } = payload as { id: string; method: string; params: unknown[] };
      let result: unknown;
      switch (method) {
        case "getLatestBlockhash":
          result = { context: { slot: tipSlot }, value: { blockhash: tipHash, lastValidBlockHeight: 1150 } };
          break;
        case "getBlocks":
          result = slots;
          break;
        case "getBlock":
          expect([tipSlot, selectedSlot]).toContain(params[0]);
          result = params[0] === tipSlot ? { blockHeight: 1000, blockhash: tipHash } : { blockHeight: 866, blockhash: shortHash };
          break;
        case "sendTransaction": {
          sent++;
          expect(params[1]).toMatchObject({ maxRetries: 0, preflightCommitment: "confirmed" });
          const wire = Buffer.from(String(params[0]), "base64");
          const { getTransactionDecoder, getCompiledTransactionMessageDecoder } = await import("@solana/kit");
          const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(wire).messageBytes);
          expect(message.lifetimeToken).toBe(shortHash);
          expect(active.pending[0]?.lastValidBlockHeight).toBe("1016");
          result = active.pending[0]!.signature;
          break;
        }
        case "getSignatureStatuses":
          result = { context: { slot: tipSlot }, value: [{ confirmationStatus: "confirmed", err: null }] };
          break;
        default: throw new Error(method);
      }
      return { jsonrpc: "2.0", id, result };
    }) as RpcTransport,
  });
  const signer = await generateKeyPairSigner();
  await active.run(() => chain.clientFor(signer, { review: true }).send([transferInstruction(signer, signer.address, 1n)], { maxRetries: 0 }));
  expect(sent).toBe(1);
  expect(active.pending).toEqual([]);
});
