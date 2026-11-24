import { afterEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { startWorld, type World } from "./harness.js";
import { restoreBackup } from "../src/backup.js";

let world: World;
afterEach(async () => {
  await world?.wallet.close();
});

it("keeps a restored buyer-only wallet working while consent is pending, then confirms it without a job room", async () => {
  world = await startWorld({ chain: (base) => ({ ...base, network: "localnet" }) });
  const buyer = await world.wallet.createAgent("Buyer only", "external-project");
  await world.wallet.fundAgent(buyer.id, { usdCents: 500 });
  await world.wallet.setPolicy(buyer.id, {
    askAboveCents: 500,
    refill: { enabled: true, topUpToCents: 0, perDayCents: 500 },
  });
  const { job } = await world.wallet.hire({
    agentId: buyer.id,
    listing: world.listing,
    request: "A poem for the restored device",
  });
  const file = path.join(world.dataDir, "saved");
  await world.wallet.exportBackup("buyer backup", file);
  const text = readFileSync(file, "utf8");
  await world.wallet.close();

  const dir = mkdtempSync(path.join(tmpdir(), "agenc-buyer-restored-"));
  const secret = randomBytes(32);
  await restoreBackup({ dataDir: dir, unlockSecret: secret, text, password: "buyer backup", network: "localnet", now: world.clock.now });
  world.wallet = await world.reopen({ dataDir: dir, unlockSecret: secret });
  const recovery = await world.wallet.businessStatus();
  expect(recovery).toMatchObject({ requiresConsent: true });
  expect(recovery!.obligations).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: job.id })]));

  // New seller work stays closed until the owner confirms the device.
  await expect(world.wallet.setEarn(buyer.id, true)).rejects.toThrow(/permission/);

  // The live hire keeps moving: the delivery is read and the review is due.
  await world.sandbox.workOnce();
  await world.wallet.tick();
  const review = world.wallet.jobInbox(buyer.id).actions.find((a) => a.jobId === job.id);
  expect(review?.event).toBe("review");

  // A purchase waiting for approval still expires on time.
  await world.wallet.setPolicy(buyer.id, { askAboveCents: 1, refill: { enabled: true, topUpToCents: 0, perDayCents: 500 } });
  const asked = await world.wallet.hire({ agentId: buyer.id, listing: world.listing, request: "A second poem" });
  expect(asked.approval).toBeTruthy();
  world.clock.now = asked.approval!.expiresAt + 1;
  await world.wallet.tick();
  expect((await world.wallet.getJob(asked.job.id, true)).status).toBe("declined");

  // A buyer has no seller state, so confirming needs no isolated job room.
  await expect(world.wallet.confirmRestoredDevice(recovery!.restoredAt)).resolves.toMatchObject({ requiresConsent: false });
}, 60000);
