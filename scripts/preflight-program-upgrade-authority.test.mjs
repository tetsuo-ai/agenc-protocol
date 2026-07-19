import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  PROGRAMDATA_METADATA_BYTES,
  REVIEWED_POLICY_URL,
  assertApprovedExecutableSnapshot,
  assertImmediatePostUpgradeSnapshot,
  assertImmediatePreUpgradeSnapshot,
  assertSquadsV4CustodyPolicy,
  assertUpgradeAuthorityPolicy,
  decodeSquadsV4MultisigAccount,
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  loadReviewedUpgradeAuthorityPolicy,
  parseUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
} from "./program-upgrade-authority-policy.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

const policy = loadReviewedUpgradeAuthorityPolicy();
const loader = new PublicKey(policy.loaderProgramId);
const programId = new PublicKey(policy.programId);
const programData = new PublicKey(policy.expectedProgramData);
const reviewedAuthority = new PublicKey(
  policy.allowedUpgradeAuthorities[0].address,
);
const custody = policy.allowedUpgradeAuthorities[0].custody;
const custodyProgram = new PublicKey(custody.programId);
const custodyMultisig = new PublicKey(custody.multisig);
const custodyCreateKey = new PublicKey(
  "5UJUUFZnbGpS65nTrwenvzGNTffkUDrsjGAGg894uZqr",
);

function loaderAccount(data, executable) {
  return {
    data,
    executable,
    lamports: 1,
    owner: loader,
    rentEpoch: 0,
  };
}

function programAccount(programDataAddress = programData) {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programDataAddress.toBuffer().copy(data, 4);
  return loaderAccount(data, true);
}

function programDataAccount({
  authority = reviewedAuthority,
  payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  slot = 123n,
} = {}) {
  const data = Buffer.alloc(PROGRAMDATA_METADATA_BYTES + payload.length);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(slot, 4);
  if (authority === null) {
    data[12] = 0;
  } else {
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
  }
  payload.copy(data, PROGRAMDATA_METADATA_BYTES);
  return loaderAccount(data, false);
}

function custodyMultisigAccount({ threshold = custody.threshold } = {}) {
  const data = Buffer.alloc(132 + custody.members.length * 33);
  Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]).copy(data, 0);
  custodyCreateKey.toBuffer().copy(data, 8);
  PublicKey.default.toBuffer().copy(data, 40);
  data.writeUInt16LE(threshold, 72);
  data.writeUInt32LE(custody.timeLockSeconds, 74);
  data.writeBigUInt64LE(9n, 78);
  data.writeBigUInt64LE(1n, 86);
  data[94] = 0;
  const [, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      Buffer.from("multisig"),
      custodyCreateKey.toBuffer(),
    ],
    custodyProgram,
  );
  data[95] = bump;
  data.writeUInt32LE(custody.members.length, 96);
  let cursor = 100;
  for (const member of custody.members) {
    new PublicKey(member.address).toBuffer().copy(data, cursor);
    data[cursor + 32] = member.permissionsMask;
    cursor += 33;
  }
  return {
    data,
    executable: false,
    lamports: 1,
    owner: custodyProgram,
    rentEpoch: 0,
  };
}

function mockConnection(accounts, contextSlot = 500) {
  return {
    async getMultipleAccountsInfoAndContext(keys, config) {
      assert.deepEqual(
        keys.map((key) => key.toBase58()),
        [
          programId.toBase58(),
          programData.toBase58(),
          custodyMultisig.toBase58(),
        ],
      );
      assert.equal(config.commitment, "confirmed");
      // The authority vault account is intentionally not fetched or classified.
      // The third read is the pinned Squads controller state.
      assert.equal(keys.length, 3);
      return { context: { slot: contextSlot }, value: accounts };
    },
  };
}

test("reviewed policy pins canonical ProgramData and the exact Squads vault", () => {
  assert.equal(policy.requiredState, "mutable");
  assert.equal(
    policy.allowedUpgradeAuthorities[0].address,
    "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf",
  );
  assert.equal(
    policy.allowedUpgradeAuthorities[0].custody.multisig,
    "7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY",
  );
  assert.equal(policy.allowedUpgradeAuthorities[0].custody.threshold, 2);
  assert.equal(policy.allowedUpgradeAuthorities[0].custody.memberCount, 3);
  const [canonical] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    loader,
  );
  assert.equal(policy.expectedProgramData, canonical.toBase58());

  const raw = JSON.parse(readFileSync(REVIEWED_POLICY_URL, "utf8"));
  assert.throws(
    () => parseUpgradeAuthorityPolicy({ ...raw, typoAuthority: "ignored?" }),
    /keys do not match the reviewed schema/,
  );
  assert.throws(
    () =>
      parseUpgradeAuthorityPolicy({
        ...raw,
        expectedProgramData: PublicKey.default.toBase58(),
      }),
    /is not canonical/,
  );
  assert.throws(
    () =>
      parseUpgradeAuthorityPolicy({
        ...raw,
        allowedUpgradeAuthorities: [
          {
            ...raw.allowedUpgradeAuthorities[0],
            custody: {
              ...raw.allowedUpgradeAuthorities[0].custody,
              vaultIndex: 1,
            },
          },
        ],
      }),
    /!= derived Squads v4 vault/,
  );
});

test("canonical loader accounts decode exactly and policy rejects authority drift", async () => {
  const connection = mockConnection([
    programAccount(),
    programDataAccount(),
    custodyMultisigAccount(),
  ]);
  const snapshot = await readProgramUpgradeAuthoritySnapshot(
    connection,
    policy,
  );
  assert.equal(snapshot.programId, programId.toBase58());
  assert.equal(snapshot.programData, programData.toBase58());
  assert.equal(snapshot.programDataSlot, 123n);
  assert.equal(snapshot.authority, reviewedAuthority.toBase58());
  assert.deepEqual(snapshot.payload, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.equal(snapshot.custody.threshold, 2);
  assert.equal(snapshot.custody.memberCount, 3);
  assert.equal(snapshot.custody.configAuthority, PublicKey.default.toBase58());

  await assert.rejects(
    () =>
      readProgramUpgradeAuthoritySnapshot(
        mockConnection(
          [programAccount(), programDataAccount(), custodyMultisigAccount()],
          499,
        ),
        policy,
        { minContextSlot: 500 },
      ),
    /loader account RPC context 499.*minContextSlot 500/,
  );
  await assert.rejects(
    () =>
      readProgramUpgradeAuthoritySnapshot(connection, policy, {
        minContextSlot: -1,
      }),
    /minContextSlot must be a non-negative safe integer/,
  );

  assert.doesNotThrow(() =>
    assertUpgradeAuthorityPolicy(policy, reviewedAuthority.toBase58()),
  );
  assert.throws(
    () => assertUpgradeAuthorityPolicy(policy, null),
    /requires mutability/,
  );
  assert.throws(
    () => assertUpgradeAuthorityPolicy(policy, PublicKey.default.toBase58()),
    /unexpected ProgramData upgrade authority/,
  );

  const raw = JSON.parse(readFileSync(REVIEWED_POLICY_URL, "utf8"));
  const immutablePolicy = parseUpgradeAuthorityPolicy({
    ...raw,
    allowedUpgradeAuthorities: [],
    requiredState: "immutable",
  });
  assert.doesNotThrow(() => assertUpgradeAuthorityPolicy(immutablePolicy, null));
  assert.throws(
    () =>
      assertUpgradeAuthorityPolicy(
        immutablePolicy,
        reviewedAuthority.toBase58(),
      ),
    /must be immutable/,
  );
});

test("approved executable binding requires exact ELF bytes and zero loader padding", async () => {
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const digest = createHash("sha256").update(binary).digest("hex");
  const snapshot = await readProgramUpgradeAuthoritySnapshot(
    mockConnection([
      programAccount(),
      programDataAccount({ payload: Buffer.concat([binary, Buffer.alloc(8)]) }),
      custodyMultisigAccount(),
    ]),
    policy,
  );
  assert.equal(
    assertApprovedExecutableSnapshot({
      genesisHash: policy.genesisHash,
      policy,
      snapshot,
      binaryBytes: binary,
      expectedSha256: digest,
    }).binaryBytes,
    binary.length,
  );
  assert.throws(
    () =>
      assertApprovedExecutableSnapshot({
        genesisHash: policy.genesisHash,
        policy,
        snapshot,
        binaryBytes: binary,
        expectedSha256: "00".repeat(32),
      }),
    /SBF sha256 .* != approved/,
  );
  assert.throws(
    () =>
      assertApprovedExecutableSnapshot({
        genesisHash: policy.genesisHash,
        policy,
        snapshot: { ...snapshot, payload: Buffer.concat([binary, Buffer.from([1])]) },
        binaryBytes: binary,
        expectedSha256: digest,
      }),
    /nonzero bytes after the approved SBF/,
  );
  assert.throws(
    () =>
      assertApprovedExecutableSnapshot({
        genesisHash: "wrong-cluster",
        policy,
        snapshot,
        binaryBytes: binary,
        expectedSha256: digest,
      }),
    /RPC genesis .* != reviewed/,
  );
});

test("loader decoding rejects non-canonical pointers, variants, owners, and Option tags", async () => {
  const wrongPointer = PublicKey.unique();
  await assert.rejects(
    () =>
      readProgramUpgradeAuthoritySnapshot(
        mockConnection([
          programAccount(wrongPointer),
          programDataAccount(),
          custodyMultisigAccount(),
        ]),
        policy,
      ),
    /points to non-canonical ProgramData/,
  );

  const badProgram = programAccount();
  badProgram.data.writeUInt32LE(1, 0);
  assert.throws(
    () => decodeUpgradeableProgramAccount(badProgram, loader),
    /variant 1 != Program/,
  );

  const badProgramData = programDataAccount();
  badProgramData.data[12] = 2;
  assert.throws(
    () => decodeUpgradeableProgramDataAccount(badProgramData, loader),
    /Option tag 2 is invalid/,
  );

  const wrongOwner = programDataAccount();
  wrongOwner.owner = programId;
  assert.throws(
    () => decodeUpgradeableProgramDataAccount(wrongOwner, loader),
    /owner .* != loader/,
  );

  const executableProgramData = programDataAccount();
  executableProgramData.executable = true;
  assert.throws(
    () => decodeUpgradeableProgramDataAccount(executableProgramData, loader),
    /executable=true; expected false/,
  );

  assert.throws(
    () =>
      assertSquadsV4CustodyPolicy(
        custody,
        decodeSquadsV4MultisigAccount(
          custodyMultisigAccount({ threshold: 1 }),
          custodyMultisig,
          custodyProgram,
        ),
      ),
    /threshold=1 != reviewed 2/,
  );
});

test("immediate pre/post snapshots fail closed on races and custody changes", () => {
  const before = {
    authority: reviewedAuthority.toBase58(),
    contextSlot: 500,
    custodyAccountDataSha256: "00".repeat(32),
    loaderProgramId: loader.toBase58(),
    policySha256: policy.policySha256,
    programAccountDataSha256: "11".repeat(32),
    programData: programData.toBase58(),
    programDataAccountDataSha256: "22".repeat(32),
    programDataSlot: 123n,
    programId: programId.toBase58(),
    stateDigest: "33".repeat(32),
  };
  assert.doesNotThrow(() =>
    assertImmediatePreUpgradeSnapshot(before, {
      ...before,
      contextSlot: 501,
    }),
  );
  assert.throws(
    () =>
      assertImmediatePreUpgradeSnapshot(before, {
        ...before,
        contextSlot: 501,
        stateDigest: "44".repeat(32),
      }),
    /loader state changed after preflight/,
  );

  const after = {
    ...before,
    contextSlot: 502,
    programDataAccountDataSha256: "55".repeat(32),
    programDataSlot: 124n,
  };
  assert.doesNotThrow(() =>
    assertImmediatePostUpgradeSnapshot(before, after),
  );
  assert.throws(
    () =>
      assertImmediatePostUpgradeSnapshot(before, {
        ...after,
        authority: PublicKey.default.toBase58(),
      }),
    /post-upgrade authority changed/,
  );
  assert.throws(
    () =>
      assertImmediatePostUpgradeSnapshot(before, {
        ...after,
        programDataSlot: before.programDataSlot,
      }),
    /did not advance/,
  );
});
