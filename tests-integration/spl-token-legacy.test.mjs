import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "./spl-token-legacy.mjs";

const key = (byte) => new PublicKey(Buffer.alloc(32, byte));

test("legacy SPL constants and instruction encodings stay byte-exact", () => {
  assert.equal(MINT_SIZE, 82);
  assert.equal(ACCOUNT_SIZE, 165);
  assert.equal(TOKEN_PROGRAM_ID.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.equal(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  const mint = key(1);
  const authority = key(2);
  const destination = key(3);
  const replacement = key(4);

  const initializeMint = createInitializeMintInstruction(mint, 9, authority, null);
  assert.deepEqual(initializeMint.data, Buffer.concat([
    Buffer.from([0, 9]),
    authority.toBuffer(),
    Buffer.alloc(4),
  ]));
  assert.deepEqual(initializeMint.keys, [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]);

  const initializeAccount = createInitializeAccountInstruction(destination, mint, authority);
  assert.deepEqual(initializeAccount.data, Buffer.from([1]));
  assert.equal(initializeAccount.keys.length, 4);
  assert.ok(initializeAccount.keys[3].pubkey.equals(SYSVAR_RENT_PUBKEY));

  const mintTo = createMintToInstruction(mint, destination, authority, 0x0102_0304_0506_0708n);
  assert.equal(mintTo.data.toString("hex"), "070807060504030201");
  assert.equal(mintTo.keys[2].isSigner, true);

  const setAuthority = createSetAuthorityInstruction(
    destination,
    authority,
    AuthorityType.AccountOwner,
    replacement,
  );
  assert.deepEqual(setAuthority.data, Buffer.concat([
    Buffer.from([6, 2, 1, 0, 0, 0]),
    replacement.toBuffer(),
  ]));
  assert.equal(setAuthority.keys[1].isSigner, true);
});

test("ATA derivation and creation use the canonical seed and account order", () => {
  const mint = key(5);
  const owner = Keypair.generate().publicKey;
  const payer = key(6);
  const expected = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
  const ata = getAssociatedTokenAddressSync(mint, owner);
  assert.ok(ata.equals(expected));

  const instruction = createAssociatedTokenAccountInstruction(payer, ata, owner, mint);
  assert.ok(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(instruction.data.length, 0);
  assert.deepEqual(instruction.keys.map(({ pubkey }) => pubkey.toBase58()), [
    payer,
    ata,
    owner,
    mint,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
  ].map((pubkey) => pubkey.toBase58()));
});

test("local encoders reject out-of-range fields and off-curve owners", () => {
  const mint = key(7);
  const authority = key(8);
  assert.throws(
    () => createInitializeMintInstruction(mint, 256, authority, null),
    /unsigned 8-bit/,
  );
  assert.throws(
    () => createMintToInstruction(mint, key(9), authority, -1n),
    /unsigned 64-bit/,
  );
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from("owner")], key(10))[0];
  assert.throws(() => getAssociatedTokenAddressSync(mint, offCurve), /on curve/);
  assert.doesNotThrow(() => getAssociatedTokenAddressSync(mint, offCurve, true));
});
