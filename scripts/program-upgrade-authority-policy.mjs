import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

export const UPGRADEABLE_LOADER_ID =
  "BPFLoaderUpgradeab1e11111111111111111111111";
export const PROGRAM_ACCOUNT_BYTES = 36;
export const PROGRAMDATA_METADATA_BYTES = 45;
export const REVIEWED_POLICY_URL = new URL(
  "./mainnet-upgrade-authority-policy.json",
  import.meta.url,
);

const PROGRAM_VARIANT = 2;
const PROGRAMDATA_VARIANT = 3;
const TOP_LEVEL_POLICY_KEYS = [
  "allowedUpgradeAuthorities",
  "expectedProgramData",
  "genesisHash",
  "loaderProgramId",
  "network",
  "programId",
  "requiredState",
  "schemaVersion",
];
const AUTHORITY_POLICY_KEYS = ["address", "custody"];
const CUSTODY_KEYS = [
  "autonomous",
  "kind",
  "memberCount",
  "members",
  "multisig",
  "programId",
  "rentCollector",
  "residualRisk",
  "threshold",
  "timeLockSeconds",
  "vaultIndex",
];
const CUSTODY_MEMBER_KEYS = ["address", "permissionsMask"];
const SQUADS_MULTISIG_DISCRIMINATOR = Buffer.from([
  224, 116, 121, 186, 68, 161, 79, 236,
]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(
      `${label} keys do not match the reviewed schema: ` +
        `actual=[${actual.join(",")}] expected=[${wanted.join(",")}]`,
    );
  }
}

function parsePubkey(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty base58 public key`);
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid public key: ${value}`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

/**
 * Parse the committed authority policy strictly. Unknown and missing fields fail
 * closed so a typo cannot silently weaken a custody review.
 */
export function parseUpgradeAuthorityPolicy(value) {
  assertPlainObject(value, "upgrade-authority policy");
  assertExactKeys(value, TOP_LEVEL_POLICY_KEYS, "upgrade-authority policy");
  if (value.schemaVersion !== 1) {
    throw new Error(`unsupported upgrade-authority policy schemaVersion ${value.schemaVersion}`);
  }
  if (value.network !== "mainnet-beta") {
    throw new Error(`upgrade-authority policy network must be mainnet-beta, got ${value.network}`);
  }
  if (typeof value.genesisHash !== "string" || value.genesisHash.length === 0) {
    throw new Error("upgrade-authority policy genesisHash is required");
  }

  const programId = parsePubkey(value.programId, "policy.programId");
  const loaderProgramId = parsePubkey(
    value.loaderProgramId,
    "policy.loaderProgramId",
  );
  if (loaderProgramId.toBase58() !== UPGRADEABLE_LOADER_ID) {
    throw new Error(
      `policy.loaderProgramId ${loaderProgramId.toBase58()} is not the BPF upgradeable loader`,
    );
  }
  const expectedProgramData = parsePubkey(
    value.expectedProgramData,
    "policy.expectedProgramData",
  );
  const [canonicalProgramData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    loaderProgramId,
  );
  if (!expectedProgramData.equals(canonicalProgramData)) {
    throw new Error(
      `policy.expectedProgramData ${expectedProgramData.toBase58()} is not canonical ` +
        `${canonicalProgramData.toBase58()} for program ${programId.toBase58()}`,
    );
  }

  if (value.requiredState !== "mutable" && value.requiredState !== "immutable") {
    throw new Error(
      `policy.requiredState must be mutable or immutable, got ${value.requiredState}`,
    );
  }
  if (!Array.isArray(value.allowedUpgradeAuthorities)) {
    throw new Error("policy.allowedUpgradeAuthorities must be an array");
  }
  if (value.requiredState === "immutable") {
    if (value.allowedUpgradeAuthorities.length !== 0) {
      throw new Error(
        "immutable policy must have an empty allowedUpgradeAuthorities array",
      );
    }
  } else if (value.allowedUpgradeAuthorities.length !== 1) {
    throw new Error(
      "mutable policy must pin exactly one reviewed upgrade authority",
    );
  }

  const allowedUpgradeAuthorities = value.allowedUpgradeAuthorities.map(
    (entry, index) => {
      const label = `policy.allowedUpgradeAuthorities[${index}]`;
      assertPlainObject(entry, label);
      assertExactKeys(entry, AUTHORITY_POLICY_KEYS, label);
      const address = parsePubkey(entry.address, `${label}.address`).toBase58();

      assertPlainObject(entry.custody, `${label}.custody`);
      assertExactKeys(entry.custody, CUSTODY_KEYS, `${label}.custody`);
      if (entry.custody.kind !== "squads-v4-vault") {
        throw new Error(`${label}.custody.kind must be squads-v4-vault`);
      }
      const custodyProgramId = parsePubkey(
        entry.custody.programId,
        `${label}.custody.programId`,
      );
      const multisig = parsePubkey(
        entry.custody.multisig,
        `${label}.custody.multisig`,
      );
      if (
        !Number.isSafeInteger(entry.custody.vaultIndex) ||
        entry.custody.vaultIndex < 0 ||
        entry.custody.vaultIndex > 255
      ) {
        throw new Error(`${label}.custody.vaultIndex must be a u8`);
      }
      assertPositiveInteger(entry.custody.threshold, `${label}.custody.threshold`);
      assertPositiveInteger(entry.custody.memberCount, `${label}.custody.memberCount`);
      if (entry.custody.threshold > entry.custody.memberCount) {
        throw new Error(`${label}.custody.threshold exceeds memberCount`);
      }
      if (
        !Number.isSafeInteger(entry.custody.timeLockSeconds) ||
        entry.custody.timeLockSeconds < 0 ||
        entry.custody.timeLockSeconds > 0xffff_ffff
      ) {
        throw new Error(`${label}.custody.timeLockSeconds must be a u32`);
      }
      if (entry.custody.rentCollector !== null) {
        parsePubkey(
          entry.custody.rentCollector,
          `${label}.custody.rentCollector`,
        );
      }
      if (entry.custody.autonomous !== true) {
        throw new Error(`${label}.custody.autonomous must be true`);
      }
      if (!Array.isArray(entry.custody.members)) {
        throw new Error(`${label}.custody.members must be an array`);
      }
      if (entry.custody.members.length !== entry.custody.memberCount) {
        throw new Error(
          `${label}.custody.members length != memberCount`,
        );
      }
      const memberAddresses = new Set();
      let voterCount = 0;
      let proposerCount = 0;
      let executorCount = 0;
      for (let memberIndex = 0; memberIndex < entry.custody.members.length; memberIndex++) {
        const member = entry.custody.members[memberIndex];
        const memberLabel = `${label}.custody.members[${memberIndex}]`;
        assertPlainObject(member, memberLabel);
        assertExactKeys(member, CUSTODY_MEMBER_KEYS, memberLabel);
        const memberAddress = parsePubkey(
          member.address,
          `${memberLabel}.address`,
        ).toBase58();
        if (memberAddresses.has(memberAddress)) {
          throw new Error(`${label}.custody.members contains duplicate ${memberAddress}`);
        }
        memberAddresses.add(memberAddress);
        if (
          !Number.isSafeInteger(member.permissionsMask) ||
          member.permissionsMask <= 0 ||
          member.permissionsMask >= 8
        ) {
          throw new Error(`${memberLabel}.permissionsMask must be in 1..7`);
        }
        if ((member.permissionsMask & 0b010) !== 0) voterCount++;
        if ((member.permissionsMask & 0b001) !== 0) proposerCount++;
        if ((member.permissionsMask & 0b100) !== 0) executorCount++;
      }
      if (voterCount < entry.custody.threshold) {
        throw new Error(`${label}.custody.threshold exceeds voting members`);
      }
      if (proposerCount === 0 || executorCount === 0) {
        throw new Error(`${label}.custody requires a proposer and executor`);
      }
      if (
        typeof entry.custody.residualRisk !== "string" ||
        entry.custody.residualRisk.trim().length === 0
      ) {
        throw new Error(`${label}.custody.residualRisk must be documented`);
      }
      // Squads v4 getVaultPda seeds, pinned from its program/SDK:
      // ["multisig", multisig, "vault", vault_index(u8)]. This proves the
      // reviewed authority address is the stated vault PDA without making any
      // inference from the vault account's System Program owner or zero data.
      const [derivedVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("multisig"),
          multisig.toBuffer(),
          Buffer.from("vault"),
          Buffer.from([entry.custody.vaultIndex]),
        ],
        custodyProgramId,
      );
      if (derivedVault.toBase58() !== address) {
        throw new Error(
          `${label}.address ${address} != derived Squads v4 vault ` +
            `${derivedVault.toBase58()}`,
        );
      }
      return { address, custody: { ...entry.custody } };
    },
  );

  return {
    ...value,
    programId: programId.toBase58(),
    loaderProgramId: loaderProgramId.toBase58(),
    expectedProgramData: expectedProgramData.toBase58(),
    allowedUpgradeAuthorities,
  };
}

export function loadReviewedUpgradeAuthorityPolicy() {
  const raw = readFileSync(REVIEWED_POLICY_URL);
  let decoded;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(
      `reviewed upgrade-authority policy is not valid JSON: ${error.message}`,
    );
  }
  return {
    ...parseUpgradeAuthorityPolicy(decoded),
    policyPath: REVIEWED_POLICY_URL.pathname,
    policySha256: sha256(raw),
  };
}

function assertLoaderAccountBoundary(account, loaderProgramId, label, executable) {
  if (!account) throw new Error(`${label} account is missing`);
  if (!account.owner || typeof account.owner.equals !== "function") {
    throw new Error(`${label} account owner is malformed`);
  }
  if (!account.owner.equals(loaderProgramId)) {
    throw new Error(
      `${label} owner ${account.owner.toBase58()} != loader ${loaderProgramId.toBase58()}`,
    );
  }
  if (account.executable !== executable) {
    throw new Error(
      `${label} executable=${String(account.executable)}; expected ${String(executable)}`,
    );
  }
  if (!Buffer.isBuffer(account.data) && !(account.data instanceof Uint8Array)) {
    throw new Error(`${label} data is not bytes`);
  }
  return Buffer.from(account.data);
}

export function decodeUpgradeableProgramAccount(account, loaderProgramId) {
  const data = assertLoaderAccountBoundary(
    account,
    loaderProgramId,
    "Program",
    true,
  );
  if (data.length !== PROGRAM_ACCOUNT_BYTES) {
    throw new Error(
      `Program account length ${data.length} != ${PROGRAM_ACCOUNT_BYTES}`,
    );
  }
  const variant = data.readUInt32LE(0);
  if (variant !== PROGRAM_VARIANT) {
    throw new Error(
      `Program loader variant ${variant} != Program(${PROGRAM_VARIANT})`,
    );
  }
  return {
    programDataAddress: new PublicKey(data.subarray(4, 36)).toBase58(),
  };
}

export function decodeUpgradeableProgramDataAccount(account, loaderProgramId) {
  const data = assertLoaderAccountBoundary(
    account,
    loaderProgramId,
    "ProgramData",
    false,
  );
  if (data.length < PROGRAMDATA_METADATA_BYTES) {
    throw new Error(
      `ProgramData account length ${data.length} < ${PROGRAMDATA_METADATA_BYTES}`,
    );
  }
  const variant = data.readUInt32LE(0);
  if (variant !== PROGRAMDATA_VARIANT) {
    throw new Error(
      `ProgramData loader variant ${variant} != ProgramData(${PROGRAMDATA_VARIANT})`,
    );
  }
  const slot = data.readBigUInt64LE(4);
  const optionTag = data[12];
  if (optionTag !== 0 && optionTag !== 1) {
    throw new Error(`ProgramData authority Option tag ${optionTag} is invalid`);
  }
  const authority =
    optionTag === 1
      ? new PublicKey(data.subarray(13, 45)).toBase58()
      : null;
  return {
    authority,
    metadataBytes: PROGRAMDATA_METADATA_BYTES,
    payload: data.subarray(PROGRAMDATA_METADATA_BYTES),
    slot,
  };
}

export function decodeSquadsV4MultisigAccount(
  account,
  multisigAddress,
  squadsProgramId,
) {
  if (!account) throw new Error("Squads multisig account is missing");
  if (!account.owner || typeof account.owner.equals !== "function") {
    throw new Error("Squads multisig account owner is malformed");
  }
  if (!account.owner.equals(squadsProgramId)) {
    throw new Error(
      `Squads multisig owner ${account.owner.toBase58()} != ${squadsProgramId.toBase58()}`,
    );
  }
  if (account.executable !== false) {
    throw new Error(
      `Squads multisig executable=${String(account.executable)}; expected false`,
    );
  }
  if (!Buffer.isBuffer(account.data) && !(account.data instanceof Uint8Array)) {
    throw new Error("Squads multisig data is not bytes");
  }
  const data = Buffer.from(account.data);
  let cursor = 0;
  const take = (bytes, label) => {
    if (cursor + bytes > data.length) {
      throw new Error(
        `Squads multisig truncated while decoding ${label} at ${cursor}+${bytes}/${data.length}`,
      );
    }
    const value = data.subarray(cursor, cursor + bytes);
    cursor += bytes;
    return value;
  };

  if (!take(8, "discriminator").equals(SQUADS_MULTISIG_DISCRIMINATOR)) {
    throw new Error("Squads multisig discriminator mismatch");
  }
  const createKey = new PublicKey(take(32, "create_key"));
  const configAuthority = new PublicKey(take(32, "config_authority"));
  const threshold = take(2, "threshold").readUInt16LE(0);
  const timeLockSeconds = take(4, "time_lock").readUInt32LE(0);
  const transactionIndex = take(8, "transaction_index").readBigUInt64LE(0);
  const staleTransactionIndex = take(
    8,
    "stale_transaction_index",
  ).readBigUInt64LE(0);
  if (staleTransactionIndex > transactionIndex) {
    throw new Error("Squads multisig stale_transaction_index exceeds transaction_index");
  }
  const rentCollectorTag = take(1, "rent_collector Option tag")[0];
  if (rentCollectorTag !== 0 && rentCollectorTag !== 1) {
    throw new Error(
      `Squads multisig rent_collector Option tag ${rentCollectorTag} is invalid`,
    );
  }
  const rentCollector =
    rentCollectorTag === 1
      ? new PublicKey(take(32, "rent_collector")).toBase58()
      : null;
  const bump = take(1, "bump")[0];
  const memberCount = take(4, "members length").readUInt32LE(0);
  // The program always allocates 32 bytes for rent_collector even when None.
  // Removed-member capacity may make the account larger; only zero padding is
  // accepted after the serialized state.
  const minimumAllocatedBytes = 132 + memberCount * 33;
  if (data.length < minimumAllocatedBytes) {
    throw new Error(
      `Squads multisig allocation ${data.length} < ${minimumAllocatedBytes} for ${memberCount} members`,
    );
  }
  const members = [];
  const seen = new Set();
  let voterCount = 0;
  let proposerCount = 0;
  let executorCount = 0;
  for (let index = 0; index < memberCount; index++) {
    const address = new PublicKey(take(32, `members[${index}].key`)).toBase58();
    const permissionsMask = take(1, `members[${index}].permissions`)[0];
    if (seen.has(address)) {
      throw new Error(`Squads multisig duplicate member ${address}`);
    }
    seen.add(address);
    if (permissionsMask >= 8) {
      throw new Error(
        `Squads multisig member ${address} has unknown permissions ${permissionsMask}`,
      );
    }
    if ((permissionsMask & 0b010) !== 0) voterCount++;
    if ((permissionsMask & 0b001) !== 0) proposerCount++;
    if ((permissionsMask & 0b100) !== 0) executorCount++;
    members.push({ address, permissionsMask });
  }
  if (data.subarray(cursor).some((byte) => byte !== 0)) {
    throw new Error("Squads multisig has nonzero bytes after its decoded state");
  }
  if (threshold === 0 || threshold > voterCount) {
    throw new Error(
      `Squads multisig threshold ${threshold} is invalid for ${voterCount} voters`,
    );
  }
  if (proposerCount === 0 || executorCount === 0) {
    throw new Error("Squads multisig has no proposer or executor");
  }
  const [derivedMultisig, derivedBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      Buffer.from("multisig"),
      createKey.toBuffer(),
    ],
    squadsProgramId,
  );
  if (!derivedMultisig.equals(multisigAddress) || bump !== derivedBump) {
    throw new Error(
      `Squads multisig PDA/bump is non-canonical: derived=${derivedMultisig.toBase58()}/${derivedBump} ` +
        `observed=${multisigAddress.toBase58()}/${bump}`,
    );
  }
  return {
    bump,
    configAuthority: configAuthority.toBase58(),
    createKey: createKey.toBase58(),
    executorCount,
    memberCount,
    members,
    proposerCount,
    rentCollector,
    staleTransactionIndex,
    threshold,
    timeLockSeconds,
    transactionIndex,
    voterCount,
  };
}

export function assertSquadsV4CustodyPolicy(custodyPolicy, observed) {
  if (custodyPolicy.autonomous && observed.configAuthority !== PublicKey.default.toBase58()) {
    throw new Error(
      `Squads multisig is controlled by config authority ${observed.configAuthority}; ` +
        "reviewed custody requires autonomous configuration",
    );
  }
  for (const field of [
    "memberCount",
    "rentCollector",
    "threshold",
    "timeLockSeconds",
  ]) {
    if (observed[field] !== custodyPolicy[field]) {
      throw new Error(
        `Squads multisig ${field}=${String(observed[field])} != reviewed ` +
          `${String(custodyPolicy[field])}`,
      );
    }
  }
  if (observed.members.length !== custodyPolicy.members.length) {
    throw new Error("Squads multisig member inventory length drifted");
  }
  for (let index = 0; index < custodyPolicy.members.length; index++) {
    const expected = custodyPolicy.members[index];
    const actual = observed.members[index];
    if (
      actual.address !== expected.address ||
      actual.permissionsMask !== expected.permissionsMask
    ) {
      throw new Error(
        `Squads multisig member[${index}] drifted: ` +
          `observed=${actual.address}/${actual.permissionsMask} ` +
          `reviewed=${expected.address}/${expected.permissionsMask}`,
      );
    }
  }
}

export function assertUpgradeAuthorityPolicy(policy, observedAuthority) {
  if (policy.requiredState === "immutable") {
    if (observedAuthority !== null) {
      throw new Error(
        `program must be immutable, but ProgramData still has upgrade authority ${observedAuthority}`,
      );
    }
    return;
  }
  if (observedAuthority === null) {
    throw new Error(
      "ProgramData has no upgrade authority, but the reviewed policy requires mutability",
    );
  }
  const allowed = policy.allowedUpgradeAuthorities.map((entry) => entry.address);
  if (!allowed.includes(observedAuthority)) {
    throw new Error(
      `unexpected ProgramData upgrade authority ${observedAuthority}; ` +
        `reviewed authority=[${allowed.join(",")}]. Refusing`,
    );
  }
}

function snapshotStateDigest(snapshot) {
  return sha256(
    JSON.stringify({
      authority: snapshot.authority,
      custodyAccountDataSha256: snapshot.custodyAccountDataSha256,
      loaderProgramId: snapshot.loaderProgramId,
      programAccountDataSha256: snapshot.programAccountDataSha256,
      programData: snapshot.programData,
      programDataAccountDataSha256: snapshot.programDataAccountDataSha256,
      programDataSlot: snapshot.programDataSlot.toString(),
      programId: snapshot.programId,
    }),
  );
}

/**
 * Atomically read the executable Program account and canonical ProgramData
 * account at one RPC context slot and verify the committed policy.
 *
 * Deliberately do not inspect the authority account's owner/data to infer EOA vs
 * PDA custody. A Squads vault PDA may be system-owned with zero data; only the
 * explicitly reviewed address is authoritative here.
 */
export async function readProgramUpgradeAuthoritySnapshot(
  connection,
  policy,
  { commitment = "confirmed", minContextSlot } = {},
) {
  const programId = new PublicKey(policy.programId);
  const loaderProgramId = new PublicKey(policy.loaderProgramId);
  const [canonicalProgramData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    loaderProgramId,
  );
  if (canonicalProgramData.toBase58() !== policy.expectedProgramData) {
    throw new Error(
      `runtime canonical ProgramData ${canonicalProgramData.toBase58()} != reviewed ` +
        `${policy.expectedProgramData}`,
    );
  }

  if (
    minContextSlot !== undefined &&
    (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
  ) {
    throw new Error("loader account minContextSlot must be a non-negative safe integer");
  }
  const config = { commitment };
  if (minContextSlot !== undefined) config.minContextSlot = minContextSlot;
  const custodyPolicy = policy.allowedUpgradeAuthorities[0]?.custody ?? null;
  const custodyMultisig = custodyPolicy
    ? new PublicKey(custodyPolicy.multisig)
    : null;
  const accountKeys = [programId, canonicalProgramData];
  if (custodyMultisig) accountKeys.push(custodyMultisig);
  const response = await connection.getMultipleAccountsInfoAndContext(
    accountKeys,
    config,
  );
  if (
    !response ||
    !response.context ||
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot < 0 ||
    !Array.isArray(response.value) ||
    response.value.length !== accountKeys.length
  ) {
    throw new Error("loader account RPC response is malformed");
  }
  if (minContextSlot !== undefined && response.context.slot < minContextSlot) {
    throw new Error(
      `loader account RPC context ${response.context.slot} is below required ` +
        `minContextSlot ${minContextSlot}`,
    );
  }
  const [programAccount, programDataAccount, custodyMultisigAccount] =
    response.value;
  const programState = decodeUpgradeableProgramAccount(
    programAccount,
    loaderProgramId,
  );
  if (programState.programDataAddress !== canonicalProgramData.toBase58()) {
    throw new Error(
      `Program points to non-canonical ProgramData ${programState.programDataAddress}; ` +
        `expected ${canonicalProgramData.toBase58()}`,
    );
  }
  const programDataState = decodeUpgradeableProgramDataAccount(
    programDataAccount,
    loaderProgramId,
  );
  assertUpgradeAuthorityPolicy(policy, programDataState.authority);
  let custodyState = null;
  if (custodyPolicy) {
    custodyState = decodeSquadsV4MultisigAccount(
      custodyMultisigAccount,
      custodyMultisig,
      new PublicKey(custodyPolicy.programId),
    );
    assertSquadsV4CustodyPolicy(custodyPolicy, custodyState);
  }

  const snapshot = {
    authority: programDataState.authority,
    contextSlot: response.context.slot,
    custody: custodyState,
    custodyAccountDataSha256: custodyMultisigAccount
      ? sha256(Buffer.from(custodyMultisigAccount.data))
      : null,
    loaderProgramId: loaderProgramId.toBase58(),
    metadataBytes: programDataState.metadataBytes,
    payload: programDataState.payload,
    policySha256: policy.policySha256 ?? null,
    programAccountDataSha256: sha256(Buffer.from(programAccount.data)),
    programData: canonicalProgramData.toBase58(),
    programDataAccountDataSha256: sha256(Buffer.from(programDataAccount.data)),
    programDataSlot: programDataState.slot,
    programId: programId.toBase58(),
  };
  snapshot.stateDigest = snapshotStateDigest(snapshot);
  return snapshot;
}

export function assertImmediatePreUpgradeSnapshot(initial, immediate) {
  if (initial.policySha256 !== immediate.policySha256) {
    throw new Error("reviewed upgrade-authority policy changed after preflight");
  }
  if (initial.stateDigest !== immediate.stateDigest) {
    throw new Error(
      `loader state changed after preflight: initial=${initial.stateDigest} ` +
        `immediate=${immediate.stateDigest}`,
    );
  }
  if (immediate.contextSlot < initial.contextSlot) {
    throw new Error("immediate pre-upgrade RPC context regressed");
  }
}

export function assertImmediatePostUpgradeSnapshot(before, after) {
  if (before.policySha256 !== after.policySha256) {
    throw new Error("reviewed upgrade-authority policy changed during upgrade");
  }
  for (const field of [
    "authority",
    "custodyAccountDataSha256",
    "loaderProgramId",
    "programAccountDataSha256",
    "programData",
    "programId",
  ]) {
    if (before[field] !== after[field]) {
      throw new Error(
        `post-upgrade ${field} changed: before=${before[field]} after=${after[field]}`,
      );
    }
  }
  if (after.contextSlot < before.contextSlot) {
    throw new Error("post-upgrade RPC context regressed");
  }
  if (after.programDataSlot <= before.programDataSlot) {
    throw new Error(
      `post-upgrade ProgramData slot ${after.programDataSlot} did not advance past ` +
        `${before.programDataSlot}`,
    );
  }
  if (
    before.programDataAccountDataSha256 ===
    after.programDataAccountDataSha256
  ) {
    throw new Error("post-upgrade ProgramData bytes did not change");
  }
}
