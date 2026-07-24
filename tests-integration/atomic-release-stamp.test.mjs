import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  BN,
  CURRENT_SURFACE_REVISION,
  Keypair,
  LiteSVM,
  PID,
  PublicKey,
  SO,
  arr,
  coder,
  enc,
  expectFail,
  expectOk,
  injectBidMarketplace,
  injectModerationConfig,
  injectProtocolConfig,
  makeProgram,
  pda,
  send,
  setMultisig,
  setProtocolPaused,
} from "./harness.mjs";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const PROGRAMDATA_METADATA_BYTES = 45;
const PROGRAMDATA_VARIANT = 3;
const REVIEWED_PROGRAMDATA_SLOT = 50n;
const STAMP_SLOT = 100n;
const PROGRAM_PAYLOAD = Buffer.from("reviewed-program-payload");
const IDL_DATA = Buffer.from("reviewed-anchor-idl-account");
const CUSTODY_DATA = Buffer.from("reviewed-upgrade-custody-policy");

function sha256(data) {
  return arr(crypto.createHash("sha256").update(data).digest());
}

function putAccount(svm, address, owner, data) {
  svm.setAccount(address, {
    lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner,
    executable: false,
    rentEpoch: 0,
  });
}

function programDataAddress() {
  return PublicKey.findProgramAddressSync(
    [PID.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

function programDataBytes(upgradeAuthority) {
  const data = Buffer.alloc(PROGRAMDATA_METADATA_BYTES + PROGRAM_PAYLOAD.length);
  data.writeUInt32LE(PROGRAMDATA_VARIANT, 0);
  data.writeBigUInt64LE(REVIEWED_PROGRAMDATA_SLOT, 4);
  data[12] = 1;
  upgradeAuthority.toBuffer().copy(data, 13);
  PROGRAM_PAYLOAD.copy(data, PROGRAMDATA_METADATA_BYTES);
  return data;
}

async function anchorIdlAddress() {
  const [base] = PublicKey.findProgramAddressSync([], PID);
  return PublicKey.createWithSeed(base, "anchor:idl", PID);
}

async function makeWorld({
  paused = true,
  moderationEnabled = true,
  moderationUpdatedAt = 1_699_999_900n,
} = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const clock = svm.getClock();
  clock.slot = STAMP_SLOT;
  clock.unixTimestamp = 1_700_000_000n;
  svm.setClock(clock);

  const authority = Keypair.generate();
  const secondOwner = Keypair.generate();
  const moderationAuthority = Keypair.generate();
  const upgradeAuthority = Keypair.generate();
  const custody = Keypair.generate();
  const custodyOwner = Keypair.generate();
  for (const signer of [authority, secondOwner]) {
    svm.airdrop(signer.publicKey, 10_000_000_000n);
  }

  const protocolConfig = await injectProtocolConfig(svm, authority);
  await setMultisig(
    svm,
    [authority.publicKey, secondOwner.publicKey],
    2,
  );
  await setProtocolPaused(svm, paused);
  const bidMarketplaceConfig = await injectBidMarketplace(svm, authority);
  const moderationConfig = await injectModerationConfig(
    svm,
    authority,
    moderationAuthority,
    moderationEnabled,
  );

  const moderationAccount = svm.getAccount(moderationConfig);
  const moderation = coder.accounts.decode(
    "ModerationConfig",
    Buffer.from(moderationAccount.data),
  );
  moderation.created_at = new BN(moderationUpdatedAt.toString());
  moderation.updated_at = new BN(moderationUpdatedAt.toString());
  const moderationData = await coder.accounts.encode(
    "ModerationConfig",
    moderation,
  );
  putAccount(svm, moderationConfig, PID, moderationData);

  const programData = programDataAddress();
  putAccount(
    svm,
    programData,
    BPF_LOADER_UPGRADEABLE,
    programDataBytes(upgradeAuthority.publicKey),
  );
  const anchorIdl = await anchorIdlAddress();
  putAccount(svm, anchorIdl, PID, IDL_DATA);
  putAccount(svm, custody.publicKey, custodyOwner.publicKey, CUSTODY_DATA);

  return {
    svm,
    authority,
    secondOwner,
    upgradeAuthority,
    protocolConfig,
    bidMarketplaceConfig,
    moderationConfig,
    programData,
    anchorIdl,
    custody,
    custodyOwner,
  };
}

async function stampInstruction(
  world,
  {
    expectedProgramDataSlot = REVIEWED_PROGRAMDATA_SLOT,
    expectedProtocolHash,
    expectedIdlHash = sha256(IDL_DATA),
  } = {},
) {
  const protocolData = Buffer.from(
    world.svm.getAccount(world.protocolConfig).data,
  );
  const bidData = Buffer.from(
    world.svm.getAccount(world.bidMarketplaceConfig).data,
  );
  const moderationData = Buffer.from(
    world.svm.getAccount(world.moderationConfig).data,
  );
  return makeProgram(world.authority).methods
    .stampReleaseSurface(
      0,
      CURRENT_SURFACE_REVISION,
      expectedProtocolHash ?? sha256(protocolData),
      new BN(expectedProgramDataSlot.toString()),
      PROGRAM_PAYLOAD.length,
      world.upgradeAuthority.publicKey,
      sha256(bidData),
      sha256(moderationData),
      expectedIdlHash,
      world.custody.publicKey,
      world.custodyOwner.publicKey,
      sha256(CUSTODY_DATA),
    )
    .accounts({
      protocolConfig: world.protocolConfig,
      bidMarketplaceConfig: world.bidMarketplaceConfig,
      moderationConfig: world.moderationConfig,
      programData: world.programData,
      anchorIdl: world.anchorIdl,
      upgradeAuthorityCustody: world.custody.publicKey,
      authority: world.authority.publicKey,
    })
    .remainingAccounts([
      {
        pubkey: world.authority.publicKey,
        isSigner: true,
        isWritable: false,
      },
      {
        pubkey: world.secondOwner.publicKey,
        isSigner: true,
        isWritable: false,
      },
    ])
    .instruction();
}

function protocolState(world) {
  return coder.accounts.decode(
    "ProtocolConfig",
    Buffer.from(world.svm.getAccount(world.protocolConfig).data),
  );
}

test("compiled stamp_release_surface atomically stamps an exact reviewed boundary", async () => {
  const world = await makeWorld();
  const result = send(
    world.svm,
    await stampInstruction(world),
    [world.authority, world.secondOwner],
  );
  expectOk(result, "atomic release stamp");
  const state = protocolState(world);
  assert.equal(state.protocol_paused, true);
  assert.equal(state.disabled_task_type_mask, 0);
  assert.equal(state.surface_revision, CURRENT_SURFACE_REVISION);

  world.svm.expireBlockhash();
  const unpause = await makeProgram(world.authority).methods
    .updateLaunchControls(false, 0xff, 0xffff)
    .accounts({
      protocolConfig: world.protocolConfig,
      authority: world.authority.publicKey,
    })
    .remainingAccounts([
      {
        pubkey: world.authority.publicKey,
        isSigner: true,
        isWritable: false,
      },
      {
        pubkey: world.secondOwner.publicKey,
        isSigner: true,
        isWritable: false,
      },
    ])
    .instruction();
  expectOk(
    send(world.svm, unpause, [world.authority, world.secondOwner]),
    "post-stamp unpause",
  );
  const liveState = protocolState(world);
  assert.equal(liveState.protocol_paused, false);
  assert.equal(liveState.surface_revision, CURRENT_SURFACE_REVISION);
});

test("compiled stamp_release_surface rejects an unpaused protocol", async () => {
  const world = await makeWorld({ paused: false });
  expectFail(
    send(
      world.svm,
      await stampInstruction(world),
      [world.authority, world.secondOwner],
    ),
    "ReleaseStampRequiresPaused",
    "unpaused atomic release stamp",
  );
  assert.equal(protocolState(world).surface_revision, 1);
});

test("compiled stamp_release_surface rejects stale reviewed account bytes", async () => {
  const world = await makeWorld();
  const wrongIdlHash = sha256(Buffer.from("different-reviewed-idl"));
  expectFail(
    send(
      world.svm,
      await stampInstruction(world, { expectedIdlHash: wrongIdlHash }),
      [world.authority, world.secondOwner],
    ),
    "ReleaseBoundaryDigestMismatch",
    "mismatched IDL boundary",
  );
  assert.equal(protocolState(world).surface_revision, 1);
});

test("compiled stamp_release_surface rejects a changed ProtocolConfig preimage", async () => {
  const world = await makeWorld();
  expectFail(
    send(
      world.svm,
      await stampInstruction(world, {
        expectedProtocolHash: sha256(Buffer.from("stale-protocol-config")),
      }),
      [world.authority, world.secondOwner],
    ),
    "ReleaseBoundaryDigestMismatch",
    "mismatched ProtocolConfig boundary",
  );
  assert.equal(protocolState(world).surface_revision, 1);
});

test("compiled stamp_release_surface permits a reviewed disabled policy with an old heartbeat", async () => {
  const world = await makeWorld({
    moderationEnabled: false,
    moderationUpdatedAt: 1n,
  });
  expectOk(
    send(
      world.svm,
      await stampInstruction(world),
      [world.authority, world.secondOwner],
    ),
    "disabled-policy atomic release stamp",
  );
  assert.equal(protocolState(world).surface_revision, CURRENT_SURFACE_REVISION);
});

test("compiled stamp_release_surface rejects an enabled policy with an old heartbeat", async () => {
  const world = await makeWorld({ moderationUpdatedAt: 1n });
  expectFail(
    send(
      world.svm,
      await stampInstruction(world),
      [world.authority, world.secondOwner],
    ),
    "ReleaseBoundaryAccountMismatch",
    "stale enabled-policy atomic release stamp",
  );
  assert.equal(protocolState(world).surface_revision, 1);
});

test("compiled stamp_release_surface rejects a ProgramData snapshot from the stamp slot", async () => {
  const world = await makeWorld();
  const data = programDataBytes(world.upgradeAuthority.publicKey);
  data.writeBigUInt64LE(STAMP_SLOT, 4);
  putAccount(world.svm, world.programData, BPF_LOADER_UPGRADEABLE, data);
  expectFail(
    send(
      world.svm,
      await stampInstruction(world, { expectedProgramDataSlot: STAMP_SLOT }),
      [world.authority, world.secondOwner],
    ),
    "ReleaseProgramDataNotSettled",
    "same-slot ProgramData boundary",
  );
  assert.equal(protocolState(world).surface_revision, 1);
});
