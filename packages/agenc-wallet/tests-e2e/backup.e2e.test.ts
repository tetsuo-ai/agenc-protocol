// Backing the wallet up from the running service and bringing it back on
// another computer: the same addresses, the same agents, the same jobs.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreBackup } from "../src/backup.js";
import type { Chain } from "../src/chain.js";
import { AgencWallet } from "../src/wallet.js";
import { startWorld, type World } from "./harness.js";

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

    await expect(wallet.exportBackup("short")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const made = await wallet.exportBackup("a long enough password");
    expect(made.agents).toBe(1);
    expect((await wallet.overview()).backup).toEqual({ at: made.createdAt, upToDate: true });

    // A wallet made after the backup is not in it.
    await wallet.createAgent("Helper");
    expect((await wallet.overview()).backup).toEqual({ at: made.createdAt, upToDate: false });
    await wallet.exportBackup("a long enough password");
    expect((await wallet.overview()).backup.upToDate).toBe(true);
  });

  it("comes back whole on another computer", async () => {
    world = await startWorld({ chain: asLocalnet });
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setBudget(agent.id, 200);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about backups." });
    await sandbox.workOnce();
    expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
    const before = await wallet.overview();

    const { file, createdAt } = await wallet.exportBackup("a long enough password");
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
