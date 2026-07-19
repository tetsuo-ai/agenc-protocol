import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

// The integration suite needs only this fixed subset of the immutable legacy
// SPL Token wire format. Keeping the encoders local avoids pulling extension
// metadata packages (and their native bigint dependency) into deployment and
// operator tooling merely to create test fixtures.
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const MINT_SIZE = 82;
export const ACCOUNT_SIZE = 165;

export const AuthorityType = Object.freeze({
  MintTokens: 0,
  FreezeAccount: 1,
  AccountOwner: 2,
  CloseAccount: 3,
});

function requirePublicKey(value, name) {
  if (!(value instanceof PublicKey)) {
    throw new TypeError(`${name} must be a PublicKey`);
  }
  return value;
}

function requireU8(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an unsigned 8-bit integer`);
  }
  return value;
}

function requireU64(value, name) {
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${name} must be an unsigned 64-bit integer`);
  }
  return normalized;
}

function cOptionPublicKey(value) {
  const data = Buffer.alloc(value === null ? 4 : 36);
  data.writeUInt32LE(value === null ? 0 : 1, 0);
  if (value !== null) {
    requirePublicKey(value, "optional authority").toBuffer().copy(data, 4);
  }
  return data;
}

function authorityKeys(authority, multiSigners) {
  requirePublicKey(authority, "authority");
  if (!Array.isArray(multiSigners)) {
    throw new TypeError("multiSigners must be an array");
  }
  if (multiSigners.length === 0) {
    return [{ pubkey: authority, isSigner: true, isWritable: false }];
  }
  return [
    { pubkey: authority, isSigner: false, isWritable: false },
    ...multiSigners.map((signer) => ({
      pubkey: requirePublicKey(
        signer instanceof PublicKey ? signer : signer?.publicKey,
        "multisig signer",
      ),
      isSigner: true,
      isWritable: false,
    })),
  ];
}

export function createInitializeMintInstruction(
  mint,
  decimals,
  mintAuthority,
  freezeAuthority,
  programId = TOKEN_PROGRAM_ID,
) {
  requirePublicKey(mint, "mint");
  requirePublicKey(mintAuthority, "mintAuthority");
  requirePublicKey(programId, "programId");
  const data = Buffer.concat([
    Buffer.from([0, requireU8(decimals, "decimals")]),
    mintAuthority.toBuffer(),
    cOptionPublicKey(freezeAuthority),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function createInitializeAccountInstruction(
  account,
  mint,
  owner,
  programId = TOKEN_PROGRAM_ID,
) {
  requirePublicKey(account, "account");
  requirePublicKey(mint, "mint");
  requirePublicKey(owner, "owner");
  requirePublicKey(programId, "programId");
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function createMintToInstruction(
  mint,
  destination,
  authority,
  amount,
  multiSigners = [],
  programId = TOKEN_PROGRAM_ID,
) {
  requirePublicKey(mint, "mint");
  requirePublicKey(destination, "destination");
  requirePublicKey(programId, "programId");
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(requireU64(amount, "amount"), 1);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      ...authorityKeys(authority, multiSigners),
    ],
    data,
  });
}

export function createSetAuthorityInstruction(
  account,
  currentAuthority,
  authorityType,
  newAuthority,
  multiSigners = [],
  programId = TOKEN_PROGRAM_ID,
) {
  requirePublicKey(account, "account");
  requirePublicKey(programId, "programId");
  const data = Buffer.concat([
    Buffer.from([6, requireU8(authorityType, "authorityType")]),
    cOptionPublicKey(newAuthority),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      ...authorityKeys(currentAuthority, multiSigners),
    ],
    data,
  });
}

export function getAssociatedTokenAddressSync(
  mint,
  owner,
  allowOwnerOffCurve = false,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID,
) {
  requirePublicKey(mint, "mint");
  requirePublicKey(owner, "owner");
  requirePublicKey(programId, "programId");
  requirePublicKey(associatedTokenProgramId, "associatedTokenProgramId");
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new TypeError("owner must be on curve unless allowOwnerOffCurve is true");
  }
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  )[0];
}

export function createAssociatedTokenAccountInstruction(
  payer,
  associatedToken,
  owner,
  mint,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID,
) {
  for (const [name, value] of Object.entries({
    payer,
    associatedToken,
    owner,
    mint,
    programId,
    associatedTokenProgramId,
  })) {
    requirePublicKey(value, name);
  }
  return new TransactionInstruction({
    programId: associatedTokenProgramId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}
