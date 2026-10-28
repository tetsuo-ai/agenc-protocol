#!/usr/bin/env node
// Read-only ceremony preparation. This entrypoint never loads keys, signs,
// broadcasts, or submits an external verification job.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { address, createNoopSigner, getBase58Decoder } from "@solana/kit";
import {
  AccountDiscriminator,
  Compression,
  DataSource,
  Encoding,
  Format,
  getAllocateInstruction,
  getBufferDecoder,
  getCloseInstruction,
  getInitializeInstruction,
  getMetadataDecoder,
  getWriteInstruction,
} from "@solana-program/program-metadata";
import {
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  loadReviewedUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
  UPGRADEABLE_LOADER_ID,
} from "./program-upgrade-authority-policy.mjs";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");
const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
export const PROGRAM_DATA = "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw";
export const UPGRADE_AUTHORITY_VAULT =
  "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf";
export const SQUADS_MULTISIG = "7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY";
export const REPO_URL = "https://github.com/tetsuo-ai/agenc-protocol";
// Revision 8, deployed 2026-10-28 by Squads proposal 11. The ProgramData keeps
// 227,712 bytes of headroom, so the live payload is the release ELF plus zeros.
export const RELEASE_COMMIT = "f39b383e416ec5bc511b0ffb781481a658d137d8";
export const RELEASE_ARTIFACT_SHA256 =
  "0b450dab8096b10c79bf5b8d8cf4a4a837cd8df69ea4cfaa09d68d9d2f16a44e";
export const RELEASE_PAYLOAD_SHA256 =
  "ed0e0f11239671b301813a06071c07791453d54f3c0969359a986a481cc505f9";
export const RELEASE_NORMALIZED_SHA256 =
  "ffb8f3cb4c7abd3ee92e9e2839cf0f6cf0bc6129addf00fb529c8ec4d3995b38";
export const RELEASE_SLOT = "462468899";
export const PMP_ID = "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S";
export const PMP_SHA256 =
  "3d0c0f7504c01b1f6996d30a5c3dc2cccb8b65dedba80d6fceb60a7cada093e0";
export const PMP_VERSION = "0.7.0"; // Last 0.x line compatible with this repo's Kit 6.9.
export const VERIFIER_SHA256 =
  "b9d5ccce9634dc14269cab3e7a58649bc141b3306e7735a94478c936341f211f";
export const OTTER_ID = "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC";
export const LIBRARY_NAME = "agenc_coordination";
export const MOUNT_PATH = "programs/agenc-coordination";
export const SECURITY_JSON_REL = "programs/agenc-coordination/security.json";
export const PVR_CONTACT = `link:${REPO_URL}/security/advisories/new`;
export const OSEC_STATUS_URL = `https://verify.osec.io/status/${PROGRAM_ID}`;
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const json = (value) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const defaultSecurityJsonPath = (root = ROOT) =>
  path.join(root, SECURITY_JSON_REL);
export function parseSecurityJson(raw) {
  ensure(
    Buffer.byteLength(raw) <= 8192,
    "security.json exceeds the reviewed single-CPI growth bound",
  );
  const doc = JSON.parse(raw);
  ensure(
    doc !== null && typeof doc === "object" && !Array.isArray(doc),
    "security.json must be an object",
  );
  return doc;
}
export function validateSecurityJson(doc, now = new Date()) {
  ensure(
    doc !== null && typeof doc === "object" && !Array.isArray(doc),
    "security.json must be an object",
  );
  const expected = {
    name: "AgenC Coordination",
    source_code: REPO_URL,
    source_revision: RELEASE_COMMIT,
    source_release: "revision-8",
    version: "8",
    policy: `${REPO_URL}/blob/main/SECURITY.md`,
    project_url: "https://agenc.ag",
  };
  for (const [key, value] of Object.entries(expected))
    ensure(doc[key] === value, `invalid ${key}`);
  ensure(
    typeof doc.description === "string" && doc.description.trim().length > 0,
    "description is required",
  );
  ensure(
    Array.isArray(doc.contacts) &&
      doc.contacts.length === 1 &&
      doc.contacts[0] === PVR_CONTACT,
    "contacts must contain only the confirmed PVR channel",
  );
  ensure(
    Array.isArray(doc.preferred_languages) &&
      doc.preferred_languages.join(",") === "en",
    "invalid preferred_languages",
  );
  for (const key of ["logo", "sdk", "acknowledgements"]) {
    ensure(
      typeof doc[key] === "string" && new URL(doc[key]).protocol === "https:",
      `invalid HTTPS ${key}`,
    );
  }
  ensure(
    typeof doc.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(doc.expiry),
    "expiry must be a UTC date",
  );
  const expiry = new Date(`${doc.expiry}T00:00:00Z`);
  ensure(
    Number.isFinite(now.getTime()) &&
      Number.isFinite(expiry.getTime()) &&
      expiry.toISOString().slice(0, 10) === doc.expiry,
    "invalid expiry date",
  );
  ensure(expiry > now, "security.json has expired");
  ensure(
    !JSON.stringify(doc).toLowerCase().includes("security@agenc.tech"),
    "unconfirmed mailbox",
  );
  ensure(
    Buffer.byteLength(JSON.stringify(doc)) <= 8192,
    "security.json too large",
  );
  return doc;
}
export function normalizedHash(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return sha256(bytes.subarray(0, end));
}
export function assertDeployedRevision(snapshot, artifact) {
  ensure(
    snapshot.programId === PROGRAM_ID && snapshot.programData === PROGRAM_DATA,
    "wrong program/ProgramData",
  );
  ensure(
    snapshot.authority === UPGRADE_AUTHORITY_VAULT,
    "upgrade authority changed",
  );
  ensure(
    String(snapshot.programDataSlot) === RELEASE_SLOT,
    "deployment slot changed; re-review the ceremony",
  );
  ensure(
    sha256(snapshot.payload) === RELEASE_PAYLOAD_SHA256 &&
      normalizedHash(snapshot.payload) === RELEASE_NORMALIZED_SHA256,
    "live executable differs from the reviewed revision-8 build",
  );
  if (artifact !== undefined)
    ensure(
      sha256(artifact) === RELEASE_ARTIFACT_SHA256 &&
        Buffer.from(artifact).equals(
          snapshot.payload.subarray(0, artifact.length),
        ) &&
        snapshot.payload.subarray(artifact.length).every((b) => b === 0),
      "rebuilt artifact does not match deployed revision 8 byte-for-byte",
    );
}
export function canonicalSecurityAddress(program = PROGRAM_ID) {
  const seed = Buffer.alloc(16);
  seed.write("security");
  return PublicKey.findProgramAddressSync(
    [new PublicKey(program).toBuffer(), seed],
    new PublicKey(PMP_ID),
  )[0];
}
export function decodeCanonicalSecurity(
  info,
  { program = PROGRAM_ID, authority = UPGRADE_AUTHORITY_VAULT, raw } = {},
) {
  if (info === null) return { present: false, matches: false };
  ensure(
    info.owner.toBase58() === PMP_ID && !info.executable,
    "invalid canonical metadata owner",
  );
  ensure(
    info.data.length >= 96 && info.data.length <= 96 + 8192,
    "invalid metadata length",
  );
  const m = getMetadataDecoder().decode(info.data);
  ensure(
    m.discriminator === AccountDiscriminator.Metadata &&
      m.program === program &&
      m.canonical &&
      m.seed === "security",
    "invalid canonical security header",
  );
  // Canonical initialization leaves authority=None: the program upgrade
  // authority retains control. An explicit delegation is accepted only to it.
  ensure(
    m.mutable &&
      (m.authority.__option === "None" || m.authority.value === authority),
    "metadata authority or mutability changed",
  );
  ensure(
    m.encoding === Encoding.Utf8 &&
      m.compression === Compression.None &&
      m.format === Format.Json &&
      m.dataSource === DataSource.Direct,
    "unexpected metadata representation; review instead of fetching external content",
  );
  ensure(m.dataLength === m.data.length, "metadata data-length mismatch");
  const content = Buffer.from(m.data);
  const doc = validateSecurityJson(
    parseSecurityJson(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    ),
  );
  return {
    present: true,
    matches: raw !== undefined && content.equals(Buffer.from(raw)),
    contentSha256: sha256(content),
    document: doc,
  };
}
export function assertSecurityBuffer(info, authority, raw) {
  ensure(
    info !== null && info.owner.toBase58() === PMP_ID && !info.executable,
    "invalid buffer owner or missing buffer",
  );
  ensure(
    info.data.length === 96 + raw.length,
    "buffer length differs from reviewed document",
  );
  const b = getBufferDecoder().decode(info.data);
  ensure(
    b.discriminator === AccountDiscriminator.Buffer &&
      !b.canonical &&
      b.program.__option === "None" &&
      b.seed === "",
    "not a standalone metadata buffer",
  );
  ensure(
    b.authority.__option === "Some" && b.authority.value === authority,
    "buffer must be handed to the reviewed vault",
  );
  ensure(
    Buffer.from(b.data).equals(Buffer.from(raw)),
    "buffer bytes differ from reviewed document",
  );
}
export function toWeb3Instruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    data: Buffer.from(ix.data),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: (a.role & 2) !== 0,
      isWritable: (a.role & 1) !== 0,
    })),
  });
}
export async function assertPmpExecutable(connection, minContextSlot) {
  const id = new PublicKey(PMP_ID),
    loader = new PublicKey(UPGRADEABLE_LOADER_ID);
  const [pd] = PublicKey.findProgramAddressSync([id.toBuffer()], loader);
  const r = await connection.getMultipleAccountsInfoAndContext([id, pd], {
    commitment: "confirmed",
    minContextSlot,
  });
  ensure(r.context.slot >= (minContextSlot ?? 0), "stale PMP snapshot");
  const program = decodeUpgradeableProgramAccount(r.value[0], loader);
  const data = decodeUpgradeableProgramDataAccount(r.value[1], loader);
  ensure(
    program.programDataAddress === pd.toBase58() &&
      sha256(data.payload) === PMP_SHA256,
    "PMP executable changed; review its implementation before exporting",
  );
  return {
    contextSlot: r.context.slot,
    programData: pd.toBase58(),
    executableSha256: PMP_SHA256,
  };
}
// Shared by the local RPC drill and mainnet preparation. It only reads RPC and
// creates a zero-signature legacy transaction. The caller independently binds
// cluster, source artifact, and custody before using it for a live ceremony.
export async function buildCanonicalSecurityTransaction(
  connection,
  {
    program = PROGRAM_ID,
    authority = UPGRADE_AUTHORITY_VAULT,
    buffer,
    rentReturn,
    raw,
    minContextSlot = 0,
  },
) {
  raw = Buffer.from(raw);
  validateSecurityJson(parseSecurityJson(raw.toString("utf8")));
  const programKey = new PublicKey(program),
    signer = createNoopSigner(address(authority));
  const loader = new PublicKey(UPGRADEABLE_LOADER_ID);
  const [pd] = PublicKey.findProgramAddressSync(
    [programKey.toBuffer()],
    loader,
  );
  const metadata = canonicalSecurityAddress(program),
    bufferKey = new PublicKey(buffer),
    recipient = new PublicKey(rentReturn);
  ensure(
    !recipient.equals(bufferKey) &&
      !recipient.equals(metadata) &&
      !recipient.equals(programKey) &&
      !recipient.equals(pd),
    "invalid rent-return destination",
  );
  const r = await connection.getMultipleAccountsInfoAndContext(
    [programKey, pd, bufferKey, metadata],
    { commitment: "confirmed", minContextSlot },
  );
  ensure(r.context.slot >= minContextSlot, "stale security export snapshot");
  const programState = decodeUpgradeableProgramAccount(r.value[0], loader);
  const programDataState = decodeUpgradeableProgramDataAccount(
    r.value[1],
    loader,
  );
  ensure(
    programState.programDataAddress === pd.toBase58() &&
      programDataState.authority === authority,
    "program upgrade authority changed",
  );
  assertSecurityBuffer(r.value[2], authority, raw);
  const existing = r.value[3];
  ensure(
    existing === null ||
      (existing.owner.equals(SystemProgram.programId) &&
        existing.data.length === 0 &&
        !existing.executable),
    "canonical security already exists; check status and review updates separately",
  );
  const rent = await connection.getMinimumBalanceForRentExemption(
    96 + raw.length,
  );
  const rentTopUp = Math.max(0, rent - (existing?.lamports ?? 0));
  const common = {
    authority: signer,
    program: address(program),
    programData: address(pd.toBase58()),
  };
  const instructions = [
    ...(rentTopUp
      ? [
          SystemProgram.transfer({
            fromPubkey: new PublicKey(authority),
            toPubkey: metadata,
            lamports: rentTopUp,
          }),
        ]
      : []),
    toWeb3Instruction(
      getAllocateInstruction({
        ...common,
        buffer: address(metadata.toBase58()),
        seed: "security",
      }),
    ),
    toWeb3Instruction(
      getWriteInstruction({
        buffer: address(metadata.toBase58()),
        authority: signer,
        sourceBuffer: address(buffer),
        offset: 0,
      }),
    ),
    toWeb3Instruction(
      getInitializeInstruction({
        ...common,
        metadata: address(metadata.toBase58()),
        seed: "security",
        encoding: Encoding.Utf8,
        compression: Compression.None,
        format: Format.Json,
        dataSource: DataSource.Direct,
        system: address(PMP_ID),
      }),
    ),
    toWeb3Instruction(
      getCloseInstruction({
        account: address(buffer),
        authority: signer,
        destination: address(rentReturn),
      }),
    ),
  ];
  const lifetime = await connection.getLatestBlockhash({
    commitment: "confirmed",
    minContextSlot: r.context.slot,
  });
  const transaction = new Transaction({
    feePayer: new PublicKey(authority),
    ...lifetime,
  }).add(...instructions);
  const bytes = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return {
    transaction,
    packet: {
      schemaVersion: 1,
      kind: "canonical-security-create",
      generatedAt: new Date().toISOString(),
      contextSlot: r.context.slot,
      program,
      programData: pd.toBase58(),
      authority,
      metadata: metadata.toBase58(),
      buffer,
      rentReturn,
      securitySha256: sha256(raw),
      bufferAccountSha256: sha256(r.value[2].data),
      rentTopUp,
      ...lifetime,
      encoding: "base58",
      unsignedTransaction: getBase58Decoder().decode(bytes),
      instructions: instructions.map((ix) => ({
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({
          address: k.pubkey.toBase58(),
          signer: k.isSigner,
          writable: k.isWritable,
        })),
        dataBase64: ix.data.toString("base64"),
      })),
      notice:
        "Unsigned proposal input. Re-run preflight before each approval/execution; stored Squads proposals do not inherit this blockhash lifetime.",
    },
  };
}
export function buildVerifyPdaExportArgs({
  rpc = DEFAULT_RPC,
  authority = UPGRADE_AUTHORITY_VAULT,
} = {}) {
  return [
    "export-pda-tx",
    REPO_URL,
    "--program-id",
    PROGRAM_ID,
    "--uploader",
    authority,
    "--commit-hash",
    RELEASE_COMMIT,
    "--library-name",
    LIBRARY_NAME,
    "--mount-path",
    MOUNT_PATH,
    "--encoding",
    "base64",
    "--compute-unit-price",
    "0",
    "-u",
    rpc,
  ];
}
export function buildSubmitOsecArgs() {
  return [
    "remote",
    "submit-job",
    "--program-id",
    PROGRAM_ID,
    "--uploader",
    UPGRADE_AUTHORITY_VAULT,
  ];
}
export function validateOsecStatus(status) {
  return (
    status?.is_verified === true &&
    status.commit === RELEASE_COMMIT &&
    status.on_chain_hash === RELEASE_NORMALIZED_SHA256 &&
    status.executable_hash === RELEASE_NORMALIZED_SHA256 &&
    status.repo_url === `${REPO_URL}/tree/${RELEASE_COMMIT}` &&
    status.is_closed === false
  );
}
export function validateVerifierExport(
  stdout,
  { authority = UPGRADE_AUTHORITY_VAULT, deployedSlot = RELEASE_SLOT } = {},
) {
  const candidates = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(s));
  ensure(candidates.length === 1, "expected exactly one verifier transaction");
  const tx = Transaction.from(Buffer.from(candidates[0], "base64"));
  ensure(
    tx.feePayer?.toBase58() === authority &&
      tx.signatures.length === 1 &&
      tx.signatures[0].signature === null,
    "unexpected verifier signer or signature",
  );
  ensure(
    tx.instructions.length === 1 &&
      tx.instructions[0].programId.toBase58() === OTTER_ID,
    "unexpected verifier instructions",
  );
  const ix = tx.instructions[0];
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("otter_verify"),
      new PublicKey(authority).toBuffer(),
      new PublicKey(PROGRAM_ID).toBuffer(),
    ],
    new PublicKey(OTTER_ID),
  );
  const expectedKeys = [
    [pda.toBase58(), false, true],
    [authority, true, true],
    [PROGRAM_ID, false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ];
  ensure(
    JSON.stringify(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    ) === JSON.stringify(expectedKeys),
    "wrong verification PDA, accounts or permissions",
  );
  ensure(
    [
      [175, 175, 109, 31, 13, 152, 155, 237],
      [219, 200, 88, 176, 158, 63, 253, 127],
    ].some((d) => Buffer.from(d).equals(ix.data.subarray(0, 8))),
    "unexpected verification instruction",
  );
  let offset = 8;
  const string = () => {
    ensure(offset + 4 <= ix.data.length, "truncated verifier parameters");
    const length = ix.data.readUInt32LE(offset);
    offset += 4;
    ensure(
      length <= 1024 && offset + length <= ix.data.length,
      "invalid verifier string length",
    );
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      ix.data.subarray(offset, offset + length),
    );
    offset += length;
    return value;
  };
  ensure(
    string() === "0.5.2" &&
      string() === REPO_URL &&
      string() === RELEASE_COMMIT,
    "wrong verifier version, repository or commit",
  );
  ensure(
    offset + 4 <= ix.data.length && ix.data.readUInt32LE(offset) === 4,
    "unexpected verification build arguments",
  );
  offset += 4;
  const args = [string(), string(), string(), string()];
  ensure(
    JSON.stringify(args) ===
      JSON.stringify([
        "--mount-path",
        MOUNT_PATH,
        "--library-name",
        LIBRARY_NAME,
      ]),
    "unexpected verification build arguments",
  );
  ensure(
    offset + 8 === ix.data.length &&
      ix.data.readBigUInt64LE(offset).toString() === String(deployedSlot),
    "wrong deployed slot or surplus verifier data",
  );
  return {
    encoding: "base58",
    unsignedTransaction: getBase58Decoder().decode(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ),
    verificationPda: pda.toBase58(),
  };
}
const shell = (x) => `'${String(x).replaceAll("'", "'\\''")}'`;
export function renderOperatorCard({ rpc = DEFAULT_RPC } = {}) {
  const cli = "node node_modules/@solana-program/program-metadata/bin/cli.cjs";
  return [
    `Explorer metadata for ${PROGRAM_ID}; deployed revision 8 at ${RELEASE_COMMIT}.`,
    "Preparation is read-only. Operator approvals, buffer funding/handoff, Squads execution and OtterSec submission are separate runbook gates.",
    "npm ci && npm ci --prefix tests-integration",
    "node scripts/explorer-metadata.mjs preflight --artifact <REBUILT_REV8_SO>",
    "After explicit authorization, use a disposable funded operator (never export its secret):",
    `${cli} create-buffer ${SECURITY_JSON_REL} --compression none --format json --rpc ${shell(rpc)} --keypair <OPERATOR_KEYPAIR>`,
    `${cli} set-buffer-authority <BUFFER> --new-authority ${UPGRADE_AUTHORITY_VAULT} --rpc ${shell(rpc)} --keypair <OPERATOR_KEYPAIR>`,
    "Read and compare the exact buffer, then export unsigned proposal inputs:",
    "node scripts/explorer-metadata.mjs export-security --artifact <REBUILT_REV8_SO> --buffer <BUFFER> --rent-return <OPERATOR_PUBLIC_KEY>",
    "node scripts/explorer-metadata.mjs export-verify-pda --artifact <REBUILT_REV8_SO> --verifier <PINNED_SOLANA_VERIFY_0.5.2>",
    "Review each instruction and re-run preflight before both Squads approvals/execution. See docs/EXPLORER_METADATA.md.",
    `After the verification PDA is confirmed and submission is approved: solana-verify ${buildSubmitOsecArgs().join(" ")}`,
    "node scripts/explorer-metadata.mjs status",
    "Acceptance: canonical bytes match AND fresh OtterSec commit/repository/both hashes match. Explorer UI confirmation remains separate.",
  ].join("\n");
}
async function preflight(connection, artifact) {
  const policy = loadReviewedUpgradeAuthorityPolicy();
  ensure(
    (await connection.getGenesisHash()) === policy.genesisHash,
    "wrong cluster genesis",
  );
  const snapshot = await readProgramUpgradeAuthoritySnapshot(
    connection,
    policy,
  );
  assertDeployedRevision(snapshot, artifact);
  const pmp = await assertPmpExecutable(connection, snapshot.contextSlot);
  const { payload, ...publicSnapshot } = snapshot;
  return {
    snapshot,
    report: {
      observedAt: new Date().toISOString(),
      genesisHash: policy.genesisHash,
      ...publicSnapshot,
      sourceCommit: RELEASE_COMMIT,
      artifactSha256: sha256(payload),
      normalizedExecutableSha256: normalizedHash(payload),
      pmp,
    },
  };
}
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      rpc: { type: "string" },
      artifact: { type: "string" },
      buffer: { type: "string" },
      "rent-return": { type: "string" },
      verifier: { type: "string" },
    },
  });
  ensure(positionals.length <= 1, "expected one command");
  const command = positionals[0] ?? "print";
  ensure(
    [
      "print",
      "check",
      "status",
      "preflight",
      "export-security",
      "export-verify-pda",
    ].includes(command),
    `unknown command ${command}`,
  );
  const raw = await readFile(defaultSecurityJsonPath());
  validateSecurityJson(parseSecurityJson(raw.toString("utf8")));
  if (command === "print") {
    console.log(renderOperatorCard({ rpc: values.rpc }));
    return;
  }
  if (command === "check") {
    console.log(`ok ${SECURITY_JSON_REL} sha256=${sha256(raw)}`);
    return;
  }
  const connection = new Connection(values.rpc ?? DEFAULT_RPC, "confirmed");
  const needsArtifact = command !== "status";
  if (needsArtifact)
    ensure(
      values.artifact,
      "--artifact is required: rebuild the exact deployed commit before preparing proposals",
    );
  const artifact = values.artifact
    ? await readFile(values.artifact)
    : undefined;
  const checked = await preflight(connection, artifact);
  if (command === "preflight") {
    console.log(json(checked.report));
    return;
  }
  if (command === "status") {
    const r = await connection.getAccountInfoAndContext(
      canonicalSecurityAddress(),
      { commitment: "confirmed", minContextSlot: checked.snapshot.contextSlot },
    );
    ensure(
      r.context.slot >= checked.snapshot.contextSlot,
      "stale canonical metadata snapshot",
    );
    const security = decodeCanonicalSecurity(r.value, { raw });
    const response = await fetch(OSEC_STATUS_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    ensure(response.ok, `OtterSec HTTP ${response.status}`);
    const osec = await response.json();
    console.log(
      json({
        ...checked.report,
        security,
        osec,
        acceptanceMet: security.matches && validateOsecStatus(osec),
      }),
    );
    return;
  }
  let packet;
  if (command === "export-security") {
    ensure(
      values.buffer && values["rent-return"],
      "--buffer and --rent-return public addresses are required",
    );
    ({ packet } = await buildCanonicalSecurityTransaction(connection, {
      buffer: values.buffer,
      rentReturn: values["rent-return"],
      raw,
      minContextSlot: checked.snapshot.contextSlot,
    }));
  } else {
    ensure(
      values.verifier,
      "--verifier must name the checksum-pinned solana-verify 0.5.2 binary",
    );
    ensure(
      sha256(await readFile(values.verifier)) === VERIFIER_SHA256,
      "unreviewed verifier executable",
    );
    const scratch = await mkdtemp(
      path.join(os.tmpdir(), "agenc-verifier-export-"),
    );
    try {
      const { stdout } = await execFile(
        path.resolve(values.verifier),
        buildVerifyPdaExportArgs({ rpc: values.rpc }),
        { cwd: scratch, maxBuffer: 2 * 1024 * 1024, timeout: 180000 },
      );
      packet = {
        schemaVersion: 1,
        kind: "revision-8-verification-pda",
        ...validateVerifierExport(stdout),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  const fresh = await readProgramUpgradeAuthoritySnapshot(
    connection,
    loadReviewedUpgradeAuthorityPolicy(),
    { minContextSlot: checked.snapshot.contextSlot },
  );
  ensure(
    fresh.stateDigest === checked.snapshot.stateDigest,
    "loader/custody changed during export; discard and repeat",
  );
  await assertPmpExecutable(connection, fresh.contextSlot);
  console.log(json({ ...packet, preflight: checked.report }));
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
