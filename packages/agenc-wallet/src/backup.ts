import { BUSINESS_FILE, pauseRestoredBusiness, restoredBusiness, verifyPortableBusiness } from "./business-backup.js";
import type { PortableBusiness } from "./client/business.js";
import type { WalletState } from "./store.js";
// A backup of the wallet: every key and the journal, in one file the person
// keeps somewhere safe, locked with a password they choose.
//
// Why it exists: the keys live on one computer, sealed with a secret that
// stays in that computer's keychain. Lose the computer and the money is gone.
// A backup is the same keys sealed with a password instead, so they can be
// opened anywhere.
//
// - The whole content (keys, journal, the agents' work ledgers) is one
//   AES-256-GCM ciphertext. The key comes from the password through scrypt.
// - The header (when, which network, the main address, how many agents) is
//   readable without the password so a person can tell backups apart. It is
//   bound into the ciphertext, so it cannot be edited to pass one backup off
//   as another.
// - Restoring NEVER deletes. Whatever wallet was in the folder is moved into
//   a dated folder beside it first.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { WalletError } from "./errors.js";
import { acquireServiceLock } from "./store.js";
import { KeyVault } from "./vault.js";

export const BACKUP_FORMAT = "agenc-wallet-backup";
export const BACKUP_VERSION = 1;
/** Shortest password a backup may be locked with. */
export const MIN_BACKUP_PASSWORD = 8;

const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
/** Largest backup file accepted for reading. */
const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
/** Largest single file carried in a backup. Anything bigger is left out. */
const MAX_CARRIED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CARRIED_FILES = 4_000;
const MAIN_KEY = "main";
const KEY_ID = /^[a-z][a-z0-9:_-]{0,63}$/;

/** What a backup says about itself without its password. */
export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** Unix ms. */
  createdAt: number;
  network: string;
  /** The main balance's address. */
  main: string;
  /** How many agents it holds. */
  agents: number;
}

interface BackupFile extends BackupHeader {
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  nonce: string;
  sealed: string;
}

interface BackupContent {
  business?: PortableBusiness;
  /** key id -> base64 of the 64-byte keypair. */
  keys: Record<string, string>;
  /** path below the wallet folder (forward slashes) -> base64 of the file. */
  files: Record<string, string>;
}

function headerAad(header: BackupHeader): Buffer {
  return Buffer.from(
    [header.format, header.version, header.createdAt, header.network, header.main, header.agents].join("\n"),
    "utf8",
  );
}

function deriveKey(password: string, kdf: BackupFile["kdf"]): Buffer {
  return scryptSync(Buffer.from(password.normalize("NFKC"), "utf8"), Buffer.from(kdf.salt, "base64"), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT.maxmem,
  });
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_BACKUP_PASSWORD) {
    throw new WalletError(
      "BAD_REQUEST",
      `Choose a password of at least ${MIN_BACKUP_PASSWORD} characters. You will need it to open the backup.`,
    );
  }
  if (password.length > 1_024) {
    throw new WalletError("BAD_REQUEST", "That password is too long.");
  }
}

/** The journal and the work ledgers: everything but the keys and the lock. */
function carriedFiles(dataDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  let count = 0;
  const take = (relative: string): void => {
    const absolute = path.join(dataDir, relative);
    let info;
    try {
      info = lstatSync(absolute);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) take(path.posix.join(relative, name));
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_BACKUP_BYTES || (info.size > MAX_CARRIED_FILE_BYTES && !relative.endsWith("state.json")))
      throw new WalletError("BAD_REQUEST", "A wallet file exceeds the backup size limit.");
    count += 1;
    if (count > MAX_CARRIED_FILES) {
      throw new WalletError("INTERNAL", "This wallet has too many files to back up in one go.");
    }
    files[relative] = readFileSync(absolute).toString("base64");
  };
  take("state.json");
  take("earn");
  return files;
}

/**
 * Seal the wallet in `dataDir` into one backup file's text. The vault must be
 * the open vault of that folder. Nothing is written by this function.
 */
export async function createBackup(input: {
  dataDir: string;
  vault: KeyVault;
  business?: PortableBusiness;
  password: string;
  network: string;
  agents: number;
  now: number;
}): Promise<{ text: string; header: BackupHeader }> {
  assertPassword(input.password);
  if (input.network === "sandbox") {
    throw new WalletError("NOT_AVAILABLE", "Practice money is not real, so there is nothing to back up.");
  }
  if (!input.vault.has(MAIN_KEY)) {
    throw new WalletError("NOT_FOUND", "This wallet has no keys to back up yet.");
  }
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: input.now,
    network: input.network,
    main: input.vault.address(MAIN_KEY),
    agents: input.agents,
  };
  const secrets: Uint8Array[] = [];
  let plain: Buffer | null = null;
  try {
    const keys: Record<string, string> = {};
    for (const id of input.vault.ids()) {
      const secret = await input.vault.exportSecretKey(id);
      secrets.push(secret);
      keys[id] = Buffer.from(secret).toString("base64");
    }
    const business = input.business ?? restoredBusiness(input.dataDir);
    const content: BackupContent = { keys, files: carriedFiles(input.dataDir), ...(business && { business: verifyPortableBusiness(business) }) };
    plain = Buffer.from(JSON.stringify(content), "utf8");

    const kdf: BackupFile["kdf"] = {
      name: "scrypt",
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: randomBytes(32).toString("base64"),
    };
    const key = deriveKey(input.password, kdf);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(headerAad(header));
      const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      const file: BackupFile = {
        ...header,
        kdf,
        nonce: nonce.toString("base64"),
        sealed: sealed.toString("base64"),
      };
      const text = JSON.stringify(file) + "\n";
      if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) throw new WalletError("BAD_REQUEST", "This backup exceeds the wallet archive size limit.");
      return { text, header };
    } finally {
      key.fill(0);
    }
  } finally {
    for (const secret of secrets) secret.fill(0);
    plain?.fill(0);
  }
}

/** A network the way a person knows it. */
function moneyKind(network: string): string {
  return network === "mainnet" ? "real money" : network === "sandbox" ? "practice money" : "test money";
}

/** A backup only goes back where its kind of money lives. */
function assertSameMoney(header: BackupHeader, network: string): void {
  if (header.network !== network) {
    throw new WalletError(
      "BAD_REQUEST",
      `That backup holds ${moneyKind(header.network)}, and this is ${moneyKind(network)}. It cannot be restored here.`,
    );
  }
}

const NOT_SAVED = "The backup could not be saved there. Choose another folder.";

/**
 * Put a backup's text where the person chose to keep it: whole or not at
 * all, and readable by its owner only. The folder is theirs (a documents
 * folder, a USB stick), so it is neither made nor made private here.
 */
export function writeBackupFile(file: string, text: string): void {
  if (!path.isAbsolute(file)) {
    throw new WalletError("BAD_REQUEST", "A backup needs a full path to be saved to.");
  }
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number;
  try {
    fd = openSync(temporary, "wx", 0o600);
  } catch {
    throw new WalletError("BAD_REQUEST", NOT_SAVED);
  }
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone.
    }
    throw new WalletError("BAD_REQUEST", NOT_SAVED);
  }
}

/** Read a backup file a person chose. Anything too big to be one is refused unread. */
export function readBackupFile(file: string): string {
  if (!path.isAbsolute(file)) {
    throw new WalletError("BAD_REQUEST", "Say where the backup is with a full path.");
  }
  let size: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new WalletError("NOT_FOUND", "That backup file could not be read.");
  }
  if (size > MAX_BACKUP_BYTES) {
    throw new WalletError("BAD_REQUEST", "That file is not an AgenC backup.");
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new WalletError("NOT_FOUND", "That backup file could not be read.");
  }
}

/**
 * Try a password on a backup without changing anything: what it holds when
 * the password opens it, a sentence to show when it does not.
 */
export function checkBackup(input: { text: string; password: string; network: string }): BackupHeader {
  const { header, content } = openBackup(input.text, input.password);
  assertSameMoney(header, input.network);
  const ids = Object.keys(content.keys);
  if (!ids.includes(MAIN_KEY) || !ids.every((id) => KEY_ID.test(id))) {
    throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
  }
  return header;
}

function parseBackup(text: unknown): BackupFile {
  const notABackup = (): never => {
    throw new WalletError("BAD_REQUEST", "That file is not an AgenC backup.");
  };
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_BACKUP_BYTES) notABackup();
  let value: unknown;
  try {
    value = JSON.parse(text as string);
  } catch {
    notABackup();
  }
  const file = value as Partial<BackupFile> | null;
  if (
    typeof file !== "object" ||
    file === null ||
    file.format !== BACKUP_FORMAT ||
    typeof file.createdAt !== "number" ||
    !Number.isSafeInteger(file.createdAt) ||
    typeof file.network !== "string" ||
    typeof file.main !== "string" ||
    typeof file.agents !== "number" ||
    !Number.isSafeInteger(file.agents) ||
    typeof file.nonce !== "string" ||
    typeof file.sealed !== "string" ||
    typeof file.kdf !== "object" ||
    file.kdf === null ||
    file.kdf.name !== "scrypt" ||
    typeof file.kdf.salt !== "string" ||
    ![file.kdf.N, file.kdf.r, file.kdf.p].every((n) => Number.isSafeInteger(n) && (n as number) > 0) ||
    // A backup may not ask for more work than this program would ever spend.
    file.kdf.N > 1_048_576 ||
    file.kdf.r > 16 ||
    file.kdf.p > 4
  ) {
    notABackup();
  }
  if (file!.version !== BACKUP_VERSION) {
    throw new WalletError(
      "NOT_AVAILABLE",
      "That backup was made by a newer version of AgenC. Update AgenC, then restore it.",
    );
  }
  return file as BackupFile;
}

/** What a backup says about itself. Needs no password. */
export function readBackupHeader(text: string): BackupHeader {
  const { format, version, createdAt, network, main, agents } = parseBackup(text);
  return { format, version, createdAt, network, main, agents };
}

function openBackup(text: string, password: string): { header: BackupHeader; content: BackupContent } {
  assertPassword(password);
  const file = parseBackup(text);
  const header: BackupHeader = {
    format: file.format,
    version: file.version,
    createdAt: file.createdAt,
    network: file.network,
    main: file.main,
    agents: file.agents,
  };
  const key = deriveKey(password, file.kdf);
  let plain: Buffer;
  try {
    const sealed = Buffer.from(file.sealed, "base64");
    if (sealed.length < 17) throw new Error("short");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.nonce, "base64"));
    decipher.setAAD(headerAad(header));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new WalletError("BAD_REQUEST", "That password does not open this backup.");
  } finally {
    key.fill(0);
  }
  try {
    const content = JSON.parse(plain.toString("utf8")) as BackupContent;
    if (
      typeof content !== "object" ||
      content === null ||
      typeof content.keys !== "object" ||
      content.keys === null ||
      typeof content.files !== "object" ||
      content.files === null
    ) {
      throw new Error("shape");
    }
    if (content.business !== undefined) verifyPortableBusiness(content.business);
    return { header, content };
  } catch {
    throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
  } finally {
    plain.fill(0);
  }
}

/** A carried path is safe to write when it stays inside the wallet folder. */
function safeRelative(relative: string): string | null {
  if (relative.length === 0 || relative.length > 512 || relative.includes("\\") || relative.includes("\0")) {
    return null;
  }
  const parts = relative.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  if (relative !== "state.json" && parts[0] !== "earn") return null;
  return parts.join(path.sep);
}

/**
 * Put a backup back into `dataDir`, sealing its keys with this computer's
 * unlock secret. The wallet must be closed. Whatever was in the folder is
 * moved into `replaced-<time>` first, never deleted, and its path is returned.
 */
export async function restoreBackup(input: {
  dataDir: string;
  unlockSecret: Uint8Array;
  text: string;
  password: string;
  /** Refuse a backup made for another network than this folder serves. */
  network: string;
  now: number;
}): Promise<{ header: BackupHeader; replaced: string | null }> {
  if (!path.isAbsolute(input.dataDir)) {
    throw new WalletError("INTERNAL", "The wallet needs an absolute folder to keep its files in.");
  }
  const { header, content } = openBackup(input.text, input.password);
  assertSameMoney(header, input.network);
  const ids = Object.keys(content.keys);
  if (!ids.includes(MAIN_KEY) || !ids.every((id) => KEY_ID.test(id))) {
    throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
  }
  const writes: { file: string; bytes: Buffer }[] = [];
  for (const [relative, body] of Object.entries(content.files)) {
    const safe = safeRelative(relative);
    if (safe === null || typeof body !== "string") {
      throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
    }
    let bytes = Buffer.from(body, "base64");
    if (safe === "state.json") {
      // The records were sealed a moment before the backup was noted in them.
      // What comes back is exactly what this file holds, so it says so:
      // otherwise a wallet just restored would ask to be backed up.
      try {
        const state = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        state.backup = { at: header.createdAt, keyIds: ids };
        const hasWork = Object.entries(content.files).some(([name, raw]) => {
          if (!/^earn\/[^/]+\/state\.json$/.test(name)) return false;
          const ledger = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
          return !!ledger.openClaim || ledger.submissions?.some((entry: {settled: boolean}) => !entry.settled);
        });
        pauseRestoredBusiness(state as unknown as WalletState, content.business, input.now, hasWork);
        bytes = Buffer.from(JSON.stringify(state), "utf8");
      } catch {
        throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
      }
    }
    writes.push({ file: path.join(input.dataDir, safe), bytes });
  }

  if (!Object.hasOwn(content.files, "state.json")) throw new WalletError("BAD_REQUEST", "The backup is missing its wallet records.");
  if (content.business) writes.push({file: path.join(input.dataDir, BUSINESS_FILE), bytes: Buffer.from(JSON.stringify(content.business))});
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireServiceLock(input.dataDir);
  try {
    // Move the wallet that is here out of the way. Nothing is deleted.
    let replaced: string | null = null;
    const present = ["vault.json", "state.json", "earn", BUSINESS_FILE, "connection-grants.json", "business-rehearsals.json"].filter((name) =>
      existsSync(path.join(input.dataDir, name)),
    );
    if (present.length > 0) {
      replaced = path.join(
        input.dataDir,
        `replaced-${new Date(input.now).toISOString().replace(/[:.]/g, "-")}`,
      );
      mkdirSync(replaced, { recursive: false, mode: 0o700 });
      for (const name of present) renameSync(path.join(input.dataDir, name), path.join(replaced, name));
    }

    try {
      const vault = KeyVault.open({ file: path.join(input.dataDir, "vault.json"), secret: input.unlockSecret });
      for (const id of ids) {
        const secret = Buffer.from(content.keys[id] as string, "base64");
        try {
          await vault.import(id, secret);
        } finally {
          secret.fill(0);
        }
      }
      if (vault.address(MAIN_KEY) !== header.main) {
        throw new WalletError("BAD_REQUEST", "That backup is damaged and cannot be restored.");
      }
      for (const { file, bytes } of writes) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, bytes, { mode: 0o600 });
        chmodSync(file, 0o600);
      }
    } catch (error) {
      // Half a restore is worse than none: take out what was just written
      // and put the wallet that was here back exactly as it was.
      for (const name of ["vault.json", "state.json", "earn", BUSINESS_FILE, "connection-grants.json", "business-rehearsals.json"]) {
        rmSync(path.join(input.dataDir, name), { recursive: true, force: true });
      }
      if (replaced !== null) {
        for (const name of present) renameSync(path.join(replaced, name), path.join(input.dataDir, name));
        rmSync(replaced, { recursive: true, force: true });
      }
      throw error;
    }
    return { header, replaced };
  } finally {
    release();
  }
}
