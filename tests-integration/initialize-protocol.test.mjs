import test from "node:test";
import assert from "node:assert/strict";

import {
  BN,
  FailedTransactionMetadata,
  Keypair,
  LiteSVM,
  PID,
  PublicKey,
  SO,
  SystemProgram,
  arr,
  coder,
  decode,
  expectFail,
  enc,
  expectOk,
  makeProgram,
  pda,
  send,
} from "./harness.mjs";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const PROGRAMDATA_VARIANT = 3;
const PROGRAMDATA_METADATA_BYTES = 45;

function programDataAddress() {
  return PublicKey.findProgramAddressSync(
    [PID.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

function programDataBytes(upgradeAuthority, variant = PROGRAMDATA_VARIANT) {
  const data = Buffer.alloc(PROGRAMDATA_METADATA_BYTES);
  data.writeUInt32LE(variant, 0);
  data.writeBigUInt64LE(1n, 4);
  data[12] = 1;
  upgradeAuthority.toBuffer().copy(data, 13);
  return data;
}

function putProgramData(
  svm,
  upgradeAuthority,
  { address = programDataAddress(), owner = BPF_LOADER_UPGRADEABLE, variant } = {},
) {
  const data = programDataBytes(upgradeAuthority, variant);
  svm.setAccount(address, {
    lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner,
    executable: false,
    rentEpoch: 0,
  });
  return address;
}

async function newInitWorld({ programDataVariant = PROGRAMDATA_VARIANT } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);

  const authority = Keypair.generate();
  const secondSigner = Keypair.generate();
  const thirdOwner = Keypair.generate();
  const fourthOwner = Keypair.generate();
  const treasury = Keypair.generate();
  for (const signer of [authority, secondSigner, thirdOwner, fourthOwner, treasury]) {
    svm.airdrop(signer.publicKey, 10_000_000_000n);
  }

  const programData = putProgramData(svm, authority.publicKey, {
    variant: programDataVariant,
  });
  const [protocolConfig, bump] = pda([enc("protocol")]);
  return {
    svm,
    program: makeProgram(authority),
    authority,
    secondSigner,
    thirdOwner,
    fourthOwner,
    treasury,
    programData,
    protocolConfig,
    bump,
  };
}

async function initializeIx(
  world,
  {
    owners = [
      world.authority.publicKey,
      world.secondSigner.publicKey,
      world.thirdOwner.publicKey,
    ],
    threshold = 2,
    treasury = world.treasury.publicKey,
    programData = world.programData,
    disputeThreshold = 67,
    protocolFeeBps = 321,
    minStake = 2_000_000,
    minStakeForDispute = 1_000_000,
    additionalRemaining = [],
  } = {},
) {
  return world.program.methods
    .initializeProtocol(
      disputeThreshold,
      protocolFeeBps,
      new BN(minStake),
      new BN(minStakeForDispute),
      threshold,
      owners,
    )
    .accounts({
      protocolConfig: world.protocolConfig,
      treasury,
      authority: world.authority.publicKey,
      secondSigner: world.secondSigner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: programData, isSigner: false, isWritable: false },
      ...additionalRemaining,
    ])
    .instruction();
}

async function sendInitialize(world, options = {}) {
  return send(
    world.svm,
    await initializeIx(world, options),
    [world.authority, world.secondSigner, world.treasury],
  );
}

test("initialize_protocol accepts canonical ProgramData and writes the complete production bootstrap", async () => {
  const world = await newInitWorld();
  expectOk(await sendInitialize(world), "initialize_protocol canonical bootstrap");

  const config = decode(world.svm, "ProtocolConfig", world.protocolConfig);
  assert.ok(config, "ProtocolConfig created");
  assert.equal(config.authority.toBase58(), world.authority.publicKey.toBase58());
  assert.equal(config.treasury.toBase58(), world.treasury.publicKey.toBase58());
  assert.equal(config.dispute_threshold, 67);
  assert.equal(config.protocol_fee_bps, 321);
  assert.equal(config.min_arbiter_stake.toString(), "2000000");
  assert.equal(config.min_agent_stake.toString(), "2000000");
  assert.equal(config.min_stake_for_dispute.toString(), "1000000");
  assert.equal(config.multisig_threshold, 2);
  assert.equal(config.multisig_owners_len, 3);
  assert.deepEqual(
    config.multisig_owners.slice(0, 3).map((owner) => owner.toBase58()),
    [world.authority, world.secondSigner, world.thirdOwner].map((owner) =>
      owner.publicKey.toBase58()
    ),
  );
  assert.ok(
    config.multisig_owners.slice(3).every((owner) => owner.equals(PublicKey.default)),
    "unused multisig slots are zeroed",
  );
  assert.equal(config.task_creation_cooldown.toString(), "60");
  assert.equal(config.max_tasks_per_24h, 50);
  assert.equal(config.dispute_initiation_cooldown.toString(), "300");
  assert.equal(config.max_disputes_per_24h, 10);
  assert.equal(config.state_update_cooldown.toString(), "60");
  assert.equal(config.slash_percentage, 25);
  assert.equal(config.protocol_version, 1);
  assert.equal(config.min_supported_version, 1);
  assert.equal(config.protocol_paused, false);
  assert.equal(config.disabled_task_type_mask, 0);
  assert.equal(config.surface_revision, 5);

  const replay = await sendInitialize(world);
  assert.ok(
    replay instanceof FailedTransactionMetadata,
    "the initialized protocol PDA cannot be initialized again",
  );
});

test("initialize_protocol rejects every non-ProgramData loader-state variant", async (t) => {
  for (const variant of [0, 1, 2, 4, 0xffff_ffff]) {
    await t.test(`loader-state tag ${variant}`, async () => {
      const world = await newInitWorld({ programDataVariant: variant });
      expectFail(
        await sendInitialize(world),
        "CorruptedData",
        `initialize_protocol loader-state tag ${variant}`,
      );
      assert.equal(
        decode(world.svm, "ProtocolConfig", world.protocolConfig),
        null,
        "failed bootstrap leaves no ProtocolConfig",
      );
    });
  }
});

test("initialize_protocol binds the canonical loader owner and upgrade authority", async (t) => {
  await t.test("wrong ProgramData address", async () => {
    const world = await newInitWorld();
    const impostor = Keypair.generate().publicKey;
    putProgramData(world.svm, world.authority.publicKey, { address: impostor });
    expectFail(
      await sendInitialize(world, { programData: impostor }),
      "UnauthorizedUpgrade",
      "initialize_protocol wrong ProgramData address",
    );
  });

  await t.test("wrong ProgramData owner", async () => {
    const world = await newInitWorld();
    putProgramData(world.svm, world.authority.publicKey, {
      owner: SystemProgram.programId,
    });
    expectFail(
      await sendInitialize(world),
      "InvalidAccountOwner",
      "initialize_protocol wrong ProgramData owner",
    );
  });

  await t.test("wrong upgrade authority", async () => {
    const world = await newInitWorld();
    putProgramData(world.svm, Keypair.generate().publicKey);
    expectFail(
      await sendInitialize(world),
      "UnauthorizedUpgrade",
      "initialize_protocol wrong upgrade authority",
    );
  });
});

test("initialize_protocol rejects invalid custody and multisig bootstrap shapes", async (t) => {
  await t.test("duplicate multisig owner", async () => {
    const world = await newInitWorld();
    expectFail(
      await sendInitialize(world, {
        owners: [
          world.authority.publicKey,
          world.secondSigner.publicKey,
          world.secondSigner.publicKey,
        ],
      }),
      "MultisigDuplicateSigner",
      "initialize_protocol duplicate owner",
    );
  });

  await t.test("threshold lacks required signer", async () => {
    const world = await newInitWorld();
    expectFail(
      await sendInitialize(world, {
        owners: [
          world.authority.publicKey,
          world.secondSigner.publicKey,
          world.thirdOwner.publicKey,
          world.fourthOwner.publicKey,
        ],
        threshold: 3,
      }),
      "MultisigNotEnoughSigners",
      "initialize_protocol insufficient approvals",
    );
  });

  await t.test("program-owned treasury", async () => {
    const world = await newInitWorld();
    const treasuryAccount = world.svm.getAccount(world.treasury.publicKey);
    world.svm.setAccount(world.treasury.publicKey, {
      ...treasuryAccount,
      owner: PID,
    });
    expectFail(
      await sendInitialize(world),
      "InvalidTreasury",
      "initialize_protocol program-owned treasury",
    );
  });
});
