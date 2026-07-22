/**
 * WP-D6 orchestration unit coverage.
 *
 * The moderation-account resolvers decide which P1.2 gate accounts a
 * transaction carries (roster PDA / legacy record override), so their
 * branching is money-path-adjacent: attach the roster entry only when it
 * verifiably exists, prefer v2 records, honor the legacy grace window only
 * for the SAME moderator, and degrade to "no overrides" on any read failure.
 * The generated account fetchers are mocked at the module seam (the react
 * suite's proven pattern); PDA derivation is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({
  records: {} as Record<string, { moderator: string }>,
  tasks: {} as Record<string, Record<string, unknown>>,
  escrows: {} as Record<string, Record<string, unknown>>,
  hireRecords: {} as Record<string, Record<string, unknown>>,
  validationConfigs: {} as Record<string, Record<string, unknown>>,
  listings: {} as Record<string, Record<string, unknown>>,
  protocolConfigs: {} as Record<string, Record<string, unknown>>,
  transactions: {} as Record<string, Record<string, unknown>>,
  jobSpecs: {} as Record<
    string,
    {
      task: string;
      creator: string;
      jobSpecHash: Uint8Array;
      jobSpecUri: string;
    }
  >,
  attestors: {} as Record<string, true>,
  moderationConfig: null as null | { moderationAuthority: string },
  throwOnFetch: false,
}));

vi.mock("../src/generated/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/generated/index.js")>();
  const fetchRecord = async (_rpc: unknown, addr: unknown) => {
    if (chain.throwOnFetch) throw new Error("rpc unavailable");
    const data = chain.records[addr as string];
    return data
      ? { exists: true, address: addr, data }
      : { exists: false, address: addr };
  };
  return {
    ...actual,
    fetchMaybeTaskModeration: vi.fn(fetchRecord),
    fetchMaybeListingModeration: vi.fn(fetchRecord),
    fetchMaybeModerationAttestor: vi.fn(
      async (_rpc: unknown, addr: unknown) => {
        if (chain.throwOnFetch) throw new Error("rpc unavailable");
        return chain.attestors[addr as string]
          ? { exists: true, address: addr, data: {} }
          : { exists: false, address: addr };
      },
    ),
    fetchMaybeModerationConfig: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      return chain.moderationConfig
        ? { exists: true, address: addr, data: chain.moderationConfig }
        : { exists: false, address: addr };
    }),
    fetchMaybeTaskJobSpec: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.jobSpecs[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
    fetchMaybeTask: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.tasks[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
    fetchMaybeTaskEscrow: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.escrows[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
    fetchMaybeHireRecord: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.hireRecords[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
    fetchMaybeTaskValidationConfig: vi.fn(
      async (_rpc: unknown, addr: unknown) => {
        if (chain.throwOnFetch) throw new Error("rpc unavailable");
        const data = chain.validationConfigs[addr as string];
        return data
          ? { exists: true, address: addr, data }
          : { exists: false, address: addr };
      },
    ),
    fetchMaybeServiceListing: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.listings[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
    fetchMaybeProtocolConfig: vi.fn(async (_rpc: unknown, addr: unknown) => {
      if (chain.throwOnFetch) throw new Error("rpc unavailable");
      const data = chain.protocolConfigs[addr as string];
      return data
        ? { exists: true, address: addr, data }
        : { exists: false, address: addr };
    }),
  };
});

import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getSignatureFromTransaction,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { runInNewContext } from "node:vm";
import {
  AgencError,
  createMarketplaceClient,
  type Transport,
} from "../src/client/index.js";
import {
  findListingModerationPda,
  findCreateTaskHumanlessAuthorityRateLimitPda,
  findEscrowPda,
  findHireRecordPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskModerationPda,
  findTaskJobSpecPda,
  findTaskPda,
  findTaskValidationConfigPda,
  getHireFromListingHumanlessInstructionDataEncoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  ListingState,
  TaskStatus,
  TaskType,
  ValidationMode,
} from "../src/generated/index.js";
import * as facade from "../src/facade/index.js";
import {
  hireAndActivate,
  HireAndActivateError,
  HireAndActivateFinalizedFailure,
  resumeHireAndActivate,
  resolveActivationModerationAccounts,
  resolveHireListingModerationAccounts,
  type ModerationAccountReadRpc,
} from "../src/orchestration/index.js";

const RPC = {
  getTransaction(signature: string) {
    return {
      send: async () => chain.transactions[signature] ?? null,
    };
  },
} as unknown as ModerationAccountReadRpc;
const GLOBAL_AUTHORITY = address("11111111111111111111111111111111");
const ROSTER_MODERATOR = address("So11111111111111111111111111111111111111112");
const TASK = address("SysvarC1ock11111111111111111111111111111111");
const LISTING = address("SysvarRent111111111111111111111111111111111");
const PROVIDER_AGENT = address("Vote111111111111111111111111111111111111111");
const LISTING_HASH = new Uint8Array(32).fill(7);
const HASH = new Uint8Array(32).fill(9);
const CANDIDATE_SIGNATURE = getBase58Decoder().decode(
  new Uint8Array(64).fill(3),
);
const OTHER_CANDIDATE_SIGNATURE = getBase58Decoder().decode(
  new Uint8Array(64).fill(4),
);
const ACTIVATION_SIGNATURE = getBase58Decoder().decode(
  new Uint8Array(64).fill(5),
);
const CREATED_AT = 1_000n;
const DEFAULT_DEADLINE_SECS = 7_200n;
const PROTOCOL_FEE_BPS = 250;
const MANUAL_VALIDATION_SENTINEL = new TextEncoder().encode(
  "agenc-manual-validation-v2-seed!",
);

beforeEach(() => {
  chain.records = {};
  chain.tasks = {};
  chain.escrows = {};
  chain.hireRecords = {};
  chain.validationConfigs = {};
  chain.listings = {};
  chain.protocolConfigs = {};
  chain.transactions = {};
  chain.jobSpecs = {};
  chain.attestors = {};
  chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
  chain.throwOnFetch = false;
});

describe("resolveActivationModerationAccounts", () => {
  it("attaches nothing on the global-authority path with a v2 record", async () => {
    const [v2] = await findTaskModerationPda({
      task: TASK,
      jobSpecHash: HASH,
      moderator: GLOBAL_AUTHORITY,
    });
    chain.records[v2] = { moderator: GLOBAL_AUTHORITY };
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: GLOBAL_AUTHORITY,
      }),
    ).resolves.toEqual({});
  });

  it("attaches the roster PDA only when the entry exists on-chain", async () => {
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    // No roster entry -> no attach (a set-but-missing account fails harder).
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
    // Entry exists -> attach.
    chain.attestors[rosterPda] = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });
  });

  it("points at the legacy record ONLY when authored by the same moderator", async () => {
    const [legacyPda] = await facade.findLegacyTaskModerationPda({
      task: TASK,
      jobSpecHash: HASH,
    });
    chain.records[legacyPda] = { moderator: ROSTER_MODERATOR };
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    chain.attestors[rosterPda] = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({
      moderationAttestor: rosterPda,
      taskModeration: legacyPda,
    });
    // Different author -> the override must NOT be attached.
    chain.records[legacyPda] = { moderator: GLOBAL_AUTHORITY };
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });
  });

  it("degrades to no overrides on read failure and without an rpc", async () => {
    chain.throwOnFetch = true;
    await expect(
      resolveActivationModerationAccounts({
        rpc: RPC,
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
    await expect(
      resolveActivationModerationAccounts({
        task: TASK,
        jobSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({});
  });
});

describe("resolveHireListingModerationAccounts", () => {
  it("prefers the v2 listing record and returns the legacy override otherwise", async () => {
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    chain.attestors[rosterPda] = true;
    const [v2] = await findListingModerationPda({
      listing: LISTING,
      jobSpecHash: HASH,
      moderator: ROSTER_MODERATOR,
    });
    chain.records[v2] = { moderator: ROSTER_MODERATOR };
    await expect(
      resolveHireListingModerationAccounts({
        rpc: RPC,
        listing: LISTING,
        listingSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({ moderationAttestor: rosterPda });

    delete chain.records[v2];
    const [legacyPda] = await facade.findLegacyListingModerationPda({
      listing: LISTING,
      jobSpecHash: HASH,
    });
    chain.records[legacyPda] = { moderator: ROSTER_MODERATOR };
    await expect(
      resolveHireListingModerationAccounts({
        rpc: RPC,
        listing: LISTING,
        listingSpecHash: HASH,
        moderator: ROSTER_MODERATOR,
      }),
    ).resolves.toEqual({
      moderationAttestor: rosterPda,
      listingModeration: legacyPda,
    });
  });
});

describe("hireAndActivate moderation-result validation", () => {
  function stubClient(calls: string[]) {
    return {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        calls.push("hire");
        return { signature: CANDIDATE_SIGNATURE, logs: [] };
      },
      setTaskJobSpec: async () => {
        calls.push("activate");
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
  }
  const hire = {
    listing: LISTING,
    providerAgent: PROVIDER_AGENT,
    taskId: new Uint8Array(32).fill(1),
    expectedPrice: 1n,
    expectedVersion: 1n,
    reviewWindowSecs: 3600n,
    listingSpecHash: LISTING_HASH,
    taskJobSpecHash: HASH,
    moderator: GLOBAL_AUTHORITY,
  };

  async function recordFinalizedHire(
    taskOverrides: Record<string, unknown> = {},
  ) {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const [[escrowPda], [hireRecordPda], [validationConfigPda]] =
      await Promise.all([
        findEscrowPda({ task: taskPda }),
        findHireRecordPda({ task: taskPda }),
        findTaskValidationConfigPda({ task: taskPda }),
      ]);
    const [protocolConfigPda] = await findProtocolConfigPda();
    chain.listings[LISTING] = {
      providerAgent: PROVIDER_AGENT,
      specHash: new Uint8Array(LISTING_HASH),
      price: 1n,
      priceMint: { __option: "None" },
      requiredCapabilities: 0x55n,
      defaultDeadlineSecs: DEFAULT_DEADLINE_SECS,
      operator: GLOBAL_AUTHORITY,
      operatorFeeBps: 0,
      state: ListingState.Active,
      version: 1n,
    };
    chain.protocolConfigs[protocolConfigPda] = {
      protocolFeeBps: PROTOCOL_FEE_BPS,
      maxClaimDuration: 86_400n,
    };
    chain.tasks[taskPda] = {
      taskId: new Uint8Array(hire.taskId),
      creator: GLOBAL_AUTHORITY,
      requiredCapabilities: 0x55n,
      rewardAmount: 1n,
      maxWorkers: 1,
      currentWorkers: 0,
      status: TaskStatus.Open,
      taskType: TaskType.Exclusive,
      createdAt: CREATED_AT,
      deadline: CREATED_AT + DEFAULT_DEADLINE_SECS,
      completedAt: 0n,
      escrow: escrowPda,
      completions: 0,
      requiredCompletions: 1,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      minReputation: 0,
      rewardMint: { __option: "None" },
      operator: GLOBAL_AUTHORITY,
      operatorFeeBps: 0,
      referrer: GLOBAL_AUTHORITY,
      referrerFeeBps: 0,
      constraintHash: new Uint8Array(MANUAL_VALIDATION_SENTINEL),
      // Revision 5 stores the listing commitment in the first half and the
      // buyer-specific task commitment in the second half. Reconciliation
      // must compare the latter before adopting an already-funded hire.
      description: new Uint8Array(64).map((_, index) =>
        index >= 32 ? HASH[index - 32]! : LISTING_HASH[index]!,
      ),
      ...taskOverrides,
    };
    chain.escrows[escrowPda] = {
      task: taskPda,
      amount: 1n,
      distributed: 0n,
      isClosed: false,
    };
    chain.hireRecords[hireRecordPda] = {
      task: taskPda,
      listing: LISTING,
      operator: GLOBAL_AUTHORITY,
      operatorFeeBps: 0,
      designatedProvider: PROVIDER_AGENT,
      referrer: GLOBAL_AUTHORITY,
      referrerFeeBps: 0,
    };
    chain.validationConfigs[validationConfigPda] = {
      task: taskPda,
      creator: GLOBAL_AUTHORITY,
      mode: ValidationMode.CreatorReview,
      reviewWindowSecs: 3600n,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    return taskPda;
  }

  async function recordSuccessfulHireTransaction(
    signature = CANDIDATE_SIGNATURE,
    hireOverrides: Partial<Omit<typeof hire, "moderator">> & {
      moderator?: Address;
      referrer?: Address;
      referrerFeeBps?: number;
    } = {},
  ) {
    const intent = { ...hire, ...hireOverrides };
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: intent.taskId,
    });
    const [
      [escrowPda],
      [hireRecordPda],
      [validationConfigPda],
      [protocolConfigPda],
      [moderationConfigPda],
      [listingModerationPda],
      [moderationBlockPda],
      [authorityRateLimitPda],
    ] = await Promise.all([
      findEscrowPda({ task: taskPda }),
      findHireRecordPda({ task: taskPda }),
      findTaskValidationConfigPda({ task: taskPda }),
      findProtocolConfigPda(),
      findModerationConfigPda(),
      findListingModerationPda({
        listing: intent.listing,
        jobSpecHash: intent.listingSpecHash,
        moderator: intent.moderator,
      }),
      findModerationBlockPda({ contentHash: intent.listingSpecHash }),
      findCreateTaskHumanlessAuthorityRateLimitPda({
        creator: GLOBAL_AUTHORITY,
      }),
    ]);
    const instructionAccounts = [
      taskPda,
      escrowPda,
      hireRecordPda,
      validationConfigPda,
      intent.listing,
      intent.providerAgent,
      protocolConfigPda,
      moderationConfigPda,
      listingModerationPda,
      AGENC_COORDINATION_PROGRAM_ADDRESS,
      moderationBlockPda,
      authorityRateLimitPda,
      GLOBAL_AUTHORITY,
      GLOBAL_AUTHORITY,
    ];
    const accountKeys = Array.from(
      new Set([...instructionAccounts, AGENC_COORDINATION_PROGRAM_ADDRESS]),
    );
    const data = getBase58Decoder().decode(
      getHireFromListingHumanlessInstructionDataEncoder().encode({
        taskId: intent.taskId,
        expectedPrice: intent.expectedPrice,
        expectedVersion: intent.expectedVersion,
        reviewWindowSecs: intent.reviewWindowSecs,
        referrer: intent.referrer ?? null,
        referrerFeeBps: intent.referrerFeeBps ?? 0,
        moderator: intent.moderator,
        taskJobSpecHash: intent.taskJobSpecHash,
      }),
    );
    chain.transactions[signature] = {
      meta: { err: null },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys,
          addressTableLookups: [],
          instructions: [
            {
              accounts: instructionAccounts.map((account) =>
                accountKeys.indexOf(account),
              ),
              data,
              programIdIndex: accountKeys.indexOf(
                AGENC_COORDINATION_PROGRAM_ADDRESS,
              ),
            },
          ],
        },
      },
    };
  }

  async function validIntentDigest(): Promise<string> {
    const failure = await hireAndActivate(stubClient([]), {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        throw new Error("capture durable intent digest");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HireAndActivateError);
    return (failure as HireAndActivateError).progress.hireIntentDigest;
  }

  it.each([
    [
      "unattested moderation",
      {
        moderationAttested: false,
        jobSpecHash: HASH,
        jobSpecUri: "u",
        moderator: GLOBAL_AUTHORITY as string,
      },
      /was not attested/i,
    ],
    [
      "invalid jobSpecHash",
      {
        moderationAttested: true,
        jobSpecHash: new Uint8Array(31),
        jobSpecUri: "u",
        moderator: GLOBAL_AUTHORITY as string,
      },
      /invalid jobSpecHash/i,
    ],
    [
      "empty jobSpecUri",
      {
        moderationAttested: true,
        jobSpecHash: HASH,
        jobSpecUri: "  ",
        moderator: GLOBAL_AUTHORITY as string,
      },
      /empty jobSpecUri/i,
    ],
    [
      "a hash different from the funded hire commitment",
      {
        moderationAttested: true,
        jobSpecHash: new Uint8Array(32).fill(8),
        jobSpecUri: "u",
        moderator: GLOBAL_AUTHORITY as string,
      },
      /different from the hash committed at hire/i,
    ],
    [
      "missing moderator",
      {
        moderationAttested: true,
        jobSpecHash: HASH,
        jobSpecUri: "u",
        moderator: "",
      },
      /no moderator/i,
    ],
    [
      "invalid moderator",
      {
        moderationAttested: true,
        jobSpecHash: HASH,
        jobSpecUri: "u",
        moderator: "not-base58",
      },
      /invalid moderator/i,
    ],
  ])(
    "refuses to sign activation after %s",
    async (_name, moderation, error) => {
      const calls: string[] = [];
      await expect(
        hireAndActivate(stubClient(calls), {
          hire,
          jobSpec: null,
          hostAndModerateJobSpec: async () => moderation as never,
        }),
      ).rejects.toThrow(error);
      // The hire signed, activation did NOT.
      expect(calls).toEqual(["hire"]);
    },
  );

  it.each([
    ["missing", undefined],
    ["wrong-sized", new Uint8Array(31)],
    ["all-zero", new Uint8Array(32)],
  ])(
    "rejects a %s listing commitment before submitting a funded hire",
    async (_label, listingSpecHash) => {
      const submit = vi.fn();
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        hireFromListingHumanless: submit,
      } as unknown as Parameters<typeof hireAndActivate>[0];
      await expect(
        hireAndActivate(client, {
          hire: { ...hire, listingSpecHash } as never,
          jobSpec: null,
          hostAndModerateJobSpec: vi.fn(),
        }),
      ).rejects.toThrow(/hire\.listingSpecHash/u);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-cloneable job spec before submitting a funded hire", async () => {
    const submit = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: submit,
    } as unknown as Parameters<typeof hireAndActivate>[0];
    await expect(
      hireAndActivate(client, {
        hire,
        jobSpec: { callback: () => undefined },
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/jobSpec must be structured-cloneable/u);
    expect(submit).not.toHaveBeenCalled();
  });

  it("threads the callback's moderator into activation by default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({
        signature: CANDIDATE_SIGNATURE,
        logs: [],
      }),
      setTaskJobSpec: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const result = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/u",
        moderationAttested: true,
        moderator: ROSTER_MODERATOR as Address,
      }),
    });
    expect(seen[0]?.moderator).toBe(ROSTER_MODERATOR);
    expect(result.activationSignature).toBe(ACTIVATION_SIGNATURE);
  });

  it("reconciles an ambiguous funded hire before hosting and never debits twice", async () => {
    let hireAttempts = 0;
    let observedHost:
      | { hireSignature: string; hireReconciled?: boolean }
      | undefined;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        hireAttempts += 1;
        await recordFinalizedHire();
        await recordSuccessfulHireTransaction();
        throw Object.assign(new Error("response timed out after broadcast"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
      setTaskJobSpec: async () => ({
        signature: ACTIVATION_SIGNATURE,
        logs: [],
      }),
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const result = await hireAndActivate(client, {
      hire,
      rpc: RPC,
      jobSpec: { prompt: "perform work" },
      hostAndModerateJobSpec: async (host) => {
        observedHost = host;
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/reconciled-first-hire",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    });

    expect(hireAttempts).toBe(1);
    expect(observedHost).toMatchObject({
      hireSignature: CANDIDATE_SIGNATURE,
    });
    expect(result.hireSignature).toBe(CANDIDATE_SIGNATURE);
    expect(result.hireReconciled).toBeUndefined();
  });

  it("refuses to adopt matching pre-existing state without attributable transaction proof", async () => {
    await recordFinalizedHire();
    const hireAgain = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: hireAgain,
      setTaskJobSpec: async () => ({
        signature: ACTIVATION_SIGNATURE,
        logs: [],
      }),
    } as unknown as Parameters<typeof hireAndActivate>[0];

    await expect(
      hireAndActivate(client, {
        hire,
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: async () => ({
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/restart-hire",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        }),
      }),
    ).rejects.toThrow(/no attributable ambiguous hire transaction/u);
    expect(hireAgain).not.toHaveBeenCalled();
  });

  it("fails closed when ambiguous finalized hire state conflicts with intent", async () => {
    const host = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        await recordFinalizedHire({ rewardAmount: 2n });
        await recordSuccessfulHireTransaction();
        throw Object.assign(new Error("response timed out after broadcast"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];

    await expect(
      hireAndActivate(client, {
        hire,
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: host,
      }),
    ).rejects.toThrow(/does not match the funded hire intent/u);
    expect(host).not.toHaveBeenCalled();
  });

  it("does not adopt a finalized hire with a different task commitment", async () => {
    const conflictingDescription = new Uint8Array(64);
    conflictingDescription.set(new Uint8Array(32).fill(8), 32);
    const host = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        await recordFinalizedHire({ description: conflictingDescription });
        await recordSuccessfulHireTransaction();
        throw Object.assign(new Error("response timed out after broadcast"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];

    await expect(
      hireAndActivate(client, {
        hire,
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: host,
      }),
    ).rejects.toThrow(/does not match the funded hire intent/u);
    expect(host).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous-hire token and later resumes by reconciliation only", async () => {
    const attempts: string[] = [];
    const ambiguous = Object.assign(new Error("status unavailable"), {
      signature: CANDIDATE_SIGNATURE,
    });
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        attempts.push("hire");
        throw ambiguous;
      },
      setTaskJobSpec: async () => {
        attempts.push("activate");
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        attempts.push("host");
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/late-finality",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    };

    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);
    expect((first as HireAndActivateError).progress).toMatchObject({
      phase: "hiring",
      candidateSignature: CANDIDATE_SIGNATURE,
    });
    await expect(
      resumeHireAndActivate(
        client,
        input,
        (first as HireAndActivateError).progress,
      ),
    ).rejects.toMatchObject({
      progress: { phase: "hiring" },
    });

    await recordFinalizedHire();
    await recordSuccessfulHireTransaction();
    const result = await resumeHireAndActivate(
      client,
      input,
      (first as HireAndActivateError).progress,
    );
    expect(result.hireSignature).toBe(CANDIDATE_SIGNATURE);
    expect(attempts).toEqual(["hire", "host", "activate"]);
  });

  it("keeps the intent stable when automatic roster mechanics are resolved only for the transaction", async () => {
    const rosterHire = { ...hire, moderator: ROSTER_MODERATOR as Address };
    const [rosterPda] = await findModerationAttestorPda({
      attestor: ROSTER_MODERATOR,
    });
    const [listingModerationPda] = await findListingModerationPda({
      listing: rosterHire.listing,
      jobSpecHash: rosterHire.listingSpecHash,
      moderator: ROSTER_MODERATOR,
    });
    chain.attestors[rosterPda] = true;
    chain.records[listingModerationPda] = { moderator: ROSTER_MODERATOR };

    const observedHireInputs: Array<Record<string, unknown>> = [];
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async (resolved: Record<string, unknown>) => {
        observedHireInputs.push(resolved);
        throw Object.assign(new Error("status unavailable"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
      setTaskJobSpec: async () => ({
        signature: ACTIVATION_SIGNATURE,
        logs: [],
      }),
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire: rosterHire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/roster-resume",
        moderationAttested: true,
        moderator: ROSTER_MODERATOR,
      }),
    };

    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);
    expect(observedHireInputs[0]).toMatchObject({
      moderationAttestor: rosterPda,
    });
    expect(input.hire).not.toHaveProperty("moderationAttestor");

    await recordFinalizedHire();
    await recordSuccessfulHireTransaction(CANDIDATE_SIGNATURE, {
      moderator: ROSTER_MODERATOR,
    });
    await expect(
      resumeHireAndActivate(
        client,
        input,
        (first as HireAndActivateError).progress,
      ),
    ).resolves.toMatchObject({ hireSignature: CANDIDATE_SIGNATURE });
    expect(observedHireInputs).toHaveLength(1);
  });

  it("recovers an exact finalized hire after the listing and protocol mutate", async () => {
    const ambiguous = Object.assign(new Error("status unavailable"), {
      signature: CANDIDATE_SIGNATURE,
    });
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw ambiguous;
      },
      setTaskJobSpec: async () => ({
        signature: ACTIVATION_SIGNATURE,
        logs: [],
      }),
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const host = vi.fn(async () => ({
      jobSpecHash: HASH,
      jobSpecUri: "agenc://job-spec/sha256/mutable-sources",
      moderationAttested: true,
      moderator: GLOBAL_AUTHORITY,
    }));
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: host,
    };
    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);

    await recordFinalizedHire();
    await recordSuccessfulHireTransaction();
    chain.listings[LISTING] = {
      ...chain.listings[LISTING]!,
      providerAgent: GLOBAL_AUTHORITY,
      price: 999n,
      state: ListingState.Retired,
      version: 99n,
    };
    const [protocolConfigPda] = await findProtocolConfigPda();
    chain.protocolConfigs[protocolConfigPda] = {
      protocolFeeBps: 999,
      maxClaimDuration: 1n,
    };

    await expect(
      resumeHireAndActivate(
        client,
        input,
        (first as HireAndActivateError).progress,
      ),
    ).resolves.toMatchObject({ hireSignature: CANDIDATE_SIGNATURE });
    expect(host).toHaveBeenCalledOnce();
  });

  it("snapshots caller-owned intent bytes, scalars, job spec, and default referral at entry", async () => {
    const taskId = new Uint8Array(32).fill(0x21);
    const listingSpecHash = new Uint8Array(32).fill(0x22);
    const taskJobSpecHash = new Uint8Array(32).fill(0x23);
    const defaultReferrer = {
      address: ROSTER_MODERATOR as Address,
      feeBps: 75,
    };
    const jobSpec = {
      prompt: "entry snapshot",
      nested: { constraints: [{ region: "ca" }] },
    };
    let submitted: Record<string, unknown> | undefined;
    let hostedJobSpec: unknown;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      defaultReferrer,
      hireFromListingHumanless: async (wire: Record<string, unknown>) => {
        submitted = wire;
        return { signature: CANDIDATE_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const mutableInput = {
      hire: {
        ...hire,
        taskId,
        listingSpecHash,
        taskJobSpecHash,
        expectedVersion: 1n,
      },
      jobSpec,
      hostAndModerateJobSpec: async (host: { jobSpec: unknown }) => {
        hostedJobSpec = host.jobSpec;
        throw new Error("stop after observing the committed snapshot");
      },
    };
    const [expectedTask] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: new Uint8Array(taskId),
    });

    const running = hireAndActivate(client, mutableInput);
    taskId.fill(0xff);
    listingSpecHash.fill(0xfe);
    taskJobSpecHash.fill(0xfd);
    mutableInput.hire.expectedVersion = 99n;
    jobSpec.prompt = "mutated after entry";
    jobSpec.nested.constraints[0]!.region = "mutated";
    defaultReferrer.address = PROVIDER_AGENT;
    defaultReferrer.feeBps = 999;
    const failure = await running.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect(submitted).toMatchObject({
      expectedVersion: 1n,
      referrer: ROSTER_MODERATOR,
      referrerFeeBps: 75,
    });
    expect(Array.from(submitted!.taskId as Uint8Array)).toEqual(
      Array(32).fill(0x21),
    );
    expect(Array.from(submitted!.listingSpecHash as Uint8Array)).toEqual(
      Array(32).fill(0x22),
    );
    expect(Array.from(submitted!.taskJobSpecHash as Uint8Array)).toEqual(
      Array(32).fill(0x23),
    );
    expect(hostedJobSpec).toEqual({
      prompt: "entry snapshot",
      nested: { constraints: [{ region: "ca" }] },
    });
    expect((failure as HireAndActivateError).progress).toMatchObject({
      phase: "moderating",
      taskPda: expectedTask,
    });
  });

  it("accepts and detaches ordinary-buffer commitments from another realm", async () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const taskId = new ForeignUint8Array(32).fill(1);
    const listingSpecHash = new ForeignUint8Array(32).fill(7);
    const taskJobSpecHash = new ForeignUint8Array(32).fill(9);
    expect(taskId).not.toBeInstanceOf(Uint8Array);
    let submitted: Record<string, unknown> | undefined;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async (wire: Record<string, unknown>) => {
        submitted = wire;
        return { signature: CANDIDATE_SIGNATURE, logs: [] };
      },
      setTaskJobSpec: async () => ({
        signature: ACTIVATION_SIGNATURE,
        logs: [],
      }),
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const running = hireAndActivate(client, {
      hire: {
        ...hire,
        taskId,
        listingSpecHash,
        taskJobSpecHash,
      },
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/cross-realm",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
      }),
    });
    taskId.fill(0xf1);
    listingSpecHash.fill(0xf2);
    taskJobSpecHash.fill(0xf3);
    await running;

    expect(submitted?.taskId).toEqual(new Uint8Array(32).fill(1));
    expect(submitted?.listingSpecHash).toEqual(new Uint8Array(32).fill(7));
    expect(submitted?.taskJobSpecHash).toEqual(new Uint8Array(32).fill(9));
    expect(submitted?.taskId).toBeInstanceOf(Uint8Array);
  });

  it("rejects SharedArrayBuffer-backed commitments before a funded call", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const calls: string[] = [];
    await expect(
      hireAndActivate(stubClient(calls), {
        hire: {
          ...hire,
          taskId: new Uint8Array(new SharedArrayBuffer(32)),
        },
        jobSpec: null,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/hireAndActivate: hire\.taskId must be exactly 32 bytes/);
    expect(calls).toEqual([]);
  });

  it("rejects deeply nested shared job-spec memory before a funded call", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const calls: string[] = [];
    const root: Record<string, unknown> = {};
    root.self = root;
    root.map = new Map([
      [
        "nested",
        new Set([{ bytes: new Uint8Array(new SharedArrayBuffer(32)).fill(7) }]),
      ],
    ]);

    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec: root,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/jobSpec must be structured-cloneable/);
    expect(calls).toEqual([]);
  });

  it("rejects hidden shared WebAssembly.Memory before a funded call", async () => {
    if (
      typeof WebAssembly === "undefined" ||
      WebAssembly.Memory === undefined ||
      typeof SharedArrayBuffer === "undefined"
    ) {
      return;
    }
    const calls: string[] = [];
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });

    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec: { nested: new Map([["memory", memory]]) },
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/jobSpec must be structured-cloneable/);
    expect(calls).toEqual([]);
  });

  it("rejects job-spec accessors without invoking them or funding", async () => {
    const calls: string[] = [];
    let getterCalls = 0;
    const jobSpec = Object.defineProperty({}, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe accessor";
      },
    });

    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/jobSpec must be structured-cloneable/);
    expect(getterCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("preserves and detaches ordinary cyclic Map/Set job-spec topology", async () => {
    const calls: string[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const jobSpec: Record<string, unknown> = { bytes };
    jobSpec.self = jobSpec;
    jobSpec.map = new Map([["set", new Set([jobSpec])]]);
    let hosted: Record<string, unknown> | undefined;

    const pending = hireAndActivate(stubClient(calls), {
      hire,
      jobSpec,
      hostAndModerateJobSpec: async ({ jobSpec: snapshot }) => {
        hosted = snapshot as Record<string, unknown>;
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/cyclic",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    });
    bytes.fill(9);
    await pending;

    expect(calls).toEqual(["hire", "activate"]);
    expect(hosted).toBeDefined();
    expect(hosted!.self).toBe(hosted);
    expect(hosted!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const hostedSet = (hosted!.map as Map<string, Set<unknown>>).get("set")!;
    expect(hostedSet.has(hosted)).toBe(true);
  });

  it("snapshots the creator address before the first await", async () => {
    const mutableSigner = { address: GLOBAL_AUTHORITY as Address };
    let submittedCreator: Address | undefined;
    const client = {
      signer: mutableSigner,
      hireFromListingHumanless: async (wire: {
        creator: { address: Address };
      }) => {
        submittedCreator = wire.creator.address;
        return { signature: CANDIDATE_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const [expectedTask] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });

    const running = hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        throw new Error("stop after hire");
      },
    });
    expect(() => {
      mutableSigner.address = ROSTER_MODERATOR;
    }).toThrow(TypeError);
    const failure = await running.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect(submittedCreator).toBe(GLOBAL_AUTHORITY);
    expect((failure as HireAndActivateError).progress.taskPda).toBe(
      expectedTask,
    );
  });

  it("preserves one frozen Solana Kit signer identity through the real client send pipeline", async () => {
    const signer = await generateKeyPairSigner();
    expect(Object.isFrozen(signer)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(signer, "signTransactions"),
    ).toMatchObject({ configurable: false, writable: false });
    let submitted = 0;
    const transport: Transport = {
      async getLatestBlockhash() {
        return {
          blockhash: GLOBAL_AUTHORITY as never,
          lastValidBlockHeight: 1_000n,
        };
      },
      async sendAndConfirm(transaction) {
        submitted += 1;
        return {
          signature: getSignatureFromTransaction(transaction),
          logs: [],
        };
      },
    };
    const client = createMarketplaceClient({ transport, signer });
    expect(client.signer).toBe(signer);

    const failure = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        throw new Error("stop after generated builder");
      },
    }).catch((error: unknown) => error);

    expect(submitted).toBe(1);
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress.phase).toBe("moderating");
  });

  it("canonicalizes a distinct same-address creator to the real client fee payer", async () => {
    const signer = await generateKeyPairSigner();
    const creator: TransactionSigner = {
      address: signer.address,
      signTransactions: (transactions, config) =>
        signer.signTransactions(transactions, config),
    };
    let submitted = 0;
    const transport: Transport = {
      async getLatestBlockhash() {
        return {
          blockhash: GLOBAL_AUTHORITY as never,
          lastValidBlockHeight: 1_000n,
        };
      },
      async sendAndConfirm(transaction) {
        submitted += 1;
        return {
          signature: getSignatureFromTransaction(transaction),
          logs: [],
        };
      },
    };
    const client = createMarketplaceClient({ transport, signer });

    const failure = await hireAndActivate(client, {
      hire,
      creator,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        throw new Error("stop after generated builder");
      },
    }).catch((error: unknown) => error);

    expect(submitted).toBe(1);
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect(creator).not.toBe(client.signer);
  });

  it("makes an attributable finalized failed hire explicitly retry-safe", async () => {
    const host = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        await recordSuccessfulHireTransaction();
        chain.transactions[CANDIDATE_SIGNATURE]!.meta = {
          err: { InstructionError: [0, "Custom"] },
        };
        throw Object.assign(new Error("confirmation response was ambiguous"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const failure = await hireAndActivate(client, {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: host,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateFinalizedFailure);
    expect(failure).not.toBeInstanceOf(HireAndActivateError);
    expect(failure).toMatchObject({
      retrySafe: true,
      signature: CANDIDATE_SIGNATURE,
    });
    expect(host).not.toHaveBeenCalled();
    expect(Object.keys(chain.tasks)).toHaveLength(0);
    expect(Object.keys(chain.escrows)).toHaveLength(0);
  });

  it("never marks a swapped failed signature retry-safe when hire state exists", async () => {
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw Object.assign(new Error("status unavailable"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: vi.fn(),
    };
    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);

    await recordFinalizedHire();
    await recordSuccessfulHireTransaction(OTHER_CANDIDATE_SIGNATURE);
    chain.transactions[OTHER_CANDIDATE_SIGNATURE]!.meta = {
      err: { InstructionError: [0, "Custom"] },
    };
    const failure = await resumeHireAndActivate(client, input, {
      ...(first as HireAndActivateError).progress,
      candidateSignature: OTHER_CANDIDATE_SIGNATURE,
    } as never).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect(failure).not.toBeInstanceOf(HireAndActivateFinalizedFailure);
    expect(failure).toHaveProperty("progress.phase", "hiring");
    expect(String(failure)).toMatch(/failed, but finalized hire state exists/u);
  });

  it("rejects a non-canonical candidate signature in a hiring token", async () => {
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw Object.assign(new Error("status unavailable"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: vi.fn(),
    };
    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);
    await expect(
      resumeHireAndActivate(client, input, {
        ...(first as HireAndActivateError).progress,
        candidateSignature: "not-a-solana-signature",
      } as never),
    ).rejects.toThrow(/invalid ambiguous-hire recovery payload/u);
  });

  it("does not adopt a reused taskId whose finalized transaction used a different listing version", async () => {
    const host = vi.fn();
    const ambiguous = Object.assign(new Error("status unavailable"), {
      signature: CANDIDATE_SIGNATURE,
    });
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw ambiguous;
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: host,
    };
    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);

    await recordFinalizedHire();
    chain.listings[LISTING]!.version = 2n;
    await recordSuccessfulHireTransaction(CANDIDATE_SIGNATURE, {
      expectedVersion: 2n,
    });
    await expect(
      resumeHireAndActivate(
        client,
        input,
        (first as HireAndActivateError).progress,
      ),
    ).rejects.toThrow(/arguments do not match the requested hire intent/u);
    expect(host).not.toHaveBeenCalled();
  });

  it("binds an ambiguous recovery token to listing spec and moderator intent", async () => {
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw Object.assign(new Error("status unavailable"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: vi.fn(),
    };
    const first = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(HireAndActivateError);

    for (const conflictingHire of [
      { ...hire, listingSpecHash: new Uint8Array(32).fill(8) },
      { ...hire, moderator: ROSTER_MODERATOR },
    ]) {
      await expect(
        resumeHireAndActivate(
          client,
          { ...input, hire: conflictingHire },
          (first as HireAndActivateError).progress,
        ),
      ).rejects.toThrow(/does not match the complete supplied hire intent/u);
    }
    expect(input.hostAndModerateJobSpec).not.toHaveBeenCalled();
  });

  it.each([
    [
      "listing moderation override",
      { listingModeration: TASK },
      /non-canonical listing moderation account/u,
    ],
    [
      "moderation attestor override",
      { moderationAttestor: TASK },
      /non-canonical moderation attestor account/u,
    ],
    [
      "explicit attestor mode",
      { moderatorIsAttestor: true },
      /non-canonical moderation attestor account/u,
    ],
  ])(
    "requires the finalized transaction to use the exact %s",
    async (_label, mechanics, expectedError) => {
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        hireFromListingHumanless: async () => {
          throw Object.assign(new Error("status unavailable"), {
            signature: CANDIDATE_SIGNATURE,
          });
        },
      } as unknown as Parameters<typeof hireAndActivate>[0];
      const input = {
        hire: { ...hire, ...mechanics },
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: vi.fn(),
      };
      const first = await hireAndActivate(client, input).catch(
        (error: unknown) => error,
      );
      expect(first).toBeInstanceOf(HireAndActivateError);

      await recordFinalizedHire();
      await recordSuccessfulHireTransaction();
      await expect(
        resumeHireAndActivate(
          client,
          input,
          (first as HireAndActivateError).progress,
        ),
      ).rejects.toThrow(expectedError);
      expect(input.hostAndModerateJobSpec).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, undefined],
    [undefined, false],
  ])(
    "binds explicit moderatorIsAttestor=%s separately from %s",
    async (tokenMode, resumeMode) => {
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        hireFromListingHumanless: async () => {
          throw Object.assign(new Error("status unavailable"), {
            signature: CANDIDATE_SIGNATURE,
          });
        },
      } as unknown as Parameters<typeof hireAndActivate>[0];
      const first = await hireAndActivate(client, {
        hire: { ...hire, moderatorIsAttestor: tokenMode },
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: vi.fn(),
      }).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(HireAndActivateError);

      await expect(
        resumeHireAndActivate(
          client,
          {
            hire: { ...hire, moderatorIsAttestor: resumeMode },
            rpc: RPC,
            jobSpec: null,
            hostAndModerateJobSpec: vi.fn(),
          },
          (first as HireAndActivateError).progress,
        ),
      ).rejects.toThrow(/does not match the complete supplied hire intent/u);
    },
  );

  it.each([
    ["operator/HireRecord link", { operator: ROSTER_MODERATOR }],
    ["impossible deadline", { deadline: CREATED_AT - 1n }],
  ])(
    "rejects internally inconsistent finalized %s",
    async (_label, taskOverrides) => {
      const host = vi.fn();
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        hireFromListingHumanless: async () => {
          await recordFinalizedHire(taskOverrides);
          await recordSuccessfulHireTransaction();
          throw Object.assign(new Error("response timed out after broadcast"), {
            signature: CANDIDATE_SIGNATURE,
          });
        },
      } as unknown as Parameters<typeof hireAndActivate>[0];
      await expect(
        hireAndActivate(client, {
          hire,
          rpc: RPC,
          jobSpec: null,
          hostAndModerateJobSpec: host,
        }),
      ).rejects.toThrow(/does not match the funded hire intent/u);
      expect(host).not.toHaveBeenCalled();
    },
  );

  it("rejects a conflicting finalized review window", async () => {
    const host = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        const taskPda = await recordFinalizedHire();
        const [validationConfigPda] = await findTaskValidationConfigPda({
          task: taskPda,
        });
        chain.validationConfigs[validationConfigPda]!.reviewWindowSecs = 7_200n;
        await recordSuccessfulHireTransaction();
        throw Object.assign(new Error("response timed out after broadcast"), {
          signature: CANDIDATE_SIGNATURE,
        });
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    await expect(
      hireAndActivate(client, {
        hire,
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: host,
      }),
    ).rejects.toThrow(/does not match the funded hire intent/u);
    expect(host).not.toHaveBeenCalled();
  });

  it("keeps a proven pre-broadcast hire failure retry-safe", async () => {
    const preBroadcast = new AgencError("signing refused", { signature: null });
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        throw preBroadcast;
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const failure = await hireAndActivate(client, {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        throw new Error("must not host");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBe(preBroadcast);
    expect(failure).not.toBeInstanceOf(HireAndActivateError);
  });

  it("does not adopt a prior hire with different durable referral terms", async () => {
    await recordFinalizedHire();
    const hireAgain = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: hireAgain,
    } as unknown as Parameters<typeof hireAndActivate>[0];

    await expect(
      hireAndActivate(client, {
        hire: {
          ...hire,
          referrer: ROSTER_MODERATOR,
          referrerFeeBps: 125,
        },
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: async () => {
          throw new Error("must not host conflicting state");
        },
      }),
    ).rejects.toThrow(/no attributable ambiguous hire transaction/u);
    expect(hireAgain).not.toHaveBeenCalled();
  });

  it.each(["explicit", "client-default"] as const)(
    "reconciles an ambiguous %s referrer with a zero fee as the canonical no-leg snapshot",
    async (source) => {
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        ...(source === "client-default"
          ? {
              defaultReferrer: {
                address: ROSTER_MODERATOR,
                feeBps: 0,
              },
            }
          : {}),
        hireFromListingHumanless: async () => {
          throw Object.assign(new Error("status unavailable"), {
            signature: CANDIDATE_SIGNATURE,
          });
        },
        setTaskJobSpec: async () => ({
          signature: ACTIVATION_SIGNATURE,
          logs: [],
        }),
      } as unknown as Parameters<typeof hireAndActivate>[0];
      const input = {
        hire: {
          ...hire,
          ...(source === "explicit"
            ? { referrer: ROSTER_MODERATOR, referrerFeeBps: 0 }
            : {}),
        },
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: async () => ({
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/zero-fee-referral",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        }),
      };
      const first = await hireAndActivate(client, input).catch(
        (error: unknown) => error,
      );
      expect(first).toBeInstanceOf(HireAndActivateError);

      await recordFinalizedHire();
      await recordSuccessfulHireTransaction(CANDIDATE_SIGNATURE, {
        referrer: ROSTER_MODERATOR,
        referrerFeeBps: 0,
      });
      await expect(
        resumeHireAndActivate(
          client,
          input,
          (first as HireAndActivateError).progress,
        ),
      ).resolves.toMatchObject({ hireSignature: CANDIDATE_SIGNATURE });
    },
  );

  it.each([
    "protocolConfig",
    "moderationConfig",
    "taskModeration",
    "moderationAttestor",
    "moderationBlock",
    "taskJobSpec",
    "systemProgram",
    "hireRecord",
    "moderator",
  ] as const)(
    "validates activation.%s before submitting a funded hire",
    async (field) => {
      const calls: string[] = [];
      await expect(
        hireAndActivate(stubClient(calls), {
          hire,
          jobSpec: null,
          activation: { [field]: "not-base58" } as never,
          hostAndModerateJobSpec: async () => ({
            jobSpecHash: HASH,
            jobSpecUri: "agenc://job-spec/sha256/override",
            moderationAttested: true,
            moderator: GLOBAL_AUTHORITY,
          }),
        }),
      ).rejects.toThrow(new RegExp(`activation\\.${field}`));
      expect(calls).toEqual([]);
    },
  );

  it("validates activation.moderatorIsAttestor before submitting a funded hire", async () => {
    const calls: string[] = [];
    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec: null,
        activation: { moderatorIsAttestor: "yes" } as never,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/activation\.moderatorIsAttestor/u);
    expect(calls).toEqual([]);
  });

  it("validates hire.moderatorIsAttestor before submitting a funded hire", async () => {
    const calls: string[] = [];
    await expect(
      hireAndActivate(stubClient(calls), {
        hire: { ...hire, moderatorIsAttestor: "false" } as never,
        jobSpec: null,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrow(/hire\.moderatorIsAttestor/u);
    expect(calls).toEqual([]);
  });

  it("preserves funded-hire recovery state and resumes hosting without hiring twice", async () => {
    const calls: string[] = [];
    const client = stubClient(calls);
    let hostAttempts = 0;
    const input = {
      hire,
      jobSpec: { prompt: "work" },
      hostAndModerateJobSpec: async () => {
        hostAttempts += 1;
        calls.push("host");
        if (hostAttempts === 1) throw new Error("host unavailable");
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/recovered",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    };
    const failure = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress).toMatchObject({
      phase: "moderating",
      hireSignature: CANDIDATE_SIGNATURE,
    });

    const result = await resumeHireAndActivate(
      client,
      input,
      (failure as HireAndActivateError).progress,
    );
    expect(result.activationSignature).toBe(ACTIVATION_SIGNATURE);
    expect(calls.filter((call) => call === "hire")).toHaveLength(1);
  });

  it("rejects a legacy reconciled token that lacks the stable hire-intent digest", async () => {
    const calls: string[] = [];
    const client = stubClient(calls);
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    let observedHost:
      | { hireSignature: string; hireReconciled?: boolean }
      | undefined;
    await expect(
      resumeHireAndActivate(
        client,
        {
          hire,
          jobSpec: { prompt: "resume exact finalized task" },
          hostAndModerateJobSpec: async (host) => {
            calls.push("host");
            observedHost = host;
            return {
              jobSpecHash: HASH,
              jobSpecUri: "agenc://job-spec/sha256/reconciled-hire",
              moderationAttested: true,
              moderator: GLOBAL_AUTHORITY,
            };
          },
        },
        {
          phase: "moderating",
          taskPda,
          hireSignature: "",
          hireReconciled: true,
        } as never,
      ),
    ).rejects.toThrow(
      /missing or does not match the complete supplied hire intent/u,
    );
    expect(observedHost).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("rejects an empty hire signature without explicit finalized reconciliation", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    await expect(
      resumeHireAndActivate(
        stubClient([]),
        {
          hire,
          jobSpec: null,
          hostAndModerateJobSpec: async () => {
            throw new Error("must not host invalid progress");
          },
        },
        {
          phase: "moderating",
          taskPda,
          hireSignature: "",
          hireIntentDigest: await validIntentDigest(),
        },
      ),
    ).rejects.toThrow(/invalid recovery progress/u);
  });

  it.each(["moderating", "activating"] as const)(
    "rejects a non-canonical hire signature in %s recovery",
    async (phase) => {
      const [taskPda] = await findTaskPda({
        creator: GLOBAL_AUTHORITY,
        taskId: hire.taskId,
      });
      const common = {
        taskPda,
        hireSignature: "x",
        hireIntentDigest: await validIntentDigest(),
      };
      const progress =
        phase === "moderating"
          ? { phase, ...common }
          : {
              phase,
              ...common,
              jobSpecHash: HASH,
              jobSpecUri: "agenc://job-spec/sha256/invalid-signature",
              moderator: GLOBAL_AUTHORITY,
            };
      await expect(
        resumeHireAndActivate(
          stubClient([]),
          {
            hire,
            jobSpec: null,
            hostAndModerateJobSpec: vi.fn(),
          },
          progress as never,
        ),
      ).rejects.toThrow(/invalid recovery progress/u);
    },
  );

  it.each([
    ["listing", { listing: TASK }],
    ["provider", { providerAgent: TASK }],
    ["price terms", { expectedPrice: 2n }],
  ])(
    "rejects ordinary committed recovery after changed %s intent",
    async (_label, changedHire) => {
      const [taskPda] = await findTaskPda({
        creator: GLOBAL_AUTHORITY,
        taskId: hire.taskId,
      });
      const digest = await validIntentDigest();
      const host = vi.fn();
      const activate = vi.fn();
      const client = {
        signer: { address: GLOBAL_AUTHORITY },
        setTaskJobSpec: activate,
      } as unknown as Parameters<typeof resumeHireAndActivate>[0];
      for (const progress of [
        {
          phase: "moderating" as const,
          taskPda,
          hireSignature: CANDIDATE_SIGNATURE,
          hireIntentDigest: digest,
        },
        {
          phase: "activating" as const,
          taskPda,
          hireSignature: CANDIDATE_SIGNATURE,
          hireIntentDigest: digest,
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/stale-intent",
          moderator: GLOBAL_AUTHORITY,
        },
      ]) {
        await expect(
          resumeHireAndActivate(
            client,
            {
              hire: { ...hire, ...changedHire },
              jobSpec: null,
              hostAndModerateJobSpec: host,
            },
            progress,
          ),
        ).rejects.toThrow(/does not match the complete supplied hire intent/u);
      }
      expect(host).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
    },
  );

  it("snapshots activating recovery synchronously before caller mutation", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const progress = {
      phase: "activating" as const,
      taskPda,
      hireSignature: CANDIDATE_SIGNATURE,
      hireIntentDigest: await validIntentDigest(),
      jobSpecHash: new ForeignUint8Array(HASH),
      jobSpecUri: "agenc://job-spec/sha256/original-recovery",
      moderator: GLOBAL_AUTHORITY,
    };
    let submitted: Record<string, unknown> | undefined;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      setTaskJobSpec: async (wire: Record<string, unknown>) => {
        submitted = wire;
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof resumeHireAndActivate>[0];

    const running = resumeHireAndActivate(
      client,
      {
        hire,
        jobSpec: null,
        hostAndModerateJobSpec: vi.fn(),
      },
      progress,
    );
    progress.jobSpecUri = "agenc://job-spec/sha256/mutated-recovery";
    progress.jobSpecHash.fill(0xff);
    const result = await running;

    expect(submitted?.jobSpecUri).toBe(
      "agenc://job-spec/sha256/original-recovery",
    );
    expect(submitted?.jobSpecHash).toEqual(HASH);
    expect(result.jobSpecUri).toBe("agenc://job-spec/sha256/original-recovery");
  });

  it("resumes activation from validated moderation without repeating hire or hosting", async () => {
    const calls: string[] = [];
    let activationAttempts = 0;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        calls.push("hire");
        return { signature: CANDIDATE_SIGNATURE, logs: [] };
      },
      setTaskJobSpec: async () => {
        activationAttempts += 1;
        calls.push("activate");
        if (activationAttempts === 1) throw new Error("rpc unavailable");
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const input = {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => {
        calls.push("host");
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/ready",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    };
    const failure = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress.phase).toBe("activating");

    await resumeHireAndActivate(
      client,
      input,
      (failure as HireAndActivateError).progress,
    );
    expect(calls).toEqual(["hire", "host", "activate", "activate"]);
  });

  it("preserves funded progress when the moderating phase callback throws", async () => {
    const calls: string[] = [];
    const client = stubClient(calls);
    let throwPhase = true;
    const input = {
      hire,
      jobSpec: null,
      onPhase: (phase: "hiring" | "moderating" | "activating") => {
        if (phase === "moderating" && throwPhase) {
          throw new Error("telemetry unavailable");
        }
      },
      hostAndModerateJobSpec: async () => {
        calls.push("host");
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/callback-recovery",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    };
    const failure = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress.phase).toBe("moderating");
    expect(calls).toEqual(["hire"]);

    throwPhase = false;
    await resumeHireAndActivate(
      client,
      input,
      (failure as HireAndActivateError).progress,
    );
    expect(calls).toEqual(["hire", "host", "activate"]);
  });

  it("preserves activating progress when its phase callback throws", async () => {
    const calls: string[] = [];
    const client = stubClient(calls);
    let throwPhase = true;
    const input = {
      hire,
      jobSpec: null,
      onPhase: (phase: "hiring" | "moderating" | "activating") => {
        if (phase === "activating" && throwPhase) {
          throw new Error("telemetry unavailable");
        }
      },
      hostAndModerateJobSpec: async () => {
        calls.push("host");
        return {
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/activate-callback",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        };
      },
    };
    const failure = await hireAndActivate(client, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress.phase).toBe("activating");
    expect(calls).toEqual(["hire", "host"]);

    throwPhase = false;
    await resumeHireAndActivate(
      client,
      input,
      (failure as HireAndActivateError).progress,
    );
    expect(calls).toEqual(["hire", "host", "activate"]);
  });

  it("owns the moderated hash before activation callbacks can mutate caller bytes", async () => {
    const callbackHash = new Uint8Array(HASH);
    let submittedHash: Uint8Array | undefined;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({
        signature: CANDIDATE_SIGNATURE,
        logs: [],
      }),
      setTaskJobSpec: async (activation: { jobSpecHash: Uint8Array }) => {
        submittedHash = new Uint8Array(activation.jobSpecHash);
        return { signature: ACTIVATION_SIGNATURE, logs: [] };
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const result = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      onPhase: (phase) => {
        if (phase === "activating") callbackHash.fill(0xff);
      },
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: callbackHash,
        jobSpecUri: "agenc://job-spec/sha256/owned-hash",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
      }),
    });

    expect(Array.from(submittedHash!)).toEqual(Array.from(HASH));
    expect(Array.from(result.jobSpecHash)).toEqual(Array.from(HASH));
  });

  it("preserves activating recovery when activation returns a malformed signature", async () => {
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({
        signature: CANDIDATE_SIGNATURE,
        logs: [],
      }),
      setTaskJobSpec: async () => ({ signature: "x", logs: [] }),
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const failure = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/malformed-activation-receipt",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
      }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateError);
    expect((failure as HireAndActivateError).progress).toMatchObject({
      phase: "activating",
      hireSignature: CANDIDATE_SIGNATURE,
      jobSpecUri: "agenc://job-spec/sha256/malformed-activation-receipt",
    });
    expect(String(failure)).toMatch(/non-canonical transaction signature/u);
  });

  it("keeps opaque moderation data out of durable activating progress", async () => {
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({
        signature: CANDIDATE_SIGNATURE,
        logs: [],
      }),
      setTaskJobSpec: async () => {
        throw new Error("activation unavailable");
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const failure = await hireAndActivate(client, {
      hire,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/cloneable-progress",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
        moderation: { nonCloneable: () => "ephemeral only" },
      }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HireAndActivateError);
    const progress = (failure as HireAndActivateError).progress;
    expect(progress.phase).toBe("activating");
    expect(progress).not.toHaveProperty("moderation");
    expect(() => structuredClone(progress)).not.toThrow();
  });

  it("reconciles an ambiguous activation from exact finalized account state", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
    let activationAttempts = 0;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({
        signature: CANDIDATE_SIGNATURE,
        logs: [],
      }),
      setTaskJobSpec: async () => {
        activationAttempts += 1;
        chain.jobSpecs[jobSpecPda] = {
          task: taskPda,
          creator: GLOBAL_AUTHORITY,
          jobSpecHash: new Uint8Array(HASH),
          jobSpecUri: "agenc://job-spec/sha256/ambiguous",
        };
        throw new Error("response timed out after broadcast");
      },
    } as unknown as Parameters<typeof hireAndActivate>[0];
    const result = await hireAndActivate(client, {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/ambiguous",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
      }),
    });

    expect(activationAttempts).toBe(1);
    expect(result.activationReconciled).toBe(true);
    expect(result.activationSignature).toBe("");
  });

  it("does not resend a matching activation during recovery", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
    chain.jobSpecs[jobSpecPda] = {
      task: taskPda,
      creator: GLOBAL_AUTHORITY,
      jobSpecHash: new Uint8Array(HASH),
      jobSpecUri: "agenc://job-spec/sha256/restart",
    };
    const activate = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      setTaskJobSpec: activate,
    } as unknown as Parameters<typeof resumeHireAndActivate>[0];
    const result = await resumeHireAndActivate(
      client,
      {
        hire,
        rpc: RPC,
        jobSpec: null,
        hostAndModerateJobSpec: async () => {
          throw new Error("must not host during activating recovery");
        },
      },
      {
        phase: "activating",
        taskPda,
        hireSignature: CANDIDATE_SIGNATURE,
        hireIntentDigest: await validIntentDigest(),
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/restart",
        moderator: GLOBAL_AUTHORITY,
      },
    );
    expect(result.activationReconciled).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects a stale activating token whose hash differs from the funded hire", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const activate = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      setTaskJobSpec: activate,
    } as unknown as Parameters<typeof resumeHireAndActivate>[0];
    await expect(
      resumeHireAndActivate(
        client,
        {
          hire,
          rpc: RPC,
          jobSpec: null,
          hostAndModerateJobSpec: async () => {
            throw new Error("not reached");
          },
        },
        {
          phase: "activating",
          taskPda,
          hireSignature: CANDIDATE_SIGNATURE,
          hireIntentDigest: await validIntentDigest(),
          jobSpecHash: new Uint8Array(32).fill(0x7f),
          jobSpecUri: "agenc://job-spec/sha256/stale-token",
          moderator: GLOBAL_AUTHORITY,
        },
      ),
    ).rejects.toThrow(/does not match the funded hire intent/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("fails closed on a conflicting activation account without resending", async () => {
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
    chain.jobSpecs[jobSpecPda] = {
      task: taskPda,
      creator: GLOBAL_AUTHORITY,
      jobSpecHash: new Uint8Array(32).fill(7),
      jobSpecUri: "agenc://job-spec/sha256/conflict",
    };
    const activate = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      setTaskJobSpec: activate,
    } as unknown as Parameters<typeof resumeHireAndActivate>[0];
    await expect(
      resumeHireAndActivate(
        client,
        {
          hire,
          rpc: RPC,
          jobSpec: null,
          hostAndModerateJobSpec: async () => {
            throw new Error("not reached");
          },
        },
        {
          phase: "activating",
          taskPda,
          hireSignature: CANDIDATE_SIGNATURE,
          hireIntentDigest: await validIntentDigest(),
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/restart",
          moderator: GLOBAL_AUTHORITY,
        },
      ),
    ).rejects.toThrow(/does not match the funded activation intent/);
    expect(activate).not.toHaveBeenCalled();
  });
});
