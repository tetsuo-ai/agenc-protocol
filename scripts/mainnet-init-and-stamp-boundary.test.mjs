import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHILD = new URL("./mainnet-init-and-stamp.mjs", import.meta.url);
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const anchor = require("@coral-xyz/anchor");
const { Keypair } = require("@solana/web3.js");

test("stamp child binds every broadcast to the reviewed executable and release state", async () => {
  const source = await readFile(CHILD, "utf8");
  for (const required of [
    "EXPECTED_SO_SHA256",
    "EXPECTED_PROTOCOL_CONFIG_SHA256",
    "EXPECTED_MODERATION_MIN_UPDATED_AT",
    "RUN_STAMP",
    "FORCE_STAMP",
    "resolveStampMode",
    "assertApprovedExecutableSnapshot",
    "assertImmediatePreUpgradeSnapshot",
    "readProgramUpgradeAuthoritySnapshot",
    "assertModerationFreshForStamp",
    "decodeAnchorIdlAccount",
    "assertFetchedOnChainIdlMatchesReviewed",
    "stampReleaseSurface",
    "upgradeAuthorityCustody",
  ]) {
    assert.match(source, new RegExp(required));
  }
  const mainBody = source.slice(source.indexOf("async function main()"));
  assert.ok(
    mainBody.indexOf("assertApprovedExecutableSnapshot({") <
      mainBody.indexOf("initializeSigningMaterial();"),
    "live loader/custody/SBF approval must pass before plaintext signing files are opened",
  );
  assert.match(
    source,
    /async function sendIx[\s\S]*verifyLoaderBoundary\(`\$\{label\} pre-broadcast`\)[\s\S]*preBroadcast[\s\S]*sendRawTransaction[\s\S]*verifyLoaderBoundary\([\s\S]*post-confirmation/,
  );
  assert.match(
    source,
    /approvedLoaderSnapshot = await readProgramUpgradeAuthoritySnapshot\([\s\S]*commitment: "finalized"/,
    "the exact reviewed ProgramData image must be rooted before any signing material is opened",
  );
  assert.match(
    source,
    /surface stamp instruction-build boundary"[\s\S]*commitment: "finalized"/,
    "the final stamp instruction must be rebuilt from a fresh finalized executable/custody snapshot",
  );
  assert.match(
    source,
    /stamp_release_surface \(atomic surface stamp\)[\s\S]*preBroadcast:[\s\S]*readReviewedStampBoundary[\s\S]*postConfirmation:[\s\S]*expectedPostImage/,
  );
  assert.match(
    source,
    /\.stampReleaseSurface\([\s\S]*instructionLoader\.programDataSlot[\s\S]*accountHashes\.bid[\s\S]*accountHashes\.moderation[\s\S]*accountHashes\.idl[\s\S]*custodyAccountDataSha256[\s\S]*programData:[\s\S]*anchorIdl:[\s\S]*upgradeAuthorityCustody:/,
    "the signed instruction itself must bind and lock every reviewed dependency",
  );
  assert.match(
    source,
    /cfg\.surfaceRevision === targetSurfaceRevision[\s\S]*!stampMode\.forceStamp &&[\s\S]*maskOverride === null/,
    "a current revision may be skipped only when neither a forced stamp nor an explicit mask write is pending",
  );
  assert.match(
    source,
    /!stampMode\.skipStamp && !cfg\.protocolPaused[\s\S]*pause the protocol before the final surface stamp/,
    "the stamp must preserve a fail-safe paused state until every post-boundary check succeeds",
  );
  assert.match(
    source,
    /if \(expectedPostImage\)[\s\S]*boundaryCfg\.rawData\.equals\(expectedPostImage\)/,
    "post-confirmation verification must compare every ProtocolConfig account-data byte",
  );
});

test("generated IDL constructs the complete atomic release-stamp instruction", async () => {
  const idl = JSON.parse(
    await readFile(
      new URL("../artifacts/anchor/idl/agenc_coordination.json", import.meta.url),
      "utf8",
    ),
  );
  const authority = Keypair.generate();
  const provider = new anchor.AnchorProvider(
    {},
    new anchor.Wallet(authority),
    {},
  );
  const program = new anchor.Program(idl, provider);
  const keys = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const digest = new Array(32).fill(7);
  const instruction = await program.methods
    .stampReleaseSurface(
      0,
      5,
      digest,
      new anchor.BN(100),
      2_276_608,
      keys[0],
      digest,
      digest,
      digest,
      keys[1],
      keys[2],
      digest,
    )
    .accounts({
      protocolConfig: keys[0],
      bidMarketplaceConfig: keys[1],
      moderationConfig: keys[2],
      programData: keys[3],
      anchorIdl: keys[4],
      upgradeAuthorityCustody: keys[5],
      authority: authority.publicKey,
    })
    .instruction();
  assert.equal(instruction.keys.length, 7);
  assert.equal(instruction.data.length, 279);
});
