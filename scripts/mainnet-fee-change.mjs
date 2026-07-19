#!/usr/bin/env node
// Mainnet protocol-fee change via on-chain governance (FeeChange proposal).
//
// TWO PATHS exist to change protocol_fee_bps; this script drives the second:
//
//   A. Direct `update_protocol_fee` — requires the on-chain multisig
//      configured in ProtocolConfig (threshold >= 2 enforced in
//      utils/multisig.rs:require_multisig_threshold; it hard-fails when no
//      owners are configured). Live mainnet decode 2026-07-02:
//      multisig_owners_len=3, threshold=2 — so this path IS operable with
//      2-of-3 signatures. Not what this script does.
//
//   B. The governance FeeChange pipeline (this script; field-proven — mainnet's
//      historical 100→500 bps change ran through this path) —
//
//   0. initialize_governance   (ONE-TIME; signed by ProtocolConfig.authority.
//                               PARAMETERS ARE PERMANENT — there is no
//                               update_governance instruction.)
//   1. create_proposal          (FeeChange payload; proposer = a REGISTERED agent
//                               with stake >= min_proposal_stake; its wallet signs)
//   2. vote_proposal            (each wallet signs at most once, using its
//                               highest-weight eligible agent; weight =
//                               min(stake, snapshotted cap) * reputation / 10000)
//   3. execute_proposal         (after voting_deadline + execution_delay; a passed
//                               FeeChange also needs the CURRENT ProtocolConfig
//                               M-of-N multisig in remaining accounts)
//
// Existing tasks keep the fee snapshotted at their creation; only NEW tasks pick
// up the changed fee.
//
// SAFE BY DEFAULT: read-only plan unless --execute is passed. Plan mode decodes
// live state, computes the quorum arithmetic, and SENDS NOTHING.
//
// This script never accepts inline secret-key material. Signing modes read only
// the operator-supplied plaintext keypair FILE PATHS after the local artifact
// approvals and live mainnet executable/custody checks pass; protect those files
// as secrets. Plain keypair JSON only.
//
// USAGE (deps resolve from tests-integration/node_modules):
//   Every invocation also requires independently reviewed EXPECTED_IDL_SHA256
//   and EXPECTED_SO_SHA256 digests. IDL_PATH and SO_PATH may select the reviewed
//   artifacts; defaults are artifacts/anchor/idl/agenc_coordination.json and
//   programs/agenc-coordination/target/deploy/agenc_coordination.so. The program
//   id and mainnet genesis are not overridable. A committed strict policy also
//   binds the canonical ProgramData account and its Squads custody configuration.
//
//   Plan (read-only, no keys needed):
//     EXPECTED_IDL_SHA256=REVIEWED_IDL_DIGEST EXPECTED_SO_SHA256=REVIEWED_SBF_DIGEST \
//     RPC_URL=https://your-mainnet-rpc node scripts/mainnet-fee-change.mjs
//
//   Step 0 — initialize governance (authority signs; PARAMETERS ARE PERMANENT):
//     EXPECTED_IDL_SHA256=REVIEWED_IDL_DIGEST EXPECTED_SO_SHA256=REVIEWED_SBF_DIGEST \
//     RPC_URL=... AUTHORITY_KEYPAIR=/path/authority.json \
//     [VOTING_PERIOD_SECS=86400] [EXECUTION_DELAY_SECS=3600] \
//     [QUORUM_BPS=300] [APPROVAL_THRESHOLD_BPS=5000] [MIN_PROPOSAL_STAKE_LAMPORTS=10000000] \
//     node scripts/mainnet-fee-change.mjs --init-governance [--execute]
//
//   Step 1 — create the FeeChange proposal (proposer wallet signs):
//     EXPECTED_IDL_SHA256=REVIEWED_IDL_DIGEST EXPECTED_SO_SHA256=REVIEWED_SBF_DIGEST \
//     RPC_URL=... PROPOSER_KEYPAIR=/path/wallet-with-registered-agent.json \
//     NEW_FEE_BPS=500 [PROPOSAL_VOTING_PERIOD_SECS=86400] \
//     node scripts/mainnet-fee-change.mjs --propose [--execute]
//
//   Step 2 — vote (repeat per voting wallet; each wallet must own a registered agent):
//     EXPECTED_IDL_SHA256=REVIEWED_IDL_DIGEST EXPECTED_SO_SHA256=REVIEWED_SBF_DIGEST \
//     RPC_URL=... SECONDARY_RPC_URL=https://an-independent-mainnet-rpc \
//     VOTER_KEYPAIR=/path/voter.json PROPOSAL=<proposalPda> NEW_FEE_BPS=500 \
//     node scripts/mainnet-fee-change.mjs --vote [--execute]
//
//   Step 3 — execute after deadlines (executor + current multisig owners sign):
//     EXPECTED_IDL_SHA256=REVIEWED_IDL_DIGEST EXPECTED_SO_SHA256=REVIEWED_SBF_DIGEST \
//     RPC_URL=... SECONDARY_RPC_URL=https://an-independent-mainnet-rpc \
//     AUTHORITY_KEYPAIR=/path/executor.json \
//     MULTISIG_OWNER_KEYPAIRS=/path/owner1.json,/path/owner2.json \
//     PROPOSAL=<proposalPda> NEW_FEE_BPS=500 \
//     node scripts/mainnet-fee-change.mjs --finalize [--execute]
//
//   Executing vote/finalize requires SECONDARY_RPC_URL on a different host run
//   by an independent operator. Immediately before Anchor signs and broadcasts,
//   both mainnet RPCs must return byte-for-byte identical finalized Proposal
//   account state, and those agreed raw bytes are decoded and rebound to the
//   explicit PROPOSAL + NEW_FEE_BPS intent. Dry-runs remain read-only and do not
//   require the secondary endpoint.

import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import { createHash } from "crypto";
import {
  assertImmediatePreUpgradeSnapshot,
  loadReviewedUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
} from "./program-upgrade-authority-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const anchor = require("@coral-xyz/anchor");
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SYSVAR_CLOCK_PUBKEY,
} = require("@solana/web3.js");

export async function submitLocallySignedTransaction({
  connection,
  transaction,
  label,
  sendOptions,
  log = console.log,
}) {
  const signatureBytes = transaction?.signature;
  if (
    !(signatureBytes instanceof Uint8Array) ||
    signatureBytes.byteLength !== 64
  ) {
    throw new Error(`${label} transaction is missing a 64-byte local signature`);
  }
  const localSignature = bs58.encode(signatureBytes);
  const wireBytes = transaction.serialize();

  // This signature is determined entirely by the signed wire bytes. Preserve
  // it before the first network write so an accepted request with a lost HTTP
  // response can still be investigated without risking a blind resubmission.
  log(`SIGNED ${label}: ${localSignature}`);

  let rpcSignature;
  try {
    rpcSignature = await connection.sendRawTransaction(wireBytes, sendOptions);
  } catch (error) {
    throw new Error(
      `${label} transaction ${localSignature} has an UNKNOWN BROADCAST OUTCOME: ` +
        `sendRawTransaction failed after the signed bytes were handed to the RPC. ` +
        `Do not resubmit until this signature is checked. RPC error: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rpcSignature !== localSignature) {
    throw new Error(
      `${label} transaction ${localSignature} has an UNKNOWN BROADCAST OUTCOME: ` +
        `the RPC returned mismatched signature ${String(rpcSignature)}. ` +
        `Do not resubmit until the local signature is checked.`,
    );
  }
  log(`SUBMITTED ${label}: ${localSignature}`);
  return localSignature;
}

const PROGRAM_ID_STR = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SYSVAR_OWNER = new PublicKey("Sysvar1111111111111111111111111111111111111");
const MAX_GOVERNANCE_PERIOD_SECS = 604_800;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const AGENT_REGISTRATION_AUTHORITY_OFFSET = 8 + 32;
const ACTION_FLAGS = new Map([
  ["--init-governance", "init-governance"],
  ["--propose", "propose"],
  ["--vote", "vote"],
  ["--finalize", "finalize"],
]);

export function parseFeeChangeCommand(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw new Error("fee-change CLI arguments must be strings");
  }
  const allowed = new Set([...ACTION_FLAGS.keys(), "--execute"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown fee-change argument(s): ${unknown.join(", ")}`);
  }
  const duplicate = argv.find((arg, index) => argv.indexOf(arg) !== index);
  if (duplicate) {
    throw new Error(`duplicate fee-change argument: ${duplicate}`);
  }
  const actions = argv.filter((arg) => ACTION_FLAGS.has(arg));
  if (actions.length > 1) {
    throw new Error(
      `exactly one action flag is allowed; received ${actions.join(", ")}`,
    );
  }
  const execute = argv.includes("--execute");
  if (execute && actions.length !== 1) {
    throw new Error("--execute requires exactly one action flag");
  }
  return {
    execute,
    mode: actions.length === 0 ? "plan" : ACTION_FLAGS.get(actions[0]),
  };
}

const COMMAND = (() => {
  try {
    return parseFeeChangeCommand(process.argv.slice(2));
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
})();
const EXECUTE = COMMAND.execute;
const MODE = COMMAND.mode;

function redactRpc(value) {
  return String(value).replace(/(?:https?|wss?):\/\/[^\s"']+/giu, "<redacted-rpc>");
}
function die(msg) { console.error(`ERROR: ${redactRpc(msg)}`); process.exit(1); }
function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace(/^~/, process.env.HOME), "utf8"))));
}
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) die(`${name} must be a canonical integer`);
  const v = Number(raw);
  if (!Number.isSafeInteger(v)) die(`${name} must be a safe integer`);
  return v;
}
const fmt = (n) => Number(n).toLocaleString("en-US");

// Runtime state is initialized only by direct CLI invocation. Keeping imports
// side-effect-free lets the fail-closed validators be unit-tested without
// reading keys/artifacts or constructing an RPC client.
let signer;
let connection;
let secondaryConnection;
let idl;
let idlBytes;
let idlPath;
let soBytes;
let soPath;
let expectedSoSha256;
let program;
let protocolPda;
let governancePda;
let upgradeAuthorityPolicy;
let approvedLoaderSnapshot;

const MAX_REPUTATION = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const MIN_GOVERNANCE_VOTER_STAKE = 10_000_000n;
const MIN_GOVERNANCE_VOTER_REPUTATION = 5_000;
const MIN_GOVERNANCE_DISTINCT_VOTERS = 3n;
const MIN_GOVERNANCE_QUORUM_WEIGHT = 100_000_000n;
const GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER = 10n;
const PROPOSAL_EXECUTION_WINDOW_SECS = 7n * 24n * 60n * 60n;

const asBigInt = (value) => BigInt(value.toString());

export function assertMainnetFeeChangeRailBinding({
  genesisHash,
  programId,
  idl: candidateIdl,
  idlBytes: candidateIdlBytes,
  expectedIdlSha256,
}) {
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `RPC genesis ${genesisHash} is not mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  const candidateProgram = programId instanceof PublicKey
    ? programId
    : new PublicKey(programId);
  if (!candidateProgram.equals(PROGRAM_ID)) {
    throw new Error(
      `program ${candidateProgram.toBase58()} != pinned AgenC program ${PROGRAM_ID_STR}`,
    );
  }
  const expected = String(expectedIdlSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      "EXPECTED_IDL_SHA256 is required and must be an independently reviewed 64-hex digest",
    );
  }
  const bytes = Buffer.from(candidateIdlBytes ?? []);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`IDL sha256 ${actual} != approved ${expected}`);
  }
  let parsedIdl;
  try {
    parsedIdl = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `approved IDL is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (
    candidateIdl &&
    JSON.stringify(candidateIdl) !== JSON.stringify(parsedIdl)
  ) {
    throw new Error("decoded IDL object does not match the approved artifact bytes");
  }
  if (parsedIdl?.address !== PROGRAM_ID_STR) {
    throw new Error(
      `IDL address ${parsedIdl?.address ?? "missing"} != pinned program ${PROGRAM_ID_STR}`,
    );
  }
  if (!Array.isArray(parsedIdl.instructions)) {
    throw new Error("approved IDL instructions are missing");
  }
  const instructionNames = new Set(parsedIdl.instructions.map((ix) => ix.name));
  for (const required of ["create_proposal", "vote_proposal", "execute_proposal"]) {
    if (!instructionNames.has(required)) {
      throw new Error(`approved IDL is missing ${required}`);
    }
  }
  return { actualIdlSha256: actual, programId: PROGRAM_ID_STR, genesisHash };
}

function parseFeeChangeRpcUrl(value, label) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    throw new Error(`${label} is required`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use HTTP(S)`);
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must name an RPC host`);
  }
  return { parsed, raw };
}

/**
 * Require a secondary endpoint on a distinct host. Host diversity is only a
 * mechanically checkable floor: operators must still choose separately run
 * infrastructure, as documented in the fee-change runbook.
 */
export function requireDistinctSecondaryFeeChangeRpcUrl(
  primaryRpcUrl,
  secondaryRpcUrl,
) {
  const primary = parseFeeChangeRpcUrl(primaryRpcUrl, "RPC_URL");
  const secondary = parseFeeChangeRpcUrl(
    secondaryRpcUrl,
    "SECONDARY_RPC_URL",
  );
  const primaryHostname = primary.parsed.hostname
    .toLowerCase()
    .replace(/\.$/u, "");
  const secondaryHostname = secondary.parsed.hostname
    .toLowerCase()
    .replace(/\.$/u, "");
  if (primaryHostname === secondaryHostname) {
    throw new Error(
      "SECONDARY_RPC_URL must use a host distinct from RPC_URL",
    );
  }
  return secondary.raw;
}

export function assertSecondaryFeeChangeMainnetGenesis(genesisHash) {
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `secondary RPC genesis ${String(genesisHash)} is not mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  return { genesisHash };
}

function finalizedAccountScalar(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be non-negative`);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
    // web3.js exposes rentEpoch as a number, including the rent-exempt u64
    // sentinel outside the safe-integer range. Compare the exact representation
    // supplied by each independently parsed response rather than rejecting it.
    return String(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value).toString();
  }
  throw new Error(`${label} must be an unsigned integer`);
}

function decodeFinalizedFeeChangeAccountResponse(response, label) {
  const contextSlot = response?.context?.slot;
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 0) {
    throw new Error(`${label} finalized context slot is malformed`);
  }
  const account = response?.value;
  if (!account) {
    throw new Error(`${label} finalized Proposal account is missing`);
  }
  let owner;
  try {
    owner = account.owner instanceof PublicKey
      ? account.owner
      : new PublicKey(account.owner);
  } catch {
    throw new Error(`${label} finalized Proposal owner is malformed`);
  }
  if (!owner.equals(PROGRAM_ID)) {
    throw new Error(
      `${label} finalized Proposal owner ${owner.toBase58()} != ${PROGRAM_ID_STR}`,
    );
  }
  if (account.executable !== false) {
    throw new Error(`${label} finalized Proposal must be non-executable`);
  }
  const data = Buffer.from(account.data ?? []);
  if (data.length === 0) {
    throw new Error(`${label} finalized Proposal data is empty`);
  }
  return {
    contextSlot,
    data,
    executable: account.executable,
    lamports: finalizedAccountScalar(
      account.lamports,
      `${label} finalized Proposal lamports`,
    ),
    owner,
    rentEpoch: finalizedAccountScalar(
      account.rentEpoch,
      `${label} finalized Proposal rentEpoch`,
    ),
  };
}

/**
 * Compare every AccountInfo field returned by two finalized RPC reads. Context
 * slots may differ because independently operated nodes can have different
 * finalized roots; the account state itself must be identical.
 */
export function assertFinalizedFeeChangeAccountAgreement({
  primaryResponse,
  secondaryResponse,
}) {
  const primary = decodeFinalizedFeeChangeAccountResponse(
    primaryResponse,
    "primary RPC",
  );
  const secondary = decodeFinalizedFeeChangeAccountResponse(
    secondaryResponse,
    "secondary RPC",
  );
  const mismatches = [];
  if (!primary.owner.equals(secondary.owner)) mismatches.push("owner");
  if (primary.executable !== secondary.executable) mismatches.push("executable");
  if (primary.lamports !== secondary.lamports) mismatches.push("lamports");
  if (primary.rentEpoch !== secondary.rentEpoch) mismatches.push("rentEpoch");
  if (!primary.data.equals(secondary.data)) mismatches.push("data");
  if (mismatches.length > 0) {
    throw new Error(
      `finalized Proposal account disagreement between RPCs: ${mismatches.join(", ")}`,
    );
  }
  const stateDigest = createHash("sha256")
    .update(primary.owner.toBuffer())
    .update(Buffer.from([primary.executable ? 1 : 0]))
    .update(`${primary.lamports}\0${primary.rentEpoch}\0`, "utf8")
    .update(primary.data)
    .digest("hex");
  return {
    data: Buffer.from(primary.data),
    primaryContextSlot: primary.contextSlot,
    secondaryContextSlot: secondary.contextSlot,
    stateDigest,
  };
}

/**
 * Fetch an exact finalized Proposal snapshot from two RPCs, decode only the
 * agreed raw bytes, and bind those bytes to the operator's explicit intent.
 */
export async function readAgreedFinalizedFeeChangeProposal({
  primaryConnection,
  secondaryConnection: independentConnection,
  accountCoder,
  proposalAddress,
  intendedFeeBps,
  requireActive = true,
}) {
  if (
    typeof primaryConnection?.getAccountInfoAndContext !== "function" ||
    typeof independentConnection?.getAccountInfoAndContext !== "function"
  ) {
    throw new Error("both fee-change RPC connections are required");
  }
  if (
    typeof accountCoder?.accounts?.decode !== "function" ||
    typeof accountCoder?.accounts?.accountDiscriminator !== "function"
  ) {
    throw new Error("the approved Anchor account coder is required");
  }
  const proposalKey = asPublicKeyForProposal(
    proposalAddress,
    "proposal address",
  );
  const [primaryResponse, secondaryResponse] = await Promise.all([
    primaryConnection.getAccountInfoAndContext(proposalKey, {
      commitment: "finalized",
    }),
    independentConnection.getAccountInfoAndContext(proposalKey, {
      commitment: "finalized",
    }),
  ]);
  const agreement = assertFinalizedFeeChangeAccountAgreement({
    primaryResponse,
    secondaryResponse,
  });
  let proposal;
  try {
    // A raw Anchor IDL retains `Proposal`; Program converts it to `proposal`.
    // Select the approved coder name by discriminator instead of assuming one
    // representation or attempting to decode against an unrelated layout.
    const proposalAccountName = ["proposal", "Proposal"].find((name) => {
      try {
        return Buffer.from(
          accountCoder.accounts.accountDiscriminator(name),
        ).equals(agreement.data.subarray(0, 8));
      } catch {
        return false;
      }
    });
    if (!proposalAccountName) {
      throw new Error("Proposal discriminator is absent from the approved IDL");
    }
    proposal = accountCoder.accounts.decode(
      proposalAccountName,
      agreement.data,
    );
  } catch (error) {
    throw new Error(
      `agreed finalized Proposal bytes failed approved-IDL decode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assertCanonicalFeeChangeProposal(
    proposal,
    proposalKey,
    intendedFeeBps,
    { requireActive },
  );
  return { ...agreement, proposal };
}

function requiredApprovedSha256(value, label) {
  const expected = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      `${label} is required and must be an independently reviewed 64-hex digest`,
    );
  }
  return expected;
}

export function assertApprovedFeeChangeSbf(binaryBytes, expectedSoSha256) {
  const expected = requiredApprovedSha256(
    expectedSoSha256,
    "EXPECTED_SO_SHA256",
  );
  const binary = Buffer.from(binaryBytes ?? []);
  if (binary.length === 0) {
    throw new Error("approved SBF artifact is empty");
  }
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new Error(`SBF sha256 ${actual} != approved ${expected}`);
  }
  return { actualSoSha256: actual, binaryBytes: binary.length };
}

/**
 * Bind an approved local SBF to the exact live upgradeable-loader payload and
 * the strict committed loader/custody policy. Loader capacity may exceed the
 * ELF, but every byte after the approved image must be zero padding.
 */
export function assertMainnetFeeChangeExecutableBinding({
  genesisHash,
  policy,
  snapshot,
  binaryBytes,
  expectedSoSha256,
}) {
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `RPC genesis ${genesisHash} is not mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  if (policy?.genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `loader policy genesis ${String(policy?.genesisHash)} != mainnet-beta ${MAINNET_GENESIS}`,
    );
  }
  if (policy?.programId !== PROGRAM_ID_STR) {
    throw new Error(
      `loader policy program ${String(policy?.programId)} != ${PROGRAM_ID_STR}`,
    );
  }
  for (const [field, actual, expected] of [
    ["program", snapshot?.programId, PROGRAM_ID_STR],
    ["ProgramData", snapshot?.programData, policy?.expectedProgramData],
    ["loader", snapshot?.loaderProgramId, policy?.loaderProgramId],
    ["policy sha256", snapshot?.policySha256, policy?.policySha256],
  ]) {
    if (typeof expected !== "string" || actual !== expected) {
      throw new Error(
        `live loader ${field} ${String(actual)} != reviewed ${String(expected)}`,
      );
    }
  }
  if (!/^[0-9a-f]{64}$/.test(String(snapshot?.stateDigest ?? ""))) {
    throw new Error("live loader snapshot state digest is malformed");
  }
  const approval = assertApprovedFeeChangeSbf(binaryBytes, expectedSoSha256);
  const binary = Buffer.from(binaryBytes);
  const payload = Buffer.from(snapshot?.payload ?? []);
  if (payload.length < binary.length) {
    throw new Error(
      `live ProgramData payload ${payload.length} bytes is shorter than approved SBF ${binary.length}`,
    );
  }
  if (!payload.subarray(0, binary.length).equals(binary)) {
    throw new Error("live ProgramData executable bytes do not match the approved SBF");
  }
  if (!payload.subarray(binary.length).every((byte) => byte === 0)) {
    throw new Error("live ProgramData has nonzero bytes after the approved SBF");
  }
  return {
    ...approval,
    contextSlot: snapshot.contextSlot,
    programData: snapshot.programData,
    stateDigest: snapshot.stateDigest,
  };
}

export function assertFeeChangeLoaderSnapshotUnchanged({
  initial,
  immediate,
  policy,
  genesisHash,
  binaryBytes,
  expectedSoSha256,
}) {
  assertImmediatePreUpgradeSnapshot(initial, immediate);
  return assertMainnetFeeChangeExecutableBinding({
    genesisHash,
    policy,
    snapshot: immediate,
    binaryBytes,
    expectedSoSha256,
  });
}

export function decodeFeeChangeChainClockResponse(
  response,
  { minContextSlot = 0 } = {},
) {
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
    throw new Error("chain-clock minContextSlot must be a non-negative safe integer");
  }
  const contextSlot = response?.context?.slot;
  if (!Number.isSafeInteger(contextSlot) || contextSlot < minContextSlot) {
    throw new Error(
      `chain-clock context slot ${String(contextSlot)} is below required ${minContextSlot}`,
    );
  }
  const account = response?.value;
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
  if (unixTimestamp < 0n || unixTimestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Clock sysvar unix timestamp is outside the safe supported range");
  }
  return { contextSlot, unixTimestamp };
}

async function readFeeChangeChainClock(minContextSlot) {
  const response = await connection.getAccountInfoAndContext(
    SYSVAR_CLOCK_PUBKEY,
    { commitment: "confirmed", minContextSlot },
  );
  return decodeFeeChangeChainClockResponse(response, { minContextSlot });
}

export function validateGovernanceInitializationTiming(
  votingPeriod,
  executionDelay,
) {
  if (
    !Number.isSafeInteger(votingPeriod) ||
    votingPeriod < 1 ||
    votingPeriod > MAX_GOVERNANCE_PERIOD_SECS
  ) {
    throw new Error(
      `VOTING_PERIOD_SECS must be in 1..${MAX_GOVERNANCE_PERIOD_SECS}`,
    );
  }
  if (
    !Number.isSafeInteger(executionDelay) ||
    executionDelay < 0 ||
    executionDelay > MAX_GOVERNANCE_PERIOD_SECS
  ) {
    throw new Error(
      `EXECUTION_DELAY_SECS must be in 0..${MAX_GOVERNANCE_PERIOD_SECS}`,
    );
  }
  return { votingPeriod, executionDelay };
}

export function effectiveProposalVotingPeriod(requested, configured) {
  if (
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > MAX_GOVERNANCE_PERIOD_SECS
  ) {
    throw new Error("live governance voting period is outside 1..604800");
  }
  if (!Number.isSafeInteger(requested)) {
    throw new Error("PROPOSAL_VOTING_PERIOD_SECS must be a safe integer");
  }
  return requested > 0
    ? Math.max(configured, Math.min(requested, MAX_GOVERNANCE_PERIOD_SECS))
    : configured;
}

export function validateIntendedFeeBps(value) {
  const raw = String(value ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("NEW_FEE_BPS is required and must be a canonical integer in 0..2000");
  }
  const fee = Number(raw);
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 2_000) {
    throw new Error("NEW_FEE_BPS is required and must be in 0..2000");
  }
  return fee;
}

function anchorEnumVariant(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.replaceAll("_", "").toLowerCase();
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 1 ? keys[0].replaceAll("_", "").toLowerCase() : null;
  }
  return null;
}

/**
 * Bind a signing action to one canonical FeeChange proposal and fee. This is
 * intentionally stricter than the on-chain execute router: the operator rail
 * must never approve or execute an arbitrary compatible proposal address.
 */
export function assertCanonicalFeeChangeProposal(
  proposal,
  proposalAddress,
  intendedFeeBps,
  { requireActive = true } = {},
) {
  const intendedFee = validateIntendedFeeBps(intendedFeeBps);
  const proposalType = anchorEnumVariant(proposal?.proposalType ?? proposal?.proposal_type);
  if (proposalType !== 1 && proposalType !== "feechange") {
    throw new Error(`proposal type is not FeeChange (got ${String(proposalType)})`);
  }
  const payload = Buffer.from(proposal?.payload ?? []);
  if (payload.length !== 64) {
    throw new Error(`FeeChange payload length ${payload.length} != canonical 64`);
  }
  const encodedFee = payload.readUInt16LE(0);
  if (encodedFee !== intendedFee) {
    throw new Error(
      `FeeChange payload fee ${encodedFee} != explicitly intended ${intendedFee}`,
    );
  }
  if (!payload.subarray(2).equals(Buffer.alloc(62))) {
    throw new Error("FeeChange payload has nonzero trailing bytes");
  }
  const canonicalTitleHash = createHash("sha256")
    .update(`Set protocol_fee_bps to ${intendedFee}`)
    .digest();
  if (!Buffer.from(proposal?.titleHash ?? proposal?.title_hash ?? []).equals(canonicalTitleHash)) {
    throw new Error("FeeChange title hash does not match the canonical intended-fee title");
  }
  if (requireActive) {
    const status = anchorEnumVariant(proposal?.status);
    if (status !== 0 && status !== "active") {
      throw new Error(`FeeChange proposal is not Active (got ${String(status)})`);
    }
  }
  const proposer = asPublicKeyForProposal(proposal?.proposer, "proposal proposer");
  let nonce;
  try {
    nonce = BigInt(proposal?.nonce?.toString?.() ?? proposal?.nonce);
  } catch {
    throw new Error("proposal nonce is malformed");
  }
  if (nonce < 0n || nonce > ((1n << 64n) - 1n)) {
    throw new Error("proposal nonce is outside u64");
  }
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const [canonicalProposal] = PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), proposer.toBuffer(), nonceBytes],
    PROGRAM_ID,
  );
  const suppliedProposal = asPublicKeyForProposal(proposalAddress, "proposal address");
  if (!suppliedProposal.equals(canonicalProposal)) {
    throw new Error(
      `proposal ${suppliedProposal.toBase58()} is not canonical ` +
        `${canonicalProposal.toBase58()} for its proposer/nonce`,
    );
  }
  return { intendedFeeBps: intendedFee, proposal: canonicalProposal };
}

function asPublicKeyForProposal(value, label) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
}

function voteWeight(stake, reputation, cap) {
  const normalizedStake = asBigInt(stake);
  const stakeWeight = normalizedStake < cap ? normalizedStake : cap;
  const weight = (stakeWeight * BigInt(reputation)) / MAX_REPUTATION;
  return stakeWeight > 0n && weight === 0n ? 1n : weight;
}

export function selectBestGovernanceVoter(eligible, rules) {
  if (!Array.isArray(eligible) || eligible.length === 0) {
    throw new Error("no eligible governance voter was supplied");
  }
  const ranked = eligible.map((candidate) => {
    if (!candidate?.publicKey?.toBase58 || !candidate?.account) {
      throw new Error("eligible governance voter entry is malformed");
    }
    return {
      candidate,
      publicKeyBytes: Buffer.from(candidate.publicKey.toBuffer()),
      weight: voteWeight(
        candidate.account.stake,
        candidate.account.reputation,
        rules.maxVoteWeight,
      ),
    };
  });
  ranked.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
    return Buffer.compare(a.publicKeyBytes, b.publicKeyBytes);
  });
  return { voter: ranked[0].candidate, weight: ranked[0].weight };
}

function freshProposalRequirements(
  minProposalStake,
  minArbiterStake,
  quorumBps,
  approvalThresholdBps,
) {
  if (!Number.isInteger(quorumBps) || quorumBps < 1 || quorumBps > 10_000) {
    throw new Error(`quorum_bps=${quorumBps} must be in 1..10000`);
  }
  if (
    !Number.isInteger(approvalThresholdBps) ||
    approvalThresholdBps < 1 ||
    approvalThresholdBps >= 10_000
  ) {
    throw new Error(
      `approval_threshold_bps=${approvalThresholdBps} must be in 1..9999`,
    );
  }
  const configuredMinimum = asBigInt(minProposalStake);
  const minVoterStake = configuredMinimum > MIN_GOVERNANCE_VOTER_STAKE
    ? configuredMinimum
    : MIN_GOVERNANCE_VOTER_STAKE;
  const maxVoteWeight = asBigInt(minArbiterStake) *
    GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER;
  if (maxVoteWeight > U64_MAX) {
    throw new Error(`per-voter cap=${maxVoteWeight} exceeds u64`);
  }
  if (configuredMinimum < 1n || minVoterStake > maxVoteWeight) {
    throw new Error(
      `min_proposal_stake=${configuredMinimum} min_voter_stake=${minVoterStake} ` +
        `exceeds per-voter cap=${maxVoteWeight}`,
    );
  }
  const minimumElectorateCapacity = maxVoteWeight *
    MIN_GOVERNANCE_DISTINCT_VOTERS;
  if (minimumElectorateCapacity > U64_MAX) {
    throw new Error(
      `minimum electorate capacity=${minimumElectorateCapacity} exceeds u64`,
    );
  }
  if (minimumElectorateCapacity < MIN_GOVERNANCE_QUORUM_WEIGHT) {
    throw new Error(
      `minimum electorate capacity=${minimumElectorateCapacity} cannot attain ` +
        `hard quorum=${MIN_GOVERNANCE_QUORUM_WEIGHT}`,
    );
  }
  const minimumStakeQuorum = minVoterStake * MIN_GOVERNANCE_DISTINCT_VOTERS;
  const percentageQuorum =
    (minimumElectorateCapacity * BigInt(quorumBps) + 9_999n) / 10_000n;
  const quorum = [
    MIN_GOVERNANCE_QUORUM_WEIGHT,
    minimumStakeQuorum,
    percentageQuorum,
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  if (quorum > minimumElectorateCapacity) {
    throw new Error(
      `quorum=${quorum} exceeds minimum electorate capacity=` +
        `${minimumElectorateCapacity}`,
    );
  }
  return {
    minVoterStake,
    minVoterReputation: MIN_GOVERNANCE_VOTER_REPUTATION,
    maxVoteWeight,
    minDistinctVoters: Number(MIN_GOVERNANCE_DISTINCT_VOTERS),
    approvalThresholdBps,
    minimumElectorateCapacity,
    minimumStakeQuorum,
    percentageQuorum,
    quorum,
  };
}

function decodeProposalRules(proposal) {
  const reserved = Buffer.from(proposal._reserved);
  if (reserved.length !== 64 || reserved[0] !== 1) {
    throw new Error("proposal has no revision-5 governance rules snapshot");
  }
  if (!reserved.subarray(23).equals(Buffer.alloc(41))) {
    throw new Error("proposal governance rules snapshot has nonzero trailing bytes");
  }
  const rules = {
    minVoterStake: reserved.readBigUInt64LE(1),
    minVoterReputation: reserved.readUInt16LE(9),
    maxVoteWeight: reserved.readBigUInt64LE(11),
    minDistinctVoters: reserved.readUInt16LE(19),
    approvalThresholdBps: reserved.readUInt16LE(21),
  };
  // Mirror ProposalGovernanceRules::validate exactly. execute_proposal turns a
  // corrupt snapshot into a durable Defeated terminal record, so the signing
  // rail must reject it before broadcasting rather than discovering corruption
  // from the irreversible post-image.
  if (rules.minVoterStake < MIN_GOVERNANCE_VOTER_STAKE) {
    throw new Error(
      "proposal governance rules snapshot has invalid min_voter_stake",
    );
  }
  if (
    rules.minVoterReputation < MIN_GOVERNANCE_VOTER_REPUTATION ||
    rules.minVoterReputation > Number(MAX_REPUTATION)
  ) {
    throw new Error(
      "proposal governance rules snapshot has invalid min_voter_reputation",
    );
  }
  if (rules.maxVoteWeight < rules.minVoterStake) {
    throw new Error(
      "proposal governance rules snapshot has invalid max_vote_weight",
    );
  }
  if (rules.minDistinctVoters < Number(MIN_GOVERNANCE_DISTINCT_VOTERS)) {
    throw new Error(
      "proposal governance rules snapshot has invalid min_distinct_voters",
    );
  }
  if (
    rules.approvalThresholdBps < 1 ||
    rules.approvalThresholdBps >= 10_000
  ) {
    throw new Error(
      "proposal governance rules snapshot has invalid approval_threshold_bps",
    );
  }
  return rules;
}

function proposalUnsignedInteger(value, label, maximum = U64_MAX) {
  let parsed;
  try {
    parsed = BigInt(value?.toString?.() ?? value);
  } catch {
    throw new Error(`${label} is malformed`);
  }
  if (parsed < 0n || parsed > maximum) {
    throw new Error(`${label} is outside its unsigned integer range`);
  }
  return parsed;
}

/** Mirror the on-chain election/timelock checks before a finalize broadcast. */
export function assertFeeChangeExecutionReady(proposal, nowUnixSeconds) {
  const now = proposalUnsignedInteger(
    nowUnixSeconds,
    "current unix timestamp",
    BigInt(Number.MAX_SAFE_INTEGER),
  );
  const votingDeadline = proposalUnsignedInteger(
    proposal?.votingDeadline ?? proposal?.voting_deadline,
    "proposal voting deadline",
  );
  if (now < votingDeadline) {
    throw new Error("proposal voting period has not ended");
  }

  const rules = decodeProposalRules(proposal);
  const votesFor = proposalUnsignedInteger(
    proposal?.votesFor ?? proposal?.votes_for,
    "proposal votes_for",
  );
  const votesAgainst = proposalUnsignedInteger(
    proposal?.votesAgainst ?? proposal?.votes_against,
    "proposal votes_against",
  );
  const totalVotes = votesFor + votesAgainst;
  if (totalVotes > U64_MAX) {
    throw new Error("proposal total vote weight overflows u64");
  }
  const quorum = proposalUnsignedInteger(proposal?.quorum, "proposal quorum");
  const totalVoters = proposalUnsignedInteger(
    proposal?.totalVoters ?? proposal?.total_voters,
    "proposal total_voters",
    65_535n,
  );
  const electionPassed =
    totalVotes > 0n &&
    totalVotes >= quorum &&
    totalVoters >= BigInt(rules.minDistinctVoters) &&
    votesFor * 10_000n >
      totalVotes * BigInt(rules.approvalThresholdBps);
  if (!electionPassed) {
    throw new Error(
      "proposal election does not meet quorum, distinct-voter, and approval requirements and would be Defeated",
    );
  }

  const executionAfter = proposalUnsignedInteger(
    proposal?.executionAfter ?? proposal?.execution_after,
    "proposal execution_after",
  );
  if (now < executionAfter) {
    throw new Error("proposal execution timelock has not elapsed");
  }
  if (now > executionAfter + PROPOSAL_EXECUTION_WINDOW_SECS) {
    throw new Error("proposal execution window expired and would be Defeated");
  }
  return { executionAfter, votingDeadline };
}

/** Require both the intended fee and an Executed proposal post-image. */
export function assertExecutedFeeChangePostImage(
  proposal,
  protocolFeeBps,
  intendedFeeBps,
) {
  const intendedFee = validateIntendedFeeBps(intendedFeeBps);
  const status = anchorEnumVariant(proposal?.status);
  if (status !== 1 && status !== "executed") {
    throw new Error(
      `FeeChange proposal post-status is not Executed (got ${String(status)})`,
    );
  }
  const actualFee = Number(protocolFeeBps?.toString?.() ?? protocolFeeBps);
  if (!Number.isSafeInteger(actualFee) || actualFee !== intendedFee) {
    throw new Error(
      `post-execution protocol_fee_bps=${String(protocolFeeBps)} != intended ${intendedFee}`,
    );
  }
  return { intendedFeeBps: intendedFee, status: "executed" };
}

function isActiveAgent(agent) {
  const variant = Object.keys(agent.status ?? {})[0]?.toLowerCase();
  return variant === "active" && agent.retired !== true;
}

export function agentAuthorityMemcmpFilter(authorityPk) {
  const authority = asPublicKeyForProposal(authorityPk, "agent authority");
  return {
    memcmp: {
      // Anchor discriminator (8) + AgentRegistration.agent_id ([u8; 32]).
      offset: AGENT_REGISTRATION_AUTHORITY_OFFSET,
      bytes: authority.toBase58(),
    },
  };
}

export async function fetchAgentsOwnedBy(programClient, authorityPk) {
  const authority = asPublicKeyForProposal(authorityPk, "agent authority");
  const registrations = await programClient?.account?.agentRegistration?.all?.([
    agentAuthorityMemcmpFilter(authority),
  ]);
  if (!Array.isArray(registrations)) {
    throw new Error("agent-registration GPA response is malformed");
  }
  for (const registration of registrations) {
    if (!registration?.account?.authority?.equals?.(authority)) {
      throw new Error(
        "agent-registration GPA returned an account outside the authority filter",
      );
    }
  }
  return registrations;
}

async function sendIx(
  builder,
  label,
  { preBroadcast, preSign, signers: extraSigners = [], postConfirmation } = {},
) {
  if (!EXECUTE) {
    console.log(`DRY-RUN: would send ${label} (pass --execute to send)`);
    return null;
  }
  let minContextSlot = approvedLoaderSnapshot.contextSlot;
  if (preBroadcast) {
    const result = await preBroadcast();
    if (result?.contextSlot !== undefined) {
      if (!Number.isSafeInteger(result.contextSlot) || result.contextSlot < 0) {
        throw new Error(`${label} pre-broadcast context slot is malformed`);
      }
      minContextSlot = Math.max(minContextSlot, result.contextSlot);
    }
  }
  const immediateLoader = await readProgramUpgradeAuthoritySnapshot(
    connection,
    upgradeAuthorityPolicy,
    { commitment: "confirmed", minContextSlot },
  );
  assertFeeChangeLoaderSnapshotUnchanged({
    initial: approvedLoaderSnapshot,
    immediate: immediateLoader,
    policy: upgradeAuthorityPolicy,
    genesisHash: MAINNET_GENESIS,
    binaryBytes: soBytes,
    expectedSoSha256,
  });
  console.log(
    `PRE-BROADCAST loader/custody unchanged at context slot ${immediateLoader.contextSlot}`,
  );
  // Resolve the complete instruction and blockhash before the independent
  // finalized-state callback. After that callback returns, only local assembly
  // and signing occur before the raw bytes are submitted.
  const built = await builder.transaction();
  const latest = await connection.getLatestBlockhash("confirmed");
  if (preSign) await preSign();
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...built.instructions);
  const transactionSigners = [signer, ...extraSigners].filter(
    (candidate, index, all) =>
      all.findIndex((other) =>
        other.publicKey.equals(candidate.publicKey),
      ) === index,
  );
  transaction.sign(...transactionSigners);
  const sig = await submitLocallySignedTransaction({
    connection,
    transaction,
    label,
    sendOptions: {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    },
  });
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
      confirmationSlot < immediateLoader.contextSlot
    ) {
      throw new Error(
        `confirmation context slot ${String(confirmationSlot)} is invalid or below ` +
          `pre-broadcast slot ${immediateLoader.contextSlot}`,
      );
    }
    const postLoader = await readProgramUpgradeAuthoritySnapshot(
      connection,
      upgradeAuthorityPolicy,
      { commitment: "confirmed", minContextSlot: confirmationSlot },
    );
    assertFeeChangeLoaderSnapshotUnchanged({
      initial: approvedLoaderSnapshot,
      immediate: postLoader,
      policy: upgradeAuthorityPolicy,
      genesisHash: MAINNET_GENESIS,
      binaryBytes: soBytes,
      expectedSoSha256,
    });
    if (postConfirmation) {
      await postConfirmation(Math.max(confirmationSlot, postLoader.contextSlot));
    }
  } catch (error) {
    throw new Error(
      `${label} transaction ${sig} was submitted, but confirmation/post-image ` +
        `verification failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  console.log(`CONFIRMED ${label}: ${sig}`);
  return sig;
}

async function main() {
  const signerPath =
    MODE === "propose" ? process.env.PROPOSER_KEYPAIR
    : MODE === "vote" ? process.env.VOTER_KEYPAIR
    : MODE === "init-governance" || MODE === "finalize" ? process.env.AUTHORITY_KEYPAIR
    : null;
  if (MODE !== "plan" && !signerPath) {
    die(`${MODE} needs ${MODE === "propose" ? "PROPOSER_KEYPAIR" : MODE === "vote" ? "VOTER_KEYPAIR" : "AUTHORITY_KEYPAIR"}`);
  }
  const idlPathRaw = process.env.IDL_PATH || "artifacts/anchor/idl/agenc_coordination.json";
  idlPath = path.isAbsolute(idlPathRaw) ? idlPathRaw : path.join(ROOT, idlPathRaw);
  idlBytes = readFileSync(idlPath);
  idl = JSON.parse(idlBytes.toString("utf8"));
  const soPathRaw = process.env.SO_PATH ||
    "programs/agenc-coordination/target/deploy/agenc_coordination.so";
  soPath = path.isAbsolute(soPathRaw) ? soPathRaw : path.join(ROOT, soPathRaw);
  soBytes = readFileSync(soPath);
  expectedSoSha256 = process.env.EXPECTED_SO_SHA256;
  // Validate every local binding before reading a key or touching RPC. The
  // second IDL call below substitutes the actual cluster genesis.
  assertMainnetFeeChangeRailBinding({
    genesisHash: MAINNET_GENESIS,
    programId: process.env.PROGRAM_ID || PROGRAM_ID_STR,
    idl,
    idlBytes,
    expectedIdlSha256: process.env.EXPECTED_IDL_SHA256,
  });
  const localSbfApproval = assertApprovedFeeChangeSbf(
    soBytes,
    expectedSoSha256,
  );
  upgradeAuthorityPolicy = loadReviewedUpgradeAuthorityPolicy();
  connection = new Connection(RPC_URL, "confirmed");
  const genesisHash = await connection.getGenesisHash();
  const binding = assertMainnetFeeChangeRailBinding({
    genesisHash,
    programId: process.env.PROGRAM_ID || PROGRAM_ID_STR,
    idl,
    idlBytes,
    expectedIdlSha256: process.env.EXPECTED_IDL_SHA256,
  });
  approvedLoaderSnapshot = await readProgramUpgradeAuthoritySnapshot(
    connection,
    upgradeAuthorityPolicy,
    { commitment: "confirmed" },
  );
  const executableBinding = assertMainnetFeeChangeExecutableBinding({
    genesisHash,
    policy: upgradeAuthorityPolicy,
    snapshot: approvedLoaderSnapshot,
    binaryBytes: soBytes,
    expectedSoSha256,
  });
  const needsIndependentProposalRead =
    EXECUTE && (MODE === "vote" || MODE === "finalize");
  if (needsIndependentProposalRead) {
    const secondaryRpcUrl = requireDistinctSecondaryFeeChangeRpcUrl(
      RPC_URL,
      process.env.SECONDARY_RPC_URL,
    );
    secondaryConnection = new Connection(secondaryRpcUrl, "finalized");
    const secondaryGenesisHash = await secondaryConnection.getGenesisHash();
    assertSecondaryFeeChangeMainnetGenesis(secondaryGenesisHash);
  }
  // Only now, after local approvals, primary mainnet genesis, executable bytes,
  // loader custody, and (for executing vote/finalize) the independent endpoint's
  // mainnet genesis all match, is signing material read from disk.
  signer = signerPath ? loadKeypair(signerPath) : Keypair.generate();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(signer),
    { commitment: "confirmed" },
  );
  program = new anchor.Program(idl, provider);
  [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
  [governancePda] = PublicKey.findProgramAddressSync([Buffer.from("governance")], PROGRAM_ID);
  console.log(`mode=${MODE} execute=${EXECUTE} rpc=<redacted-rpc>`);
  console.log(`program=${PROGRAM_ID.toBase58()}`);
  console.log(`cluster=${binding.genesisHash} (mainnet-beta)`);
  if (needsIndependentProposalRead) {
    console.log("secondary RPC=<redacted-rpc> genesis=mainnet-beta distinct_host=YES");
  }
  console.log(`approved IDL=${idlPath} sha256=${binding.actualIdlSha256}`);
  console.log(
    `approved SBF=${soPath} bytes=${localSbfApproval.binaryBytes} ` +
      `sha256=${executableBinding.actualSoSha256}`,
  );
  console.log(
    `live ProgramData=${executableBinding.programData} ` +
      `context_slot=${executableBinding.contextSlot} exact=YES`,
  );
  console.log(
    `loader/custody policy=${upgradeAuthorityPolicy.policyPath} ` +
      `sha256=${upgradeAuthorityPolicy.policySha256}`,
  );

  const config = await program.account.protocolConfig.fetch(protocolPda);
  console.log(`\nProtocolConfig: authority=${config.authority.toBase58()}`);
  console.log(`  protocol_fee_bps=${config.protocolFeeBps} (current)`);
  console.log(`  total_agents=${config.totalAgents} min_arbiter_stake=${fmt(config.minArbiterStake)}`);

  const govInfo = await connection.getAccountInfo(governancePda);
  let governance = null;
  if (govInfo) {
    governance = await program.account.governanceConfig.fetch(governancePda);
    console.log(`\nGovernanceConfig: INITIALIZED`);
    console.log(`  voting_period=${governance.votingPeriod}s execution_delay=${governance.executionDelay}s`);
    console.log(`  quorum_bps=${governance.quorumBps} approval_threshold_bps=${governance.approvalThresholdBps}`);
    console.log(`  min_proposal_stake=${fmt(governance.minProposalStake)} total_proposals=${governance.totalProposals}`);
  } else {
    console.log(`\nGovernanceConfig: NOT INITIALIZED (["governance"] PDA empty) — run --init-governance first.`);
  }

  /* ----------------------------- init-governance ----------------------------- */
  if (MODE === "init-governance") {
    if (govInfo) die("governance is already initialized — parameters are PERMANENT and cannot be re-set.");
    if (!signer.publicKey.equals(config.authority)) {
      die(`AUTHORITY_KEYPAIR pubkey ${signer.publicKey.toBase58()} != ProtocolConfig.authority ${config.authority.toBase58()}`);
    }
    const votingPeriod = envInt("VOTING_PERIOD_SECS", 86_400);
    const executionDelay = envInt("EXECUTION_DELAY_SECS", 3_600);
    const quorumBps = envInt("QUORUM_BPS", 300);
    const approvalBps = envInt("APPROVAL_THRESHOLD_BPS", 5_000);
    const minProposalStake = envInt("MIN_PROPOSAL_STAKE_LAMPORTS", 10_000_000);
    validateGovernanceInitializationTiming(votingPeriod, executionDelay);

    const requirements = freshProposalRequirements(
      minProposalStake,
      config.minArbiterStake,
      quorumBps,
      approvalBps,
    );
    console.log(`\nPLAN initialize_governance (PERMANENT):`);
    console.log(`  voting_period=${votingPeriod}s (${(votingPeriod / 3600).toFixed(1)}h)`);
    console.log(`  execution_delay=${executionDelay}s quorum_bps=${quorumBps} approval=${approvalBps}`);
    console.log(`  min_proposal_stake=${fmt(minProposalStake)} lamports`);
    console.log(
      `  -> hard quorum=${fmt(requirements.quorum)} ` +
        `min_distinct_voters=${requirements.minDistinctVoters} ` +
        `min_voter_stake=${fmt(requirements.minVoterStake)} ` +
        `min_voter_reputation=${requirements.minVoterReputation}`,
    );

    await sendIx(
      program.methods
        .initializeGovernance(
          new anchor.BN(votingPeriod),
          new anchor.BN(executionDelay),
          quorumBps,
          approvalBps,
          new anchor.BN(minProposalStake),
        )
        .accounts({
          governanceConfig: governancePda,
          protocolConfig: protocolPda,
          authority: signer.publicKey,
        }),
      "initialize_governance",
    );
    return;
  }

  /* --------------------------------- propose --------------------------------- */
  if (MODE === "propose") {
    if (!governance) die("governance not initialized — run --init-governance first.");
    const newFeeBps = validateIntendedFeeBps(process.env.NEW_FEE_BPS);

    const agents = await fetchAgentsOwnedBy(program, signer.publicKey);
    const requirements = freshProposalRequirements(
      governance.minProposalStake,
      config.minArbiterStake,
      governance.quorumBps,
      governance.approvalThresholdBps,
    );
    const proposerAgent = agents.find((a) =>
      isActiveAgent(a.account) &&
      asBigInt(a.account.stake) >= requirements.minVoterStake &&
      a.account.reputation >= requirements.minVoterReputation
    );
    if (!proposerAgent) {
      die(
        `wallet ${signer.publicKey.toBase58()} owns no Active agent with ` +
          `stake >= ${requirements.minVoterStake} and reputation >= ` +
          `${requirements.minVoterReputation} (owned: ${agents.length})`,
      );
    }
    const nonce = new anchor.BN(Date.now());
    const [proposalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), proposerAgent.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID,
    );
    const title = `Set protocol_fee_bps to ${newFeeBps}`;
    const description = `Change protocol_fee_bps from ${config.protocolFeeBps} to ${newFeeBps}. New tasks snapshot the new fee; existing tasks keep their locked fee.`;
    const payload = Buffer.alloc(64);
    payload.writeUInt16LE(newFeeBps, 0);
    const configuredVotingPeriod = Number(governance.votingPeriod);
    const requestedVotingPeriod = envInt(
      "PROPOSAL_VOTING_PERIOD_SECS",
      configuredVotingPeriod,
    );
    const votingPeriod = effectiveProposalVotingPeriod(
      requestedVotingPeriod,
      configuredVotingPeriod,
    );

    console.log(`\nPLAN create_proposal (FeeChange):`);
    console.log(`  proposer agent=${proposerAgent.publicKey.toBase58()} (stake=${fmt(proposerAgent.account.stake)})`);
    console.log(`  proposal PDA=${proposalPda.toBase58()} nonce=${nonce.toString()}`);
    console.log(
      `  ${config.protocolFeeBps} bps -> ${newFeeBps} bps | ` +
        `voting_period=${votingPeriod}s` +
        (requestedVotingPeriod === votingPeriod
          ? ""
          : ` (requested ${requestedVotingPeriod}s; normalized by on-chain floor/cap)`),
    );
    console.log(`  title="${title}"`);

    await sendIx(
      program.methods
        .createProposal(
          nonce,
          1, // ProposalType::FeeChange
          [...createHash("sha256").update(title).digest()],
          [...createHash("sha256").update(description).digest()],
          [...payload],
          new anchor.BN(votingPeriod),
        )
        .accounts({
          proposal: proposalPda,
          proposer: proposerAgent.publicKey,
          protocolConfig: protocolPda,
          governanceConfig: governancePda,
          authority: signer.publicKey,
        }),
      "create_proposal",
    );
    console.log(`\nKEEP THE TITLE + DESCRIPTION TEXT — only their sha-256 goes on-chain:\n  title: ${title}\n  description: ${description}`);
    if (EXECUTE) console.log(`\nNext: vote with PROPOSAL=${proposalPda.toBase58()}`);
    return;
  }

  /* ----------------------------------- vote ---------------------------------- */
  if (MODE === "vote") {
    if (!governance) die("governance not initialized.");
    const intendedFeeBps = validateIntendedFeeBps(process.env.NEW_FEE_BPS);
    const proposalPda = new PublicKey(process.env.PROPOSAL || die("PROPOSAL=<pda> required"));
    const proposal = await program.account.proposal.fetch(proposalPda);
    assertCanonicalFeeChangeProposal(proposal, proposalPda, intendedFeeBps);
    const rules = decodeProposalRules(proposal);
    const agents = await fetchAgentsOwnedBy(program, signer.publicKey);
    const eligible = agents.filter((a) =>
      isActiveAgent(a.account) &&
      asBigInt(a.account.stake) >= rules.minVoterStake &&
      a.account.reputation >= rules.minVoterReputation &&
      a.account.reputation <= Number(MAX_REPUTATION)
    );
    if (!eligible.length) {
      die(
        `wallet ${signer.publicKey.toBase58()} owns no Active agent eligible ` +
          `under this proposal's immutable rules`,
      );
    }
    const { voter, weight } = selectBestGovernanceVoter(eligible, rules);
    const [votePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("governance_vote"), proposalPda.toBuffer(), signer.publicKey.toBuffer()],
      PROGRAM_ID,
    );
    console.log(`\nPLAN vote_proposal(approve=true):`);
    console.log(`  bound FeeChange intent: protocol_fee_bps -> ${intendedFeeBps}`);
    console.log(`  proposal=${proposalPda.toBase58()} deadline=${new Date(Number(proposal.votingDeadline) * 1000).toISOString()}`);
    console.log(`  votes_for=${fmt(proposal.votesFor)} votes_against=${fmt(proposal.votesAgainst)} quorum=${fmt(proposal.quorum)}`);
    console.log(`  voting agent=${voter.publicKey.toBase58()} weight=${fmt(weight)}`);

    await sendIx(
      program.methods.voteProposal(true).accounts({
        proposal: proposalPda,
        vote: votePda,
        voter: voter.publicKey,
        protocolConfig: protocolPda,
        authority: signer.publicKey,
      }),
      "vote_proposal",
      {
        preSign: async () => {
          const agreed = await readAgreedFinalizedFeeChangeProposal({
            primaryConnection: connection,
            secondaryConnection,
            accountCoder: program.coder,
            proposalAddress: proposalPda,
            intendedFeeBps,
          });
          console.log(
            `PRE-SIGN finalized Proposal agreement sha256=${agreed.stateDigest} ` +
              `primary_slot=${agreed.primaryContextSlot} ` +
              `secondary_slot=${agreed.secondaryContextSlot}`,
          );
        },
      },
    );
    return;
  }

  /* --------------------------------- finalize -------------------------------- */
  if (MODE === "finalize") {
    if (!governance) die("governance not initialized.");
    const intendedFeeBps = validateIntendedFeeBps(process.env.NEW_FEE_BPS);
    const proposalPda = new PublicKey(process.env.PROPOSAL || die("PROPOSAL=<pda> required"));
    const proposal = await program.account.proposal.fetch(proposalPda);
    assertCanonicalFeeChangeProposal(proposal, proposalPda, intendedFeeBps);
    const chainClock = await readFeeChangeChainClock(
      approvedLoaderSnapshot.contextSlot,
    );
    const now = chainClock.unixTimestamp;
    const deadline = Number(proposal.votingDeadline);
    const execAfter = Number(proposal.executionAfter);
    console.log(`\nPLAN execute_proposal:`);
    console.log(`  bound FeeChange intent: protocol_fee_bps -> ${intendedFeeBps}`);
    console.log(`  votes_for=${fmt(proposal.votesFor)} votes_against=${fmt(proposal.votesAgainst)} quorum=${fmt(proposal.quorum)}`);
    console.log(`  voting ends ${new Date(deadline * 1000).toISOString()} | executable after ${new Date(execAfter * 1000).toISOString()}`);
    console.log(
      `  chain time=${now} (confirmed context slot ${chainClock.contextSlot})`,
    );
    let readinessError = null;
    try {
      assertFeeChangeExecutionReady(proposal, now);
    } catch (error) {
      readinessError = error instanceof Error ? error.message : String(error);
      console.log(`  NOT EXECUTABLE: ${readinessError}`);
    }
    if (EXECUTE && readinessError !== null) {
      die(`refusing finalize broadcast: ${readinessError}`);
    }

    const configuredOwners = config.multisigOwners
      .slice(0, config.multisigOwnersLen)
      .map((owner) => owner.toBase58());
    const ownerPaths = (process.env.MULTISIG_OWNER_KEYPAIRS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const ownerKeypairs = ownerPaths.map(loadKeypair);
    const availableByKey = new Map(
      [signer, ...ownerKeypairs]
        .filter((keypair) => configuredOwners.includes(keypair.publicKey.toBase58()))
        .map((keypair) => [keypair.publicKey.toBase58(), keypair]),
    );
    const availableOwners = [...availableByKey.values()];
    console.log(
      `  current multisig threshold=${config.multisigThreshold}/` +
        `${config.multisigOwnersLen} supplied_unique_owners=${availableOwners.length}`,
    );
    if (EXECUTE && availableOwners.length < config.multisigThreshold) {
      die(
        `finalize needs ${config.multisigThreshold} unique current owner keys; ` +
          `${availableOwners.length} supplied`,
      );
    }
    const ownerMetas = availableOwners.map((keypair) => ({
      pubkey: keypair.publicKey,
      isSigner: true,
      isWritable: false,
    }));
    const additionalSigners = availableOwners.filter(
      (keypair) => !keypair.publicKey.equals(signer.publicKey),
    );

    await sendIx(
      program.methods.executeProposal().accounts({
        proposal: proposalPda,
        protocolConfig: protocolPda,
        governanceConfig: governancePda,
        authority: signer.publicKey,
        treasury: null,
        recipient: null,
      })
        .remainingAccounts(ownerMetas),
      "execute_proposal",
      {
        signers: additionalSigners,
        preBroadcast: async () => {
          const [proposalBeforeSend, immediateClock] = await Promise.all([
            program.account.proposal.fetch(proposalPda),
            readFeeChangeChainClock(chainClock.contextSlot),
          ]);
          assertCanonicalFeeChangeProposal(
            proposalBeforeSend,
            proposalPda,
            intendedFeeBps,
          );
          assertFeeChangeExecutionReady(
            proposalBeforeSend,
            immediateClock.unixTimestamp,
          );
          return immediateClock;
        },
        preSign: async () => {
          const [agreed, immediateClock] = await Promise.all([
            readAgreedFinalizedFeeChangeProposal({
              primaryConnection: connection,
              secondaryConnection,
              accountCoder: program.coder,
              proposalAddress: proposalPda,
              intendedFeeBps,
            }),
            readFeeChangeChainClock(chainClock.contextSlot),
          ]);
          assertFeeChangeExecutionReady(
            agreed.proposal,
            immediateClock.unixTimestamp,
          );
          console.log(
            `PRE-SIGN finalized Proposal agreement sha256=${agreed.stateDigest} ` +
              `primary_slot=${agreed.primaryContextSlot} ` +
              `secondary_slot=${agreed.secondaryContextSlot}`,
          );
        },
      },
    );
    if (EXECUTE) {
      const [after, proposalAfter] = await Promise.all([
        program.account.protocolConfig.fetch(protocolPda),
        program.account.proposal.fetch(proposalPda),
      ]);
      assertCanonicalFeeChangeProposal(
        proposalAfter,
        proposalPda,
        intendedFeeBps,
        { requireActive: false },
      );
      assertExecutedFeeChangePostImage(
        proposalAfter,
        after.protocolFeeBps,
        intendedFeeBps,
      );
      console.log(`\nprotocol_fee_bps now: ${after.protocolFeeBps}`);
      console.log("proposal post-status: Executed");
    }
    return;
  }

  /* ----------------------------------- plan ---------------------------------- */
  if (governance) {
    const requirements = freshProposalRequirements(
      governance.minProposalStake,
      config.minArbiterStake,
      governance.quorumBps,
      governance.approvalThresholdBps,
    );
    console.log(
      `\nNew-proposal quorum: ${fmt(requirements.quorum)} vote-weight ` +
        `(hard floor, ${requirements.minDistinctVoters} distinct mature voters minimum)`,
    );
  }
  console.log(`\nNext step: ${govInfo ? "--propose with PROPOSER_KEYPAIR + NEW_FEE_BPS=500" : "--init-governance with AUTHORITY_KEYPAIR"}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((e) => die(e.message ?? String(e)));
}
