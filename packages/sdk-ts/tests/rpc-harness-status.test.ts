import { describe, expect, it } from "vitest";
import { runStatusCheck } from "../tests-e2e/rpc-harness.js";

// The RPC suites start with the launcher's status check. When it fails, the
// error must carry the check's report: CI showed only "exit 1" and a byte
// count for scripts/localnet-status.mjs, never what it found.
describe("RPC harness status check", () => {
  it("passes quietly when the status check succeeds", () => {
    expect(() =>
      runStatusCheck(["-e", "console.log('status: HEALTHY')"]),
    ).not.toThrow();
  });

  it("puts the status report and error output in the thrown error", () => {
    const failing = [
      "-e",
      [
        "console.log('[FAIL] environment: /repo/.localnet/env.json (schema)');",
        "console.log('');",
        "console.log('status: UNHEALTHY');",
        "console.error('localnet-status: details on stderr');",
        "process.exit(1);",
      ].join(" "),
    ];
    let thrown: unknown;
    try {
      runStatusCheck(failing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("localnet status check failed (exit 1)");
    expect(message).toContain(
      "[FAIL] environment: /repo/.localnet/env.json (schema)",
    );
    expect(message).toContain("status: UNHEALTHY");
    expect(message).toContain("localnet-status: details on stderr");
    expect((thrown as Error).cause).toBeDefined();
  });
});
