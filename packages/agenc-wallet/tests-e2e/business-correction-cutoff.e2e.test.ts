import type { Address } from "@solana/kit";
import { findClaimPda, getTaskClaimDecoder } from "@tetsuo-ai/marketplace-sdk";
import { mkdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  approvedPost,
  CENT,
  eventually,
  startWorld,
  type World,
} from "./harness.js";
import { businessHandlers } from "../src/business-handlers.js";
import { withFiles } from "../src/client/delivery-files.js";
import { restoreBackup } from "../src/backup.js";
import type { WalletState } from "../src/store.js";
import type { JobParties, PortableBusiness } from "../src/client/business.js";

const owner = { role: "owner" as const, agentId: null };
let world: World;
afterEach(async () => {
  await world?.wallet.close();
});
const digest = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");

it("refuses a correction that would run into the early release pause, and keeps release and submit open", async () => {
  const body = Buffer.from("first draft file");
  const file = {
    name: "first.txt",
    sha256: digest(body),
    type: "text/plain",
    bytes: body.length,
  };
  const original = withFiles(
    "a".repeat(53000) + " final line",
    [file],
    "agenc://file/",
  );
  const program =
    "require('fs').writeFileSync(require('path').join(process.argv[1],process.argv[2]),process.argv[3]);process.stdout.write(" +
    JSON.stringify(original) +
    ")";
  const correct = vi.fn(async () => ({
    stdout: Buffer.from(
      withFiles("Corrected final line", [file], "agenc://file/"),
    ),
    stderr: Buffer.alloc(0),
    exitCode: 0 as const,
  }));
  const ready = vi.fn(async () => {});
  world = await startWorld({
    earn: {
      chosenRoomEnabled: () => true,
      checkExecutionReady: ready,
      pollIntervalMs: 70,
      executor: {
        argv: [
          process.execPath,
          "-e",
          program,
          "{outbox}",
          file.sha256,
          body.toString(),
          "{prompt}",
        ],
        mode: "sandboxed",
        isolatedJobRoom: true,
        timeoutMs: 3000,
        envAllowlist: [],
      },
      runReviewRoom: correct,
    },
  });
  const { id } = await world.wallet.createAgent("Chosen worker");
  await world.wallet.fundAgent(id, { usdCents: 2000 });
  await world.wallet.setPolicy(id, {
    askAboveCents: 500,
    refill: { enabled: true, topUpToCents: 1, perDayCents: 500 },
  });
  const post = () =>
    world.sandbox.postOpenJob({
      title: "Check the report",
      instructions: "Write the report.",
      rewardLamports: 50n * CENT,
      deadlineSeconds: 7200,
    });
  const posted = await approvedPost(world.wallet, {
    request: "Check the report",
    reward: { usdCents: 50 },
  });
  const task = posted.task!;
  await post();
  const quote = await world.wallet.quoteManualWork(id);
  await world.wallet.close();
  world.wallet = await world.reopen();
  const wallet = world.wallet;
  const api = businessHandlers(wallet);
  await expect(
    wallet.setEarn(id, true, undefined, quote.quoteId),
  ).rejects.toThrow(/selected worker/);
  await expect(wallet.startManualWork(id, "missing")).rejects.toThrow();
  expect((await wallet.overview()).agents[0]?.earn.enabled).toBe(false);
  const agent = await api["work.startManual"](
    { agentId: id, fundingQuoteId: quote.quoteId },
    owner,
  );
  expect(agent.earn).toMatchObject({ chooseOpenJobs: true, offers: [] });
  expect(ready).toHaveBeenCalled();
  await eventually(
    async () =>
      (await wallet.openWork(id).catch(() => null))?.jobs.length === 2,
  );
  await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
  const hash = await eventually(
    async () => (await wallet.openWork(id)).held?.resultHash,
  );
  const held = (await wallet.openWork(id)).held!;
  const pauseAt = held.releaseWindow!.pauseAt;
  expect(held.correctionEndsAt).toBe(pauseAt - 120);
  // The claim was taken an hour before releaseBy on the unmoving practice clock. Since the
  // money track's revision 9 Clock guard, the early phase runs to releaseBy + 1 (pauseAt).
  world.sandbox.advanceClock(held.correctionEndsAt! - (pauseAt - 3601) - 30);
  await expect(wallet.correctWork(id, task, hash, "Fix the final line.")).rejects.toThrow(/Too little time/);
  expect(correct).not.toHaveBeenCalled();
  const after = (await wallet.openWork(id)).held!;
  expect(after).toMatchObject({ resultHash: hash, canSubmit: true, canRelease: true, releaseWindow: { phase: "early" } });
  const params = { agentId: id, task, hash, part: "text", offset: 0 };
  expect((await api["work.inspect"](params, owner)).correctionCents).toBeGreaterThan(0);
}, 60000);
