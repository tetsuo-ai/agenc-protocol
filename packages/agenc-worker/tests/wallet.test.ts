import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSolanaKeypairFile,
  parseSolanaKeypairJson,
  WalletFileError,
} from "../src/wallet.js";

const VALID = Array.from({ length: 64 }, (_, index) => index);

describe("Solana wallet file validation", () => {
  it("accepts exactly 64 byte integers", () => {
    expect(parseSolanaKeypairJson(JSON.stringify(VALID))).toEqual(
      Uint8Array.from(VALID),
    );
  });

  it.each([
    Array(63).fill(1),
    Array(65).fill(1),
    [...Array(63).fill(1), -1],
    [...Array(63).fill(1), 256],
    [...Array(63).fill(1), 1.5],
    [...Array(63).fill(1), Number.NaN],
    [...Array(63).fill(1), Number.POSITIVE_INFINITY],
    [...Array(63).fill(1), Number.MAX_SAFE_INTEGER + 1],
  ])("rejects malformed/coercible keypair arrays", (value) => {
    expect(() => parseSolanaKeypairJson(JSON.stringify(value))).toThrow(
      WalletFileError,
    );
  });

  it("rejects symlinks, non-regular files, and public permissions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-wallet-"));
    const wallet = path.join(dir, "wallet.json");
    writeFileSync(wallet, JSON.stringify(VALID), { mode: 0o600 });
    chmodSync(wallet, 0o600);
    expect(loadSolanaKeypairFile(wallet)).toEqual(Uint8Array.from(VALID));

    const link = path.join(dir, "link.json");
    symlinkSync(wallet, link);
    expect(() => loadSolanaKeypairFile(link)).toThrow(/symbolic links|open safely/);

    const directory = path.join(dir, "directory.json");
    mkdirSync(directory);
    expect(() => loadSolanaKeypairFile(directory)).toThrow(/regular file/);

    if (process.platform !== "win32") {
      chmodSync(wallet, 0o644);
      expect(() => loadSolanaKeypairFile(wallet)).toThrow(/chmod 600/);
    }

    const oversized = path.join(dir, "oversized.json");
    writeFileSync(oversized, " ".repeat(4 * 1024 + 1), { mode: 0o600 });
    chmodSync(oversized, 0o600);
    expect(() => loadSolanaKeypairFile(oversized)).toThrow(/exceeds 4096 bytes/);
  });
});
