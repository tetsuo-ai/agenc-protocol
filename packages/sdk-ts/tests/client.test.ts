// Structural tests for the transaction runtime: exact compute-budget bytes,
// default/override/disable prepend behavior, blockhash-expiry-aware retry
// (with RE-SIGN proof), bounded retries, and AgencError hydration across both
// kit-shaped and litesvm-shaped failures. No network, no litesvm — transports
// are faked at the seam the client actually uses.
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionSize,
  isSolanaError,
  SolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
  type Blockhash,
  type Address,
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
  stabilizeTransactionSigner,
  toAgencError,
  withReferrerDefault,
  type RpcTransportRpc,
  type RpcTransportSubscriptions,
  type SignedTransaction,
  type Transport,
} from "../src/client/index.js";
import {
  AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED,
  AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND,
  AGENC_COORDINATION_ERROR__TASK_NOT_OPEN,
} from "../src/generated/index.js";
import { getAddressLookupTableEncoder } from "@solana-program/address-lookup-table";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

describe("stabilizeTransactionSigner public identity contract", () => {
  it("canonicalizes an inherited address in place without freezing signer state", async () => {
    const baseSigner = await generateKeyPairSigner();
    const signer = Object.create(baseSigner) as TransactionSigner;
    expect(Object.getOwnPropertyDescriptor(signer, "address")).toBeUndefined();

    const stabilized = stabilizeTransactionSigner(signer);

    expect(stabilized).toBe(signer);
    expect(stabilized.address).toBe(baseSigner.address);
    expect(
      Object.getOwnPropertyDescriptor(stabilized, "address"),
    ).toMatchObject({
      configurable: false,
      enumerable: true,
      value: baseSigner.address,
      writable: false,
    });
    expect(Object.isFrozen(stabilized)).toBe(false);
  });

  it("captures a configurable address accessor without freezing other state", async () => {
    const baseSigner = await generateKeyPairSigner();
    let liveAddress: TransactionSigner["address"] = baseSigner.address;
    const signer = Object.create(baseSigner) as TransactionSigner;
    Object.defineProperty(signer, "address", {
      configurable: true,
      enumerable: true,
      get: () => liveAddress,
    });

    stabilizeTransactionSigner(signer);
    liveAddress = SYSTEM_PROGRAM;

    expect(signer.address).toBe(baseSigner.address);
    expect(Object.isFrozen(signer)).toBe(false);
  });

  it("preserves a stateful signer's ability to update unrelated own fields", async () => {
    const baseSigner = await generateKeyPairSigner();
    const signer = Object.create(baseSigner) as KeyPairSigner & {
      counter: number;
    };
    Object.defineProperties(signer, {
      counter: {
        configurable: true,
        enumerable: true,
        value: 0,
        writable: true,
      },
      signTransactions: {
        configurable: true,
        enumerable: true,
        writable: true,
        value: async function (
          this: KeyPairSigner & { counter: number },
          transactions: Parameters<KeyPairSigner["signTransactions"]>[0],
          config?: Parameters<KeyPairSigner["signTransactions"]>[1],
        ) {
          this.counter += 1;
          return baseSigner.signTransactions(transactions, config);
        },
      },
    });

    stabilizeTransactionSigner(signer);
    await signer.signTransactions([]);

    expect(signer.counter).toBe(1);
    expect(Object.isFrozen(signer)).toBe(false);
  });
});

/** Deterministic, valid base58 blockhash from a filled 32-byte seed. */
function blockhashFromSeed(seed: number): Blockhash {
  return getBase58Decoder().decode(new Uint8Array(32).fill(seed)) as Blockhash;
}

/** Deterministic, valid address for transaction-shape fixtures. */
function addressFromSeed(seed: number): Address {
  return getBase58Decoder().decode(new Uint8Array(32).fill(seed)) as Address;
}

/** Kit's real structured shape for an RPC sendTransaction preflight expiry. */
function blockhashPreflightFailure(): SolanaError {
  return new SolanaError(
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    {
      accounts: null,
      fee: null,
      loadedAccountsDataSize: null,
      loadedAddresses: null,
      logs: null,
      postBalances: null,
      postTokenBalances: null,
      preBalances: null,
      preTokenBalances: null,
      replacementBlockhash: null,
      returnData: null,
      unitsConsumed: null,
      cause: new SolanaError(
        SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
      ),
    },
  );
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
    expect(msg.instructions[1]!.data).toEqual([
      3, 0x88, 0x13, 0, 0, 0, 0, 0, 0,
    ]);
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

describe("client v0 wire-size boundary", () => {
  it("signs and sends an exact 1,232-byte message with duplicate signer metas", async () => {
    const feePayer = countingSigner(await generateKeyPairSigner());
    const instructionSigner = countingSigner(await generateKeyPairSigner());
    const transport = fakeTransport();
    const client = createMarketplaceClient({
      transport,
      signer: feePayer.signer,
    });
    const signerMeta = {
      address: instructionSigner.signer.address,
      role: AccountRole.READONLY_SIGNER as const,
      signer: instructionSigner.signer,
    };
    const instruction: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [signerMeta, signerMeta],
      data: new Uint8Array(922),
    };

    await client.send([instruction]);

    expect(transport.sendCalls()).toBe(1);
    expect(getTransactionSize(transport.captured[0]!)).toBe(1_232);
    expect(feePayer.signCalls()).toBe(1);
    expect(instructionSigner.signCalls()).toBe(1);
  });

  it("rejects a 1,233-byte message before invoking any signer or transport send", async () => {
    const feePayer = countingSigner(await generateKeyPairSigner());
    const instructionSigner = countingSigner(await generateKeyPairSigner());
    const transport = fakeTransport();
    const client = createMarketplaceClient({
      transport,
      signer: feePayer.signer,
    });
    const signerMeta = {
      address: instructionSigner.signer.address,
      role: AccountRole.READONLY_SIGNER as const,
      signer: instructionSigner.signer,
    };
    const failure = await client
      .send([
        {
          programAddress: SYSTEM_PROGRAM,
          accounts: [signerMeta, signerMeta],
          data: new Uint8Array(923),
        },
      ])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgencError);
    expect(
      isSolanaError(
        (failure as AgencError).cause,
        SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
      ),
    ).toBe(true);
    expect((failure as AgencError).signature).toBeNull();
    expect(transport.sendCalls()).toBe(0);
    expect(feePayer.signCalls()).toBe(0);
    expect(instructionSigner.signCalls()).toBe(0);
  });

  it.each([
    { dataBytes: 1_008, expectedSize: 1_232, shouldSend: true },
    { dataBytes: 1_009, expectedSize: 1_233, shouldSend: false },
  ])(
    "accounts for compute-unit price at the $expectedSize-byte boundary",
    async ({ dataBytes, expectedSize, shouldSend }) => {
      const feePayer = countingSigner(await generateKeyPairSigner());
      const transport = fakeTransport();
      const client = createMarketplaceClient({
        transport,
        signer: feePayer.signer,
        computeUnitPrice: 1n,
      });
      const outcome = await client
        .send([
          {
            programAddress: SYSTEM_PROGRAM,
            data: new Uint8Array(dataBytes),
          },
        ])
        .catch((error: unknown) => error);

      if (shouldSend) {
        expect(outcome).toEqual({
          signature: getSignatureFromTransaction(transport.captured[0]!),
          logs: ["Program log: ok"],
        });
        expect(getTransactionSize(transport.captured[0]!)).toBe(expectedSize);
        expect(feePayer.signCalls()).toBe(1);
        expect(transport.sendCalls()).toBe(1);
      } else {
        expect(outcome).toBeInstanceOf(AgencError);
        expect(
          isSolanaError(
            (outcome as AgencError).cause,
            SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
          ),
        ).toBe(true);
        expect(feePayer.signCalls()).toBe(0);
        expect(transport.sendCalls()).toBe(0);
      }
    },
  );
});

describe("client verified address lookup tables", () => {
  const LOOKUP_TABLE_PROGRAM = address(
    "AddressLookupTab1e1111111111111111111111111",
  );

  function encodeLookupTableAccount(contents: readonly Address[]): Uint8Array {
    return new Uint8Array(
      getAddressLookupTableEncoder().encode({
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 0n,
        lastExtendedSlotStartIndex: 0,
        authority: null,
        addresses: [...contents],
      }),
    );
  }

  function lookupTableRpc(
    accounts: readonly ({ bytes: Uint8Array; owner: Address } | null)[],
    observe?: (
      addresses: readonly Address[],
      config: Record<string, unknown>,
    ) => void,
  ): RpcTransportRpc {
    return {
      getMultipleAccounts(
        addresses: readonly Address[],
        config: Record<string, unknown>,
      ) {
        observe?.(addresses, config);
        return {
          async send() {
            return {
              value: accounts.map((account) =>
                account === null
                  ? null
                  : {
                      data: [
                        Buffer.from(account.bytes).toString("base64"),
                        "base64",
                      ],
                      executable: false,
                      lamports: 1n,
                      owner: account.owner,
                      space: BigInt(account.bytes.length),
                    },
              ),
            };
          },
        };
      },
    } as unknown as RpcTransportRpc;
  }

  it("RPC transport decodes raw ordered table contents at its confirmation commitment", async () => {
    const table = addressFromSeed(94);
    const contents = [addressFromSeed(10), addressFromSeed(11)];
    let observedAddresses: readonly Address[] | undefined;
    let observedConfig: Record<string, unknown> | undefined;
    const transport = createRpcTransport({
      rpc: lookupTableRpc(
        [{ bytes: encodeLookupTableAccount(contents), owner: LOOKUP_TABLE_PROGRAM }],
        (addresses, config) => {
          observedAddresses = addresses;
          observedConfig = config;
        },
      ),
      commitment: "finalized",
    });

    await expect(transport.resolveAddressLookupTables!([table])).resolves.toEqual(
      { [table]: contents },
    );
    expect(observedAddresses).toEqual([table]);
    // The raw base64 account bytes are decoded locally with the official
    // lookup-table codec — never the RPC's `jsonParsed` convenience view.
    expect(observedConfig).toMatchObject({
      commitment: "finalized",
      encoding: "base64",
    });
  });

  it("RPC transport rejects a missing lookup table account", async () => {
    const table = addressFromSeed(94);
    const transport = createRpcTransport({
      rpc: lookupTableRpc([null]),
      commitment: "confirmed",
    });

    await expect(
      transport.resolveAddressLookupTables!([table]),
    ).rejects.toThrow(/does not exist/);
  });

  it("RPC transport rejects a lookup table owned by the wrong program", async () => {
    const table = addressFromSeed(94);
    const contents = [addressFromSeed(10)];
    const transport = createRpcTransport({
      rpc: lookupTableRpc([
        { bytes: encodeLookupTableAccount(contents), owner: SYSTEM_PROGRAM },
      ]),
      commitment: "confirmed",
    });

    await expect(
      transport.resolveAddressLookupTables!([table]),
    ).rejects.toThrow(/not owned by the address lookup table program/);
  });

  it("RPC transport rejects an uninitialized lookup table account", async () => {
    const table = addressFromSeed(94);
    const bytes = encodeLookupTableAccount([addressFromSeed(10)]);
    bytes[0] = 0; // ProgramState::Uninitialized discriminator
    const transport = createRpcTransport({
      rpc: lookupTableRpc([{ bytes, owner: LOOKUP_TABLE_PROGRAM }]),
      commitment: "confirmed",
    });

    await expect(
      transport.resolveAddressLookupTables!([table]),
    ).rejects.toThrow(/not an initialized lookup table/);
  });

  it("RPC transport rejects lookup table bytes that fail strict decoding", async () => {
    const table = addressFromSeed(94);
    const bytes = encodeLookupTableAccount([
      addressFromSeed(10),
      addressFromSeed(11),
    ]).slice(0, -7); // truncated mid-address: not a valid table layout
    const transport = createRpcTransport({
      rpc: lookupTableRpc([{ bytes, owner: LOOKUP_TABLE_PROGRAM }]),
      commitment: "confirmed",
    });

    await expect(
      transport.resolveAddressLookupTables!([table]),
    ).rejects.toThrow();
  });

  it("fetches table contents through the transport and compresses an otherwise oversized message", async () => {
    const feePayer = countingSigner(await generateKeyPairSigner());
    const lookupTable = addressFromSeed(90);
    const lookedUpAddresses = Array.from({ length: 35 }, (_, index) =>
      addressFromSeed(index + 10),
    );
    const instruction: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: lookedUpAddresses.map((accountAddress, index) => ({
        address: accountAddress,
        role:
          index % 2 === 0 ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(8),
    };

    const noLookupTransport = fakeTransport();
    const noLookupClient = createMarketplaceClient({
      transport: noLookupTransport,
      signer: feePayer.signer,
    });
    const oversized = await noLookupClient
      .send([instruction])
      .catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(AgencError);
    expect(
      isSolanaError(
        (oversized as AgencError).cause,
        SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
      ),
    ).toBe(true);
    expect(noLookupTransport.sendCalls()).toBe(0);
    expect(feePayer.signCalls()).toBe(0);

    const baseTransport = fakeTransport();
    const requestedTables: Address[][] = [];
    const transport: Transport = {
      ...baseTransport,
      async resolveAddressLookupTables(tableAddresses) {
        requestedTables.push([...tableAddresses]);
        return { [lookupTable]: lookedUpAddresses };
      },
    };
    const configuredTables: Address[] = [lookupTable];
    const client = createMarketplaceClient({
      transport,
      signer: feePayer.signer,
    });
    const pending = client.send([instruction], {
      addressLookupTableAddresses: configuredTables,
    });
    configuredTables[0] = addressFromSeed(91);

    await pending;

    expect(requestedTables).toEqual([[lookupTable]]);
    expect(baseTransport.sendCalls()).toBe(1);
    expect(feePayer.signCalls()).toBe(1);
    expect(getTransactionSize(baseTransport.captured[0]!)).toBeLessThan(1_232);
    const decoded = getCompiledTransactionMessageDecoder().decode(
      baseTransport.captured[0]!.messageBytes,
    );
    expect("addressTableLookups" in decoded).toBe(true);
    if ("addressTableLookups" in decoded) {
      const lookups = decoded.addressTableLookups;
      expect(lookups).toHaveLength(1);
      if (lookups === undefined) throw new Error("expected v0 lookup table");
      expect(lookups[0]!.lookupTableAddress).toBe(lookupTable);
      expect(lookups[0]!.writableIndexes).toHaveLength(18);
      expect(lookups[0]!.readonlyIndexes).toHaveLength(17);
    }
  });

  it("fails before signing when a transport cannot resolve the requested table exactly", async () => {
    const table = addressFromSeed(92);
    const otherTable = addressFromSeed(93);
    const cases: Array<{ label: string; transport: Transport }> = [
      {
        label: "unsupported transport",
        transport: fakeTransport(),
      },
      {
        label: "missing requested table",
        transport: {
          ...fakeTransport(),
          async resolveAddressLookupTables() {
            return {};
          },
        },
      },
      {
        label: "substituted table",
        transport: {
          ...fakeTransport(),
          async resolveAddressLookupTables() {
            return { [otherTable]: [] };
          },
        },
      },
    ];

    for (const { label, transport } of cases) {
      const feePayer = countingSigner(await generateKeyPairSigner());
      const client = createMarketplaceClient({
        transport,
        signer: feePayer.signer,
      });
      const failure = await client
        .send([DUMMY_IX], { addressLookupTableAddresses: [table] })
        .catch((error: unknown) => error);
      expect(failure, label).toBeInstanceOf(AgencError);
      expect((failure as AgencError).signature, label).toBeNull();
      expect(feePayer.signCalls(), label).toBe(0);
      expect((transport as FakeTransport).sendCalls(), label).toBe(0);
    }
  });
});

describe("client async input and signer-identity boundary", () => {
  it("snapshots direct send instruction data before the blockhash await", async () => {
    let releaseBlockhash!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBlockhash = resolve;
    });
    const captured: SignedTransaction[] = [];
    const transport: Transport = {
      async getLatestBlockhash() {
        await gate;
        return {
          blockhash: blockhashFromSeed(1),
          lastValidBlockHeight: 100n,
        };
      },
      async sendAndConfirm(transaction) {
        captured.push(transaction);
        return {
          signature: getSignatureFromTransaction(transaction),
          logs: [],
        };
      },
    };
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });
    const data = new Uint8Array([1, 2, 3]);

    const pending = client.send([{ programAddress: SYSTEM_PROGRAM, data }], {
      computeBudget: false,
    });
    data.fill(9);
    releaseBlockhash();
    await pending;

    expect(decodeMessage(captured[0]!).instructions[0]!.data).toEqual([
      1, 2, 3,
    ]);
  });

  it("snapshots account metas without invoking a caller-owned array map", async () => {
    let releaseBlockhash!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBlockhash = resolve;
    });
    const captured: SignedTransaction[] = [];
    const transport: Transport = {
      async getLatestBlockhash() {
        await gate;
        return {
          blockhash: blockhashFromSeed(1),
          lastValidBlockHeight: 100n,
        };
      },
      async sendAndConfirm(transaction) {
        captured.push(transaction);
        return {
          signature: getSignatureFromTransaction(transaction),
          logs: [],
        };
      },
    };
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });
    const original = address("So11111111111111111111111111111111111111112");
    const moved = address("Stake11111111111111111111111111111111111111");
    const meta: { address: Address; role: AccountRole } = {
      address: original,
      role: AccountRole.READONLY,
    };
    const accounts = [meta];
    Object.defineProperty(accounts, "map", {
      configurable: true,
      value: () => {
        throw new Error("caller-owned map must not run");
      },
    });

    const pending = client.send(
      [
        {
          programAddress: SYSTEM_PROGRAM,
          accounts,
          data: new Uint8Array([1]),
        },
      ],
      { computeBudget: false },
    );
    meta.address = moved;
    releaseBlockhash();
    await pending;

    const message = decodeMessage(captured[0]!);
    expect(message.staticAccounts).toContain(original);
    expect(message.staticAccounts).not.toContain(moved);
  });

  it("fails closed on an uninspectable account container before transport", async () => {
    const transport = fakeTransport();
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });
    const accounts = new Proxy(
      [{ address: SYSTEM_PROGRAM, role: AccountRole.READONLY }],
      {
        getOwnPropertyDescriptor() {
          throw new Error("revoked-like account array");
        },
      },
    );

    const failure = await client
      .send(
        [
          {
            programAddress: SYSTEM_PROGRAM,
            accounts,
            data: new Uint8Array([1]),
          },
        ],
        { computeBudget: false },
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).cause).toBeInstanceOf(TypeError);
    expect(transport.sendCalls()).toBe(0);
  });

  it("accepts cross-realm instruction bytes and rejects proxy/shared/detached/spoofed views pre-transport", async () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreign = new ForeignUint8Array([4, 5, 6]);
    const transport = fakeTransport();
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });
    const pending = client.send(
      [{ programAddress: SYSTEM_PROGRAM, data: foreign }],
      { computeBudget: false },
    );
    foreign.fill(8);
    await pending;
    expect(decodeMessage(transport.captured[0]!).instructions[0]!.data).toEqual(
      [4, 5, 6],
    );

    const detached = new Uint8Array([1]);
    structuredClone(detached, { transfer: [detached.buffer] });
    const spoofed = Object.defineProperty(
      new DataView(new ArrayBuffer(1)),
      Symbol.toStringTag,
      {
        configurable: true,
        value: "Uint8Array",
      },
    );
    const invalid = [
      new Proxy(new Uint8Array([1]), {}),
      new Uint8Array(new SharedArrayBuffer(1)),
      detached,
      spoofed,
    ];
    for (const data of invalid) {
      const before = transport.sendCalls();
      const failure = await client
        .send([{ programAddress: SYSTEM_PROGRAM, data: data as Uint8Array }], {
          computeBudget: false,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgencError);
      expect((failure as AgencError).cause).toBeInstanceOf(TypeError);
      expect(transport.sendCalls()).toBe(before);
    }
  });

  it("collapses duplicate fee-payer wrappers in standard, humanless, and activation client methods", async () => {
    const base = await generateKeyPairSigner();
    const fee = countingSigner(base);
    const standardAuthority = countingSigner(base);
    const standardCreator = countingSigner(base);
    const humanlessCreator = countingSigner(base);
    const activationCreator = countingSigner(base);
    const transport = fakeTransport();
    const client = createMarketplaceClient({ transport, signer: fee.signer });
    const listing = address("Stake11111111111111111111111111111111111111");
    const providerAgent = address(
      "So11111111111111111111111111111111111111112",
    );
    const creatorAgent = address(
      "4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB",
    );
    const moderator = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA");

    await client.hireFromListing(
      {
        listing,
        providerAgent,
        creatorAgent,
        authority: standardAuthority.signer,
        creator: standardCreator.signer,
        taskId: new Uint8Array(32).fill(1),
        expectedPrice: 1n,
        expectedVersion: 1n,
        listingSpecHash: new Uint8Array(32).fill(2),
        taskJobSpecHash: new Uint8Array(32).fill(3),
        moderator,
      },
      { computeBudget: false },
    );
    await client.hireFromListingHumanless(
      {
        listing,
        providerAgent,
        creator: humanlessCreator.signer,
        taskId: new Uint8Array(32).fill(4),
        expectedPrice: 1n,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash: new Uint8Array(32).fill(5),
        taskJobSpecHash: new Uint8Array(32).fill(6),
        moderator,
      },
      { computeBudget: false },
    );
    await client.setTaskJobSpec(
      {
        task: listing,
        creator: activationCreator.signer,
        jobSpecHash: new Uint8Array(32).fill(7),
        jobSpecUri: "ipfs://client-boundary",
        moderator,
      },
      { computeBudget: false },
    );

    expect(transport.sendCalls()).toBe(3);
    expect(fee.signCalls()).toBe(3);
    expect(standardAuthority.signCalls()).toBe(0);
    expect(standardCreator.signCalls()).toBe(0);
    expect(humanlessCreator.signCalls()).toBe(0);
    expect(activationCreator.signCalls()).toBe(0);
  });

  it("locks named-method signer addresses synchronously before generated PDA awaits", async () => {
    const actorBase = await generateKeyPairSigner();
    const mutableWrapper = () => {
      let liveAddress: TransactionSigner["address"] = actorBase.address;
      const signer = Object.create(actorBase) as TransactionSigner;
      Object.defineProperty(signer, "address", {
        configurable: true,
        enumerable: true,
        get: () => liveAddress,
      });
      return {
        signer,
        move(next: TransactionSigner["address"]) {
          liveAddress = next;
        },
      };
    };
    const authority = mutableWrapper();
    const creator = mutableWrapper();
    const transport = fakeTransport();
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });
    const moved = address("Vote111111111111111111111111111111111111111");

    const pending = client.hireFromListing(
      {
        listing: address("Stake11111111111111111111111111111111111111"),
        providerAgent: address("So11111111111111111111111111111111111111112"),
        creatorAgent: address("4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB"),
        authority: authority.signer,
        creator: creator.signer,
        taskId: new Uint8Array(32).fill(0x31),
        expectedPrice: 1n,
        expectedVersion: 1n,
        listingSpecHash: new Uint8Array(32).fill(0x32),
        taskJobSpecHash: new Uint8Array(32).fill(0x33),
        moderator: address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA"),
      },
      { computeBudget: false },
    );
    authority.move(moved);
    creator.move(moved);
    await pending;

    const message = decodeMessage(transport.captured[0]!);
    expect(message.staticAccounts).toContain(actorBase.address);
    expect(message.staticAccounts).not.toContain(moved);
    expect(authority.signer.address).toBe(actorBase.address);
    // Equal-address roles collapse to the first stabilized representative;
    // the unused wrapper remains mutable but never enters the wire message.
    expect(creator.signer.address).toBe(moved);
  });

  it("keeps distinct signer capabilities and collapses equal non-fee wrappers", async () => {
    const fee = countingSigner(await generateKeyPairSigner());
    const actorBase = await generateKeyPairSigner();
    const firstActor = countingSigner(actorBase);
    const duplicateActor = countingSigner(actorBase);
    const client = createMarketplaceClient({
      transport: fakeTransport(),
      signer: fee.signer,
    });
    const instruction: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        {
          address: firstActor.signer.address,
          role: AccountRole.READONLY_SIGNER,
          signer: firstActor.signer,
        },
        {
          address: duplicateActor.signer.address,
          role: AccountRole.READONLY_SIGNER,
          signer: duplicateActor.signer,
        },
      ],
      data: new Uint8Array([1]),
    } as unknown as Instruction;

    await client.send([instruction], { computeBudget: false });

    expect(fee.signCalls()).toBe(1);
    expect(firstActor.signCalls()).toBe(1);
    expect(duplicateActor.signCalls()).toBe(0);
  });
});

describe("custom transport trust boundary", () => {
  const malformedSuccessCases: ReadonlyArray<{
    label: string;
    result: unknown;
    message: string;
  }> = [
    {
      label: "a different signature",
      result: { signature: "unrelated-signature", logs: [] },
      message: "does not match local wire signature",
    },
    {
      label: "an empty signature",
      result: { signature: "", logs: [] },
      message: "empty or non-string success signature",
    },
    {
      label: "a malformed result",
      result: null,
      message: "malformed success result",
    },
  ];

  it.each(malformedSuccessCases)(
    "rejects a claimed success carrying $label",
    async ({ result, message }) => {
      const captured: SignedTransaction[] = [];
      const transport = {
        async getLatestBlockhash() {
          return {
            blockhash: blockhashFromSeed(1),
            lastValidBlockHeight: 100n,
          };
        },
        async sendAndConfirm(signedTx: SignedTransaction) {
          captured.push(signedTx);
          return result;
        },
      } as unknown as Transport;
      const client = createMarketplaceClient({
        transport,
        signer: await generateKeyPairSigner(),
      });

      const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

      expect(captured).toHaveLength(1);
      expect(failure).toBeInstanceOf(AgencError);
      expect((failure as AgencError).signature).toBe(
        getSignatureFromTransaction(captured[0]!),
      );
      expect((failure as AgencError).message).toContain(message);
      expect((failure as AgencError).message).toContain(
        "must not be re-submitted",
      );
    },
  );

  it("rejects a thrown signature that does not match the local wire transaction", async () => {
    const captured: SignedTransaction[] = [];
    const transport: Transport = {
      async getLatestBlockhash() {
        return {
          blockhash: blockhashFromSeed(1),
          lastValidBlockHeight: 100n,
        };
      },
      async sendAndConfirm(signedTx) {
        captured.push(signedTx);
        throw Object.assign(new Error("custom transport failed"), {
          signature: "unrelated-signature",
        });
      },
    };
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    expect(captured).toHaveLength(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBe(
      getSignatureFromTransaction(captured[0]!),
    );
    expect((failure as AgencError).message).toContain(
      "does not match local wire signature",
    );
    expect((failure as AgencError).message).toContain("outcome is unknown");
  });
});

describe("blockhash-expiry-aware retry", () => {
  it("does not re-sign an unmarked custom-transport BLOCK_HEIGHT_EXCEEDED failure", async () => {
    const expiry = new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
      currentBlockHeight: 101n,
      lastValidBlockHeight: 100n,
    });
    const transport = fakeTransport([expiry]);
    const { signer, signCalls } = countingSigner(await generateKeyPairSigner());
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    expect(transport.sendCalls()).toBe(1);
    expect(signCalls()).toBe(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBe(
      getSignatureFromTransaction(transport.captured[0]!),
    );
    expect((failure as AgencError).message).toContain("outcome is unknown");
  });

  it("does not trust a custom transport's BlockhashNotFound message as retry proof", async () => {
    const transport = fakeTransport([
      new Error("Transaction failed: BlockhashNotFound"),
    ]);
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({ transport, signer });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    expect(transport.sendCalls()).toBe(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBe(
      getSignatureFromTransaction(transport.captured[0]!),
    );
  });

  it("recognizes the raw preflight context shape used by compatible RPC adapters", () => {
    const failure = Object.assign(new Error("Transaction simulation failed"), {
      context: { err: "BlockhashNotFound" },
    });
    expect(isBlockhashExpiredError(failure)).toBe(true);
  });

  it("classifies bounded blockhash-expiry text without regex backtracking", () => {
    expect(isBlockhashExpiredError("BlockhashNotFound")).toBe(true);
    expect(isBlockhashExpiredError("blockhash \t not\nfound")).toBe(true);
    expect(isBlockhashExpiredError("blockheight exceeded")).toBe(true);
    expect(isBlockhashExpiredError("blockhash lifetime expired")).toBe(true);
    expect(
      isBlockhashExpiredError("blockhash was valid\nanother request expired"),
    ).toBe(false);
    expect(
      isBlockhashExpiredError(`${"x".repeat(40_000)}BlockhashNotFound`),
    ).toBe(false);
    expect(isBlockhashExpiredError("blockhash".repeat(4_096))).toBe(false);
  });

  it("does not retry a bare-context BlockhashNotFound without -32002 provenance", async () => {
    let sendAttempts = 0;
    const thunk = <T>(value: T) => ({ send: async () => value });
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(1),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => ({
        send: async () => {
          sendAttempts += 1;
          throw Object.assign(new Error("Transaction simulation failed"), {
            context: { err: "BlockhashNotFound" },
          });
        },
      }),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const client = createMarketplaceClient({
      transport: createRpcTransport({ rpc, pollIntervalMs: 1 }),
      signer: await generateKeyPairSigner(),
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    expect(sendAttempts).toBe(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).not.toBeNull();
    expect((failure as AgencError).message).toContain("outcome is unknown");
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
    expect(agencError.signature).toBe(
      getSignatureFromTransaction(transport.captured[0]!),
    );
  });

  it("bounds SDK-proven preflight retries by maxRetries", async () => {
    let blockhashFetches = 0;
    let sendAttempts = 0;
    const thunk = <T>(value: T) => ({ send: async () => value });
    const rpc = {
      getLatestBlockhash: () => {
        blockhashFetches += 1;
        return thunk({
          value: {
            blockhash: blockhashFromSeed(blockhashFetches),
            lastValidBlockHeight: 100n + BigInt(blockhashFetches),
          },
        });
      },
      sendTransaction: () => ({
        send: async () => {
          sendAttempts += 1;
          throw blockhashPreflightFailure();
        },
      }),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const signer = await generateKeyPairSigner();
    const client = createMarketplaceClient({
      transport: createRpcTransport({ rpc, pollIntervalMs: 1 }),
      signer,
      maxRetries: 2,
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(sendAttempts).toBe(3); // 1 attempt + 2 retries
    expect(blockhashFetches).toBe(3);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).code).toBeNull();
    expect((failure as AgencError).signature).toBeNull();
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
    expect(hydrated.errorName).toBe(
      "AGENC_COORDINATION_ERROR__AGENT_NOT_FOUND",
    );
    expect(hydrated.cause).toBe(wrapped);
  });

  it("parses a raw RPC status err shape ({ InstructionError: [i, { Custom }] })", () => {
    const failure = new Error("Transaction abc failed") as Error & {
      transactionError: unknown;
    };
    failure.transactionError = {
      InstructionError: [
        0,
        { Custom: AGENC_COORDINATION_ERROR__TASK_NOT_OPEN },
      ],
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
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
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

  it("retries a real Kit BlockhashNotFound preflight with a fresh blockhash", async () => {
    let blockhashFetches = 0;
    let sendAttempts = 0;
    let statusReads = 0;
    const rpc = {
      getLatestBlockhash: () => {
        blockhashFetches += 1;
        return thunk({
          value: {
            blockhash: blockhashFromSeed(blockhashFetches),
            lastValidBlockHeight: 100n + BigInt(blockhashFetches),
          },
        });
      },
      sendTransaction: () => ({
        send: async () => {
          sendAttempts += 1;
          if (sendAttempts === 1) throw blockhashPreflightFailure();
          return "sig";
        },
      }),
      getSignatureStatuses: () => {
        statusReads += 1;
        return thunk({
          value: [
            statusReads === 1
              ? null
              : { confirmationStatus: "confirmed", err: null },
          ],
        });
      },
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const client = createMarketplaceClient({
      transport: createRpcTransport({ rpc, pollIntervalMs: 1 }),
      signer: await generateKeyPairSigner(),
    });

    await expect(client.send([DUMMY_IX])).resolves.toMatchObject({ logs: [] });
    expect(blockhashFetches).toBe(2);
    expect(sendAttempts).toBe(2);
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

  it("fails closed when a custom transport broadcasts then throws an unsigned expiry", async () => {
    const captured: SignedTransaction[] = [];
    const transport: Transport = {
      async getLatestBlockhash() {
        return {
          blockhash: blockhashFromSeed(captured.length + 1),
          lastValidBlockHeight: 100n,
        };
      },
      async sendAndConfirm(signedTx) {
        captured.push(signedTx);
        // A custom transport can broadcast the wire bytes and still omit the
        // signature from its rejection. Crossing this opaque boundary makes
        // the outcome ambiguous even though the error itself is unsigned.
        throw new Error("block height exceeded after broadcast");
      },
    };
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

    expect(captured).toHaveLength(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBe(
      getSignatureFromTransaction(captured[0]!),
    );
    expect((failure as AgencError).message).toContain("outcome is unknown");
  });

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

  it("does not report a merely processed expiry-race status as confirmed success", async () => {
    const base = fakeTransport([
      new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
        currentBlockHeight: 101n,
        lastValidBlockHeight: 100n,
      }),
    ]);
    const transport: Transport = {
      confirmationCommitment: "confirmed",
      getLatestBlockhash: () => base.getLatestBlockhash(),
      sendAndConfirm: (tx) => base.sendAndConfirm(tx),
      async getSignatureStatus() {
        return { confirmationStatus: "processed", err: null };
      },
    };
    const client = createMarketplaceClient({
      transport,
      signer: await generateKeyPairSigner(),
    });

    const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);
    expect(base.sendCalls()).toBe(1);
    expect(failure).toBeInstanceOf(AgencError);
    expect((failure as AgencError).signature).toBe(
      getSignatureFromTransaction(base.captured[0]!),
    );
    expect((failure as AgencError).message).toContain("only reached processed");
  });

  const unavailableStatusCases: ReadonlyArray<{
    label: string;
    lookup?: NonNullable<Transport["getSignatureStatus"]>;
  }> = [
    { label: "the transport has no status lookup" },
    {
      label: "the status lookup throws",
      lookup: async () => {
        throw new Error("signature status RPC is unavailable");
      },
    },
    {
      label: "the status lookup still returns null",
      lookup: async () => null,
    },
  ];

  it.each(unavailableStatusCases)(
    "fails closed without re-signing a post-broadcast expiry when $label",
    async ({ lookup }) => {
      const captured: SignedTransaction[] = [];
      const transport: Transport = {
        async getLatestBlockhash() {
          return {
            blockhash: blockhashFromSeed(captured.length + 1),
            lastValidBlockHeight: 100n,
          };
        },
        async sendAndConfirm(signedTx) {
          captured.push(signedTx);
          const signature = getSignatureFromTransaction(signedTx);
          throw Object.assign(
            new Error("block height exceeded after broadcast"),
            { signature },
          );
        },
        ...(lookup === undefined ? {} : { getSignatureStatus: lookup }),
      };
      const client = createMarketplaceClient({
        transport,
        signer: await generateKeyPairSigner(),
      });

      const failure = await client.send([DUMMY_IX]).catch((e: unknown) => e);

      expect(captured).toHaveLength(1);
      expect(failure).toBeInstanceOf(AgencError);
      expect((failure as AgencError).signature).toBe(
        getSignatureFromTransaction(captured[0]!),
      );
      expect((failure as AgencError).message).toContain("outcome is unknown");
    },
  );
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

  function successfulSubscriptions(): RpcTransportSubscriptions {
    return {
      signatureNotifications: () => ({
        subscribe: async () =>
          (async function* () {
            yield { value: { err: null } };
          })(),
      }),
      slotNotifications: () => ({
        subscribe: async () =>
          (async function* () {
            yield { slot: 50n };
            await new Promise<void>(() => undefined);
          })(),
      }),
    } as unknown as RpcTransportSubscriptions;
  }

  it("timeout errors carry the signature (outcome unknown — check before retrying)", async () => {
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
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
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
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

  it("sendTransaction response failures retain the wire signature for reconciliation", async () => {
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => ({
        send: async () => {
          throw new Error(
            "HTTP response lost after the RPC accepted the wire bytes",
          );
        },
      }),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    const hydrated = toAgencError(failure);
    expect(hydrated.signature).toBe(getSignatureFromTransaction(tx));
    expect(hydrated.message).toContain("response lost");
  });

  it("does not tag a deterministic preflight rejection as broadcast", async () => {
    const preflight = blockhashPreflightFailure();
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => ({
        send: async () => {
          throw preflight;
        },
      }),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(failure).toBe(preflight);
    expect(toAgencError(failure).signature).toBeNull();
  });

  it("does not tag a compatible raw BlockhashNotFound preflight as broadcast", async () => {
    const preflight = Object.assign(
      new Error("Transaction simulation failed"),
      {
        context: { err: "BlockhashNotFound" },
      },
    );
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => ({
        send: async () => {
          throw preflight;
        },
      }),
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(failure).toBe(preflight);
    expect(toAgencError(failure).signature).toBeNull();
  });

  it("does not tag subscription-path request-construction failures as broadcast", async () => {
    const requestFailure = new Error(
      "subscription RPC request construction failed",
    );
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => {
        throw requestFailure;
      },
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    // Confirmation is never reached because request construction fails first.
    const rpcSubscriptions = {} as unknown as RpcTransportSubscriptions;
    const transport = createRpcTransport({ rpc, rpcSubscriptions });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(failure).toBe(requestFailure);
    expect(toAgencError(failure).signature).toBeNull();
  });

  it("preserves receiver-sensitive and frozen RPC adapters on the subscription path", async () => {
    class ReceiverSensitiveRpc {
      readonly #ready = true;

      #assertReceiver(): void {
        if (!this.#ready) throw new Error("invalid RPC receiver");
      }

      sendTransaction() {
        this.#assertReceiver();
        return thunk("sig");
      }

      getSignatureStatuses() {
        this.#assertReceiver();
        return thunk({
          value: [{ confirmationStatus: "confirmed", err: null }],
        });
      }

      getEpochInfo() {
        this.#assertReceiver();
        return thunk({ absoluteSlot: 50n, blockHeight: 50n });
      }

      getLatestBlockhash() {
        this.#assertReceiver();
        return thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        });
      }
    }

    const plainFrozenRpc = Object.freeze({
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () =>
        thunk({ value: [{ confirmationStatus: "confirmed", err: null }] }),
      getEpochInfo: () => thunk({ absoluteSlot: 50n, blockHeight: 50n }),
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
    });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    for (const adapter of [new ReceiverSensitiveRpc(), plainFrozenRpc]) {
      const transport = createRpcTransport({
        rpc: adapter as unknown as RpcTransportRpc,
        rpcSubscriptions: successfulSubscriptions(),
      });
      await expect(transport.sendAndConfirm(tx)).resolves.toEqual({
        signature: getSignatureFromTransaction(tx),
        logs: [],
      });
    }
  });

  it("does not tag synchronous RPC request-construction failures as broadcast", async () => {
    const requestFailure = new Error("invalid local sendTransaction arguments");
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => {
        throw requestFailure;
      },
      getSignatureStatuses: () => thunk({ value: [null] }),
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    expect(failure).toBe(requestFailure);
    expect(toAgencError(failure).signature).toBeNull();
  });

  it("wraps a frozen post-broadcast error with the in-flight signature", async () => {
    const frozen = Object.freeze(new Error("frozen RPC status failure"));
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () => {
        throw frozen;
      },
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    const hydrated = toAgencError(failure);
    expect(hydrated.signature).toBe(getSignatureFromTransaction(tx));
    expect(hydrated.message).toContain("frozen RPC status failure");
    expect((failure as Error).cause).toBe(frozen);
  });

  it("wraps a primitive post-broadcast rejection with the in-flight signature", async () => {
    const rpc = {
      getLatestBlockhash: () =>
        thunk({
          value: {
            blockhash: blockhashFromSeed(9),
            lastValidBlockHeight: 100n,
          },
        }),
      sendTransaction: () => thunk("sig"),
      getSignatureStatuses: () => {
        throw "RPC status channel closed";
      },
      getEpochInfo: () => thunk({ blockHeight: 50n }),
    } as unknown as RpcTransportRpc;
    const transport = createRpcTransport({ rpc, pollIntervalMs: 1 });
    const tx = await signedDummyTx(await generateKeyPairSigner());

    const failure = await transport.sendAndConfirm(tx).catch((e: unknown) => e);
    const hydrated = toAgencError(failure);
    expect(hydrated.signature).toBe(getSignatureFromTransaction(tx));
    expect(hydrated.message).toContain("RPC status channel closed");
    expect((failure as Error).cause).toBe("RPC status channel closed");
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
      extractCustomProgramErrorCode(new Error("custom program error: 0x1771")),
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
      "validateTaskResult",
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

  it("snapshots and freezes the configured referral recovery intent", async () => {
    const configured: { address: ReturnType<typeof address>; feeBps: number } =
      {
        address: REF,
        feeBps: 500,
      };
    const client = createMarketplaceClient({
      transport: fakeTransport(),
      signer: await generateKeyPairSigner(),
      referrer: configured,
    });
    configured.address = OTHER;
    configured.feeBps = 999;

    expect(client.defaultReferrer).toEqual({ address: REF, feeBps: 500 });
    expect(Object.isFrozen(client.defaultReferrer)).toBe(true);
  });
});
