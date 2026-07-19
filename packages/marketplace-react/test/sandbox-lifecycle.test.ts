import { describe, expect, it, vi } from "vitest";
import {
  runSandboxBootstrap,
  start,
  type SandboxBootstrapDependencies,
  type SandboxEnv,
} from "./sandbox-up.mjs";
import {
  registerLocalnetLifecycle,
  sandboxDisposition,
} from "./localnet-e2e-gate.js";

function resolvedSandbox(): SandboxEnv {
  return {
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    rpcSubscriptionsUrl: "ws://127.0.0.1:8900",
    programId: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
    envFile: ".localnet/env.json",
    fixturesPath: ".localnet/fixtures.json",
    fixtures: {
      seeded: true,
      cluster: "localnet",
      programId: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
      seededAtSlot: 1,
      providers: [],
      listings: [],
    },
    keypairs: {
      authority: ".localnet/keys/authority.json",
      moderator: ".localnet/keys/moderator.json",
      seeder: ".localnet/keys/seeder.json",
    },
    programSha256: "a".repeat(64),
    currentProgramSha256: "a".repeat(64),
    programCurrent: true,
  };
}

function dependencies(
  overrides: Partial<SandboxBootstrapDependencies> = {},
): SandboxBootstrapDependencies {
  const resolved = resolvedSandbox();
  return {
    up: vi.fn(async () => undefined),
    readEnv: vi.fn(async () => ({})),
    seed: vi.fn(async () => undefined),
    resolve: vi.fn(async () => resolved),
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("sandbox bootstrap lifecycle", () => {
  it("does not register or invoke process-owning hooks when the integration is disabled", () => {
    const up = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const registerBeforeAll = vi.fn();
    const registerAfterAll = vi.fn();

    expect(
      registerLocalnetLifecycle(
        false,
        {
          beforeAll: registerBeforeAll,
          afterAll: registerAfterAll,
        },
        { setup: up, teardown: stop },
      ),
    ).toBe(false);
    expect(registerBeforeAll).not.toHaveBeenCalled();
    expect(registerAfterAll).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("reuses a healthy current fixture without acquiring cleanup authority", () => {
    expect(
      sandboxDisposition({
        healthy: true,
        usable: true,
        recordedProcessMayBeLive: true,
      }),
    ).toBe("reuse");
  });

  it("refuses to destroy a live caller-owned sandbox that is unusable", () => {
    expect(() =>
      sandboxDisposition({
        healthy: true,
        usable: false,
        recordedProcessMayBeLive: true,
      }),
    ).toThrow(/caller-owned sandbox/);
    expect(() =>
      sandboxDisposition({
        healthy: false,
        usable: false,
        recordedProcessMayBeLive: true,
      }),
    ).toThrow(/caller-owned sandbox/);
  });

  it("acquires only stale non-running sandbox state", () => {
    expect(
      sandboxDisposition({
        healthy: false,
        usable: false,
        recordedProcessMayBeLive: false,
      }),
    ).toBe("create");
  });

  it("cleans a disposable sandbox when localnet-up fails after spawning", async () => {
    const cleanup = vi.fn(async () => undefined);
    const deps = dependencies({
      up: vi.fn(async () => {
        // Models localnet-up publishing the validator identity and then failing
        // during airdrop/program/config convergence.
        throw new Error("post-spawn convergence failed");
      }),
      cleanup,
    });

    await expect(runSandboxBootstrap(deps)).rejects.toThrow(
      "post-spawn convergence failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans a disposable sandbox when seeding fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    const deps = dependencies({
      seed: vi.fn(async () => {
        throw new Error("seed failed");
      }),
      cleanup,
    });

    await expect(runSandboxBootstrap(deps)).rejects.toThrow("seed failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not tear down an explicitly preserved caller-owned sandbox", async () => {
    const cleanup = vi.fn(async () => undefined);
    const deps = dependencies({
      seed: vi.fn(async () => {
        throw new Error("preserved seed failed");
      }),
      cleanup,
    });

    await expect(
      runSandboxBootstrap(deps, { cleanupOnFailure: false }),
    ).rejects.toThrow("preserved seed failed");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("start does not clean an idempotently reused caller sandbox by default", async () => {
    const cleanup = vi.fn(async () => undefined);
    const resolved = resolvedSandbox();

    await expect(
      start(
        {},
        {
          assertPrereqs: vi.fn(async () => undefined),
          up: vi.fn(async () => undefined),
          readEnv: vi.fn(async () => ({})),
          seed: vi.fn(async () => {
            throw new Error("reused sandbox seed failed");
          }),
          resolve: vi.fn(async () => resolved),
          cleanup,
        },
      ),
    ).rejects.toThrow("reused sandbox seed failed");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("start cleans an explicitly owned disposable sandbox on failure", async () => {
    const cleanup = vi.fn(async () => undefined);
    const resolved = resolvedSandbox();

    await expect(
      start(
        { disposable: true },
        {
          assertPrereqs: vi.fn(async () => undefined),
          up: vi.fn(async () => {
            throw new Error("owned post-spawn failure");
          }),
          readEnv: vi.fn(async () => ({})),
          seed: vi.fn(async () => undefined),
          resolve: vi.fn(async () => resolved),
          cleanup,
        },
      ),
    ).rejects.toThrow("owned post-spawn failure");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not clean a successful sandbox before its caller is finished", async () => {
    const cleanup = vi.fn(async () => undefined);
    const resolved = resolvedSandbox();
    const deps = dependencies({
      resolve: vi.fn(async () => resolved),
      cleanup,
    });

    await expect(runSandboxBootstrap(deps)).resolves.toBe(resolved);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
