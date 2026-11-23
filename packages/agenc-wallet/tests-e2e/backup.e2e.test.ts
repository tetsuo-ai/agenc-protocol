// Backing the wallet up from the running service and bringing it back on
// another computer: the same addresses, the same agents, the same jobs.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreBackup } from "../src/backup.js";
import type { Chain } from "../src/chain.js";
import { AgencWallet } from "../src/wallet.js";
import { REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let world: World | null = null;
let restored: AgencWallet | null = null;
afterEach(async () => {
  await restored?.close();
  await world?.wallet.close();
  restored = null;
  world = null;
});

/** The practice chain, presented as a network whose money is worth backing up. */
const asLocalnet = (chain: Chain): Chain =>
  Object.create(chain, { network: { value: "localnet", enumerable: true } }) as Chain;

describe("backing the wallet up", () => {
  it("tells the person when a backup is missing or out of date", async () => {
    world = await startWorld({ chain: asLocalnet });
    const { wallet } = world;
    await wallet.createAgent("My assistant");
    expect((await wallet.overview()).backup).toEqual({ at: null, upToDate: false });

    const folder = mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-backup-"));
    const file = path.join(folder, "backup.agencbackup");
    await expect(wallet.exportBackup("short", file)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A backup that could not be put where the person said is not a backup:
    // the wallet does not count itself backed up, and leaves nothing behind.
    await expect(
      wallet.exportBackup("a long enough password", path.join(folder, "no-such-folder", "backup.agencbackup")),
    ).rejects.toMatchObject({ message: "The backup could not be saved there. Choose another folder." });
    await expect(wallet.exportBackup("a long enough password", "backup.agencbackup")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await wallet.overview()).backup).toEqual({ at: null, upToDate: false });
    expect(readdirSync(folder)).toEqual([]);

    const made = await wallet.exportBackup("a long enough password", file);
    expect(made.agents).toBe(1);
    expect(made.main).toBe((await wallet.overview()).main.address);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(["backup.agencbackup"]);
    expect((await wallet.overview()).backup).toEqual({ at: made.createdAt, upToDate: true });

    // The password can be tried without changing anything.
    await expect(wallet.checkBackup("not the password", file)).rejects.toMatchObject({
      message: "That password does not open this backup.",
    });
    expect(await wallet.checkBackup("a long enough password", file)).toEqual(made);
    await expect(wallet.checkBackup("a long enough password", path.join(folder, "gone"))).rejects.toMatchObject({
      message: "That backup file could not be read.",
    });

    // A wallet made after the backup is not in it.
    await wallet.createAgent("Helper");
    expect((await wallet.overview()).backup).toEqual({ at: made.createdAt, upToDate: false });
    // Saving over the old file replaces it whole.
    const again = await wallet.exportBackup("a long enough password", file);
    expect(again.agents).toBe(2);
    expect((await wallet.checkBackup("a long enough password", file)).agents).toBe(2);
    expect((await wallet.overview()).backup.upToDate).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("comes back whole on another computer", async () => {
    world = await startWorld({ chain: asLocalnet });
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setBudget(agent.id, 200);
    await wallet.setPolicy(agent.id, { askAboveCents: 200, refill: REVIEW_ALLOWANCE });
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about backups." });
    await sandbox.workOnce();
    expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
    const before = await wallet.overview();

    const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-backup-")), "backup.agencbackup");
    const { createdAt } = await wallet.exportBackup("a long enough password", saved);
    const file = readFileSync(saved, "utf8");
    // The first computer is gone.
    await wallet.close();

    const elsewhere = mkdtempSync(path.join(tmpdir(), "agenc-wallet-e2e-restore-"));
    const newSecret = randomBytes(32);
    await restoreBackup({
      dataDir: elsewhere,
      unlockSecret: newSecret,
      text: file,
      password: "a long enough password",
      network: "localnet",
      now: world.clock.now,
    });
    restored = await world.reopen({ dataDir: elsewhere, unlockSecret: newSecret });
    const after = await restored.overview();
    expect(after.main.address).toBe(before.main.address);
    expect(after.main.balance.lamports).toBe(before.main.balance.lamports);
    expect(after.agents.map((entry) => [entry.id, entry.name, entry.address, entry.budgetCents])).toEqual(
      before.agents.map((entry) => [entry.id, entry.name, entry.address, entry.budgetCents]),
    );

    // It knows the file it came from covers it: no nagging for a new backup.
    expect(after.backup).toEqual({ at: createdAt, upToDate: true });

    // The job that was waiting for approval is still there, and the restored
    // wallet can pay for it: its keys work.
    const waiting = await restored.getJob(job.id, true);
    expect(waiting.status).toBe("delivered");
    const paid = await restored.approveJob(job.id, undefined, true);
    expect(paid.status).toBe("paid");
  });
});
