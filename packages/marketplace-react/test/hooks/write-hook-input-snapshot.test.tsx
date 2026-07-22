import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  createNoopSigner,
  generateKeyPairSigner,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type InstructionWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  getRejectTaskResultInstructionDataDecoder,
  getRequestChangesInstructionDataDecoder,
} from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgencProvider,
  type MarketplaceClient,
  type ReadTransport,
} from "../../src/index.js";
import {
  useCompletionBond,
  useDispute,
  useRateHire,
  useSubmissionReview,
  useTaskLifecycle,
  useTaskWork,
} from "../../src/hooks/index.js";
import {
  snapshotFixedBytes32,
  snapshotOptionalFixedBytes,
  stabilizeSelectedTransactionSigner,
} from "../../src/hooks/internal.js";

const SYSTEM: Address = address("11111111111111111111111111111111");
const TASK: Address = address("So11111111111111111111111111111111111111112");
const TOKEN: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const COMPUTE: Address = address("ComputeBudget111111111111111111111111111111");
const RENT: Address = address("SysvarRent111111111111111111111111111111111");
const FAKE_LIFETIME = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
} as const;

function mutableSigner(initial: Address = SYSTEM) {
  const base = createNoopSigner(initial);
  let liveAddress: TransactionSigner["address"] = initial;
  const signer = Object.create(base) as TransactionSigner;
  Object.defineProperty(signer, "address", {
    configurable: true,
    enumerable: true,
    get: () => liveAddress,
  });
  return {
    signer,
    changeAddress(next: Address) {
      liveAddress = next;
    },
  };
}

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

function stubClient(
  signer: TransactionSigner = createNoopSigner(SYSTEM),
): MarketplaceClient {
  return {
    signer,
    transport: {} as MarketplaceClient["transport"],
    send: vi.fn(async () => ({ signature: "sig-send", logs: [] })),
    claimTaskWithJobSpec: vi.fn(async () => ({
      signature: "sig-claim",
      logs: [],
    })),
    submitTaskResult: vi.fn(async () => ({
      signature: "sig-submit",
      logs: [],
    })),
    acceptTaskResult: vi.fn(async () => ({
      signature: "sig-accept",
      logs: [],
    })),
    initiateDispute: vi.fn(async () => ({
      signature: "sig-dispute",
      logs: [],
    })),
    postCompletionBond: vi.fn(async () => ({
      signature: "sig-post",
      logs: [],
    })),
    reclaimCompletionBond: vi.fn(async () => ({
      signature: "sig-reclaim",
      logs: [],
    })),
    cancelTask: vi.fn(async () => ({ signature: "sig-cancel", logs: [] })),
    closeTask: vi.fn(async () => ({ signature: "sig-close", logs: [] })),
    autoAcceptTaskResult: vi.fn(async () => ({
      signature: "sig-auto-accept",
      logs: [],
    })),
    rateHire: vi.fn(async () => ({ signature: "sig-rate", logs: [] })),
  } as unknown as MarketplaceClient;
}

function wrapper(client: MarketplaceClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider
        config={{
          network: "localnet",
          client,
          queryTransport: readTransport(),
        }}
        queryClient={queryClient}
      >
        {children}
      </AgencProvider>
    );
  };
}

async function enqueueAndMutate<T>(
  enqueue: () => Promise<T>,
  mutate: () => void,
): Promise<T> {
  let settled!: T;
  await act(async () => {
    const running = enqueue();
    mutate();
    settled = await running;
  });
  return settled;
}

function firstInput(method: MarketplaceClient[keyof MarketplaceClient]) {
  return (method as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
    string,
    unknown
  >;
}

function instructionSigner(
  instruction: unknown,
): TransactionSigner | undefined {
  const accounts = (instruction as { accounts: readonly unknown[] }).accounts;
  return (
    accounts.find(
      (account) =>
        typeof account === "object" &&
        account !== null &&
        "signer" in account &&
        (account as { signer?: unknown }).signer !== undefined,
    ) as { signer?: TransactionSigner } | undefined
  )?.signer;
}

function messageWithAuthority(
  feePayer: TransactionSigner,
  authority: TransactionSigner,
) {
  const instruction: InstructionWithSigners &
    Pick<Instruction, "programAddress" | "data"> = {
    programAddress: SYSTEM,
    accounts: [
      {
        address: authority.address,
        role: AccountRole.READONLY_SIGNER,
        signer: authority,
      },
    ],
    data: new Uint8Array(),
  };
  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayerSigner(feePayer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(FAKE_LIFETIME, message),
    (message) => appendTransactionMessageInstruction(instruction, message),
  );
}

describe("write-hook snapshot primitives", () => {
  it("accepts an exact Uint8Array from another JavaScript realm", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const ForeignUint8Array = (
        frame.contentWindow as unknown as {
          Uint8Array: Uint8ArrayConstructor;
        }
      ).Uint8Array;
      const foreignBytes = new ForeignUint8Array(32).fill(0x7a);
      expect(foreignBytes).not.toBeInstanceOf(Uint8Array);

      const snapshot = snapshotFixedBytes32(foreignBytes, "cross-realm bytes");

      expect(snapshot).toEqual(new Uint8Array(32).fill(0x7a));
      expect(snapshot).toBeInstanceOf(Uint8Array);
      expect(snapshot).not.toBe(foreignBytes);

      const optionalSnapshot = snapshotOptionalFixedBytes(
        foreignBytes,
        32,
        "cross-realm optional bytes",
      );
      expect(optionalSnapshot).toEqual(new Uint8Array(32).fill(0x7a));
      expect(optionalSnapshot).not.toBe(foreignBytes);

      expect(() =>
        snapshotFixedBytes32(new Uint8ClampedArray(32), "clamped bytes"),
      ).toThrow(/exactly 32 bytes/);
      expect(() =>
        snapshotFixedBytes32(new DataView(new ArrayBuffer(32)), "data view"),
      ).toThrow(/exactly 32 bytes/);
    } finally {
      frame.remove();
    }
  });

  it("rejects non-byte views even when they spoof Uint8Array's tag", () => {
    const spoofTag = <T extends object>(value: T): T =>
      Object.defineProperty(value, Symbol.toStringTag, {
        configurable: true,
        value: "Uint8Array",
      });
    const impostors = [
      ["DataView", spoofTag(new DataView(new ArrayBuffer(32)))],
      ["Uint8ClampedArray", spoofTag(new Uint8ClampedArray(32))],
      ["Uint16Array", spoofTag(new Uint16Array(16))],
    ] as const;

    for (const [label, impostor] of impostors) {
      expect(() => snapshotFixedBytes32(impostor, label)).toThrow(
        /exactly 32 bytes/,
      );
      expect(() =>
        snapshotOptionalFixedBytes(impostor, 32, `optional ${label}`),
      ).toThrow(/exactly 32 bytes/);
    }
  });

  it("uses intrinsic byte length and rejects concurrently mutable backing", () => {
    const shortBytes = new Uint8Array(16).fill(0x31);
    Object.defineProperty(shortBytes, "byteLength", { value: 32 });
    expect(shortBytes.byteLength).toBe(32);
    expect(() =>
      snapshotFixedBytes32(shortBytes, "shadowed short bytes"),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      snapshotOptionalFixedBytes(shortBytes, 32, "optional shadowed bytes"),
    ).toThrow(/exactly 32 bytes/);

    const exactBytes = new Uint8Array(32).fill(0x52);
    Object.defineProperty(exactBytes, "byteLength", { value: 16 });
    const snapshot = snapshotFixedBytes32(exactBytes, "shadowed exact bytes");
    expect(snapshot).toEqual(new Uint8Array(32).fill(0x52));
    expect(snapshot).not.toBe(exactBytes);

    if (typeof SharedArrayBuffer !== "undefined") {
      const sharedBytes = new Uint8Array(new SharedArrayBuffer(32));
      expect(() => snapshotFixedBytes32(sharedBytes, "shared bytes")).toThrow(
        /exactly 32 bytes/,
      );
      expect(() =>
        snapshotOptionalFixedBytes(sharedBytes, 32, "optional shared bytes"),
      ).toThrow(/exactly 32 bytes/);
    }
  });

  it("preserves every supported OptionOrNullable byte representation", () => {
    const rawBytes = new Uint8Array(64).fill(0x44);
    const rawSnapshot = snapshotOptionalFixedBytes(
      rawBytes,
      64,
      "raw resultData",
    );
    expect(rawSnapshot).toEqual(rawBytes);
    expect(rawSnapshot).not.toBe(rawBytes);

    expect(snapshotOptionalFixedBytes(null, 64, "null resultData")).toBeNull();

    const explicitNone = none<Uint8Array>();
    const noneSnapshot = snapshotOptionalFixedBytes(
      explicitNone,
      64,
      "None resultData",
    );
    expect(noneSnapshot).toEqual(none());
    expect(noneSnapshot).not.toBe(explicitNone);
    expect(Object.isFrozen(noneSnapshot)).toBe(true);
  });

  it("canonicalizes a same-address override before Kit collects signers", async () => {
    const clientSigner = await generateKeyPairSigner();
    const sameAddressOverride: TransactionSigner = {
      address: clientSigner.address,
      signTransactions: async (transactions, config) =>
        clientSigner.signTransactions(transactions, config),
    };

    await expect(
      signTransactionMessageWithSigners(
        messageWithAuthority(clientSigner, sameAddressOverride),
      ),
    ).rejects.toThrow(/Multiple distinct signers/);

    const selected = stabilizeSelectedTransactionSigner(
      clientSigner,
      sameAddressOverride,
    );
    expect(selected).toBe(clientSigner);

    const signed = await signTransactionMessageWithSigners(
      messageWithAuthority(clientSigner, selected),
    );
    expect(signed.signatures[clientSigner.address]).toBeDefined();

    const distinctOverride = await generateKeyPairSigner();
    expect(
      stabilizeSelectedTransactionSigner(clientSigner, distinctOverride),
    ).toBe(distinctOverride);
  });
});

describe("public write-hook enqueue snapshots", () => {
  it("useTaskWork detaches claim/result bytes and stabilizes each authority", async () => {
    const client = stubClient(createNoopSigner(COMPUTE));
    const { result } = renderHook(() => useTaskWork(TASK), {
      wrapper: wrapper(client),
    });

    const claimAuthority = mutableSigner(SYSTEM);
    const jobSpecHash = new Uint8Array(32).fill(0x11);
    const expectedJobSpecHash = new Uint8Array(jobSpecHash);
    const claimInput = {
      worker: TOKEN,
      authority: claimAuthority.signer,
      jobSpecHash,
    };
    await enqueueAndMutate(
      () => result.current.claim(claimInput as never),
      () => {
        jobSpecHash.fill(0xa1);
        claimInput.worker = COMPUTE;
        claimAuthority.changeAddress(RENT);
      },
    );

    const claim = firstInput(client.claimTaskWithJobSpec);
    expect(claim.worker).toBe(TOKEN);
    expect(claim.jobSpecHash).toEqual(expectedJobSpecHash);
    expect(claim.jobSpecHash).not.toBe(jobSpecHash);
    expect(claim.authority).toBe(claimAuthority.signer);
    expect((claim.authority as TransactionSigner).address).toBe(SYSTEM);
    expect(Object.isFrozen(claimAuthority.signer)).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(claimAuthority.signer, "address"),
    ).toMatchObject({ configurable: false, writable: false, value: SYSTEM });

    const submitAuthority = mutableSigner(SYSTEM);
    const proofHash = new Uint8Array(32).fill(0x21);
    const resultBytes = new Uint8Array(64).fill(0x22);
    const expectedProofHash = new Uint8Array(proofHash);
    const expectedResultBytes = new Uint8Array(resultBytes);
    const resultData = { __option: "Some", value: resultBytes } as const;
    const submitInput = {
      worker: TOKEN,
      authority: submitAuthority.signer,
      proofHash,
      resultData,
    };
    await enqueueAndMutate(
      () => result.current.submit(submitInput as never),
      () => {
        proofHash.fill(0xb1);
        resultBytes.fill(0xb2);
        (resultData as { value: Uint8Array }).value = new Uint8Array(64).fill(
          0xb3,
        );
        submitInput.worker = COMPUTE;
        submitAuthority.changeAddress(RENT);
      },
    );

    const submit = firstInput(client.submitTaskResult);
    const submittedResult = submit.resultData as {
      __option: "Some";
      value: Uint8Array;
    };
    expect(submit.worker).toBe(TOKEN);
    expect(submit.proofHash).toEqual(expectedProofHash);
    expect(submit.proofHash).not.toBe(proofHash);
    expect(submittedResult).not.toBe(resultData);
    expect(submittedResult.value).toEqual(expectedResultBytes);
    expect(submittedResult.value).not.toBe(resultBytes);
    expect(submit.authority).toBe(submitAuthority.signer);
    expect((submit.authority as TransactionSigner).address).toBe(SYSTEM);
  });

  it("useSubmissionReview snapshots all three verbs, including bid settlement", async () => {
    const defaultSigner = mutableSigner(SYSTEM);
    const client = stubClient(defaultSigner.signer);
    const { result } = renderHook(() => useSubmissionReview(TASK), {
      wrapper: wrapper(client),
    });

    const bidSettlement = {
      acceptedBid: TOKEN,
      bidderMarketState: COMPUTE,
      bidderAuthority: RENT,
    };
    const acceptInput = {
      worker: TOKEN,
      treasury: SYSTEM,
      workerAuthority: RENT,
      bidSettlement,
    };
    await enqueueAndMutate(
      () => result.current.accept(acceptInput as never),
      () => {
        bidSettlement.acceptedBid = RENT;
        bidSettlement.bidderMarketState = RENT;
        acceptInput.worker = COMPUTE;
        defaultSigner.changeAddress(RENT);
      },
    );

    const accepted = firstInput(client.acceptTaskResult);
    expect(accepted.worker).toBe(TOKEN);
    expect(accepted.creator).toBe(defaultSigner.signer);
    expect((accepted.creator as TransactionSigner).address).toBe(SYSTEM);
    expect(accepted.bidSettlement).not.toBe(bidSettlement);
    expect(accepted.bidSettlement).toEqual({
      acceptedBid: TOKEN,
      bidderMarketState: COMPUTE,
      bidderAuthority: RENT,
    });

    const rejectSigner = mutableSigner(TOKEN);
    const rejectionHash = new Uint8Array(32).fill(0x31);
    const expectedRejectionHash = new Uint8Array(rejectionHash);
    const rejectInput = {
      worker: TOKEN,
      claim: COMPUTE,
      workerAuthority: RENT,
      rejectionHash,
      creator: rejectSigner.signer,
    };
    await enqueueAndMutate(
      () => result.current.reject(rejectInput as never),
      () => {
        rejectionHash.fill(0xc1);
        rejectInput.claim = RENT;
        rejectSigner.changeAddress(RENT);
      },
    );

    const changesHash = new Uint8Array(32).fill(0x41);
    const expectedChangesHash = new Uint8Array(changesHash);
    const changesInput = {
      claim: COMPUTE,
      changesHash,
    };
    await enqueueAndMutate(
      () => result.current.requestChanges(changesInput as never),
      () => {
        changesHash.fill(0xd1);
        changesInput.claim = RENT;
      },
    );

    const sendCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls;
    const rejectIx = sendCalls[0]![0][0];
    const changesIx = sendCalls[1]![0][0];
    expect(
      getRejectTaskResultInstructionDataDecoder().decode(rejectIx.data)
        .rejectionHash,
    ).toEqual(expectedRejectionHash);
    expect(
      getRequestChangesInstructionDataDecoder().decode(changesIx.data)
        .changesHash,
    ).toEqual(expectedChangesHash);
    expect(instructionSigner(rejectIx)).toBe(rejectSigner.signer);
    expect(rejectSigner.signer.address).toBe(TOKEN);
    expect(instructionSigner(changesIx)).toBe(defaultSigner.signer);
    expect(
      rejectIx.accounts.some(
        (meta: { address: Address }) => meta.address === COMPUTE,
      ),
    ).toBe(true);
    expect(
      changesIx.accounts.some(
        (meta: { address: Address }) => meta.address === COMPUTE,
      ),
    ).toBe(true);
  });

  it("useDispute detaches all fixed identities and its authority", async () => {
    const client = stubClient(createNoopSigner(COMPUTE));
    const { result } = renderHook(() => useDispute(TASK, { enabled: false }), {
      wrapper: wrapper(client),
    });
    const authority = mutableSigner(SYSTEM);
    const disputeId = new Uint8Array(32).fill(0x51);
    const taskId = new Uint8Array(32).fill(0x52);
    const evidenceHash = new Uint8Array(32).fill(0x53);
    const expectedDisputeId = new Uint8Array(disputeId);
    const expectedTaskId = new Uint8Array(taskId);
    const expectedEvidenceHash = new Uint8Array(evidenceHash);
    const input = {
      agent: TOKEN,
      authority: authority.signer,
      disputeId,
      taskId,
      evidenceHash,
      resolutionType: 0,
      evidence: "original evidence",
    };
    await enqueueAndMutate(
      () => result.current.initiate(input as never),
      () => {
        disputeId.fill(0xe1);
        taskId.fill(0xe2);
        evidenceHash.fill(0xe3);
        input.evidence = "mutated evidence";
        authority.changeAddress(RENT);
      },
    );

    const submitted = firstInput(client.initiateDispute);
    expect(submitted.disputeId).toEqual(expectedDisputeId);
    expect(submitted.taskId).toEqual(expectedTaskId);
    expect(submitted.evidenceHash).toEqual(expectedEvidenceHash);
    expect(submitted.evidence).toBe("original evidence");
    expect(submitted.authority).toBe(authority.signer);
    expect(authority.signer.address).toBe(SYSTEM);
  });

  it("useCompletionBond snapshots post and reclaim at their public boundaries", async () => {
    const postClient = stubClient(createNoopSigner(COMPUTE));
    const postHook = renderHook(() => useCompletionBond(TASK), {
      wrapper: wrapper(postClient),
    });
    const authority = mutableSigner(SYSTEM);
    const postInput = {
      role: 1,
      worker: TOKEN,
      authority: authority.signer,
      dependencyParent: COMPUTE,
    };
    await enqueueAndMutate(
      () => postHook.result.current.post(postInput as never),
      () => {
        postInput.role = 0;
        postInput.worker = RENT;
        postInput.dependencyParent = RENT;
        authority.changeAddress(RENT);
      },
    );
    const post = firstInput(postClient.postCompletionBond);
    expect(post).toMatchObject({
      role: 1,
      worker: TOKEN,
      dependencyParent: COMPUTE,
    });
    expect(post.authority).toBe(authority.signer);
    expect(authority.signer.address).toBe(SYSTEM);

    const feePayer = mutableSigner(SYSTEM);
    const reclaimClient = stubClient(feePayer.signer);
    const reclaimHook = renderHook(() => useCompletionBond(TASK), {
      wrapper: wrapper(reclaimClient),
    });
    const reclaimInput = { role: 1 };
    await enqueueAndMutate(
      () => reclaimHook.result.current.reclaim(reclaimInput as never),
      () => {
        reclaimInput.role = 0;
        feePayer.changeAddress(RENT);
      },
    );
    const reclaim = firstInput(reclaimClient.reclaimCompletionBond);
    expect(reclaim.role).toBe(1);
    expect(reclaim.party).toBe(SYSTEM);
    expect(feePayer.signer.address).toBe(SYSTEM);
    expect(Object.isFrozen(feePayer.signer)).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(feePayer.signer, "address"),
    ).toMatchObject({ configurable: false, writable: false, value: SYSTEM });
  });

  it("useTaskLifecycle detaches worker, child, and bid account collections", async () => {
    const defaultSigner = mutableSigner(SYSTEM);
    const client = stubClient(defaultSigner.signer);
    const { result } = renderHook(() => useTaskLifecycle(TASK), {
      wrapper: wrapper(client),
    });

    const workerAccounts = [
      { claim: TOKEN, workerAgent: COMPUTE, workerAuthority: RENT },
    ];
    const cancelBid = {
      kind: "accepted" as const,
      bidBook: TOKEN,
      acceptedBid: COMPUTE,
      bidderMarketState: RENT,
    };
    const cancelInput = {
      workerBondAuthority: RENT,
      workerAccounts,
      bidSettlement: cancelBid,
    };
    await enqueueAndMutate(
      () => result.current.cancel(cancelInput as never),
      () => {
        workerAccounts[0]!.claim = RENT;
        workerAccounts.push({
          claim: RENT,
          workerAgent: RENT,
          workerAuthority: RENT,
        });
        cancelBid.acceptedBid = RENT;
        cancelInput.workerBondAuthority = TOKEN;
        defaultSigner.changeAddress(RENT);
      },
    );
    const cancel = firstInput(client.cancelTask);
    expect(cancel.workerBondAuthority).toBe(RENT);
    expect(cancel.authority).toBe(defaultSigner.signer);
    expect(cancel.workerAccounts).not.toBe(workerAccounts);
    expect(cancel.workerAccounts).toEqual([
      { claim: TOKEN, workerAgent: COMPUTE, workerAuthority: RENT },
    ]);
    expect(cancel.bidSettlement).not.toBe(cancelBid);
    expect(cancel.bidSettlement).toMatchObject({ acceptedBid: COMPUTE });

    const closeAuthority = mutableSigner(TOKEN);
    const children = [
      { kind: "creatorFunded" as const, account: TOKEN },
      {
        kind: "namedRecipient" as const,
        account: COMPUTE,
        recipient: RENT,
      },
    ];
    const closeInput = {
      authority: closeAuthority.signer,
      creatorCompletionBond: TOKEN,
      children,
    };
    await enqueueAndMutate(
      () => result.current.close(closeInput as never),
      () => {
        children[0]!.account = RENT;
        children.splice(1, 1);
        closeInput.creatorCompletionBond = RENT;
        closeAuthority.changeAddress(RENT);
      },
    );
    const close = firstInput(client.closeTask);
    expect(close.creatorCompletionBond).toBe(TOKEN);
    expect(close.children).not.toBe(children);
    expect(close.children).toEqual([
      { kind: "creatorFunded", account: TOKEN },
      { kind: "namedRecipient", account: COMPUTE, recipient: RENT },
    ]);
    expect(close.authority).toBe(closeAuthority.signer);
    expect(closeAuthority.signer.address).toBe(TOKEN);

    const autoAuthority = mutableSigner(TOKEN);
    const autoBid = {
      acceptedBid: TOKEN,
      bidderMarketState: COMPUTE,
      bidderAuthority: RENT,
    };
    const autoInput = {
      worker: TOKEN,
      treasury: SYSTEM,
      creator: SYSTEM,
      workerAuthority: RENT,
      authority: autoAuthority.signer,
      bidSettlement: autoBid,
    };
    await enqueueAndMutate(
      () => result.current.autoAccept(autoInput as never),
      () => {
        autoBid.acceptedBid = RENT;
        autoInput.worker = COMPUTE;
        autoAuthority.changeAddress(RENT);
      },
    );
    const autoAccept = firstInput(client.autoAcceptTaskResult);
    expect(autoAccept.worker).toBe(TOKEN);
    expect(autoAccept.bidSettlement).not.toBe(autoBid);
    expect(autoAccept.bidSettlement).toMatchObject({ acceptedBid: TOKEN });
    expect(autoAccept.authority).toBe(autoAuthority.signer);
    expect(autoAuthority.signer.address).toBe(TOKEN);
  });

  it("useRateHire detaches optional review bytes and its buyer signer", async () => {
    const client = stubClient(createNoopSigner(COMPUTE));
    const { result } = renderHook(() => useRateHire(TASK), {
      wrapper: wrapper(client),
    });
    const buyer = mutableSigner(SYSTEM);
    const reviewBytes = new Uint8Array(32).fill(0x61);
    const expectedReviewBytes = new Uint8Array(reviewBytes);
    const reviewHash = { __option: "Some", value: reviewBytes } as const;
    const input = {
      listing: TOKEN,
      buyer: buyer.signer,
      score: 5,
      reviewHash,
      reviewUri: "https://example.test/reviews/original.json",
    };
    await enqueueAndMutate(
      () => result.current.rate(input as never),
      () => {
        reviewBytes.fill(0xf1);
        (reviewHash as { value: Uint8Array }).value = new Uint8Array(32).fill(
          0xf2,
        );
        input.score = 1;
        input.reviewUri = "https://example.test/reviews/mutated.json";
        buyer.changeAddress(RENT);
      },
    );

    const rate = firstInput(client.rateHire);
    const submittedHash = rate.reviewHash as {
      __option: "Some";
      value: Uint8Array;
    };
    expect(rate.score).toBe(5);
    expect(rate.reviewUri).toBe("https://example.test/reviews/original.json");
    expect(submittedHash).not.toBe(reviewHash);
    expect(submittedHash.value).toEqual(expectedReviewBytes);
    expect(submittedHash.value).not.toBe(reviewBytes);
    expect(rate.buyer).toBe(buyer.signer);
    expect(buyer.signer.address).toBe(SYSTEM);
  });

  it("useRateHire preserves an omitted review hash as undefined", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useRateHire(TASK), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.rate({ listing: TOKEN, score: 5 } as never);
    });

    expect(firstInput(client.rateHire).reviewHash).toBeUndefined();
  });
});
