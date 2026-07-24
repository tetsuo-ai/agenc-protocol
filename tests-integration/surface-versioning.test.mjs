// P6.5 surface-versioning contract — in-process litesvm integration tests.
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
//
// Covers the LIVE-ACCOUNT migration of the single mainnet ProtocolConfig:
//   - migrate_protocol reallocs a legacy 349B config up to 351B (multisig-gated),
//     zero-inits surface_revision, tops up rent, preserves the legacy prefix, and is
//     idempotent + dry-run-equivalent (re-runnable);
//   - the appended surface_revision permits historical/conservative values through
//     update_launch_controls, while the current revision requires the atomic release
//     stamp and unknown revisions remain rejected.
//
// NOTE: this test is written against the POST-regen IDL (the field/arg names below
// — surface_revision on ProtocolConfig, the surfaceRevision arg on
// updateLaunchControls, and the payer/systemProgram accounts on migrateProtocol —
// exist only after `anchor build && artifacts:refresh && sdk:generate`). The
// integrator runs it after regenerating.
//
// Run:  cd tests-integration && node --test surface-versioning.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  CURRENT_SURFACE_REVISION, PID, pda, enc, makeProgram, send, expectOk, expectFail, decode, freshWorld,
  setMultisig, getSurfaceRevision,
} from "./harness.mjs";

const OLD_CONFIG_SIZE = 349;
const NEW_CONFIG_SIZE = 351;
const SURFACE_REVISION_FULL = 1;
const SURFACE_REVISION_CURRENT = CURRENT_SURFACE_REVISION;

// Build the 2-of-2 multisig signer metas the migrate/admin gate requires.
async function arm2of2(w) {
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  return { owner2, signerMetas };
}

// Truncate the live (already-migrated, 351B) ProtocolConfig down to the legacy
// pre-P6.5 layout (349B = drop the trailing 2 surface_revision bytes) and fund it at
// only the 349-byte rent so the migration must top up. Mirrors the migrate_task test's
// "simulate a legacy account" trick.
function makeLegacyConfig(w) {
  const [protocolPda] = pda([enc("protocol")]);
  const full = w.svm.getAccount(protocolPda);
  assert.equal(full.data.length, NEW_CONFIG_SIZE, "fresh world config is at the new size");
  // Decode the full (351B) config BEFORE truncation — the BorshCoder cannot decode the
  // 349B legacy buffer (it expects the surface_revision tail).
  const fullDecoded = decode(w.svm, "ProtocolConfig", protocolPda);
  const legacy = Buffer.from(full.data).subarray(0, OLD_CONFIG_SIZE);
  const rentOld = Number(w.svm.minimumBalanceForRentExemption(BigInt(OLD_CONFIG_SIZE)));
  w.svm.setAccount(protocolPda, {
    lamports: rentOld,
    data: legacy,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  return { protocolPda, rentOld, fullDecoded };
}

test("migrate_protocol: reallocs a legacy 349B ProtocolConfig to 351B (multisig-gated, idempotent, rent topped up, surface_revision zero-init)", async () => {
  const w = await freshWorld({ price: 1_000_000 });

  // Arm the multisig on the full-size config FIRST (setMultisig decodes/re-encodes the
  // account, so it must run while the account is still the new 351B layout), THEN
  // truncate to the legacy 349B layout.
  const { owner2, signerMetas } = await arm2of2(w);
  const { protocolPda, fullDecoded } = makeLegacyConfig(w);

  // Capture legacy-prefix fields (from the pre-truncation decode) to prove the
  // append-only prefix survives the realloc.
  const feeBefore = fullDecoded.protocol_fee_bps;
  const treasuryBefore = fullDecoded.treasury.toBase58();

  const rentNew = Number(w.svm.minimumBalanceForRentExemption(BigInt(NEW_CONFIG_SIZE)));

  // target_version == current_version (1) is the realloc-only path on today's mainnet.
  const buildMigrate = async () =>
    makeProgram(w.admin).methods
      .migrateProtocol(1)
      .accounts({ protocolConfig: protocolPda, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts(signerMetas)
      .instruction();

  // A single signer cannot pass the 2-of-2 gate.
  expectFail(
    send(w.svm, await makeProgram(w.admin).methods
      .migrateProtocol(1)
      .accounts({ protocolConfig: protocolPda, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts([{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }])
      .instruction(), [w.admin]),
    "MultisigNotEnoughSigners",
    "single signer rejected",
  );
  assert.equal(w.svm.getAccount(protocolPda).data.length, OLD_CONFIG_SIZE, "failed gate left the legacy size");

  // Real migration: 349 -> 351, rent topped up, surface_revision zero-inits to 0.
  expectOk(send(w.svm, await buildMigrate(), [w.admin, owner2]), "migrate_protocol realloc");
  const migrated = w.svm.getAccount(protocolPda);
  assert.equal(migrated.data.length, NEW_CONFIG_SIZE, "config reallocated to the P6.5 size");
  assert.ok(Number(migrated.lamports) >= rentNew, `rent topped up to >= ${rentNew} (got ${migrated.lamports})`);

  const after = decode(w.svm, "ProtocolConfig", protocolPda);
  assert.equal(after.surface_revision, 0, "surface_revision zero-inited by the realloc (unstamped)");
  assert.equal(after.protocol_fee_bps, feeBefore, "legacy protocol_fee_bps preserved across realloc");
  assert.equal(after.treasury.toBase58(), treasuryBefore, "legacy treasury preserved across realloc");
  assert.equal(after.protocol_version, 1, "protocol_version unchanged by the realloc-only call");

  // Idempotent: a second run on the now-351B account is a no-op Ok (no realloc, no
  // spurious version bump). Expire the blockhash so this isn't a deduped repeat.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildMigrate(), [w.admin, owner2]), "migrate_protocol idempotent re-run");
  assert.equal(w.svm.getAccount(protocolPda).data.length, NEW_CONFIG_SIZE, "still 351 after idempotent re-run");
  assert.equal(decode(w.svm, "ProtocolConfig", protocolPda).surface_revision, 0, "surface_revision still 0 after re-run");
});

test("update_launch_controls: permits historical revisions but cannot bypass the current atomic stamp", async () => {
  const w = await freshWorld({ price: 1_000_000 });
  // Arm the multisig on the full-size config first, then truncate to the legacy layout
  // and migrate up — so we start from a migrated (351B) config with surface_revision 0.
  const { owner2, signerMetas } = await arm2of2(w);
  const { protocolPda } = makeLegacyConfig(w);
  expectOk(
    send(w.svm, await makeProgram(w.admin).methods
      .migrateProtocol(1)
      .accounts({ protocolConfig: protocolPda, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts(signerMetas)
      .instruction(), [w.admin, owner2]),
    "migrate before stamp",
  );
  assert.equal(getSurfaceRevision(w.svm), 0, "unstamped after migration");

  const buildStamp = async (rev, paused = true) =>
    makeProgram(w.admin).methods
      .updateLaunchControls(paused, 0, rev)
      .accounts({ protocolConfig: protocolPda, authority: w.admin.publicKey })
      .remainingAccounts(signerMetas)
      .instruction();

  // Unknown surface revision is rejected (operator cannot stamp a surface the SDK
  // does not understand).
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await buildStamp(7), [w.admin, owner2]), "InvalidSurfaceRevision", "unknown revision rejected");
  assert.equal(getSurfaceRevision(w.svm), 0, "rejected stamp left surface_revision untouched");

  // The current production revision is reserved for stamp_release_surface,
  // which binds the reviewed release boundary atomically.
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await buildStamp(SURFACE_REVISION_CURRENT), [w.admin, owner2]),
    "InvalidSurfaceRevision",
    "current revision bypass rejected",
  );
  assert.equal(getSurfaceRevision(w.svm), 0, "atomic-stamp bypass left revision untouched");

  // The full build cannot be made live while the resulting revision is still
  // unstamped. This closes the pause-toggle bypass around the atomic stamp.
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await buildStamp(0, false), [w.admin, owner2]),
    "ReleaseUnpauseRequiresCurrentSurface",
    "unstamped unpause rejected",
  );

  // Stamp the full surface.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildStamp(SURFACE_REVISION_FULL), [w.admin, owner2]), "stamp full surface while paused");
  assert.equal(getSurfaceRevision(w.svm), SURFACE_REVISION_FULL, "surface_revision stamped to FULL");

  // An operator can revert to unstamped (0) too.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildStamp(0), [w.admin, owner2]), "stamp back to 0 while paused");
  assert.equal(getSurfaceRevision(w.svm), 0, "surface_revision back to 0");
});

test("migrate_protocol: rejects a wrong-size (non-migratable) ProtocolConfig", async () => {
  const w = await freshWorld({ price: 1_000_000 });
  // Arm the multisig on the full-size config first (setMultisig decodes/re-encodes),
  // then corrupt the size.
  const { owner2, signerMetas } = await arm2of2(w);
  const [protocolPda] = pda([enc("protocol")]);
  // Corrupt the size to 350 (strictly between OLD 349 and NEW 351) — must be rejected.
  const full = w.svm.getAccount(protocolPda);
  const wrong = Buffer.from(full.data).subarray(0, 350);
  w.svm.setAccount(protocolPda, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(350n)),
    data: wrong,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });

  expectFail(
    send(w.svm, await makeProgram(w.admin).methods
      .migrateProtocol(1)
      .accounts({ protocolConfig: protocolPda, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts(signerMetas)
      .instruction(), [w.admin, owner2]),
    "ConfigNotMigratable",
    "350-byte config rejected as non-migratable",
  );
});
