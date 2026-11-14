import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAddressDecoder, verifySignature, type SignatureBytes } from "@solana/kit";
import { KeyVault } from "../src/vault.js";

function freshFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "agenc-wallet-vault-")), "vault.json");
}

describe("the key vault", () => {
  it("creates keys, reopens them and signs with the same address", async () => {
    const file = freshFile();
    const secret = randomBytes(32);
    const vault = KeyVault.open({ file, secret });
    const address = await vault.create("main");
    expect(vault.address("main")).toBe(address);

    const reopened = KeyVault.open({ file, secret });
    expect(reopened.ids()).toEqual(["main"]);
    const signer = await reopened.signer("main");
    expect(signer.address).toBe(address);
    const message = new TextEncoder().encode("hello");
    const [signed] = await signer.signMessages([{ content: message, signatures: {} }]);
    const ok = await verifySignature(
      signer.keyPair.publicKey,
      signed![address] as SignatureBytes,
      message,
    );
    expect(ok).toBe(true);
  });

  it("keeps the file private and never stores a key in the clear", async () => {
    const file = freshFile();
    const vault = KeyVault.open({ file, secret: randomBytes(32) });
    await vault.create("main");
    const exported = await vault.exportSecretKey("main");
    expect(exported).toHaveLength(64);
    expect(getAddressDecoder().decode(exported.subarray(32))).toBe(vault.address("main"));
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o077).toBe(0);
    }
    const onDisk = readFileSync(file);
    expect(onDisk.includes(Buffer.from(exported.subarray(0, 32)))).toBe(false);
    expect(onDisk.includes(Buffer.from(exported.subarray(0, 32)).toString("base64"))).toBe(false);
  });

  it("refuses the wrong secret and a swapped entry", async () => {
    const file = freshFile();
    const secret = randomBytes(32);
    const vault = KeyVault.open({ file, secret });
    await vault.create("main");
    await vault.create("agent:one");
    expect(() => KeyVault.open({ file, secret: randomBytes(32) })).toThrowError(
      /could not be unlocked/,
    );

    // Point one name at another key's ciphertext: the binding must fail.
    const data = JSON.parse(readFileSync(file, "utf8"));
    const main = data.keys.main;
    data.keys.main = { ...data.keys["agent:one"], address: main.address };
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    const tampered = KeyVault.open({ file, secret });
    await expect(tampered.signer("main")).rejects.toThrowError(/could not be read/);
  });

  it("refuses duplicate and malformed names", async () => {
    const vault = KeyVault.open({ file: freshFile(), secret: randomBytes(32) });
    await vault.create("main");
    await expect(vault.create("main")).rejects.toThrowError(/already exists/);
    await expect(vault.create("../etc")).rejects.toThrowError(/not valid/);
  });
});
