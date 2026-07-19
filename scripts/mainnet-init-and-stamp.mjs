#!/usr/bin/env node
// Mainnet full-surface config init + final surface_revision stamp.
//
// Runs, IN ORDER, AFTER the binary deploy (step 1) and the migrate sweep (steps 2–3):
//   4. initialize_bid_marketplace   (creates BidMarketplaceConfig) — MULTISIG-gated
//   4. ZK activation                DISABLED/DEFERRED — never initializes or rotates ZkConfig
//   4. configure_task_moderation     (verify/realign ModerationConfig authority) — single authority
//   5. publish + fetch-verify the reviewed compact on-chain IDL (parent orchestrator)
//   6. stamp_release_surface         (atomic surface_revision = CURRENT boundary) — MULTISIG-gated  [LAST]
//
// The parent invokes this child once with SKIP_STAMP for singleton initialization, publishes
// and verifies the IDL, then invokes it again with singleton mutations skipped for the final
// stamp. Advertising the full surface before configs, migrations, and IDL are complete would
// point clients at an incomplete release.
//
// SAFE BY DEFAULT: PLAN unless you pass --execute. PLAN is read-only — it decodes the
// live ProtocolConfig + each target account and RPC-simulates every pending mutation with
// real signer/account metas, but commits nothing. It refuses unexpected live state.
//
// KEY HANDLING: this script reads only explicitly supplied plaintext keypair files for
// signing, never logs or embeds their secret bytes, and refuses encrypted *.vault.json
// objects. Pass plain keypair JSON paths (or adapt the rail to your signer); the human
// owns and supplies the keys.
//
// The binary deploy and on-chain IDL publish are parent-orchestrator CLI phases —
// see the runbook; they are NOT done here.
//
// USAGE (resolves deps from tests-integration/node_modules):
//   RPC_URL=https://your-mainnet-rpc \
//   AUTHORITY_KEYPAIR=/path/to/protocol-authority.json \          # = ProtocolConfig.authority
//   COSIGNERS=/path/multisig-second.json,/path/multisig-third.json \  # in-program multisig co-signers (M-1 of them)
//   [MODERATION_AUTHORITY=<pubkey>] \   # only if you intend to (re)set the moderation attestor
//   [SKIP_BID_MARKETPLACE=1] [SKIP_MODERATION=1] [SKIP_STAMP=1] \
//   [RUN_STAMP=1] [FORCE_STAMP=1] \  # parent-only stamp phase; FORCE requires RUN
//   # Each skipped singleton requires the EXPECTED_* snapshot emitted by
//   # mainnet-upgrade.mjs; direct skip-and-stamp invocations fail closed without it.
//   [DISABLED_TASK_TYPE_MASK=0] \   # stamp override: 0..15, set bit = DISABLED task type
//                                   # (1=Exclusive 2=Collaborative 4=Competitive 8=BidExclusive).
//                                   # 0 = enable ALL task types; UNSET = preserve the live mask.
//   IDL_PATH=target/idl/agenc_coordination.json \
//   EXPECTED_IDL_SHA256=<reviewed 64-hex digest> \  # REQUIRED; fail-closed artifact binding
//   SO_PATH=programs/agenc-coordination/target/deploy/agenc_coordination.so \
//   EXPECTED_SO_SHA256=<reviewed 64-hex digest> \    # REQUIRED; exact live executable binding
//   EXPECTED_PROTOCOL_CONFIG_SHA256=<reviewed live account-data digest> \
//   EXPECTED_MODERATION_MIN_UPDATED_AT=<reviewed chain timestamp floor> \
//   [BID_MIN_BOND_LAMPORTS=...] [BID_CREATION_COOLDOWN_SECS=...] [BID_MAX_PER_24H=...] \
//   [BID_MAX_ACTIVE_PER_TASK=...] [BID_MAX_LIFETIME_SECS=...] [BID_NOSHOW_SLASH_BPS=...] \
//   node scripts/mainnet-init-and-stamp.mjs [--execute]
//
//   --execute   actually send the transactions (otherwise dry-run/plan only)
//
// REQUIRES the deployed binary to be the FULL surface. Run AFTER step 1. ZK_IMAGE_ID_HEX
// and PRIVATE_TASKS_READY are forbidden for this release: no audited guest or mainnet
// verifier deployment exists, and the on-chain activation handlers fail closed.

import { createRequire } from "module";
import { createHash } from "node:crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { assertPrivateTaskReleaseDisabled } from "./private-task-release-policy.mjs";
import {
  assertApprovedExecutableSnapshot,
  assertImmediatePreUpgradeSnapshot,
  loadReviewedUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
} from "./program-upgrade-authority-policy.mjs";
import {
  accountDataSha256,
  assertModerationFreshForStamp,
  canonicalSha256,
  resolveStampMode,
  sha256DigestBytes,
  simulateNonBroadcastableInstructions,
} from "./mainnet-release-boundary.mjs";
import {
  assertFetchedOnChainIdlMatchesReviewed,
  decodeAnchorIdlAccount,
  deriveAnchorIdlAddress,
} from "./anchor-idl-publication.mjs";
import {
  decodeBidMarketplaceConfigAccount,
  decodeModerationConfigAccount,
  reviewedBidEconomicsFromEnv,
  reviewedModerationPolicyFromEnv,
  validateBidMarketplaceEconomics,
} from "./mainnet-upgrade.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  path.join(ROOT, "tests-integration", "package.json"),
);
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");

const PROGRAM_ID_STR = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
if (process.env.PROGRAM_ID && process.env.PROGRAM_ID !== PROGRAM_ID_STR) {
  die(
    `PROGRAM_ID overrides are forbidden: this mainnet rail is pinned to ${PROGRAM_ID_STR}.`,
  );
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SYSVAR_OWNER = new PublicKey(
  "Sysvar1111111111111111111111111111111111111",
);
const RPC_URL = process.env.RPC_URL;
for (const arg of process.argv.slice(2)) {
  if (arg !== "--execute") {
    die(`unknown argument '${arg}'; only --execute is supported.`);
  }
}
const EXECUTE = process.argv.includes("--execute");

// Mirrors ProtocolConfig::SURFACE_REVISION_CURRENT (state.rs).
const SURFACE_REVISION_CURRENT = 5;
// Allowed task-type bits (state.rs ProtocolConfig::TASK_TYPE_DISABLE_MASK = 0b0000_1111).
const TASK_TYPE_DISABLE_MASK = 0b0000_1111;

function redactRpc(value) {
  return String(value).replace(
    /(?:https?|wss?):\/\/[^\s"']+/gi,
    "<redacted-rpc>",
  );
}
function die(msg) {
  console.error(`ERROR: ${redactRpc(msg)}`);
  process.exit(1);
}
function loadKeypair(p) {
  const filePath = p.replace(/^~(?=$|\/)/, process.env.HOME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    die(
      `cannot read keypair ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    die(
      `keypair ${filePath} must be a plain 64-byte JSON array; encrypted vault/object inputs are refused.`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}
function envOrDie(name) {
  const v = process.env[name];
  if (!v) die(`${name} is required.`);
  return v;
}

if (!RPC_URL) die("RPC_URL is required (a mainnet RPC).");
if (!process.env.AUTHORITY_KEYPAIR)
  die("AUTHORITY_KEYPAIR is required (must equal ProtocolConfig.authority).");
try {
  assertPrivateTaskReleaseDisabled({
    zkImageId: process.env.ZK_IMAGE_ID_HEX,
    privateTasksReady: process.env.PRIVATE_TASKS_READY === "1",
  });
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
let stampMode;
try {
  stampMode = resolveStampMode(process.env);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
if (
  stampMode.runStamp &&
  (process.env.SKIP_BID_MARKETPLACE !== "1" ||
    process.env.SKIP_MODERATION !== "1")
) {
  die(
    "RUN_STAMP=1 is a stamp-only phase and requires SKIP_BID_MARKETPLACE=1 and SKIP_MODERATION=1.",
  );
}

// Signing material is deliberately loaded only after local IDL/SBF approval and
// the live mainnet loader/custody/executable boundary all pass.
let authority;
let signerKps;
let signerMetas;
let program;
let approvedLoaderSnapshot;
let genesisHash;
let idlAddress;

// Parse the OPTIONAL DISABLED_TASK_TYPE_MASK stamp override. Returns null when unset (=>
// preserve the live mask), or a validated integer 0..15. Mirrors the on-chain validator
// validate_disabled_task_type_mask: the value must be a non-negative integer with NO bits
// outside TASK_TYPE_DISABLE_MASK (0b1111). HARD-FAILS on anything else (16, 99, -1, 1.5,
// "abc"), so the plan refuses an invalid mask before it can ever reach the chain.
//   bit 1=Exclusive  2=Collaborative  4=Competitive  8=BidExclusive  (SET bit = DISABLED).
//   0 = ALL task types enabled; 14 = only Exclusive enabled (the current live value).
function parseDisabledTaskTypeMaskOverride() {
  const raw = (process.env.DISABLED_TASK_TYPE_MASK ?? "").trim();
  if (raw === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    die(
      `DISABLED_TASK_TYPE_MASK='${raw}' is not a non-negative integer. Valid: 0..15 ` +
        `(0=all task types enabled, 14=Exclusive only). Refusing.`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    die(
      `DISABLED_TASK_TYPE_MASK='${raw}' is out of u8 range. Valid: 0..15. Refusing.`,
    );
  }
  if ((n & ~TASK_TYPE_DISABLE_MASK) !== 0) {
    die(
      `DISABLED_TASK_TYPE_MASK=${n} has bits outside 0b1111 (TASK_TYPE_DISABLE_MASK) — ` +
        `the program's validate_disabled_task_type_mask would reject it on-chain. Valid: 0..15. Refusing.`,
    );
  }
  return n;
}

const connection = new Connection(RPC_URL, "confirmed");
const idlPathRaw = process.env.IDL_PATH || "target/idl/agenc_coordination.json";
const idlPath = path.isAbsolute(idlPathRaw)
  ? idlPathRaw
  : path.join(ROOT, idlPathRaw);
const idlBytes = readFileSync(idlPath);
const idlSha256 = createHash("sha256").update(idlBytes).digest("hex");
const expectedIdlSha256 = (process.env.EXPECTED_IDL_SHA256 || "")
  .trim()
  .toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expectedIdlSha256)) {
  die(
    "EXPECTED_IDL_SHA256 is required and must be the independently reviewed 64-hex IDL digest.",
  );
}
if (idlSha256 !== expectedIdlSha256) {
  die(`IDL sha256 ${idlSha256} != approved ${expectedIdlSha256}. Refusing.`);
}
const idl = JSON.parse(idlBytes.toString("utf8"));
if (idl.address !== PROGRAM_ID.toBase58()) {
  die(
    `IDL address ${idl.address} != program ${PROGRAM_ID.toBase58()}. Refusing.`,
  );
}
if (!Array.isArray(idl.instructions)) {
  die("Approved IDL instructions are malformed. Refusing.");
}
if (
  !idl.instructions.some(
    (ix) =>
      ix.name === "stamp_release_surface" ||
      ix.name === "stampReleaseSurface",
  )
) {
  die(
    "Approved IDL does not contain stamp_release_surface; the final release boundary must be atomic.",
  );
}
const targetSurfaceRevision = Number(
  process.env.TARGET_SURFACE_REVISION || SURFACE_REVISION_CURRENT,
);
if (
  !Number.isInteger(targetSurfaceRevision) ||
  targetSurfaceRevision !== SURFACE_REVISION_CURRENT
) {
  die(
    `TARGET_SURFACE_REVISION must equal this binary's current revision ${SURFACE_REVISION_CURRENT}; got ${process.env.TARGET_SURFACE_REVISION}.`,
  );
}
const soPathRaw = envOrDie("SO_PATH");
const soPath = path.isAbsolute(soPathRaw)
  ? soPathRaw
  : path.join(ROOT, soPathRaw);
const reviewedSoBytes = readFileSync(soPath);
if (reviewedSoBytes.length === 0) die("approved SBF artifact is empty.");
const expectedSoSha256 = canonicalSha256(
  envOrDie("EXPECTED_SO_SHA256"),
  "EXPECTED_SO_SHA256",
);
const actualSoSha256 = createHash("sha256")
  .update(reviewedSoBytes)
  .digest("hex");
if (actualSoSha256 !== expectedSoSha256) {
  die(
    `SBF sha256 ${actualSoSha256} != approved ${expectedSoSha256}. Refusing.`,
  );
}
const upgradeAuthorityPolicy = loadReviewedUpgradeAuthorityPolicy();
const reviewedCustodyPolicy =
  upgradeAuthorityPolicy.allowedUpgradeAuthorities[0]?.custody;
if (!reviewedCustodyPolicy) {
  die(
    "reviewed upgrade-authority policy has no mutable custody account for the atomic release stamp.",
  );
}
const expectedProtocolConfigSha256 = stampMode.skipStamp
  ? null
  : canonicalSha256(
      envOrDie("EXPECTED_PROTOCOL_CONFIG_SHA256"),
      "EXPECTED_PROTOCOL_CONFIG_SHA256",
    );
const expectedModerationMinUpdatedAtRaw = stampMode.skipStamp
  ? null
  : envOrDie("EXPECTED_MODERATION_MIN_UPDATED_AT");
if (
  expectedModerationMinUpdatedAtRaw !== null &&
  !/^(0|[1-9][0-9]*)$/.test(expectedModerationMinUpdatedAtRaw)
) {
  die(
    "EXPECTED_MODERATION_MIN_UPDATED_AT must be a canonical non-negative integer.",
  );
}
const expectedModerationMinUpdatedAt =
  expectedModerationMinUpdatedAtRaw === null
    ? null
    : BigInt(expectedModerationMinUpdatedAtRaw);

const [protocolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol")],
  PROGRAM_ID,
);
const [bidMarketplacePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("bid_marketplace")],
  PROGRAM_ID,
);
const [zkConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("zk_config")],
  PROGRAM_ID,
);
const [moderationPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("moderation_config")],
  PROGRAM_ID,
);

function initializeSigningMaterial() {
  authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);
  const cosigners = (process.env.COSIGNERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(loadKeypair);
  // All in-program multisig signers (authority + co-signers), deduped. The
  // program counts unique signer pubkeys that are ProtocolConfig owners.
  signerKps = [authority, ...cosigners].filter(
    (kp, i, arr) =>
      arr.findIndex((candidate) => candidate.publicKey.equals(kp.publicKey)) ===
      i,
  );
  signerMetas = signerKps.map((kp) => ({
    pubkey: kp.publicKey,
    isSigner: true,
    isWritable: false,
  }));
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authority),
    { commitment: "confirmed" },
  );
  program = new anchor.Program(idl, provider);
}

async function verifyLoaderBoundary(
  label,
  minContextSlot,
  { commitment = "confirmed" } = {},
) {
  const immediate = await readProgramUpgradeAuthoritySnapshot(
    connection,
    upgradeAuthorityPolicy,
    {
      commitment,
      minContextSlot:
        minContextSlot ?? approvedLoaderSnapshot?.contextSlot ?? undefined,
    },
  );
  if (approvedLoaderSnapshot) {
    assertImmediatePreUpgradeSnapshot(approvedLoaderSnapshot, immediate);
  }
  assertApprovedExecutableSnapshot({
    genesisHash,
    policy: upgradeAuthorityPolicy,
    snapshot: immediate,
    binaryBytes: reviewedSoBytes,
    expectedSha256: expectedSoSha256,
  });
  console.log(
    `   ✓ ${label}: loader/custody + approved SBF exact at ${commitment} slot ${immediate.contextSlot}`,
  );
  return immediate;
}

async function sendIx(ix, label, { preBroadcast, postConfirmation } = {}) {
  const boundary = await verifyLoaderBoundary(`${label} pre-broadcast`);
  if (preBroadcast) await preBroadcast(boundary.contextSlot, boundary);
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: authority.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(ix);
  tx.sign(...signerKps);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  // Preserve the signature before confirmation/post-image checks: from this
  // point the mutation may already be committed even if a later RPC read fails.
  console.log(`  ↗ ${label} submitted — ${sig}`);
  try {
    const confirmation = await connection.confirmTransaction(
      { signature: sig, ...latest },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(
        `confirmation failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }
    const confirmationSlot = confirmation?.context?.slot;
    if (
      !Number.isSafeInteger(confirmationSlot) ||
      confirmationSlot < boundary.contextSlot
    ) {
      throw new Error(
        `confirmation context slot ${String(confirmationSlot)} is invalid or below ` +
          `pre-broadcast slot ${boundary.contextSlot}`,
      );
    }
    const postMinContextSlot = Math.max(
      boundary.contextSlot,
      confirmationSlot,
    );
    const postBoundary = await verifyLoaderBoundary(
      `${label} post-confirmation`,
      postMinContextSlot,
    );
    if (postConfirmation) await postConfirmation(postBoundary.contextSlot);
  } catch (error) {
    throw new Error(
      `${label} transaction ${sig} was submitted, but confirmation/post-image ` +
        `verification failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  console.log(`  ✓ ${label} confirmed — ${sig}`);
  return sig;
}

async function simulateIx(ix, label, { preBroadcast } = {}) {
  const boundary = await verifyLoaderBoundary(`${label} pre-simulation`);
  if (preBroadcast) await preBroadcast(boundary.contextSlot, boundary);
  const simulation = await simulateNonBroadcastableInstructions(connection, {
    feePayer: authority.publicKey,
    instructions: [ix],
    commitment: "confirmed",
  });
  if (simulation.value.err) {
    const logs = (simulation.value.logs ?? []).slice(-12).join(" | ");
    throw new Error(
      `${label} simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? `; ${logs}` : ""}`,
    );
  }
  console.log(`   ✓ ${label} simulated successfully (no state committed)`);
}

async function processIx(ix, label, boundaryChecks) {
  if (EXECUTE) return sendIx(ix, label, boundaryChecks);
  return simulateIx(ix, label, boundaryChecks);
}

// Decode the live ProtocolConfig (handles BOTH the 349B legacy and 351B migrated layouts).
function decodeProtocolConfigAccount(ai, contextSlot) {
  if (!ai)
    die(
      `ProtocolConfig ${protocolPda.toBase58()} not found — wrong RPC/program?`,
    );
  if (!ai.owner.equals(PROGRAM_ID))
    die(`ProtocolConfig owner ${ai.owner.toBase58()} != program.`);
  const d = ai.data,
    base = 8;
  if (
    d.length !== ProtocolConfigSizes.OLD &&
    d.length !== ProtocolConfigSizes.NEW
  ) {
    die(
      `ProtocolConfig has unexpected size ${d.length}; expected ${ProtocolConfigSizes.OLD} (legacy) or ${ProtocolConfigSizes.NEW} (migrated).`,
    );
  }
  const expectedDiscriminator = createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8);
  if (!d.subarray(0, 8).equals(expectedDiscriminator)) {
    die("ProtocolConfig discriminator mismatch; refusing to decode or stamp.");
  }
  const authorityPk = new PublicKey(d.subarray(base + 0, base + 32));
  const multisigThreshold = d[base + 132];
  const multisigOwnersLen = d[base + 133];
  const protocolPaused = d[base + 179] !== 0;
  const disabledTaskTypeMask = d[base + 180];
  const owners = [];
  for (let i = 0; i < 5; i++)
    owners.push(
      new PublicKey(
        d.subarray(base + 181 + i * 32, base + 181 + i * 32 + 32),
      ).toBase58(),
    );
  const migrated = d.length >= ProtocolConfigSizes.NEW;
  const surfaceRevision = migrated ? d.readUInt16LE(base + 341) : null;
  return {
    contextSlot,
    dataSha256: accountDataSha256(ai, "ProtocolConfig"),
    dataLen: d.length,
    authority: authorityPk,
    multisigThreshold,
    multisigOwnersLen,
    protocolPaused,
    disabledTaskTypeMask,
    owners: owners.slice(0, multisigOwnersLen),
    migrated,
    rawData: Buffer.from(d),
    surfaceRevision,
  };
}
const ProtocolConfigSizes = { OLD: 349, NEW: 351 };

async function readProtocolConfig(minContextSlot = 0) {
  const response = await connection.getAccountInfoAndContext(protocolPda, {
    commitment: "confirmed",
    minContextSlot,
  });
  if (
    !response?.context ||
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot < minContextSlot
  ) {
    die("ProtocolConfig RPC response context is malformed or regressed.");
  }
  return decodeProtocolConfigAccount(response.value, response.context.slot);
}

function decodeChainClockAccount(account) {
  if (!account) throw new Error("Clock sysvar account is missing");
  if (!account.owner?.equals?.(SYSVAR_OWNER)) {
    throw new Error("Clock sysvar owner is not the Sysvar program");
  }
  if (account.executable !== false) {
    throw new Error("Clock sysvar must be non-executable");
  }
  const data = Buffer.from(account.data ?? []);
  if (data.length !== 40) {
    throw new Error(`Clock sysvar data length ${data.length} != 40`);
  }
  const unixTimestamp = data.readBigInt64LE(32);
  if (unixTimestamp < 0n) {
    throw new Error("Clock sysvar unix timestamp is negative");
  }
  return unixTimestamp;
}

async function readReviewedStampBoundary(
  minContextSlot,
  { expectedPostImage } = {},
) {
  const response = await connection.getMultipleAccountsInfoAndContext(
    [
      protocolPda,
      bidMarketplacePda,
      moderationPda,
      SYSVAR_CLOCK_PUBKEY,
      idlAddress,
    ],
    { commitment: "confirmed", minContextSlot },
  );
  if (
    !response?.context ||
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot < minContextSlot ||
    !Array.isArray(response.value) ||
    response.value.length !== 5
  ) {
    throw new Error("stamp-boundary RPC response is malformed or regressed");
  }
  const [
    protocolAccount,
    bidAccount,
    moderationAccount,
    clockAccount,
    idlAccount,
  ] = response.value;
  const boundaryCfg = decodeProtocolConfigAccount(
    protocolAccount,
    response.context.slot,
  );
  if (expectedPostImage) {
    if (!boundaryCfg.rawData.equals(expectedPostImage)) {
      throw new Error(
        "ProtocolConfig post-image changed outside the exact reviewed launch-control fields",
      );
    }
  } else if (boundaryCfg.dataSha256 !== expectedProtocolConfigSha256) {
    throw new Error(
      `ProtocolConfig data sha256 ${boundaryCfg.dataSha256} != reviewed ` +
        `${expectedProtocolConfigSha256}`,
    );
  }

  const reviewedBid = reviewedBidEconomicsFromEnv(process.env);
  decodeBidMarketplaceConfigAccount(bidAccount, bidMarketplacePda, {
    expectedAuthority: boundaryCfg.authority,
    expectedEconomics: reviewedBid,
  });
  const reviewedModeration = reviewedModerationPolicyFromEnv(process.env);
  const moderation = decodeModerationConfigAccount(
    moderationAccount,
    moderationPda,
    {
      expectedAuthority: boundaryCfg.authority,
      expectedPolicy: reviewedModeration,
    },
  );
  const chainUnixTimestamp = decodeChainClockAccount(clockAccount);
  const freshness = assertModerationFreshForStamp(
    moderation,
    chainUnixTimestamp,
    { minimumReviewedUpdatedAt: expectedModerationMinUpdatedAt },
  );

  const onChainIdl = await decodeAnchorIdlAccount(idlAccount, idlAddress, {
    programId: PROGRAM_ID,
    expectedAuthority: authority.publicKey,
  });
  assertFetchedOnChainIdlMatchesReviewed(idl, onChainIdl.idl);
  console.log(
    `   ✓ stamp boundary slot ${response.context.slot}: ProtocolConfig + bid/moderation ` +
      `singletons + Clock freshness (${freshness.remainingSecs}s remaining) + canonical IDL exact`,
  );
  return {
    accountHashes: {
      bid: accountDataSha256(bidAccount, "BidMarketplaceConfig"),
      idl: accountDataSha256(idlAccount, "canonical Anchor IDL"),
      moderation: accountDataSha256(
        moderationAccount,
        "ModerationConfig",
      ),
    },
    cfg: boundaryCfg,
    contextSlot: response.context.slot,
    freshness,
  };
}

async function main() {
  console.log(
    `Mode: ${EXECUTE ? "EXECUTE (will send transactions)" : "PLAN (RPC simulation; nothing committed)"}`,
  );
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(
    `Approved IDL: ${idlPath} | sha256=${idlSha256} | instructions=${idl.instructions.length}`,
  );
  console.log(
    `Approved SBF: ${soPath} | sha256=${actualSoSha256} | bytes=${reviewedSoBytes.length}\n`,
  );

  // Audit F-19: the program ID is IDENTICAL on devnet — without a genesis check a
  // misplaced RPC_URL would init/stamp the wrong cluster with real keys. This is
  // the production rail, so there is deliberately no non-mainnet override.
  genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS) {
    die(
      `genesis hash ${genesisHash} is not mainnet-beta (${MAINNET_GENESIS}). ` +
        `This script initializes mainnet singletons — refusing to run against another cluster.`,
    );
  }
  console.log(`Cluster genesis: ${genesisHash} (mainnet-beta)\n`);

  approvedLoaderSnapshot = await readProgramUpgradeAuthoritySnapshot(
    connection,
    upgradeAuthorityPolicy,
    // The on-chain stamp commits ProgramData slot/length/authority instead of
    // hashing the multi-megabyte executable. Root the exact reviewed bytes
    // first so a confirmed-fork switch cannot substitute another same-slot
    // loader image after this process begins.
    { commitment: "finalized" },
  );
  assertApprovedExecutableSnapshot({
    genesisHash,
    policy: upgradeAuthorityPolicy,
    snapshot: approvedLoaderSnapshot,
    binaryBytes: reviewedSoBytes,
    expectedSha256: expectedSoSha256,
  });
  console.log(
    `Live executable/custody: exact approved SBF at slot ${approvedLoaderSnapshot.contextSlot}; ` +
      `policy sha256=${upgradeAuthorityPolicy.policySha256}`,
  );

  // Only now may plaintext signing files be opened.
  initializeSigningMaterial();
  idlAddress = await deriveAnchorIdlAddress(PROGRAM_ID);
  console.log(
    `Authority: ${authority.publicKey.toBase58()}  | multisig signers passed: ${signerKps.length}\n`,
  );

  const cfg = await readProtocolConfig(approvedLoaderSnapshot.contextSlot);
  console.log(
    `ProtocolConfig ${protocolPda.toBase58()}: dataLen=${cfg.dataLen} ` +
      `(${cfg.migrated ? "MIGRATED 351B" : "LEGACY 349B"}) multisig=${cfg.multisigThreshold}/${cfg.multisigOwnersLen} ` +
      `paused=${cfg.protocolPaused} disabledTaskTypeMask=${cfg.disabledTaskTypeMask} surfaceRevision=${cfg.surfaceRevision}`,
  );
  console.log(`  owners: ${cfg.owners.join(", ")}`);

  if (!stampMode.skipStamp) {
    if (cfg.dataSha256 !== expectedProtocolConfigSha256) {
      die(
        `ProtocolConfig data sha256 ${cfg.dataSha256} != reviewed ` +
          `${expectedProtocolConfigSha256}; refusing every child mutation.`,
      );
    }
    // Before any mutation in a stamp invocation, verify the complete reviewed
    // singleton/Clock/IDL state. It is repeated immediately before broadcast.
    await readReviewedStampBoundary(cfg.contextSlot);
  }

  // --- Preconditions ----------------------------------------------------------------------
  if (!authority.publicKey.equals(cfg.authority)) {
    die(
      `AUTHORITY_KEYPAIR (${authority.publicKey.toBase58()}) != ProtocolConfig.authority (${cfg.authority.toBase58()}).`,
    );
  }
  // The final surface_revision stamp (step 6) and bid-marketplace init (step 4a) are
  // MULTISIG-gated: they need >=
  // multisigThreshold unique owner-signers. Verify the passed signers can satisfy it.
  const ownerSet = new Set(cfg.owners);
  const eligibleSigners = signerKps.filter((kp) =>
    ownerSet.has(kp.publicKey.toBase58()),
  );
  console.log(
    `  eligible multisig signers passed: ${eligibleSigners.length} of required ${cfg.multisigThreshold}`,
  );
  const needMultisig =
    !process.env.SKIP_BID_MARKETPLACE || !stampMode.skipStamp;
  if (needMultisig && eligibleSigners.length < cfg.multisigThreshold) {
    die(
      `multisig-gated steps need >= ${cfg.multisigThreshold} signers that are ProtocolConfig owners; ` +
        `only ${eligibleSigners.length} of the passed signers are owners. Add COSIGNERS=...`,
    );
  }
  // surface_revision can only be stamped on the MIGRATED layout
  // (stamp_release_surface loads a typed Account<ProtocolConfig>, which rejects
  // the 349B legacy account).
  if (!stampMode.skipStamp && !cfg.migrated) {
    die(
      "ProtocolConfig is still the LEGACY 349B layout — run the migrate sweep (migrate_protocol) " +
        "BEFORE stamping surface_revision. Re-run after migration, or pass SKIP_STAMP=1.",
    );
  }
  // A release stamp is an advertisement boundary, not an unpause operation.
  // Keeping the protocol paused makes any post-confirmation boundary failure
  // fail-safe: no new task traffic can use a revision whose dependencies need
  // operator remediation.
  if (!stampMode.skipStamp && !cfg.protocolPaused) {
    die(
      "ProtocolConfig.protocol_paused=false — pause the protocol before the final surface stamp.",
    );
  }

  // === Step 4a: initialize_bid_marketplace (MULTISIG-gated) ===============================
  if (process.env.SKIP_BID_MARKETPLACE) {
    const expectedEconomics = reviewedBidEconomicsFromEnv(process.env);
    const existing = await connection.getAccountInfo(bidMarketplacePda);
    const decoded = decodeBidMarketplaceConfigAccount(
      existing,
      bidMarketplacePda,
      {
        expectedAuthority: cfg.authority,
        expectedEconomics,
      },
    );
    console.log(
      "\nStep 4a: mutation skipped (SKIP_BID_MARKETPLACE), but the existing " +
        `singleton exactly matched the reviewed snapshot ` +
        `(minBidBondLamports=${decoded.minBidBondLamports}).`,
    );
  } else {
    // Conservative defaults; OVERRIDE via env for the reviewed mainnet policy.
    // Validate these locally even when planning so an invalid economic policy is
    // rejected before an instruction is built or simulated.
    const intendedBidEconomics = validateBidMarketplaceEconomics({
      minBidBondLamports: process.env.BID_MIN_BOND_LAMPORTS || "1000000",
      bidCreationCooldownSecs: process.env.BID_CREATION_COOLDOWN_SECS || "60",
      maxBidsPer24h: process.env.BID_MAX_PER_24H || "50",
      maxActiveBidsPerTask: process.env.BID_MAX_ACTIVE_PER_TASK || "20",
      maxBidLifetimeSecs: process.env.BID_MAX_LIFETIME_SECS || "604800",
      acceptedNoShowSlashBps: process.env.BID_NOSHOW_SLASH_BPS || "1000",
    });
    const explicitBidPolicy = [
      "BID_MIN_BOND_LAMPORTS",
      "BID_CREATION_COOLDOWN_SECS",
      "BID_MAX_PER_24H",
      "BID_MAX_ACTIVE_PER_TASK",
      "BID_MAX_LIFETIME_SECS",
      "BID_NOSHOW_SLASH_BPS",
    ].some(
      (name) => process.env[name] !== undefined && process.env[name] !== "",
    );
    const existing = await connection.getAccountInfo(bidMarketplacePda);
    if (existing) {
      const decoded = decodeBidMarketplaceConfigAccount(
        existing,
        bidMarketplacePda,
        {
          expectedAuthority: cfg.authority,
          expectedEconomics: explicitBidPolicy
            ? intendedBidEconomics
            : undefined,
        },
      );
      console.log(
        `\nStep 4a: BidMarketplaceConfig ${bidMarketplacePda.toBase58()} decoded and validated — skipping init.`,
      );
      console.log(
        `   authority=${decoded.authority.toBase58()} minBidBondLamports=${decoded.minBidBondLamports} ` +
          `cooldown=${decoded.bidCreationCooldownSecs}s maxPer24h=${decoded.maxBidsPer24h} ` +
          `maxActivePerTask=${decoded.maxActiveBidsPerTask} maxLifetime=${decoded.maxBidLifetimeSecs}s ` +
          `noShowSlashBps=${decoded.acceptedNoShowSlashBps}`,
      );
    } else {
      const {
        minBidBondLamports,
        bidCreationCooldownSecs,
        maxBidsPer24h,
        maxActiveBidsPerTask,
        maxBidLifetimeSecs,
        acceptedNoShowSlashBps,
      } = intendedBidEconomics;
      console.log(
        `\nStep 4a: initialize_bid_marketplace (multisig) → ${bidMarketplacePda.toBase58()}`,
      );
      console.log(
        `   minBidBondLamports=${minBidBondLamports} cooldown=${bidCreationCooldownSecs}s maxPer24h=${maxBidsPer24h} ` +
          `maxActivePerTask=${maxActiveBidsPerTask} maxLifetime=${maxBidLifetimeSecs}s noShowSlashBps=${acceptedNoShowSlashBps}`,
      );
      const ix = await program.methods
        .initializeBidMarketplace(
          new anchor.BN(minBidBondLamports.toString()),
          new anchor.BN(bidCreationCooldownSecs.toString()),
          maxBidsPer24h,
          maxActiveBidsPerTask,
          new anchor.BN(maxBidLifetimeSecs.toString()),
          acceptedNoShowSlashBps,
        )
        .accounts({
          protocolConfig: protocolPda,
          bidMarketplace: bidMarketplacePda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(signerMetas)
        .instruction();
      await processIx(ix, "initialize_bid_marketplace");
      if (EXECUTE) {
        const postImage = await connection.getAccountInfo(
          bidMarketplacePda,
          "confirmed",
        );
        decodeBidMarketplaceConfigAccount(postImage, bidMarketplacePda, {
          expectedAuthority: cfg.authority,
          expectedEconomics: intendedBidEconomics,
        });
        console.log(
          "   ✓ BidMarketplaceConfig post-image decoded and matched the intended economics",
        );
      }
    }
  }

  // === Step 4b: ZK activation is unconditionally disabled/deferred ========================
  // Do not construct, simulate, or broadcast initialize_zk_config/update_zk_image_id.
  // A pre-existing canonical account is legacy inventory only and never readiness proof.
  const existingZkConfig = await connection.getAccountInfo(zkConfigPda);
  console.log(
    `\nStep 4b: ZK PRIVATE TASKS DISABLED/DEFERRED — no activation instruction constructed. ` +
      `ZkConfig ${zkConfigPda.toBase58()} is ${existingZkConfig ? `present (len=${existingZkConfig.data.length}; legacy inventory only)` : "absent"}.`,
  );

  // === Step 4c: configure_task_moderation (single authority; verify/realign) ===============
  if (process.env.SKIP_MODERATION) {
    const expectedPolicy = reviewedModerationPolicyFromEnv(process.env);
    const existing = await connection.getAccountInfo(moderationPda);
    const decoded = decodeModerationConfigAccount(existing, moderationPda, {
      expectedAuthority: cfg.authority,
      expectedPolicy,
    });
    console.log(
      "\nStep 4c: mutation skipped (SKIP_MODERATION), but the existing singleton " +
        `exactly matched the reviewed snapshot ` +
        `(moderation_authority=${decoded.moderationAuthority.toBase58()} ` +
        `enabled=${decoded.enabled} liveness_window_secs=${decoded.livenessWindowSecs}).`,
    );
  } else {
    const existing = await connection.getAccountInfo(moderationPda);
    let currentModAuth = null,
      currentEnabled = null;
    if (existing) {
      const decoded = decodeModerationConfigAccount(existing, moderationPda, {
        expectedAuthority: cfg.authority,
      });
      currentModAuth = decoded.moderationAuthority.toBase58();
      currentEnabled = decoded.enabled;
      console.log(
        `\nStep 4c: ModerationConfig ${moderationPda.toBase58()} decoded and validated — moderation_authority=${currentModAuth} enabled=${currentEnabled}`,
      );
    } else {
      console.log(
        `\nStep 4c: ModerationConfig ${moderationPda.toBase58()} DOES NOT EXIST.`,
      );
    }
    if (!process.env.MODERATION_AUTHORITY) {
      if (!existing) {
        die(
          "ModerationConfig is absent and MODERATION_AUTHORITY is not set. Supply the reviewed mainnet attestor; refusing to guess or stamp.",
        );
      }
      if (currentEnabled !== true) {
        die(
          "ModerationConfig is disabled. Supply MODERATION_AUTHORITY=<reviewed pubkey> " +
            "and MODERATION_ENABLED=true to realign it before stamping.",
        );
      }
      console.log(
        "   MODERATION_AUTHORITY not set → validated existing singleton in VERIFY-ONLY mode.",
      );
    } else {
      const modAuth = new PublicKey(process.env.MODERATION_AUTHORITY);
      if (modAuth.equals(PublicKey.default)) {
        die("MODERATION_AUTHORITY cannot be the default pubkey.");
      }
      const rawEnabled = String(
        process.env.MODERATION_ENABLED ?? "true",
      ).toLowerCase();
      if (!["true", "false"].includes(rawEnabled)) {
        die("MODERATION_ENABLED must be exactly true or false.");
      }
      const enabled = rawEnabled === "true";
      if (
        existing &&
        currentModAuth === modAuth.toBase58() &&
        currentEnabled === enabled
      ) {
        console.log(
          `   already matches MODERATION_AUTHORITY=${modAuth.toBase58()} enabled=${enabled} — skipping.`,
        );
      } else {
        console.log(
          `   configure_task_moderation → moderation_authority=${modAuth.toBase58()} enabled=${enabled}`,
        );
        const ix = await program.methods
          .configureTaskModeration(modAuth, enabled)
          .accounts({
            protocolConfig: protocolPda,
            moderationConfig: moderationPda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(); // single authority signer
        await processIx(ix, "configure_task_moderation");
        if (EXECUTE) {
          const postImage = await connection.getAccountInfo(
            moderationPda,
            "confirmed",
          );
          const decoded = decodeModerationConfigAccount(
            postImage,
            moderationPda,
            {
              expectedAuthority: cfg.authority,
            },
          );
          if (
            !decoded.moderationAuthority.equals(modAuth) ||
            decoded.enabled !== enabled
          ) {
            die(
              "ModerationConfig post-image does not match the explicitly intended authority/enabled state.",
            );
          }
          console.log(
            "   ✓ ModerationConfig post-image decoded and matched the intended policy",
          );
        }
      }
    }
  }

  // === Final step: stamp surface_revision = CURRENT (MULTISIG-gated) — LAST ================
  let stampProcessed = false;
  const maskOverride = stampMode.skipStamp
    ? null
    : parseDisabledTaskTypeMaskOverride();
  if (stampMode.skipStamp) {
    console.log("\nFinal Step 6: skipped (SKIP_STAMP).");
  } else if (
    cfg.surfaceRevision === targetSurfaceRevision &&
    !stampMode.forceStamp &&
    maskOverride === null
  ) {
    console.log(
      `\nFinal Step 6: surface_revision already = CURRENT (${targetSurfaceRevision}) — nothing to stamp.`,
    );
  } else {
    if (cfg.surfaceRevision === targetSurfaceRevision) {
      console.log(
        `\nFinal Step 6: FORCE_STAMP=1 + RUN_STAMP=1 — reasserting CURRENT ` +
          `surface_revision=${targetSurfaceRevision} as the final reviewed release boundary.`,
      );
    }
    // The atomic release stamp writes the mask + revision while preserving the
    // already-proved paused state.
    // The LIVE mask must always have only known bits — otherwise the live state itself is
    // corrupt and the on-chain validator (validate_disabled_task_type_mask) would reject any
    // re-write. Keep this guard even when overriding (defends against a corrupt live account).
    if ((cfg.disabledTaskTypeMask & ~TASK_TYPE_DISABLE_MASK) !== 0) {
      die(
        `live disabled_task_type_mask=${cfg.disabledTaskTypeMask} has unknown bits — refusing (would be rejected on-chain).`,
      );
    }
    // DISABLED_TASK_TYPE_MASK override: when set, the stamp WRITES this value (enabling/disabling
    // task types as part of the rollout) instead of preserving the live mask. When unset, the live
    // mask is preserved (legacy behavior). Validate it the same way the program does
    // (validate_disabled_task_type_mask): integer 0..15, no bits outside 0b1111.
    const maskToWrite =
      maskOverride === null ? cfg.disabledTaskTypeMask : maskOverride;
    if (maskOverride === null) {
      console.log(
        `\nFinal Step 6: stamp_release_surface → atomically stamp surface_revision=${targetSurfaceRevision} ` +
          `(preserving protocolPaused=${cfg.protocolPaused}, disabledTaskTypeMask=${cfg.disabledTaskTypeMask})`,
      );
    } else {
      console.log(
        `\nFinal Step 6: stamp_release_surface → atomically stamp surface_revision=${targetSurfaceRevision} ` +
          `(preserving protocolPaused=${cfg.protocolPaused}, OVERRIDING disabledTaskTypeMask ` +
          `${cfg.disabledTaskTypeMask} -> ${maskToWrite}${maskToWrite === 0 ? " (ALL task types ENABLED)" : ""})`,
      );
    }
    // The final instruction is derived from a newly finalized, byte-exact
    // ProgramData/SBF + custody snapshot. Confirmed pre-broadcast reads below
    // must retain this full state digest, so a same-slot fork cannot substitute
    // different executable bytes into the reviewed stamp.
    const instructionLoader = await verifyLoaderBoundary(
      "surface stamp instruction-build boundary",
      undefined,
      { commitment: "finalized" },
    );
    const instructionBoundary = await readReviewedStampBoundary(
      instructionLoader.contextSlot,
    );
    if (
      !Number.isSafeInteger(instructionLoader.payload.length) ||
      instructionLoader.payload.length > 0xffff_ffff ||
      instructionLoader.authority === null ||
      !/^[0-9a-f]{64}$/.test(
        String(instructionLoader.custodyAccountDataSha256 ?? ""),
      )
    ) {
      die("loader/custody snapshot cannot be encoded into the atomic release stamp.");
    }
    const ix = await program.methods
      .stampReleaseSurface(
        maskToWrite,
        targetSurfaceRevision,
        sha256DigestBytes(
          instructionBoundary.cfg.dataSha256,
          "ProtocolConfig preimage digest",
        ),
        new anchor.BN(instructionLoader.programDataSlot.toString()),
        instructionLoader.payload.length,
        new PublicKey(instructionLoader.authority),
        sha256DigestBytes(
          instructionBoundary.accountHashes.bid,
          "BidMarketplaceConfig digest",
        ),
        sha256DigestBytes(
          instructionBoundary.accountHashes.moderation,
          "ModerationConfig digest",
        ),
        sha256DigestBytes(
          instructionBoundary.accountHashes.idl,
          "canonical Anchor IDL digest",
        ),
        new PublicKey(reviewedCustodyPolicy.multisig),
        new PublicKey(reviewedCustodyPolicy.programId),
        sha256DigestBytes(
          instructionLoader.custodyAccountDataSha256,
          "upgrade custody digest",
        ),
      )
      .accounts({
        protocolConfig: protocolPda,
        bidMarketplaceConfig: bidMarketplacePda,
        moderationConfig: moderationPda,
        programData: new PublicKey(instructionLoader.programData),
        anchorIdl: idlAddress,
        upgradeAuthorityCustody: new PublicKey(
          reviewedCustodyPolicy.multisig,
        ),
        authority: authority.publicKey,
      })
      .remainingAccounts(signerMetas)
      .instruction();
    let exactPostImage;
    await processIx(ix, "stamp_release_surface (atomic surface stamp)", {
      preBroadcast: async (minContextSlot, liveLoader) => {
        if (liveLoader.stateDigest !== instructionLoader.stateDigest) {
          throw new Error(
            "loader/custody state changed after the atomic stamp instruction was built",
          );
        }
        const boundary = await readReviewedStampBoundary(minContextSlot);
        if (
          boundary.cfg.protocolPaused !== cfg.protocolPaused ||
          boundary.cfg.disabledTaskTypeMask !== cfg.disabledTaskTypeMask ||
          boundary.cfg.surfaceRevision !== cfg.surfaceRevision ||
          boundary.cfg.dataSha256 !== instructionBoundary.cfg.dataSha256 ||
          boundary.accountHashes.bid !==
            instructionBoundary.accountHashes.bid ||
          boundary.accountHashes.moderation !==
            instructionBoundary.accountHashes.moderation ||
          boundary.accountHashes.idl !== instructionBoundary.accountHashes.idl
        ) {
          throw new Error(
            "a release-boundary account changed after the atomic stamp instruction was built",
          );
        }
        exactPostImage = Buffer.from(boundary.cfg.rawData);
        exactPostImage[8 + 179] = cfg.protocolPaused ? 1 : 0;
        exactPostImage[8 + 180] = maskToWrite;
        exactPostImage.writeUInt16LE(targetSurfaceRevision, 8 + 341);
      },
      postConfirmation: async (minContextSlot) => {
        if (!exactPostImage) {
          throw new Error(
            "surface-stamp post-image was not established pre-broadcast",
          );
        }
        await readReviewedStampBoundary(minContextSlot, {
          expectedPostImage: exactPostImage,
        });
      },
    });
    stampProcessed = true;
  }

  console.log(
    `\n${EXECUTE ? "Done." : "Plan simulation complete. Re-run with --execute (funded authority + cosigners) to apply."}`,
  );
  if (EXECUTE && stampProcessed) {
    console.log(
      "Final surface stamp confirmed after exact executable, singleton, moderation-liveness, and on-chain IDL checks.",
    );
  }
}

main().catch((e) => die(e.stack || e.message || String(e)));
