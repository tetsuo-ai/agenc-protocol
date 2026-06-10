// Nightly devnet sandbox canary (PLAN.md P2.4 done-when): runs the REAL
// examples/devnet-first-hire.ts flow against public devnet so the hosted
// sandbox cannot silently rot. Gated on SANDBOX_NIGHTLY=1 because it needs
// network + faucet airdrops — in normal `npm test` runs it reports skipped.
//
//   SANDBOX_NIGHTLY=1 npx vitest run tests-e2e/devnet-nightly.test.ts
//
// Driven by .github/workflows/sandbox-nightly.yml (cron 03:17 UTC).
import { describe, it } from "vitest";
import { runDevnetFirstHire } from "../examples/devnet-first-hire.js";

const enabled = process.env.SANDBOX_NIGHTLY === "1";

// Optional attestor-endpoint override: the workflow forwards the repository
// variable SANDBOX_ATTESTOR_URL (empty when unset) so the nightly can point
// at the real P2.3 attestor deployment without an SDK release — the SDK's
// DEFAULT_SANDBOX_ATTESTOR_URL DNS may lag the deploy.
//
// Cluster/RPC/fixtures selection is handled INSIDE the example by the
// environment seam (resolveSandboxEnvironment): with no AGENC_SANDBOX_*
// variables exported this runs against public devnet with the shipped
// fixtures; exporting the localnet variables (from .localnet/env.json via
// scripts/localnet-up.mjs) points the very same flow at a local validator.
const attestorUrlEnv = process.env.SANDBOX_ATTESTOR_URL?.trim();
const attestorUrl =
  attestorUrlEnv !== undefined && attestorUrlEnv !== ""
    ? attestorUrlEnv
    : undefined;

describe.runIf(enabled)("devnet nightly: sandbox first hire", () => {
  it(
    "drives the faucet-to-settled hire on devnet (and fails on unseeded fixtures)",
    { timeout: 900_000 },
    async () => {
      // requireSeeded: when the nightly is enabled, unseeded fixtures are a
      // failure (the gate variable should only be flipped post-seeding).
      await runDevnetFirstHire({ requireSeeded: true, attestorUrl });
    },
  );
});
