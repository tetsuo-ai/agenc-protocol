// The 128 MiB backup limit on write and on read, and the sentence that names it.
import { randomBytes } from "node:crypto";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkBackup, createBackup, readBackupFile, restoreBackup } from "../src/backup.js";
import { KeyVault } from "../src/vault.js";

const PASSWORD = "correct horse battery";
const MIB = 1024 * 1024;

async function folder() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agenc-backup-limit-"));
  const secret = randomBytes(32);
  const vault = KeyVault.open({ file: path.join(dataDir, "vault.json"), secret });
  const main = await vault.create("main");
  writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ version: 1, agents: {} }));
  return { dataDir, secret, vault, main };
}
const sparse = (file: string, bytes: number) => {
  const fd = openSync(file, "w", 0o600);
  ftruncateSync(fd, bytes);
  closeSync(fd);
};

it("refuses to write a backup of records beyond the limit and names 128 MiB", async () => {
  const f = await folder();
  const dir = path.join(f.dataDir, "job-exchange", f.main);
  mkdirSync(dir, { recursive: true });
  // Three exchange records of 22 MiB each: 66 MiB carried, over the 64 MiB the two encodings allow.
  for (const n of ["a", "b", "c"]) sparse(path.join(dir, n.repeat(64)), 22 * MIB);
  await expect(createBackup({ dataDir: f.dataDir, vault: f.vault, password: PASSWORD, network: "mainnet", agents: 0, now: 1 }))
    .rejects.toMatchObject({ message: expect.stringContaining("128 MiB") });
}, 60_000);

it("refuses to read a file over 128 MiB before loading it, on every read path", async () => {
  const f = await folder();
  const big = path.join(f.dataDir, "big.agencbackup");
  sparse(big, 128 * MIB + 1);
  expect(() => readBackupFile(big)).toThrow(/backup/);
  const text = " ".repeat(128 * MIB + 1);
  expect(() => checkBackup({ text, password: PASSWORD, network: "mainnet" })).toThrow(/not an AgenC backup.*128 MiB/);
  await expect(restoreBackup({ dataDir: f.dataDir, unlockSecret: f.secret, text, password: PASSWORD, network: "mainnet", now: 2 }))
    .rejects.toThrow(/not an AgenC backup.*128 MiB/);
}, 60_000);

it("says the limit when the file is too big to be read", async () => {
  const f = await folder();
  const big = path.join(f.dataDir, "big.agencbackup");
  sparse(big, 128 * MIB + 1);
  expect(() => readBackupFile(big)).toThrow(/128 MiB/);
});

it("keeps the plain sentence for a small file that is not a backup", () => {
  expect(() => checkBackup({ text: "hello", password: PASSWORD, network: "mainnet" })).toThrow("That file is not an AgenC backup.");
  expect(() => checkBackup({ text: "", password: PASSWORD, network: "mainnet" })).toThrow("That file is not an AgenC backup.");
});

it("reads a file at the limit and refuses one byte more", async () => {
  const f = await folder();
  const file = path.join(f.dataDir, "edge.agencbackup");
  sparse(file, 128 * MIB);
  expect(readBackupFile(file)).toHaveLength(128 * MIB);
  sparse(file, 128 * MIB + 1);
  expect(() => readBackupFile(file)).toThrow("That file is not an AgenC backup. It is larger than the 128 MiB limit.");
}, 60_000);

it("has the restore command check the size before it reads the file", async () => {
  const f = await folder();
  const big = path.join(f.dataDir, "big.agencbackup");
  sparse(big, 128 * MIB + 1);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = spawnSync(process.execPath, [path.join(root, "../../node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli.ts"),
    "restore", "--file", big, "--data-dir", path.join(f.dataDir, "restored"), "--network", "localnet"],
    { input: JSON.stringify({ unlockSecret: f.secret.toString("base64"), password: PASSWORD }) + "\n", encoding: "utf8", timeout: 60_000 });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("It is larger than the 128 MiB limit.");
}, 90_000);
