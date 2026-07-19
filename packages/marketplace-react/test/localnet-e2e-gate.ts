export interface LocalnetLifecycleHooks {
  beforeAll: (callback: () => Promise<void>, timeoutMs: number) => void;
  afterAll: (callback: () => Promise<void>, timeoutMs: number) => void;
}

export interface LocalnetLifecycle {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

export type SandboxDisposition = "reuse" | "create";

/**
 * Decide whether an integration may acquire the repo-local sandbox. A live
 * recorded process is caller-owned unless this test started it; unusable live
 * state therefore fails closed instead of being stopped or reset.
 */
export function sandboxDisposition(input: {
  healthy: boolean;
  usable: boolean;
  recordedProcessMayBeLive: boolean;
}): SandboxDisposition {
  if (input.healthy) {
    if (!input.usable) {
      throw new Error(
        "a caller-owned sandbox is running but is not a current seeded fixture; stop it explicitly before the localnet E2E",
      );
    }
    return "reuse";
  }
  if (input.recordedProcessMayBeLive) {
    throw new Error(
      "a recorded caller-owned sandbox process may still be running; stop it explicitly before the localnet E2E",
    );
  }
  return "create";
}

/**
 * Register process-owning hooks only for an explicitly enabled integration.
 * A skipped Vitest suite still evaluates its declaration callback to collect
 * tests, so putting `beforeAll` inside `describe.skipIf` alone is insufficient.
 */
export function registerLocalnetLifecycle(
  enabled: boolean,
  hooks: LocalnetLifecycleHooks,
  lifecycle: LocalnetLifecycle,
): boolean {
  if (!enabled) return false;
  hooks.beforeAll(lifecycle.setup, 240_000);
  hooks.afterAll(lifecycle.teardown, 30_000);
  return true;
}
