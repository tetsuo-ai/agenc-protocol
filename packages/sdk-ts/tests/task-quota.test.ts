import { describe, expect, it } from "vitest";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import * as sdk from "../src/index.js";

const authority = createNoopSigner(
  address("So11111111111111111111111111111111111111112"),
);
const other = createNoopSigner(
  address("Stake11111111111111111111111111111111111111"),
);
const agent = address("Vote111111111111111111111111111111111111111");
const hash = () => new Uint8Array(32).fill(1);
const taskInput = () => ({
  authority,
  creator: authority,
  creatorAgent: agent,
  taskId: hash(),
  description: new Uint8Array([...hash(), ...new Uint8Array(32)]),
  requiredCapabilities: 1n,
  rewardAmount: 1_000_000n,
  maxWorkers: 1,
  deadline: 2_000_000_000n,
  taskType: 0,
  constraintHash: null,
  minReputation: 0,
  rewardMintArg: null,
});

describe("optional wallet task quota wire", () => {
  it("preserves legacy accounts and appends only the canonical wallet quota when explicitly enabled", async () => {
    const legacy = await sdk.facade.createTask(taskInput());
    const extended = await sdk.facade.createTask({
      ...taskInput(),
      taskQuotaSurface: sdk.capabilitiesForRevision(7),
    });
    expect(extended.data).toEqual(legacy.data);
    expect(extended.accounts.slice(0, -1)).toEqual(legacy.accounts);
    expect(extended.accounts.at(-1)).toEqual({
      address: (
        await sdk.findTaskQuotaPda({ taskAuthority: authority.address })
      )[0],
      role: AccountRole.WRITABLE,
    });
    await expect(
      sdk.facade.createTask({
        ...taskInput(),
        taskQuotaSurface: sdk.capabilitiesForRevision(6),
      }),
    ).rejects.toThrow(sdk.SurfaceNotDeployedError);
  });

  it("all task-entry facades derive the same wallet quota and snapshot the capability before awaits", async () => {
    const surface = { ...sdk.capabilitiesForRevision(7) };
    const hire = {
      listing: agent,
      providerAgent: agent,
      creator: authority,
      taskId: hash(),
      expectedPrice: 1_000_000n,
      expectedVersion: 1n,
      moderator: other.address,
      listingSpecHash: hash(),
      taskJobSpecHash: hash(),
      taskQuotaSurface: surface,
    };
    const pending = [
      sdk.facade.createTask({ ...taskInput(), taskQuotaSurface: surface }),
      sdk.facade.createTaskHumanless({
        creator: authority,
        taskId: hash(),
        description: taskInput().description,
        requiredCapabilities: 1n,
        rewardAmount: 1_000_000n,
        deadline: 2_000_000_000n,
        minReputation: 0,
        reviewWindowSecs: 3600n,
        taskQuotaSurface: surface,
      }),
      sdk.facade.createDependentTask({
        ...taskInput(),
        parentTask: agent,
        dependencyType: 3,
        taskQuotaSurface: surface,
      }),
      sdk.facade.hireFromListing({ ...hire, authority, creatorAgent: agent }),
      sdk.facade.hireFromListingHumanless({ ...hire, reviewWindowSecs: 3600n }),
    ];
    surface.taskCreationQuotas = false;
    const expected = (
      await sdk.findTaskQuotaPda({ taskAuthority: authority.address })
    )[0];
    for (const instruction of await Promise.all(pending)) {
      expect(instruction.accounts.at(-1)).toEqual({
        address: expected,
        role: AccountRole.WRITABLE,
      });
    }
  });

  it("encodes a maximum above 255 and includes both real approval signers", async () => {
    const instruction = await sdk.facade.configureTaskCreationQuota({
      authority,
      taskAuthority: other.address,
      maxTasksPer24h: 1000,
      enabled: true,
      multisigSigners: [authority, other],
    });
    expect(
      sdk
        .getConfigureTaskCreationQuotaInstructionDataDecoder()
        .decode(instruction.data),
    ).toMatchObject({
      maxTasksPer24h: 1000,
      taskAuthority: other.address,
      enabled: true,
    });
    expect(
      instruction.accounts.slice(-2).map((account) => account.address),
    ).toEqual([authority.address, other.address]);
  });
});
