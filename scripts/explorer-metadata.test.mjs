import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  getBufferEncoder,
  getMetadataEncoder,
  Compression,
  DataSource,
  Encoding,
  Format,
} from "@solana-program/program-metadata";
import { address } from "@solana/kit";
import {
  assertDeployedRevision,
  assertSecurityBuffer,
  buildVerifyPdaExportArgs,
  canonicalSecurityAddress,
  decodeCanonicalSecurity,
  defaultSecurityJsonPath,
  normalizedHash,
  OTTER_ID,
  PMP_ID,
  PROGRAM_ID,
  PROGRAM_DATA,
  PVR_CONTACT,
  renderOperatorCard,
  REPO_URL,
  REVISION_5_COMMIT,
  REVISION_5_SLOT,
  sha256,
  UPGRADE_AUTHORITY_VAULT,
  validateOsecStatus,
  validateSecurityJson,
  parseSecurityJson,
  validateVerifierExport,
  REVISION_5_NORMALIZED_SHA256,
} from "./explorer-metadata.mjs";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const raw = readFileSync(defaultSecurityJsonPath()),
  doc = JSON.parse(raw);
const now = new Date("2026-10-19T00:00:00Z");
const info = (data) => ({
  owner: new PublicKey(PMP_ID),
  executable: false,
  data: Buffer.from(data),
  lamports: 10,
});
const metadata = (change = {}) =>
  info(
    getMetadataEncoder().encode({
      program: address(PROGRAM_ID),
      authority: address(UPGRADE_AUTHORITY_VAULT),
      mutable: true,
      canonical: true,
      seed: "security",
      encoding: Encoding.Utf8,
      compression: Compression.None,
      format: Format.Json,
      dataSource: DataSource.Direct,
      dataLength: raw.length,
      data: raw,
      ...change,
    }),
  );
const buffer = (change = {}) =>
  info(
    getBufferEncoder().encode({
      program: null,
      authority: address(UPGRADE_AUTHORITY_VAULT),
      canonical: false,
      seed: "",
      data: raw,
      ...change,
    }),
  );

test("metadata binds the deployed commit and only the confirmed contact, with a real expiry", () => {
  assert.equal(
    validateSecurityJson(doc, now).source_revision,
    REVISION_5_COMMIT,
  );
  assert.deepEqual(doc.contacts, [PVR_CONTACT]);
  for (const change of [
    { source_revision: "main" },
    { source_release: "revision-7" },
    { version: 7 },
    { contacts: [PVR_CONTACT, "email:security@agenc.tech"] },
    { contacts: [] },
    { expiry: "2027-02-30" },
    { expiry: "2026-01-01" },
    { expiry: 2027 },
    { logo: "http://example.com/logo" },
    { preferred_languages: "en" },
    { description: "" },
  ])
    assert.throws(() => validateSecurityJson({ ...doc, ...change }, now));
  assert.throws(
    () => validateSecurityJson(doc, new Date("2027-07-18T00:00:00Z")),
    /expired/,
  );
  assert.throws(() => parseSecurityJson("[]"));
  assert.throws(() => parseSecurityJson("null"));
  assert.throws(() => parseSecurityJson(" ".repeat(8193)));
});
test("canonical metadata validates owner, PDA derivation, authority and exact direct bytes", () => {
  assert.equal(
    canonicalSecurityAddress().toBase58(),
    "HBXBGVW5tv59KdM5wLC7ZtTanHts3RP33WZvmj9BW8uw",
  );
  assert.deepEqual(decodeCanonicalSecurity(null), {
    present: false,
    matches: false,
  });
  assert.equal(decodeCanonicalSecurity(metadata(), { raw }).matches, true);
  assert.equal(
    decodeCanonicalSecurity(metadata({ authority: null }), { raw }).matches,
    true,
  );
  assert.equal(
    decodeCanonicalSecurity(metadata(), { raw: Buffer.from("{}") }).matches,
    false,
  );
  for (const change of [
    { canonical: false },
    { program: address(SystemProgram.programId.toBase58()) },
    { seed: "idl" },
    { mutable: false },
    { authority: address(PROGRAM_ID) },
    { dataLength: 1 },
    { dataSource: DataSource.Url },
    { compression: Compression.Zlib },
    { encoding: Encoding.Base64 },
  ])
    assert.throws(() => decodeCanonicalSecurity(metadata(change), { raw }));
  assert.throws(
    () =>
      decodeCanonicalSecurity({
        ...metadata(),
        owner: SystemProgram.programId,
      }),
    /owner/,
  );
  assert.throws(
    () => decodeCanonicalSecurity({ ...metadata(), data: Buffer.alloc(95) }),
    /length/,
  );
});
test("buffer check rejects a different owner, authority, payload, discriminator and PDA shape", () => {
  assert.doesNotThrow(() =>
    assertSecurityBuffer(buffer(), UPGRADE_AUTHORITY_VAULT, raw),
  );
  for (const change of [
    { program: address(PROGRAM_ID) },
    { authority: address(PROGRAM_ID) },
    { canonical: true },
    { seed: "security" },
    { data: Buffer.from("x".repeat(raw.length)) },
  ])
    assert.throws(() =>
      assertSecurityBuffer(buffer(change), UPGRADE_AUTHORITY_VAULT, raw),
    );
  assert.throws(() =>
    assertSecurityBuffer(metadata(), UPGRADE_AUTHORITY_VAULT, raw),
  );
  assert.throws(() => assertSecurityBuffer(null, UPGRADE_AUTHORITY_VAULT, raw));
  assert.throws(() =>
    assertSecurityBuffer(
      { ...buffer(), owner: SystemProgram.programId },
      UPGRADE_AUTHORITY_VAULT,
      raw,
    ),
  );
});
test("live revision guard rejects stale source, authority, slot and binary claims", () => {
  const s = {
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    authority: UPGRADE_AUTHORITY_VAULT,
    programDataSlot: REVISION_5_SLOT,
    payload: Buffer.from("changed"),
  };
  for (const change of [
    {},
    { programId: PMP_ID },
    { programData: PMP_ID },
    { authority: PROGRAM_ID },
    { programDataSlot: "434489453" },
  ])
    assert.throws(() => assertDeployedRevision({ ...s, ...change }));
  assert.equal(
    normalizedHash(Buffer.from([1, 2, 0, 0])),
    sha256(Buffer.from([1, 2])),
  );
});
test("OtterSec acceptance requires matching current commit, repository, both hashes and open program", () => {
  const s = {
    is_verified: true,
    commit: REVISION_5_COMMIT,
    repo_url: `${REPO_URL}/tree/${REVISION_5_COMMIT}`,
    on_chain_hash: REVISION_5_NORMALIZED_SHA256,
    executable_hash: REVISION_5_NORMALIZED_SHA256,
    is_closed: false,
  };
  assert.equal(validateOsecStatus(s), true);
  for (const change of [
    { is_verified: false },
    { commit: "097ded1" },
    { repo_url: "https://example.com" },
    { on_chain_hash: "wrong" },
    { executable_hash: "wrong" },
    { is_closed: true },
  ])
    assert.equal(validateOsecStatus({ ...s, ...change }), false);
});
function verifierTransaction() {
  const string = (s) => {
    const bytes = Buffer.from(s),
      size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(4);
  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(BigInt(REVISION_5_SLOT));
  const data = Buffer.concat([
    Buffer.from([219, 200, 88, 176, 158, 63, 253, 127]),
    string("0.5.2"),
    string(REPO_URL),
    string(REVISION_5_COMMIT),
    count,
    ...[
      "--mount-path",
      "programs/agenc-coordination",
      "--library-name",
      "agenc_coordination",
    ].map(string),
    slot,
  ]);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("otter_verify"),
      new PublicKey(UPGRADE_AUTHORITY_VAULT).toBuffer(),
      new PublicKey(PROGRAM_ID).toBuffer(),
    ],
    new PublicKey(OTTER_ID),
  );
  return new Transaction({
    feePayer: new PublicKey(UPGRADE_AUTHORITY_VAULT),
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(OTTER_ID),
      data,
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        {
          pubkey: new PublicKey(UPGRADE_AUTHORITY_VAULT),
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: new PublicKey(PROGRAM_ID),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  );
}
const encode = (tx) =>
  tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
test("verifier export is decoded completely; wrong wire arguments, extra instructions and surplus data fail", () => {
  assert.equal(
    validateVerifierExport(encode(verifierTransaction())).verificationPda,
    "CVV2Lu42qvCm8PrkzQYaKeHYSvAUjvRc6jBTawtuPfWQ",
  );
  for (const mutate of [
    (tx) => {
      tx.instructions[0].data[0] = 98;
    },
    (tx) => {
      tx.instructions[0].data = Buffer.concat([
        tx.instructions[0].data,
        Buffer.from([0]),
      ]);
    },
    (tx) => {
      tx.instructions[0].data[20] ^= 1;
    },
    (tx) => {
      tx.instructions[0].keys[0].pubkey = new PublicKey(PROGRAM_ID);
    },
    (tx) => {
      tx.instructions.push(tx.instructions[0]);
    },
  ]) {
    const tx = verifierTransaction();
    mutate(tx);
    assert.throws(() => validateVerifierExport(encode(tx)));
  }
  assert.throws(() =>
    validateVerifierExport(
      encode(verifierTransaction()) + "\n" + encode(verifierTransaction()),
    ),
  );
});
test("read-only entrypoint rejects the old apply/keypair and submit verbs before any RPC or process action", () => {
  for (const args of [
    ["export-security", "--apply"],
    ["export-security", "--keypair", "/tmp/must-not-read"],
    ["submit-osec", "--apply"],
    ["unknown"],
  ])
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["scripts/explorer-metadata.mjs", ...args],
        { stdio: "pipe", timeout: 5000 },
      ),
    );
  assert.ok(buildVerifyPdaExportArgs().includes(REVISION_5_COMMIT));
  assert.ok(!renderOperatorCard().includes("@latest"));
  assert.match(renderOperatorCard(), /Preparation is read-only/);
});
