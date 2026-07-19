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
  hireRecords: {} as Record<string, Record<string, unknown>>,
  validationConfigs: {} as Record<string, Record<string, unknown>>,
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
  };
});

import { address, type Address } from "@solana/kit";
import { AgencError } from "../src/client/index.js";
import {
  findListingModerationPda,
  findEscrowPda,
  findHireRecordPda,
  findModerationAttestorPda,
  findTaskModerationPda,
  findTaskJobSpecPda,
  findTaskPda,
  findTaskValidationConfigPda,
  TaskStatus,
  TaskType,
  ValidationMode,
} from "../src/generated/index.js";
import * as facade from "../src/facade/index.js";
import {
  hireAndActivate,
  HireAndActivateError,
  resumeHireAndActivate,
  resolveActivationModerationAccounts,
  resolveHireListingModerationAccounts,
  type ModerationAccountReadRpc,
} from "../src/orchestration/index.js";

const RPC = {} as ModerationAccountReadRpc;
const GLOBAL_AUTHORITY = address("11111111111111111111111111111111");
const ROSTER_MODERATOR = address("So11111111111111111111111111111111111111112");
const TASK = address("SysvarC1ock11111111111111111111111111111111");
const LISTING = address("SysvarRent111111111111111111111111111111111");
const PROVIDER_AGENT = address("Vote111111111111111111111111111111111111111");
const HASH = new Uint8Array(32).fill(9);

beforeEach(() => {
  chain.records = {};
  chain.tasks = {};
  chain.hireRecords = {};
  chain.validationConfigs = {};
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
        return { signature: "sig-hire", logs: [] };
      },
      setTaskJobSpec: async () => {
        calls.push("activate");
        return { signature: "sig-activate", logs: [] };
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
    chain.tasks[taskPda] = {
      taskId: new Uint8Array(hire.taskId),
      creator: GLOBAL_AUTHORITY,
      rewardAmount: 1n,
      maxWorkers: 1,
      currentWorkers: 0,
      status: TaskStatus.Open,
      taskType: TaskType.Exclusive,
      escrow: escrowPda,
      referrer: GLOBAL_AUTHORITY,
      referrerFeeBps: 0,
      ...taskOverrides,
    };
    chain.hireRecords[hireRecordPda] = {
      task: taskPda,
      listing: LISTING,
      designatedProvider: PROVIDER_AGENT,
      referrer: GLOBAL_AUTHORITY,
      referrerFeeBps: 0,
    };
    chain.validationConfigs[validationConfigPda] = {
      task: taskPda,
      creator: GLOBAL_AUTHORITY,
      mode: ValidationMode.CreatorReview,
      reviewWindowSecs: 3600n,
    };
    return taskPda;
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

  it("threads the callback's moderator into activation by default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => ({ signature: "s1", logs: [] }),
      setTaskJobSpec: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { signature: "s2", logs: [] };
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
    expect(result.activationSignature).toBe("s2");
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
        throw new Error("response timed out after broadcast");
      },
      setTaskJobSpec: async () => ({ signature: "sig-activate", logs: [] }),
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
      hireSignature: "",
      hireReconciled: true,
    });
    expect(result.hireSignature).toBe("");
    expect(result.hireReconciled).toBe(true);
  });

  it("resumes exact finalized hire state before sending a duplicate", async () => {
    await recordFinalizedHire();
    const hireAgain = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: hireAgain,
      setTaskJobSpec: async () => ({ signature: "sig-activate", logs: [] }),
    } as unknown as Parameters<typeof hireAndActivate>[0];

    const result = await hireAndActivate(client, {
      hire,
      rpc: RPC,
      jobSpec: null,
      hostAndModerateJobSpec: async () => ({
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/restart-hire",
        moderationAttested: true,
        moderator: GLOBAL_AUTHORITY,
      }),
    });

    expect(hireAgain).not.toHaveBeenCalled();
    expect(result.hireReconciled).toBe(true);
  });

  it("fails closed when ambiguous finalized hire state conflicts with intent", async () => {
    const host = vi.fn();
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        await recordFinalizedHire({ rewardAmount: 2n });
        throw new Error("response timed out after broadcast");
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
      signature: "candidate-wire-signature",
    });
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        attempts.push("hire");
        throw ambiguous;
      },
      setTaskJobSpec: async () => {
        attempts.push("activate");
        return { signature: "sig-activate", logs: [] };
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
      candidateSignature: "candidate-wire-signature",
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
    const result = await resumeHireAndActivate(
      client,
      input,
      (first as HireAndActivateError).progress,
    );
    expect(result.hireReconciled).toBe(true);
    expect(attempts).toEqual(["hire", "host", "activate"]);
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
    ).rejects.toThrow(/does not match the funded hire intent/u);
    expect(hireAgain).not.toHaveBeenCalled();
  });

  it("validates an activation moderator override before signing", async () => {
    const calls: string[] = [];
    await expect(
      hireAndActivate(stubClient(calls), {
        hire,
        jobSpec: null,
        activation: { moderator: "not-base58" as Address },
        hostAndModerateJobSpec: async () => ({
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/override",
          moderationAttested: true,
          moderator: GLOBAL_AUTHORITY,
        }),
      }),
    ).rejects.toThrow(/invalid moderator pubkey/u);
    expect(calls).toEqual(["hire"]);
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
      hireSignature: "sig-hire",
    });

    const result = await resumeHireAndActivate(
      client,
      input,
      (failure as HireAndActivateError).progress,
    );
    expect(result.activationSignature).toBe("sig-activate");
    expect(calls.filter((call) => call === "hire")).toHaveLength(1);
  });

  it("resumes a finalized ambiguous hire without inventing or repeating its signature", async () => {
    const calls: string[] = [];
    const client = stubClient(calls);
    const [taskPda] = await findTaskPda({
      creator: GLOBAL_AUTHORITY,
      taskId: hire.taskId,
    });
    let observedHost:
      | { hireSignature: string; hireReconciled?: boolean }
      | undefined;
    const result = await resumeHireAndActivate(
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
      },
    );

    expect(observedHost).toMatchObject({
      hireSignature: "",
      hireReconciled: true,
    });
    expect(result.hireSignature).toBe("");
    expect(result.hireReconciled).toBe(true);
    expect(calls).toEqual(["host", "activate"]);
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
        { phase: "moderating", taskPda, hireSignature: "" },
      ),
    ).rejects.toThrow(/invalid recovery progress/u);
  });

  it("resumes activation from validated moderation without repeating hire or hosting", async () => {
    const calls: string[] = [];
    let activationAttempts = 0;
    const client = {
      signer: { address: GLOBAL_AUTHORITY },
      hireFromListingHumanless: async () => {
        calls.push("hire");
        return { signature: "sig-hire", logs: [] };
      },
      setTaskJobSpec: async () => {
        activationAttempts += 1;
        calls.push("activate");
        if (activationAttempts === 1) throw new Error("rpc unavailable");
        return { signature: "sig-activate", logs: [] };
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
        signature: "sig-hire",
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
        hireSignature: "sig-hire",
        jobSpecHash: HASH,
        jobSpecUri: "agenc://job-spec/sha256/restart",
        moderator: GLOBAL_AUTHORITY,
      },
    );
    expect(result.activationReconciled).toBe(true);
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
          hireSignature: "sig-hire",
          jobSpecHash: HASH,
          jobSpecUri: "agenc://job-spec/sha256/restart",
          moderator: GLOBAL_AUTHORITY,
        },
      ),
    ).rejects.toThrow(/does not match the funded activation intent/);
    expect(activate).not.toHaveBeenCalled();
  });
});
