// The key vault: every wallet key the service controls, encrypted at rest.
//
// - One file, mode 0600, in a 0700 directory, replaced atomically.
// - Each 32-byte Ed25519 seed is sealed with AES-256-GCM. The key comes from
//   the unlock secret through scrypt. The unlock secret is never written here:
//   a desktop host keeps it in the OS keychain, a headless host supplies it.
// - The additional authenticated data binds every ciphertext to its key id and
//   public address, so entries cannot be swapped or relabelled on disk.
// - In memory, signers hold NON-extractable WebCrypto keys. The raw seed
//   exists only for the instant it is imported, then the buffer is zeroed.
//
// Nothing outside this module reads a seed. Callers ask for a signer.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { WalletError } from "./errors.js";

const VAULT_VERSION = 1;
const CHECK_PLAINTEXT = "agenc-wallet-vault-v1";
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_ID = /^[a-z][a-z0-9:_-]{0,63}$/;
const MAX_VAULT_BYTES = 1024 * 1024;

interface SealedValue {
  nonce: string;
  sealed: string;
}

interface VaultFile {
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  check: SealedValue;
  keys: Record<string, SealedValue & { address: string }>;
}

function seal(key: Buffer, plaintext: Uint8Array, aad: string): SealedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    sealed: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
}

function open(key: Buffer, value: SealedValue, aad: string): Buffer {
  const nonce = Buffer.from(value.nonce, "base64");
  const sealed = Buffer.from(value.sealed, "base64");
  if (nonce.length !== 12 || sealed.length < 16) {
    throw new Error("vault entry is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
}

function keyAad(id: string, address: string): string {
  return `agenc-wallet:${VAULT_VERSION}:key:${id}:${address}`;
}

function deriveKey(secret: Uint8Array, salt: Buffer, params: VaultFile["kdf"]): Buffer {
  return scryptSync(secret, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT.maxmem,
  });
}

function assertKeyId(id: string): void {
  if (!KEY_ID.test(id)) {
    throw new WalletError("BAD_REQUEST", "That wallet name is not valid.");
  }
}

/** Write a private file so a crash never leaves a half-written vault. */
export function writePrivateFileAtomic(file: string, body: string): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone.
    }
    throw error;
  }
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/** Read a private file, refusing symlinks and files other users can read. */
export function readPrivateFile(file: string, maxBytes: number): string {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WalletError("INTERNAL", "The wallet's files are not where they should be.");
  }
  if (info.size > maxBytes) {
    throw new WalletError("INTERNAL", "The wallet's files are damaged.");
  }
  if (process.platform !== "win32") {
    const getuid = process.getuid;
    if (typeof getuid === "function" && info.uid !== getuid.call(process)) {
      throw new WalletError("INTERNAL", "The wallet's files belong to another user.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new WalletError(
        "INTERNAL",
        "The wallet's files can be read by other users. Fix their permissions first.",
      );
    }
  }
  return readFileSync(file, "utf8");
}

export interface OpenVaultOptions {
  /** Absolute path of the vault file. */
  file: string;
  /**
   * The unlock secret. Use at least 32 random bytes when a machine holds it
   * (an OS keychain); a passphrase works but is only as strong as it is long.
   */
  secret: Uint8Array;
  /** Create the vault when the file does not exist. Default true. */
  create?: boolean;
}

export class KeyVault {
  readonly #file: string;
  readonly #key: Buffer;
  #data: VaultFile;
  readonly #signers = new Map<string, Promise<KeyPairSigner>>();

  private constructor(file: string, key: Buffer, data: VaultFile) {
    this.#file = file;
    this.#key = key;
    this.#data = data;
  }

  /** Open an existing vault, or create an empty one. */
  static open(options: OpenVaultOptions): KeyVault {
    if (!path.isAbsolute(options.file)) {
      throw new WalletError("INTERNAL", "The wallet needs an absolute folder to keep its files in.");
    }
    if (options.secret.length < 16) {
      throw new WalletError("BAD_REQUEST", "The unlock secret is too short.");
    }
    if (!existsSync(options.file)) {
      if (options.create === false) {
        throw new WalletError("NOT_FOUND", "No wallet has been created here yet.");
      }
      const salt = randomBytes(32);
      const kdf: VaultFile["kdf"] = {
        name: "scrypt",
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        salt: salt.toString("base64"),
      };
      const key = deriveKey(options.secret, salt, kdf);
      const data: VaultFile = {
        version: VAULT_VERSION,
        kdf,
        check: seal(key, Buffer.from(CHECK_PLAINTEXT, "utf8"), "agenc-wallet:check"),
        keys: {},
      };
      const vault = new KeyVault(options.file, key, data);
      vault.#save();
      return vault;
    }

    let parsed: VaultFile;
    try {
      parsed = JSON.parse(readPrivateFile(options.file, MAX_VAULT_BYTES)) as VaultFile;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError("INTERNAL", "The wallet's key file is damaged.", { cause: error });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== VAULT_VERSION ||
      parsed.kdf?.name !== "scrypt" ||
      !Number.isSafeInteger(parsed.kdf.N) ||
      parsed.kdf.N < 16_384 ||
      parsed.kdf.N > 1_048_576 ||
      parsed.kdf.r !== 8 ||
      parsed.kdf.p !== 1 ||
      typeof parsed.keys !== "object" ||
      parsed.keys === null
    ) {
      throw new WalletError("INTERNAL", "The wallet's key file is from a version this build cannot read.");
    }
    const key = deriveKey(options.secret, Buffer.from(parsed.kdf.salt, "base64"), parsed.kdf);
    let check: Buffer;
    try {
      check = open(key, parsed.check, "agenc-wallet:check");
    } catch (error) {
      throw new WalletError("NOT_ALLOWED", "The wallet could not be unlocked with that secret.", {
        cause: error,
      });
    }
    const expected = Buffer.from(CHECK_PLAINTEXT, "utf8");
    if (check.length !== expected.length || !timingSafeEqual(check, expected)) {
      throw new WalletError("NOT_ALLOWED", "The wallet could not be unlocked with that secret.");
    }
    return new KeyVault(options.file, key, parsed);
  }

  #save(): void {
    writePrivateFileAtomic(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`);
  }

  has(id: string): boolean {
    return Object.hasOwn(this.#data.keys, id);
  }

  ids(): string[] {
    return Object.keys(this.#data.keys);
  }

  /** The public address of a stored key. */
  address(id: string): Address {
    const entry = this.#data.keys[id];
    if (entry === undefined) {
      throw new WalletError("NOT_FOUND", "That wallet does not exist.");
    }
    return entry.address as Address;
  }

  /** Create a new key under `id` and return its address. */
  async create(id: string): Promise<Address> {
    assertKeyId(id);
    if (this.has(id)) {
      throw new WalletError("BAD_REQUEST", "A wallet with that name already exists.");
    }
    const seed = randomBytes(32);
    try {
      return await this.#store(id, seed);
    } finally {
      seed.fill(0);
    }
  }

  /**
   * Import a 64-byte Solana keypair (seed followed by public key) or a bare
   * 32-byte seed under `id`.
   */
  async import(id: string, secretKey: Uint8Array): Promise<Address> {
    assertKeyId(id);
    if (this.has(id)) {
      throw new WalletError("BAD_REQUEST", "A wallet with that name already exists.");
    }
    if (secretKey.length !== 32 && secretKey.length !== 64) {
      throw new WalletError("BAD_REQUEST", "That is not a wallet key.");
    }
    const seed = Buffer.from(secretKey.subarray(0, 32));
    try {
      return await this.#store(id, seed);
    } finally {
      seed.fill(0);
    }
  }

  async #store(id: string, seed: Buffer): Promise<Address> {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const address = signer.address;
    this.#data = {
      ...this.#data,
      keys: {
        ...this.#data.keys,
        [id]: { address, ...seal(this.#key, seed, keyAad(id, address)) },
      },
    };
    this.#save();
    this.#signers.set(id, Promise.resolve(signer));
    return address;
  }

  /** A signer for `id`. The private key inside it cannot be exported. */
  signer(id: string): Promise<KeyPairSigner> {
    const cached = this.#signers.get(id);
    if (cached !== undefined) return cached;
    const entry = this.#data.keys[id];
    if (entry === undefined) {
      return Promise.reject(new WalletError("NOT_FOUND", "That wallet does not exist."));
    }
    const pending = (async () => {
      let seed: Buffer;
      try {
        seed = open(this.#key, entry, keyAad(id, entry.address));
      } catch (error) {
        throw new WalletError("INTERNAL", "A wallet key could not be read.", { cause: error });
      }
      try {
        const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
        if (signer.address !== entry.address) {
          throw new WalletError("INTERNAL", "A wallet key does not match its address.");
        }
        return signer;
      } finally {
        seed.fill(0);
      }
    })();
    this.#signers.set(id, pending);
    pending.catch(() => this.#signers.delete(id));
    return pending;
  }

  /**
   * Hand the owner a backup of one key as a 64-byte Solana keypair. Only the
   * person at the machine should ever reach this; no agent method does.
   */
  async exportSecretKey(id: string): Promise<Uint8Array> {
    const entry = this.#data.keys[id];
    if (entry === undefined) {
      throw new WalletError("NOT_FOUND", "That wallet does not exist.");
    }
    const seed = open(this.#key, entry, keyAad(id, entry.address));
    try {
      const { getAddressEncoder } = await import("@solana/kit");
      const out = new Uint8Array(64);
      out.set(seed, 0);
      out.set(getAddressEncoder().encode(entry.address as Address), 32);
      return out;
    } finally {
      seed.fill(0);
    }
  }
}
