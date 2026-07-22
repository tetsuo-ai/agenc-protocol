import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type InstructionWithSigners,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  HireAndActivateError,
  type HireAndActivateProgress,
} from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgencProvider,
  type AgencProviderConfig,
  type MarketplaceClient,
  type ReadTransport,
} from "../../src/index.js";
import {
  useHire,
  useHumanlessHireFlow,
  useTaskActivation,
} from "../../src/hooks/index.js";

const SYSTEM = address("11111111111111111111111111111111");
const LISTING = address("So11111111111111111111111111111111111111112");
const TASK = address("SysvarC1ock11111111111111111111111111111111");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const HIRE_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(31));
const ACTIVATION_SIGNATURE = getBase58Decoder().decode(
  new Uint8Array(64).fill(32),
);
const LIFETIME = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
} as const;

function readTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: vi.fn(async () => []),
    getListing: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listingHires: vi.fn(async () => []),
    agentTrackRecord: vi.fn(async () => {
      throw new Error("not implemented");
    }),
  };
}

function wrapper(config: AgencProviderConfig) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider config={config} queryClient={queryClient}>
        {children}
      </AgencProvider>
    );
  };
}

function stubClient(
  signer: TransactionSigner,
  overrides: Partial<MarketplaceClient> = {},
): MarketplaceClient {
  return {
    signer,
    transport: {} as MarketplaceClient["transport"],
    hireFromListing: vi.fn(async () => ({ signature: "sig-hire", logs: [] })),
    hireFromListingHumanless: vi.fn(async () => ({
      signature: HIRE_SIGNATURE,
      logs: [],
    })),
    setTaskJobSpec: vi.fn(async () => ({
      signature: ACTIVATION_SIGNATURE,
      logs: [],
    })),
    ...overrides,
  } as unknown as MarketplaceClient;
}

function signerForSameAddress(
  implementation: TransactionPartialSigner,
): TransactionPartialSigner {
  return {
    address: implementation.address,
    signTransactions: (transactions, config) =>
      implementation.signTransactions(transactions, config),
  };
}

async function collectWithRealKit(
  feePayer: TransactionSigner,
  instructionSigners: readonly TransactionSigner[],
) {
  const instruction: InstructionWithSigners &
    Pick<Instruction, "programAddress" | "data"> = {
    programAddress: SYSTEM,
    accounts: instructionSigners.map((signer) => ({
      address: signer.address,
      role: AccountRole.READONLY_SIGNER,
      signer,
    })),
    data: new Uint8Array(),
  };
  const withFeePayer = setTransactionMessageFeePayerSigner(
    feePayer,
    createTransactionMessage({ version: 0 }),
  );
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    LIFETIME,
    withFeePayer,
  );
  return signTransactionMessageWithSigners(
    appendTransactionMessageInstruction(instruction, withLifetime),
  );
}

function standardHireInput(overrides: Record<string, unknown> = {}) {
  return {
    listing: LISTING,
    creatorAgent: LISTING,
    taskId: new Uint8Array(32).fill(1),
    expectedPrice: 1_000_000n,
    expectedVersion: 1n,
    moderator: LISTING,
    moderatorIsAttestor: false,
    ...overrides,
  };
}

function flowInput(
  taskId: Uint8Array,
  listingSpecHash: Uint8Array,
  taskJobSpecHash: Uint8Array,
) {
  const committedHash = new Uint8Array(taskJobSpecHash);
  return {
    hire: {
      listing: LISTING,
      providerAgent: LISTING,
      taskId,
      expectedPrice: 1_000_000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3_600n,
      listingSpecHash,
      taskJobSpecHash,
      moderator: LISTING,
      moderatorIsAttestor: false,
    },
    jobSpec: { title: "Boundary snapshot" },
    hostAndModerateJobSpec: vi.fn(async () => ({
      jobSpecHash: committedHash,
      jobSpecUri: "https://example.test/specs/boundary.json",
      moderationAttested: true,
      moderator: LISTING,
    })),
    activation: { moderatorIsAttestor: false },
  };
}

function foreignBytes(
  constructor: Uint8ArrayConstructor,
  fill: number,
): Uint8Array {
  return new constructor(32).fill(fill);
}

describe("public hook signer canonicalization", () => {
  it("useHire reuses the fee payer for distinct same-address overrides", async () => {
    const feePayer = await generateKeyPairSigner();
    const creator = signerForSameAddress(feePayer);
    const authority = signerForSameAddress(feePayer);
    let submitted: Record<string, unknown> | undefined;
    const client = stubClient(feePayer, {
      hireFromListing: vi.fn(async (input: Record<string, unknown>) => {
        submitted = input;
        await collectWithRealKit(feePayer, [
          input.creator as TransactionSigner,
          input.authority as TransactionSigner,
        ]);
        return { signature: "sig-hire", logs: [] };
      }) as MarketplaceClient["hireFromListing"],
    });
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    await act(async () => {
      await result.current.hire(
        standardHireInput({ creator, authority }) as never,
      );
    });

    expect(submitted?.creator).toBe(feePayer);
    expect(submitted?.authority).toBe(feePayer);
  });

  it("useHire merges same non-client identities but preserves distinct addresses", async () => {
    const feePayer = await generateKeyPairSigner();
    const actor = await generateKeyPairSigner();
    const otherActor = await generateKeyPairSigner();
    const calls: Record<string, unknown>[] = [];
    const client = stubClient(feePayer, {
      hireFromListing: vi.fn(async (input: Record<string, unknown>) => {
        calls.push(input);
        await collectWithRealKit(feePayer, [
          input.creator as TransactionSigner,
          input.authority as TransactionSigner,
        ]);
        return { signature: "sig-hire", logs: [] };
      }) as MarketplaceClient["hireFromListing"],
    });
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    const creator = signerForSameAddress(actor);
    const sameActorAuthority = signerForSameAddress(actor);
    await act(async () => {
      await result.current.hire(
        standardHireInput({ creator, authority: sameActorAuthority }) as never,
      );
    });
    expect(calls[0]!.creator).toBe(creator);
    expect(calls[0]!.authority).toBe(creator);

    const distinctCreator = signerForSameAddress(actor);
    const distinctAuthority = signerForSameAddress(otherActor);
    await act(async () => {
      await result.current.hire(
        standardHireInput({
          taskId: new Uint8Array(32).fill(2),
          creator: distinctCreator,
          authority: distinctAuthority,
        }) as never,
      );
    });
    expect(calls[1]!.creator).toBe(distinctCreator);
    expect(calls[1]!.authority).toBe(distinctAuthority);
  });

  it("useTaskActivation reuses a same-address fee-payer override", async () => {
    const feePayer = await generateKeyPairSigner();
    const creator = signerForSameAddress(feePayer);
    let submittedCreator: TransactionSigner | undefined;
    const client = stubClient(feePayer, {
      setTaskJobSpec: vi.fn(async (input: Record<string, unknown>) => {
        submittedCreator = input.creator as TransactionSigner;
        await collectWithRealKit(feePayer, [submittedCreator]);
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      }) as MarketplaceClient["setTaskJobSpec"],
    });
    const { result } = renderHook(() => useTaskActivation(TASK), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    await act(async () => {
      await result.current.activate({
        creator,
        jobSpecHash: new Uint8Array(32).fill(3),
        jobSpecUri: "https://example.test/specs/activation.json",
        moderator: LISTING,
        moderatorIsAttestor: false,
      });
    });

    expect(submittedCreator).toBe(feePayer);

    const distinctBacking = await generateKeyPairSigner();
    const distinctCreator = signerForSameAddress(distinctBacking);
    await act(async () => {
      await result.current.activate({
        creator: distinctCreator,
        jobSpecHash: new Uint8Array(32).fill(4),
        jobSpecUri: "https://example.test/specs/distinct-activation.json",
        moderator: LISTING,
        moderatorIsAttestor: false,
      });
    });
    expect(submittedCreator).toBe(distinctCreator);
  });

  it("useHumanlessHireFlow reuses its fee payer through SDK orchestration", async () => {
    const feePayer = await generateKeyPairSigner();
    const creator = signerForSameAddress(feePayer);
    let submittedCreator: TransactionSigner | undefined;
    const client = stubClient(feePayer, {
      hireFromListingHumanless: vi.fn(
        async (input: Record<string, unknown>) => {
          submittedCreator = input.creator as TransactionSigner;
          await collectWithRealKit(feePayer, [submittedCreator]);
          return { signature: HIRE_SIGNATURE, logs: [] };
        },
      ) as MarketplaceClient["hireFromListingHumanless"],
    });
    const input = flowInput(
      new Uint8Array(32).fill(4),
      new Uint8Array(32).fill(5),
      new Uint8Array(32).fill(6),
    );
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    await act(async () => {
      await result.current.hireAndActivate({ ...input, creator });
    });

    expect(submittedCreator).toBe(feePayer);

    const distinctBacking = await generateKeyPairSigner();
    const distinctCreator = signerForSameAddress(distinctBacking);
    const distinctInput = flowInput(
      new Uint8Array(32).fill(7),
      new Uint8Array(32).fill(8),
      new Uint8Array(32).fill(9),
    );
    await act(async () => {
      await result.current.hireAndActivate({
        ...distinctInput,
        creator: distinctCreator,
      });
    });
    expect(submittedCreator).toBe(distinctCreator);
  });
});

describe("useHumanlessHireFlow cross-realm byte snapshots", () => {
  it("detaches every fresh-hire commitment before immediate caller mutation", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const ForeignUint8Array = (
        frame.contentWindow as unknown as {
          Uint8Array: Uint8ArrayConstructor;
        }
      ).Uint8Array;
      const taskId = foreignBytes(ForeignUint8Array, 0x21);
      const listingSpecHash = foreignBytes(ForeignUint8Array, 0x22);
      const taskJobSpecHash = foreignBytes(ForeignUint8Array, 0x23);
      expect(taskId).not.toBeInstanceOf(Uint8Array);
      const expectedTaskId = new Uint8Array(taskId);
      const expectedListingSpecHash = new Uint8Array(listingSpecHash);
      const expectedTaskJobSpecHash = new Uint8Array(taskJobSpecHash);
      const input = flowInput(taskId, listingSpecHash, taskJobSpecHash);
      let submitted: Record<string, unknown> | undefined;
      const client = stubClient(await generateKeyPairSigner(), {
        hireFromListingHumanless: vi.fn(
          async (wire: Record<string, unknown>) => {
            submitted = wire;
            return { signature: HIRE_SIGNATURE, logs: [] };
          },
        ) as MarketplaceClient["hireFromListingHumanless"],
      });
      const { result } = renderHook(() => useHumanlessHireFlow(), {
        wrapper: wrapper({
          network: "localnet",
          client,
          queryTransport: readTransport(),
        }),
      });

      await act(async () => {
        const running = result.current.hireAndActivate(input);
        taskId.fill(0xf1);
        listingSpecHash.fill(0xf2);
        taskJobSpecHash.fill(0xf3);
        await running;
      });

      expect(submitted?.taskId).toEqual(expectedTaskId);
      expect(submitted?.listingSpecHash).toEqual(expectedListingSpecHash);
      expect(submitted?.taskJobSpecHash).toEqual(expectedTaskJobSpecHash);
      expect(input.hostAndModerateJobSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: expectedTaskId,
        }),
      );
    } finally {
      frame.remove();
    }
  });

  it("detaches resume commitments and recovery hash before immediate mutation", async () => {
    const taskId = new Uint8Array(32).fill(0x31);
    const listingSpecHash = new Uint8Array(32).fill(0x32);
    const taskJobSpecHash = new Uint8Array(32).fill(0x33);
    const initialInput = flowInput(taskId, listingSpecHash, taskJobSpecHash);
    let activationAttempts = 0;
    const setTaskJobSpec = vi.fn(async (_input: Record<string, unknown>) => {
      activationAttempts += 1;
      if (activationAttempts === 1) throw new Error("pause before resume");
      return { signature: ACTIVATION_SIGNATURE, logs: [] };
    });
    const client = stubClient(await generateKeyPairSigner(), {
      setTaskJobSpec: setTaskJobSpec as MarketplaceClient["setTaskJobSpec"],
    });
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    let recovery!: HireAndActivateProgress;
    await act(async () => {
      const failure = await result.current
        .hireAndActivate(initialInput)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(HireAndActivateError);
      recovery = (failure as HireAndActivateError).progress;
    });
    expect(recovery.phase).toBe("activating");

    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const ForeignUint8Array = (
        frame.contentWindow as unknown as {
          Uint8Array: Uint8ArrayConstructor;
        }
      ).Uint8Array;
      const foreignTaskId = foreignBytes(ForeignUint8Array, 0x31);
      const foreignListingHash = foreignBytes(ForeignUint8Array, 0x32);
      const foreignJobHash = foreignBytes(ForeignUint8Array, 0x33);
      const foreignRecoveryHash = foreignBytes(ForeignUint8Array, 0x33);
      const resumeInput = flowInput(
        foreignTaskId,
        foreignListingHash,
        foreignJobHash,
      );
      const foreignRecovery = {
        ...recovery,
        jobSpecHash: foreignRecoveryHash,
      } as HireAndActivateProgress;

      await act(async () => {
        const running = result.current.resumeHireAndActivate(
          resumeInput,
          foreignRecovery,
        );
        foreignTaskId.fill(0xe1);
        foreignListingHash.fill(0xe2);
        foreignJobHash.fill(0xe3);
        foreignRecoveryHash.fill(0xe4);
        await running;
      });

      const resumedActivation = setTaskJobSpec.mock.calls[1]![0] as Record<
        string,
        unknown
      >;
      expect(resumedActivation.jobSpecHash).toEqual(
        new Uint8Array(32).fill(0x33),
      );
      expect(client.hireFromListingHumanless).toHaveBeenCalledTimes(1);
    } finally {
      frame.remove();
    }
  });

  it("rejects SharedArrayBuffer-backed flow commitments before enqueue", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const client = stubClient(await generateKeyPairSigner());
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });

    const rejection = result.current.hireAndActivate(
      flowInput(
        new Uint8Array(new SharedArrayBuffer(32)),
        new Uint8Array(32).fill(2),
        new Uint8Array(32).fill(3),
      ),
    );
    await expect(rejection).rejects.toThrow(
      /useHumanlessHireFlow: hire\.taskId must be exactly 32 bytes/,
    );
    expect(client.hireFromListingHumanless).not.toHaveBeenCalled();
  });

  it("rejects nested shared job-spec graphs before enqueue", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const client = stubClient(await generateKeyPairSigner());
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });
    const root: Record<string, unknown> = {};
    root.self = root;
    root.map = new Map([
      [
        "nested",
        new Set([{ bytes: new Uint8Array(new SharedArrayBuffer(32)).fill(7) }]),
      ],
    ]);
    const input = {
      ...flowInput(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        new Uint8Array(32).fill(3),
      ),
      jobSpec: root,
    };

    await expect(result.current.hireAndActivate(input)).rejects.toThrow(
      /jobSpec must be structured-cloneable/,
    );
    expect(client.hireFromListingHumanless).not.toHaveBeenCalled();
  });

  it("rejects hidden shared WebAssembly.Memory before enqueue", async () => {
    if (
      typeof WebAssembly === "undefined" ||
      WebAssembly.Memory === undefined ||
      typeof SharedArrayBuffer === "undefined"
    ) {
      return;
    }
    const client = stubClient(await generateKeyPairSigner());
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const input = {
      ...flowInput(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        new Uint8Array(32).fill(3),
      ),
      jobSpec: { nested: new Map([["memory", memory]]) },
    };

    await expect(result.current.hireAndActivate(input)).rejects.toThrow(
      /jobSpec must be structured-cloneable/,
    );
    expect(client.hireFromListingHumanless).not.toHaveBeenCalled();
  });

  it("preserves and detaches ordinary cyclic Map/Set job specs", async () => {
    const client = stubClient(await generateKeyPairSigner());
    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: readTransport(),
      }),
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const jobSpec: Record<string, unknown> = { bytes };
    jobSpec.self = jobSpec;
    jobSpec.map = new Map([["set", new Set([jobSpec])]]);
    let hosted: Record<string, unknown> | undefined;
    const base = flowInput(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
    );
    const input = {
      ...base,
      jobSpec,
      hostAndModerateJobSpec: vi.fn(async (host: { jobSpec: unknown }) => {
        hosted = host.jobSpec as Record<string, unknown>;
        return {
          jobSpecHash: new Uint8Array(32).fill(3),
          jobSpecUri: "https://example.test/specs/cyclic.json",
          moderationAttested: true,
          moderator: LISTING,
        };
      }),
    };

    await act(async () => {
      const pending = result.current.hireAndActivate(input);
      bytes.fill(9);
      await pending;
    });

    expect(hosted).toBeDefined();
    expect(hosted!.self).toBe(hosted);
    expect(Array.from(hosted!.bytes as Uint8Array)).toEqual([1, 2, 3]);
    const hostedSet = (hosted!.map as Map<string, Set<unknown>>).get("set")!;
    expect(hostedSet.has(hosted)).toBe(true);
  });
});
