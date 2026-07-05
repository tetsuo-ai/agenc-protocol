// REAL execution of the `agenc dev` in-process fallback: `runDev` with no
// localnet stack discoverable must fall back to the litesvm sandbox (the sdk's
// `@tetsuo-ai/marketplace-sdk/testing` local marketplace, which boots the
// compiled program shipped in the sdk's testing-assets), run the SAME bot
// lifecycle, and settle a 4-way split whose treasury leg is the LIVE mainnet
// protocol fee (500 bps) — proving the fallback re-stamps the sandbox
// ProtocolConfig instead of demoing the sdk-testing default of 100 bps.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDev } from "../src/dev.js";
import { SANDBOX_PROTOCOL_FEE_BPS } from "../src/sandbox.js";
import { LocalnetError } from "../src/localnet.js";

const REWARD = 1_000_000n;
const OPERATOR_FEE_BPS = 1000; // 10%
const REFERRER_FEE_BPS = 500; // 5%

function scratchProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-dev-sandbox-"));
  writeFileSync(
    path.join(dir, "agenc.config.json"),
    `${JSON.stringify(
      {
        name: "sandbox fallback e2e",
        kind: "worker",
        network: "localnet",
        rpcUrl: null,
        walletPath: null,
        listing: {
          priceLamports: REWARD.toString(),
          operatorFeeBps: OPERATOR_FEE_BPS,
          referrerFeeBps: REFERRER_FEE_BPS,
          category: "other",
          tags: ["agenc-dev"],
        },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

describe("e2e: agenc dev falls back to the in-process litesvm sandbox", () => {
  it("--sandbox runs the full bot loop and settles at the live 500 bps protocol fee", async () => {
    // Ensure discovery cannot accidentally find a real stack.
    delete process.env.AGENC_LOCALNET_ENV;
    const logs: string[] = [];
    const summary = await runDev(scratchProject(), {
      sandbox: true,
      log: (line) => logs.push(line),
    });

    expect(summary.mode).toBe("sandbox");
    expect(summary.rpcUrl).toBeNull();

    const legs = summary.result.legs;
    // Fee legs are bps-exact fractions of the escrowed reward…
    expect(legs.operator.deltaLamports).toBe(
      (REWARD * BigInt(OPERATOR_FEE_BPS)) / 10_000n,
    );
    expect(legs.referrer.deltaLamports).toBe(
      (REWARD * BigInt(REFERRER_FEE_BPS)) / 10_000n,
    );
    // …and the treasury leg is the LIVE mainnet fee (500 bps = 5%), NOT the
    // sdk-testing seed default (100 bps). This assertion goes red if the
    // ProtocolConfig re-stamp in src/sandbox.ts is removed.
    expect(SANDBOX_PROTOCOL_FEE_BPS).toBe(500);
    expect(legs.treasury.deltaLamports).toBe(
      (REWARD * BigInt(SANDBOX_PROTOCOL_FEE_BPS)) / 10_000n,
    );

    // The worker keeps the residual cut, and everything escrowed disbursed.
    const residual =
      REWARD -
      legs.operator.deltaLamports -
      legs.referrer.deltaLamports -
      legs.treasury.deltaLamports;
    expect(summary.result.workerRewardCutLamports).toBe(residual);
    expect(residual >= (REWARD * 60n) / 100n).toBe(true);
    const payees = new Set([
      legs.worker.address,
      legs.operator.address,
      legs.referrer.address,
      legs.treasury.address,
    ]);
    expect(payees.size).toBe(4);

    // The output labels the mode and ran the real worker runtime.
    expect(logs.some((l) => l.includes("in-process sandbox (litesvm)"))).toBe(true);
    expect(logs.some((l) => l.includes("worker bot: task.claimed"))).toBe(true);
    expect(logs.some((l) => l.includes("worker bot: task.submitted"))).toBe(true);
    expect(logs.some((l) => l.includes("== SETTLEMENT"))).toBe(true);
  });

  it("falls back automatically when no localnet stack is discoverable", async () => {
    delete process.env.AGENC_LOCALNET_ENV;
    const logs: string[] = [];
    // A bare tmp dir: findLocalnetEnv walks up from /tmp and finds nothing.
    const summary = await runDev(scratchProject(), {
      log: (line) => logs.push(line),
    });
    expect(summary.mode).toBe("sandbox");
    expect(
      logs.some((l) =>
        l.includes("no stack discoverable — falling back to the in-process sandbox"),
      ),
    ).toBe(true);
  });

  it("--localnet still fails hard with setup instructions when nothing is discoverable", async () => {
    delete process.env.AGENC_LOCALNET_ENV;
    await expect(
      runDev(scratchProject(), { localnet: true, log: () => {} }),
    ).rejects.toThrow(LocalnetError);
  });

  it("rejects --sandbox combined with localnet-forcing flags", async () => {
    await expect(
      runDev(scratchProject(), { sandbox: true, localnet: true, log: () => {} }),
    ).rejects.toThrow(/--sandbox cannot be combined/);
  });
});
