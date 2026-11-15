// A backup: every key and the journal in one password-locked file, and a
// restore that never deletes the wallet it replaces.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  createBackup,
  readBackupHeader,
  restoreBackup,
} from "../src/backup.js";
import { KeyVault } from "../src/vault.js";

const PASSWORD = "correct horse battery";

async function walletFolder(): Promise<{
  dataDir: string;
  secret: Buffer;
  vault: KeyVault;
  addresses: Record<string, string>;
}> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-backup-"));
  const secret = randomBytes(32);
  const vault = KeyVault.open({ file: path.join(dataDir, "vault.json"), secret });
  const addresses: Record<string, string> = {};
  for (const id of ["main", "agent:a1", "agent:a2"]) addresses[id] = await vault.create(id);
  writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ version: 1, agents: { a1: {}, a2: {} } }));
  mkdirSync(path.join(dataDir, "earn", "a1"), { recursive: true });
  writeFileSync(path.join(dataDir, "earn", "a1", "state.json"), '{"agentIdHex":"ab"}');
  writeFileSync(path.join(dataDir, "service.lock.old"), "not carried");
  return { dataDir, secret, vault, addresses };
}

async function backupOf(folder: Awaited<ReturnType<typeof walletFolder>>, now = 1_800_000_000_000) {
  return createBackup({
    dataDir: folder.dataDir,
    vault: folder.vault,
    password: PASSWORD,
    network: "mainnet",
    agents: 2,
    now,
  });
}

describe("a wallet backup", () => {
  it("says what it is without the password and holds no key in the clear", async () => {
    const folder = await walletFolder();
    const { text, header } = await backupOf(folder);
    expect(header).toEqual({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: 1_800_000_000_000,
      network: "mainnet",
      main: folder.addresses.main,
      agents: 2,
    });
    expect(readBackupHeader(text)).toEqual(header);

    // Nothing secret is readable: not a key, not the journal, not a ledger.
    const secretKey = await folder.vault.exportSecretKey("main");
    expect(text).not.toContain(Buffer.from(secretKey).toString("base64"));
    expect(text).not.toContain(Buffer.from(secretKey.subarray(0, 32)).toString("base64"));
    expect(text).not.toContain("agentIdHex");
    expect(text).not.toContain(folder.addresses["agent:a1"]);
    // Two backups of the same wallet never look alike.
    expect((await backupOf(folder)).text).not.toBe(text);
  });

  it("restores every key, the journal and the ledgers on another computer", async () => {
    const folder = await walletFolder();
    const { text } = await backupOf(folder);

    const elsewhere = mkdtempSync(path.join(tmpdir(), "agenc-wallet-restore-"));
    const otherSecret = randomBytes(32);
    const { header, replaced } = await restoreBackup({
      dataDir: elsewhere,
      unlockSecret: otherSecret,
      text,
      password: PASSWORD,
      network: "mainnet",
      now: 1_800_000_100_000,
    });
    expect(header.main).toBe(folder.addresses.main);
    expect(replaced).toBeNull();

    // The keys open with the NEW computer's secret and sign as the same addresses.
    const vault = KeyVault.open({ file: path.join(elsewhere, "vault.json"), secret: otherSecret });
    expect(vault.ids().sort()).toEqual(["agent:a1", "agent:a2", "main"]);
    for (const id of vault.ids()) {
      expect(vault.address(id)).toBe(folder.addresses[id]);
      expect((await vault.signer(id)).address).toBe(folder.addresses[id]);
    }
    // The journal comes back as it was, with one note added: this backup covers it.
    expect(JSON.parse(readFileSync(path.join(elsewhere, "state.json"), "utf8"))).toEqual({
      ...(JSON.parse(readFileSync(path.join(folder.dataDir, "state.json"), "utf8")) as object),
      backup: { at: 1_800_000_000_000, keyIds: ["main", "agent:a1", "agent:a2"] },
    });
    expect(readFileSync(path.join(elsewhere, "earn", "a1", "state.json"), "utf8")).toBe(
      '{"agentIdHex":"ab"}',
    );
    expect(existsSync(path.join(elsewhere, "service.lock.old"))).toBe(false);
    // The old computer's secret does not open the restored vault.
    expect(() => KeyVault.open({ file: path.join(elsewhere, "vault.json"), secret: folder.secret })).toThrow();
  });

  it("moves the wallet that was there aside instead of deleting it", async () => {
    const source = await walletFolder();
    const { text } = await backupOf(source);
    const target = await walletFolder();
    const before = readFileSync(path.join(target.dataDir, "vault.json"), "utf8");

    const { replaced } = await restoreBackup({
      dataDir: target.dataDir,
      unlockSecret: target.secret,
      text,
      password: PASSWORD,
      network: "mainnet",
      now: 1_800_000_200_000,
    });
    expect(replaced).not.toBeNull();
    expect(path.dirname(replaced as string)).toBe(target.dataDir);
    expect(readFileSync(path.join(replaced as string, "vault.json"), "utf8")).toBe(before);
    expect(existsSync(path.join(replaced as string, "state.json"))).toBe(true);
    expect(existsSync(path.join(replaced as string, "earn", "a1", "state.json"))).toBe(true);
    // And the folder now holds the restored wallet.
    const vault = KeyVault.open({ file: path.join(target.dataDir, "vault.json"), secret: target.secret });
    expect(vault.address("main")).toBe(source.addresses.main);
  });

  it("refuses a wrong password, a changed header and a file that is not a backup", async () => {
    const folder = await walletFolder();
    const { text } = await backupOf(folder);
    const into = () => mkdtempSync(path.join(tmpdir(), "agenc-wallet-restore-"));
    const restore = (body: string, password = PASSWORD, network = "mainnet") =>
      restoreBackup({ dataDir: into(), unlockSecret: randomBytes(32), text: body, password, network, now: 1 });

    await expect(restore(text, "wrong password here")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "That password does not open this backup.",
    });
    // Editing what the header says (another address, more agents, a later
    // date) breaks the seal: a backup cannot be passed off as another.
    const file = JSON.parse(text) as Record<string, unknown>;
    for (const change of [{ main: folder.addresses["agent:a1"] }, { agents: 9 }, { createdAt: 5 }]) {
      await expect(restore(JSON.stringify({ ...file, ...change }))).rejects.toMatchObject({
        message: "That password does not open this backup.",
      });
    }
    await expect(restore(text, PASSWORD, "devnet")).rejects.toMatchObject({
      message: "That backup holds real money, and this is test money. It cannot be restored here.",
    });
    for (const body of ["", "hello", "{}", JSON.stringify({ format: "something-else" })]) {
      await expect(restore(body)).rejects.toMatchObject({
        message: "That file is not an AgenC backup.",
      });
    }
    await expect(restore(JSON.stringify({ ...file, version: 2 }))).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    // A backup may not make this program do unbounded work.
    await expect(
      restore(JSON.stringify({ ...file, kdf: { ...(file.kdf as object), N: 2 ** 30 } })),
    ).rejects.toMatchObject({ message: "That file is not an AgenC backup." });
  });

  it("needs a real password and has nothing to back up in practice mode", async () => {
    const folder = await walletFolder();
    const make = (password: string, network = "mainnet") =>
      createBackup({ dataDir: folder.dataDir, vault: folder.vault, password, network, agents: 2, now: 1 });
    await expect(make("short")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(make("")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(make(PASSWORD, "sandbox")).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("leaves a wallet untouched when the restore cannot finish, and writes nothing outside the folder", async () => {
    const source = await walletFolder();
    const target = await walletFolder();
    const before = readdirSync(target.dataDir).sort();
    const vaultBefore = readFileSync(path.join(target.dataDir, "vault.json"), "utf8");

    // The wallet is open in another program: the folder is locked, nothing moves.
    writeFileSync(path.join(target.dataDir, "service.lock"), String(process.ppid));
    await expect(
      restoreBackup({
        dataDir: target.dataDir,
        unlockSecret: target.secret,
        text: (await backupOf(source)).text,
        password: PASSWORD,
        network: "mainnet",
        now: 1,
      }),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(readFileSync(path.join(target.dataDir, "vault.json"), "utf8")).toBe(vaultBefore);
    expect(readdirSync(target.dataDir).filter((name) => name !== "service.lock").sort()).toEqual(before);

    // A link out of the wallet folder is not followed when a backup is made.
    const outside = mkdtempSync(path.join(tmpdir(), "agenc-wallet-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "do not carry me");
    symlinkSync(outside, path.join(source.dataDir, "earn", "linked"));
    const { text } = await backupOf(source);
    const restored = mkdtempSync(path.join(tmpdir(), "agenc-wallet-restore-"));
    await restoreBackup({
      dataDir: restored,
      unlockSecret: randomBytes(32),
      text,
      password: PASSWORD,
      network: "mainnet",
      now: 1,
    });
    expect(existsSync(path.join(restored, "earn", "linked"))).toBe(false);
  });
});
