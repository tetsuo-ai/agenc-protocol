import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  ANCHOR_IDL_ACCOUNT_HEADER_BYTES,
  ANCHOR_IDL_DISCRIMINATOR,
  ANCHOR_IDL_MAX_SAFE_INIT_COMPRESSED_BYTES,
  assertFetchedOnChainIdlMatchesReviewed,
  decodeAnchorIdlAccount,
  deriveAnchorIdlAddress,
  planAnchorIdlStorage,
  prepareOnChainIdl,
} from "./anchor-idl-publication.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = Keypair.generate().publicKey;
const AUTHORITY = Keypair.generate().publicKey;
const REVIEWED = {
  address: PROGRAM_ID.toBase58(),
  metadata: { name: "test", version: "1.0.0" },
  instructions: [
    {
      name: "do_thing",
      docs: ["human prose"],
      accounts: [],
      args: [{ name: "value", type: "u64", docs: ["more prose"] }],
    },
  ],
  accounts: [],
  events: [],
  errors: [{ code: 6000, name: "Nope", msg: "kept" }],
  types: [],
};

function idlAccountData(prepared, overrides = {}) {
  const compressed = overrides.compressed ?? prepared.compressedBytes;
  const capacity = overrides.capacity ?? compressed.length + 20;
  const data = Buffer.alloc(ANCHOR_IDL_ACCOUNT_HEADER_BYTES + capacity);
  ANCHOR_IDL_DISCRIMINATOR.copy(data, 0);
  (overrides.authority ?? AUTHORITY).toBuffer().copy(data, 8);
  data.writeUInt32LE(overrides.dataLen ?? compressed.length, 40);
  compressed.copy(data, ANCHOR_IDL_ACCOUNT_HEADER_BYTES);
  return data;
}

test("on-chain projection strips only docs and remains exact-review verifiable", () => {
  const prepared = prepareOnChainIdl(REVIEWED);
  assert.equal(prepared.idl.instructions[0].docs, undefined);
  assert.equal(prepared.idl.instructions[0].args[0].docs, undefined);
  assert.equal(prepared.idl.errors[0].msg, "kept");
  assert.equal(
    assertFetchedOnChainIdlMatchesReviewed(REVIEWED, prepared.idl)
      .canonicalSha256,
    prepared.canonicalSha256,
  );
  assert.throws(
    () =>
      assertFetchedOnChainIdlMatchesReviewed(REVIEWED, {
        ...prepared.idl,
        errors: [{ ...prepared.idl.errors[0], msg: "changed" }],
      }),
    /fetched on-chain IDL digest .* != reviewed compact projection/,
  );
});

test("storage plan uses a conservative cross-implementation compression bound", () => {
  const existing = planAnchorIdlStorage({
    nodeCompressedBytes: 27_183,
    existingCapacity: 65_330,
  });
  assert.equal(existing.mode, "upgrade");
  assert.equal(existing.conservativeCompressedBytes, 54_366);
  assert.equal(existing.transientBufferRentBytes, 54_410);
  assert.throws(
    () =>
      planAnchorIdlStorage({
        nodeCompressedBytes: 32_666,
        existingCapacity: 65_330,
      }),
    /capacity 65330 is below.*65332-byte/,
  );

  const exactInitBoundary = Math.floor(
    ANCHOR_IDL_MAX_SAFE_INIT_COMPRESSED_BYTES / 2,
  );
  assert.equal(
    planAnchorIdlStorage({ nodeCompressedBytes: exactInitBoundary }).mode,
    "init",
  );
  assert.throws(
    () => planAnchorIdlStorage({ nodeCompressedBytes: exactInitBoundary + 1 }),
    /above Anchor 0\.32\.1's safe init capacity/,
  );
  assert.throws(
    () =>
      planAnchorIdlStorage({
        nodeCompressedBytes: 69_936,
        existingCapacity: 65_330,
      }),
    /capacity 65330 is below.*139872-byte/,
    "the full documented IDL must fail closed against the live account fixture",
  );
});

test("canonical Anchor IDL account is strictly decoded and authority-bound", async () => {
  const prepared = prepareOnChainIdl(REVIEWED);
  const address = await deriveAnchorIdlAddress(PROGRAM_ID);
  const decoded = await decodeAnchorIdlAccount(
    {
      data: idlAccountData(prepared),
      executable: false,
      owner: PROGRAM_ID,
    },
    address,
    { programId: PROGRAM_ID, expectedAuthority: AUTHORITY },
  );
  assert.equal(decoded.authority.toBase58(), AUTHORITY.toBase58());
  assert.deepEqual(decoded.idl, prepared.idl);
  assert.equal(decoded.dataLen, prepared.compressedBytes.length);

  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(
        {
          data: idlAccountData(prepared, {
            authority: Keypair.generate().publicKey,
          }),
          executable: false,
          owner: PROGRAM_ID,
        },
        address,
        { programId: PROGRAM_ID, expectedAuthority: AUTHORITY },
      ),
    /IDL authority .* != expected signer/,
  );
  const wrongDiscriminator = idlAccountData(prepared);
  wrongDiscriminator[0] ^= 0xff;
  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(
        { data: wrongDiscriminator, executable: false, owner: PROGRAM_ID },
        address,
        { programId: PROGRAM_ID },
      ),
    /discriminator mismatch/,
  );
  const oversized = idlAccountData(prepared);
  oversized.writeUInt32LE(oversized.length, 40);
  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(
        { data: oversized, executable: false, owner: PROGRAM_ID },
        address,
        { programId: PROGRAM_ID },
      ),
    /data_len .* exceeds capacity/,
  );
  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(
        {
          data: idlAccountData(prepared),
          executable: false,
          owner: PublicKey.default,
        },
        address,
        { programId: PROGRAM_ID },
      ),
    /IDL account owner .* != program/,
  );
});

test("incomplete canonical IDL uploads are resumable without relaxing identity checks", async () => {
  const prepared = prepareOnChainIdl(REVIEWED);
  const address = await deriveAnchorIdlAddress(PROGRAM_ID);
  const emptyData = idlAccountData(prepared, { dataLen: 0 });
  const account = {
    data: emptyData,
    executable: false,
    owner: PROGRAM_ID,
  };

  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(account, address, {
        programId: PROGRAM_ID,
        expectedAuthority: AUTHORITY,
      }),
    /contains no published data/,
  );
  const empty = await decodeAnchorIdlAccount(account, address, {
    programId: PROGRAM_ID,
    expectedAuthority: AUTHORITY,
    allowIncomplete: true,
  });
  assert.equal(empty.idl, null);
  assert.equal(empty.dataLen, 0);
  assert.match(empty.incompleteReason, /contains no published data/);

  const truncatedCompressed = prepared.compressedBytes.subarray(
    0,
    Math.max(1, Math.floor(prepared.compressedBytes.length / 2)),
  );
  const truncatedAccount = {
    data: idlAccountData(prepared, { compressed: truncatedCompressed }),
    executable: false,
    owner: PROGRAM_ID,
  };
  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(truncatedAccount, address, {
        programId: PROGRAM_ID,
        expectedAuthority: AUTHORITY,
      }),
    /compressed payload is invalid/,
  );
  const truncated = await decodeAnchorIdlAccount(truncatedAccount, address, {
    programId: PROGRAM_ID,
    expectedAuthority: AUTHORITY,
    allowIncomplete: true,
  });
  assert.equal(truncated.idl, null);
  assert.match(truncated.incompleteReason, /compressed payload is invalid/);

  const wrongAuthority = {
    data: idlAccountData(prepared, {
      dataLen: 0,
      authority: Keypair.generate().publicKey,
    }),
    executable: false,
    owner: PROGRAM_ID,
  };
  await assert.rejects(
    () =>
      decodeAnchorIdlAccount(wrongAuthority, address, {
        programId: PROGRAM_ID,
        expectedAuthority: AUTHORITY,
        allowIncomplete: true,
      }),
    /IDL authority .* != expected signer/,
  );
});
