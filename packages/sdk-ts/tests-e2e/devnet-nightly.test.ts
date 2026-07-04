// Nightly devnet sandbox canary (PLAN.md P2.4 done-when): runs the REAL
// examples/localnet-first-hire.ts flow against public devnet so a hosted
// sandbox cannot silently rot. Gated on SANDBOX_NIGHTLY=1 because it needs
// network + faucet airdrops — in normal `npm test` runs it reports skipped.
//
//   SANDBOX_NIGHTLY=1 npx vitest run tests-e2e/devnet-nightly.test.ts
//
// Driven by .github/workflows/sandbox-nightly.yml (cron 03:17 UTC).
import { describe, it } from "vitest";
import { runFirstHire } from "../examples/localnet-first-hire.js";

const enabled = process.env.SANDBOX_NIGHTLY === "1";

// Attestor-endpoint override: the workflow forwards the repository variable
// SANDBOX_ATTESTOR_URL (empty when unset) so the nightly can point at the
// real P2.3 attestor deployment without an SDK release. The SDK ships NO
// default attestor endpoint (WP-D4 removed the dead sandbox.agenc.tech
// default), so on devnet this variable — or AGENC_SANDBOX_ATTESTOR_URL — is
// REQUIRED for the flow to attest; without it the example fails fast with a
// descriptive error instead of dialing a dead host.
//
// The cluster is pinned to devnet here: the example otherwise defaults to
// the localnet stack (and auto-discovers .localnet/env.json), which is not
// what a devnet canary should ever inherit.
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
      await runFirstHire({ requireSeeded: true, cluster: "devnet", attestorUrl });
    },
  );
});
