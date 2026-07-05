// Structural tests for the transaction runtime: exact compute-budget bytes,
// default/override/disable prepend behavior, blockhash-expiry-aware retry
// (with RE-SIGN proof), bounded retries, and AgencError hydration across both
// kit-shaped and litesvm-shaped failures. No network, no litesvm — transports
// are faked at the seam the client actually uses.
import { describe, it, expect } from "vitest";
import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  SolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  AgencError,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  createMarketplaceClient,
  createRpcTransport,
  extractCustomProgramErrorCode,
  getAgencErrorName,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  isBlockhashExpiredError,
  toAgencError,
  withReferrerDefault,
  type RpcTransportRpc,
  type SignedTransaction,
  type Transport,
} from "../src/client/index.js";
import {
  AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED,
  AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND,
  AGENC_COORDINATION_ERROR__TASK_NOT_OPEN,
} from "../src/generated/index.js";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

/** Deterministic, valid base58 blockhash from a filled 32-byte seed. */
function blockhashFromSeed(seed: number): Blockhash {
  return getBase58Decoder().decode(
    new Uint8Array(32).fill(seed),
  ) as Blockhash;
}

/** A do-nothing instruction (never executed — transports are fakes here). */
const DUMMY_IX: Instruction = {
  programAddress: SYSTEM_PROGRAM,
  data: new Uint8Array([7, 7, 7]),
};

interface FakeTransport extends Transport {
  /** Every signed transaction handed to sendAndConfirm, in order. */
  readonly captured: SignedTransaction[];
  /** Number of sendAndConfirm calls. */
  readonly sendCalls: () => number;
}

/**
 * Transport that hands out a fresh blockhash per fetch and fails the first
 * `failures.length` sends with the given errors before succeeding.
 */
function fakeTransport(failures: unknown[] = []): FakeTransport {
  const captured: SignedTransaction[] = [];
  let blockhashCounter = 0;
  let sendCount = 0;
  return {
    captured,
    sendCalls: () => sendCount,
    async getLatestBlockhash() {
      blockhashCounter += 1;
      return {
        blockhash: blockhashFromSeed(blockhashCounter),
        lastValidBlockHeight: 100n + BigInt(blockhashCounter),
      };
    },
    async sendAndConfirm(signedTx) {
      captured.push(signedTx);
      sendCount += 1;
      if (sendCount <= failures.length) {
        throw failures[sendCount - 1];
      }
      return {
        signature: getSignatureFromTransaction(signedTx),
        logs: ["Program log: ok"],
      };
    },
  };
}

/** Decode the compiled message of a captured signed transaction. */
function decodeMessage(tx: SignedTransaction) {
  const decoded = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (!("instructions" in decoded)) {
    throw new Error("expected a v0 compiled message with instructions");
  }
  return {
    staticAccounts: decoded.staticAccounts,
    instructions: decoded.instructions.map((ix) => ({
      programAddress: decoded.staticAccounts[ix.programAddressIndex],
      data: ix.data ? Array.from(ix.data) : [],
    })),
  };
}

/** Wrap a keypair signer so every signTransactions call is counted. */
function countingSigner(base: KeyPairSigner): {
  signer: TransactionSigner;
  signCalls: () => number;
} {
  let count = 0;
  const signer: TransactionSigner = {
    ...base,
    signTransactions: (...args) => {
      count += 1;
      return base.signTransactions(...args);
    },
  };
  return { signer, signCalls: () => count };
}

describe("compute-budget instruction encoding (exact bytes)", () => {
  it("SetComputeUnitLimit = [tag 2, u32le units]", () => {
    const ix = getSetComputeUnitLimitInstruction(600_000);
    expect(ix.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(ix.programAddress).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
    expect(Array.from(ix.data!)).toEqual([2, 0xc0, 0x27, 0x09, 0x00]);
    expect(ix.accounts ?? []).toEqual([]);
  });

  it("SetComputeUnitPrice = [tag 3, u64le microLamports]", () => {
    const ix = getSetComputeUnitPriceInstruction(5_000n);
    expect(ix.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(Array.from(ix.data!)).toEqual([3, 0x88, 0x13, 0, 0, 0, 0, 0, 0]);
    // number input encodes identically
    expect(Array.from(getSetComputeUnitPriceInstruction(5_000).data!)).toEqual(
      Array.from(ix.data!),
    );
  });

  it("rejects out-of-range values", () => {
    expect(() => getSetComputeUnitLimitInstruction(-1)).toThrow(RangeError);
    expect(() => getSetComputeUnitLimitInstruction(2 ** 32)).toThrow(
      RangeError,
    );
    expect(() => getSetComputeUnitLimitInstruction(1.5)).toThrow(RangeError);
    expect(() => getSetComputeUnitPriceInstruction(-1n)).toThrow(RangeError);
    expect(() => getSetComputeUnitPriceInstruction(2n ** 64n)).toThrow(
      RangeError,
    );
  });
});

describe("client compute-budget prepend (default / override / disable)", () => {
  it("prepends SetComputeUnitLimit(600_000) by default, and no price", async () => {
    const transport = fakeTransport();
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    await client.send([DUMMY_IX]);

    const msg = decodeMessage(transport.captured[0]!);
    expect(msg.instructions).toHaveLength(2);
    expect(msg.instructions[0]!.programAddress).toBe(
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
    );
    expect(msg.instructions[0]!.data).toEqual([2, 0xc0, 0x27, 0x09, 0x00]);
    expect(msg.instructions[1]!.programAddress).toBe(SYSTEM_PROGRAM);
    expect(msg.instructions[1]!.data).toEqual([7, 7, 7]);
  });

  it("client-level computeUnitPrice adds the price instruction after the limit", async () => {
    const transport = fakeTransport();
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({
      transport,
      signer,
      computeUnitPrice: 5_000n,
    });

    await client.send([DUMMY_IX]);

    const msg = decodeMessage(transport.captured[0]!);
    expect(msg.instructions).toHaveLength(3);
    expect(msg.instructions[0]!.data).toEqual([2, 0xc0, 0x27, 0x09, 0x00]);
    expect(msg.instructions[1]!.programAddress).toBe(
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
    );
    expect(msg.instructions[1]!.data).toEqual([3, 0x88, 0x13, 0, 0, 0, 0, 0, 0]);
  });

  it("per-call overrides replace the client defaults", async () => {
    const transport = fakeTransport();
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    await client.send([DUMMY_IX], {
      computeUnitLimit: 1_000_000,
      computeUnitPrice: 1n,
    });

    const msg = decodeMessage(transport.captured[0]!);
    expect(msg.instructions).toHaveLength(3);
    expect(msg.instructions[0]!.data).toEqual([2, 0x40, 0x42, 0x0f, 0x00]);
    expect(msg.instructions[1]!.data).toEqual([3, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("computeBudget: false disables the prepend entirely", async () => {
    const transport = fakeTransport();
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({
      transport,
      signer,
      computeUnitPrice: 5_000n, // would normally add two instructions
    });

    await client.send([DUMMY_IX], { computeBudget: false });

    const msg = decodeMessage(transport.captured[0]!);
    expect(msg.instructions).toHaveLength(1);
    expect(msg.instructions[0]!.programAddress).toBe(SYSTEM_PROGRAM);
    expect(msg.staticAccounts).not.toContain(COMPUTE_BUDGET_PROGRAM_ADDRESS);
  });
});

describe("blockhash-expiry-aware retry", () => {
  it("re-fetches the blockhash and RE-SIGNS on a kit BLOCK_HEIGHT_EXCEEDED failure", async () => {
    const expiry = new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
      currentBlockHeight: 101n,
      lastValidBlockHeight: 100n,
    });
    const transport = fakeTransport([expiry]);
    const { signer, signCalls } = countingSigner(
      await generateKeyPairSigner(),
    );
    const client = createMarketplaceClient({ transport, signer });

    const result = await client.send([DUMMY_IX]);

    expect(transport.sendCalls()).toBe(2);
    expect(signCalls()).toBe(2); // signed twice — once per attempt
    const [first, second] = transport.captured;
    // the retried transaction carries a DIFFERENT (re-fetched) blockhash...
    expect(first!.lifetimeConstraint.blockhash).not.toBe(
      second!.lifetimeConstraint.blockhash,
    );
    // ...and is therefore a different signature (re-signed, not re-sent bytes)
    expect(getSignatureFromTransaction(first!)).not.toBe(
      getSignatureFromTransaction(second!),
    );
    expect(result.signature).toBe(getSignatureFromTransaction(second!));
  });

  it("retries on a litesvm-style BlockhashNotFound message", async () => {
    const transport = fakeTransport([
      new Error("Transaction failed: BlockhashNotFound"),
    ]);
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    await expect(client.send([DUMMY_IX])).resolves.toMatchObject({
      logs: ["Program log: ok"],
    });
    expect(transport.sendCalls()).toBe(2);
  });

  it("does NOT retry a non-expiry (program) failure and hydrates AgencError", async () => {
    const transport = fakeTransport([
      new Error(
        "Transaction failed: TransactionErrorInstructionError { index: 2, err: custom program error: 0x1770 }",
      ),
      new Error("should never be reached"),
    ]);
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(transport.sendCalls()).toBe(1); // exactly one attempt
    expect(failure).toBeInstanceOf(AgencError);
    const agencError = failure as AgencError;
    expect(agencError.code).toBe(
      AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED,
    );
    expect(agencError.errorName).toBe(
      "AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED",
    );
  });

  it("bounds retries by maxRetries and surfaces the final expiry as AgencError", async () => {
    const failures = Array.from(
      { length: 10 },
      () => new Error("block height exceeded"),
    );
    const transport = fakeTransport(failures);
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({
      transport,
      signer,
      maxRetries: 2,
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(transport.sendCalls()).toBe(3); // 1 attempt + 2 retries
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).code).toBeNull();
    expect(isBlockhashExpiredError((failure as AgencError).cause)).toBe(true);
  });
});

describe("AgencError hydration shapes", () => {
  it("parses the kit SolanaError InstructionError Custom shape", () => {
    const kitError = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
      code: AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND,
      index: 0,
    });
    const wrapped = new Error("Transaction simulation failed", {
      cause: kitError,
    });
    const hydrated = toAgencError(wrapped);
    expect(hydrated.code).toBe(AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND);
    expect(hydrated.errorName).toBe("AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND");
    expect(hydrated.cause).toBe(wrapped);
  });

  it("parses a raw RPC status err shape ({ InstructionError: [i, { Custom }] })", () => {
    const failure = new Error("Transaction abc failed") as Error & {
      transactionError: unknown;
    };
    failure.transactionError = {
      InstructionError: [0, { Custom: AGENC_COORDINATION_ERROR__TASK_NOT_OPEN }],
    };
    const hydrated = toAgencError(failure);
    expect(hydrated.code).toBe(AGENC_COORDINATION_ERROR__TASK_NOT_OPEN);
    expect(hydrated.errorName).toBe("AGENC_COORDINATION_ERROR__TASK_NOT_OPEN");
  });

  it("parses litesvm-style 'custom program error: 0x…' strings and keeps logs", () => {
    const logs = [
      "Program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK invoke [1]",
      "Program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK failed: custom program error: 0x1770",
    ];
    const failure = new Error("Transaction failed: see logs") as Error & {
      logs: readonly string[];
    };
    failure.logs = logs;
    const hydrated = toAgencError(failure);
    expect(hydrated.code).toBe(
      AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED,
    );
    expect(hydrated.errorName).toBe(
      "AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED",
    );
    expect(hydrated.logs).toEqual(logs);
  });

  it("returns an existing AgencError unchanged and null code for unknown failures", () => {
    const existing = new AgencError("already hydrated", { code: 1 });
    expect(toAgencError(existing)).toBe(existing);
    const unknown = toAgencError(new Error("connection refused"));
    expect(unknown.code).toBeNull();
    expect(unknown.errorName).toBeNull();
    expect(unknown.message).toContain("connection refused");
  });
});

describe("createRpcTransport (polling path, no subscriptions)", () => {
  function thunk<T>(value: T) {
    return { send: async () => value };
  }

  async function signedDummyTx(signer: TransactionSigner) {
    // Build through the client against a capture-only transport so this test
    // needs no manual kit plumbing either.
    const capture = fakeTransport();
    const client = createMarketplaceClient({ transport: capture, signer });
    await client.send([DUMMY_IX]);
    return capture.captured[0]!;
  }

  it("sends base64 wire bytes then polls statuses to the commitment", async () => {
    const sent: unknown[][] = [];
    let statusPolls = 0;
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: (...args: unknown[]) => {
        sent.push(args);
        return thunk("sig");
      },
      getSignatureStatuses: () => {
        statusPolls += 1;
        return thunk({
          value: [
            statusPolls < 2
              ? null
              : { confirmationStatus: "confirmed", err: null },
          ],
        });
      },
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;

    const transport = createRpcTransport({
      rpc,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect((await transport.getLatestBlockhash()).lastValidBlockHeight).toBe(
      100n,
    );

    const tx = await signedDummyTx(await generateKeyPairSigner());
    const result = await transport.sendAndConfirm(tx);
    expect(result.signature).toBe(getSignatureFromTransaction(tx));
    expect(sent).toHaveLength(1);
    expect(typeof sent[0]![0]).toBe("string"); // base64 wire transaction
    expect(sent[0]![1]).toMatchObject({ encoding: "base64" });
    expect(statusPolls).toBe(2);
  });

  it("rejects with the status err (hydratable) and flags expiry via block height", async () => {
    const failingRpc = {
      getLatestBlockhash: () =>
        thunk({
          value: { blockhash: blockhashFromSeed(9), lastValidBlockHeight: 100n },
        }),
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () =>
        thunk({
          value: [
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, { Custom: 6000 }] },
            },
          ],
        }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failing = createRpcTransport({ rpc: failingRpc, pollIntervalMs: 1 });
    const failure = await failing.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(toAgencError(failure).code).toBe(6000);

    // never-seen signature + block height past lastValidBlockHeight => expiry
    const expiredRpc = {
      ...failingRpc,
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 9_999n }),
    } as unknown as RpcTransportRpc;
    const expired = createRpcTransport({
      rpc: expiredRpc,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    const expiry = await expired.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(isBlockhashExpiredError(expiry)).toBe(true);
  });
});

describe("expiry-vs-landed race (no double submission)", () => {
  function thunk<T>(value: T) {
    return { send: async () => value };
  }

  /** Base58 signature of the (single-signer) wire transaction sent to the RPC. */
  function signatureOfWireTransaction(wireBase64: string): string {
    const bytes = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
    // Wire format: compact-u16 signature count (1 byte here), then 64-byte sigs.
    return getBase58Decoder().decode(bytes.subarray(1, 65));
  }

  it("polling transport rechecks the status after the expiry signal and returns the FIRST signature without re-submitting", async () => {
    // The reviewer's reproduction: the tx landed in a block at height
    // 100 == lastValidBlockHeight, the status view lagged ONE poll behind,
    // and the epoch-info view already reports height 101 ("expired").
    const sentWires: string[] = [];
    let blockhashCounter = 0;
    let statusPolls = 0;
    const rpc = {
      getLatestBlockhash: () => {
        blockhashCounter += 1;
        return thunk({
          value: {
            blockhash: blockhashFromSeed(blockhashCounter),
            lastValidBlockHeight: 100n,
          },
        });
      },
      sendTransaction: (wire: string) => {
        sentWires.push(wire);
        return thunk("sig");
      },
      getSignatureStatuses: () => {
        statusPolls += 1;
        return thunk({
          value: [
            statusPolls < 2
              ? null // status view lagging — tx HAS landed, not yet visible
              : { confirmationStatus: "confirmed", err: null },
          ],
        });
      },
      getEpochInfo: () => thunk({ blockHeight: 101n }), // height view: expired
    } as unknown as RpcTransportRpc;

    const transport = createRpcTransport({
      rpc,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const result = await client.send([DUMMY_IX]);

    // Pre-fix this raced into a SECOND submission (re-signed with a fresh
    // blockhash — a literal double-spend for non-PDA-guarded instructions).
    expect(sentWires).toHaveLength(1);
    expect(result.signature).toBe(signatureOfWireTransaction(sentWires[0]!));
    expect(statusPolls).toBeGreaterThanOrEqual(2); // the final recheck ran
  });

  it("client short-circuits to the first signature before an expiry-triggered re-sign when getSignatureStatus reports it landed", async () => {
    const expiries = Array.from(
      { length: 4 },
      () =>
        new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
          currentBlockHeight: 101n,
          lastValidBlockHeight: 100n,
        }),
    );
    const base = fakeTransport(expiries);
    const statusQueries: string[] = [];
    const transport: Transport = {
      getLatestBlockhash: () => base.getLatestBlockhash(),
      sendAndConfirm: (tx) => base.sendAndConfirm(tx),
      async getSignatureStatus(signature) {
        statusQueries.push(signature);
        return { confirmationStatus: "confirmed", err: null };
      },
    };
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const result = await client.send([DUMMY_IX]);

    // Pre-fix the client re-signed/resent through all retries and threw.
    expect(base.sendCalls()).toBe(1);
    const firstSignature = getSignatureFromTransaction(base.captured[0]!);
    expect(result.signature).toBe(firstSignature);
    expect(statusQueries).toEqual([firstSignature]);
  });

  it("client surfaces the landed attempt's REAL on-chain error instead of re-signing", async () => {
    const base = fakeTransport([
      new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
        currentBlockHeight: 101n,
        lastValidBlockHeight: 100n,
      }),
    ]);
    const transport: Transport = {
      getLatestBlockhash: () => base.getLatestBlockhash(),
      sendAndConfirm: (tx) => base.sendAndConfirm(tx),
      async getSignatureStatus() {
        return {
          confirmationStatus: "confirmed",
          err: {
            InstructionError: [
              0,
              { Custom: AGENC_COORDINATION_ERROR__TASK_NOT_OPEN },
            ],
          },
        };
      },
    };
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    // Pre-fix the client re-signed and the second (fake) attempt "succeeded",
    // masking the first attempt's on-chain failure entirely.
    expect(base.sendCalls()).toBe(1);
    expect(failure).toBeInstanceOf(AgencError);
    const agencError = failure as AgencError;
    expect(agencError.code).toBe(AGENC_COORDINATION_ERROR__TASK_NOT_OPEN);
    expect(agencError.signature).toBe(
      getSignatureFromTransaction(base.captured[0]!),
    );
  });
});

describe("in-flight signature on post-submission failures", () => {
  function thunk<T>(value: T) {
    return { send: async () => value };
  }

  async function signedDummyTx(signer: TransactionSigner) {
    const capture = fakeTransport();
    const client = createMarketplaceClient({ transport: capture, signer });
    await client.send([DUMMY_IX]);
    return capture.captured[0]!;
  }

  it("timeout errors carry the signature (outcome unknown — check before retrying)", async () => {
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: { blockhash: blockhashFromSeed(9), lastValidBlockHeight: 100n },
        }),
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }), // lifetime NOT over
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({
      rpc,
      pollIntervalMs: 1,
      timeoutMs: 5,
    });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    const hydrated = toAgencError(failure);
    expect(hydrated.message).toContain("was not confirmed");
    expect(hydrated.signature).toBe(getSignatureFromTransaction(tx));
  });

  it("mid-poll network failures carry the signature (previously unrecoverable)", async () => {
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: { blockhash: blockhashFromSeed(9), lastValidBlockHeight: 100n },
        }),
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () => {
        throw new Error("fetch failed: ECONNRESET");
      },
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    const hydrated = toAgencError(failure);
    expect(hydrated.signature).toBe(getSignatureFromTransaction(tx));
    expect(hydrated.message).toContain("ECONNRESET");
  });

  it("pre-submission failures hydrate with signature: null", async () => {
    const boom = new Error("fetch failed: ECONNRESET");
    const transport: Transport = {
      async getLatestBlockhash() {
        throw boom;
      },
      async sendAndConfirm() {
        throw new Error("unreachable: nothing was submitted");
      },
    };
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBeNull();
  });
});

describe("send() hydrates EVERY failure into AgencError", () => {
  it("a getLatestBlockhash rejection surfaces as AgencError with cause preserved", async () => {
    const boom = new Error("fetch failed: ECONNRESET");
    const transport: Transport = {
      async getLatestBlockhash() {
        throw boom;
      },
      async sendAndConfirm() {
        throw new Error("unreachable: blockhash fetch already failed");
      },
    };
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    // Pre-fix the raw transport error propagated, breaking the documented
    // `catch (e) { if (e instanceof AgencError) ... }` contract.
    expect(failure).toBeInstanceOf(AgencError);
    const agencError = failure as AgencError;
    expect(agencError.cause).toBe(boom);
    expect(agencError.code).toBeNull();
    expect(agencError.message).toContain("ECONNRESET");
  });

  it("a signing failure surfaces as AgencError with cause preserved", async () => {
    const signBoom = new Error("signer unavailable");
    const base = await generateKeyPairSigner();
    const brokenSigner: TransactionSigner = {
      ...base,
      signTransactions: async () => {
        throw signBoom;
      },
    };
    const transport = fakeTransport();
    const client = createMarketplaceClient({ transport, signer: brokenSigner });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).cause).toBe(signBoom);
    expect(transport.sendCalls()).toBe(0); // never reached submission
  });
});

describe("custom program error hex-prefix parsing", () => {
  it("parses an uppercase 0X prefix as hex (0X1771 -> 6001), not decimal 0", () => {
    const failure = new Error(
      "Transaction failed: custom program error: 0X1771",
    );
    // Pre-fix: the case-insensitive regex matched "0X1771" but the
    // case-SENSITIVE prefix branch fell through to parseInt(..., 10) = 0.
    expect(extractCustomProgramErrorCode(failure)).toBe(0x1771);

    const hydrated = toAgencError(failure);
    expect(hydrated.code).toBe(6001);
    expect(hydrated.errorName).toBe(getAgencErrorName(6001));
    expect(hydrated.errorName).not.toBeNull();
  });

  it("keeps parsing lowercase 0x and bare decimal codes", () => {
    expect(
      extractCustomProgramErrorCode(
        new Error("custom program error: 0x1771"),
      ),
    ).toBe(6001);
    expect(
      extractCustomProgramErrorCode(new Error("custom program error: 6001")),
    ).toBe(6001);
  });
});

describe("MarketplaceClient first-party lifecycle surface", () => {
  it("exposes humanless hire, activation, review, cleanup, and rating methods", async () => {
    const transport = fakeTransport();
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    for (const name of [
      "hireFromListingHumanless",
      "setTaskJobSpec",
      "claimTaskWithJobSpec",
      "submitTaskResult",
      "acceptTaskResult",
      "rejectTaskResult",
      "autoAcceptTaskResult",
      "cancelTask",
      "closeTask",
      "rateHire",
      // WP-H3 Guaranteed Hire: both halves of the completion-bond lifecycle
      // are first-class named methods (post AND the reclaim recovery crank).
      "postCompletionBond",
      "reclaimCompletionBond",
      // Batch-2 on-chain store identity (P5.2): the full register/update/close
      // lifecycle is first-class on the client.
      "registerStore",
      "updateStore",
      "closeStore",
    ] as const) {
      expect(typeof client[name]).toBe("function");
    }
  });
});

describe("withReferrerDefault (P6.2 demand-side referral default)", () => {
  const REF = address("11111111111111111111111111111112");
  const OTHER = address("11111111111111111111111111111113");

  it("injects the configured referrer + bps when the input has none", () => {
    const merged = withReferrerDefault(
      { taskId: "t" },
      { address: REF, feeBps: 500 },
    ) as Record<string, unknown>;
    expect(merged.referrer).toBe(REF);
    expect(merged.referrerFeeBps).toBe(500);
    expect(merged.taskId).toBe("t");
  });

  it("does NOT override an explicit per-call referrer (explicit value wins)", () => {
    const merged = withReferrerDefault(
      { taskId: "t", referrer: OTHER, referrerFeeBps: 100 },
      { address: REF, feeBps: 500 },
    ) as Record<string, unknown>;
    expect(merged.referrer).toBe(OTHER);
    expect(merged.referrerFeeBps).toBe(100);
  });

  it("treats an explicit referrer: null as an opt-out (default not applied)", () => {
    const merged = withReferrerDefault(
      { taskId: "t", referrer: null },
      { address: REF, feeBps: 500 },
    ) as Record<string, unknown>;
    expect(merged.referrer).toBeNull();
    expect(merged.referrerFeeBps).toBeUndefined();
  });

  it("returns the input unchanged when no default referrer is configured", () => {
    const input = { taskId: "t" };
    expect(withReferrerDefault(input, undefined)).toBe(input);
  });
});
