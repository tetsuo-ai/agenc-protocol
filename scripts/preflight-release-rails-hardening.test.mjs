import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import {
  assertExactMultipleAccountsResponse,
  assertFetchedIdlMatchesApproved,
  assessReleaseConfigInitialization,
  decodeBidMarketplaceConfigAccount,
  decodeModerationConfigAccount,
  enumerateTaskCandidates,
  inspectTaskMigrationCompatibility,
  isTaskSweepComplete,
  reviewedBidEconomicsFromEnv,
  reviewedModerationPolicyFromEnv,
  reviewedReleaseConfigSnapshotEnv,
} from "./mainnet-upgrade.mjs";
import {
  assertApprovedFeeChangeSbf,
  assertCanonicalFeeChangeProposal,
  assertExecutedFeeChangePostImage,
  assertFeeChangeLoaderSnapshotUnchanged,
  assertFeeChangeExecutionReady,
  assertMainnetFeeChangeExecutableBinding,
  assertMainnetFeeChangeRailBinding,
  decodeFeeChangeChainClockResponse,
  effectiveProposalVotingPeriod,
  parseFeeChangeCommand,
  selectBestGovernanceVoter,
  validateGovernanceInitializationTiming,
} from "./mainnet-fee-change.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
const SYSTEM_PROGRAM_ID = PublicKey.default;
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const AUTHORITY = Keypair.generate().publicKey;
const MODERATOR = Keypair.generate().publicKey;
const [BID_PDA, BID_BUMP] = PublicKey.findProgramAddressSync(
  [Buffer.from("bid_marketplace")],
  PROGRAM_ID,
);
const [MODERATION_PDA, MODERATION_BUMP] = PublicKey.findProgramAddressSync(
  [Buffer.from("moderation_config")],
  PROGRAM_ID,
);

function account(data, owner = PROGRAM_ID) {
  return {
    data,
    executable: false,
    lamports: 1_000_000,
    owner,
    rentEpoch: 0,
  };
}

function bidConfigData(overrides = {}) {
  const data = Buffer.alloc(71);
  createHash("sha256")
    .update("account:BidMarketplaceConfig")
    .digest()
    .subarray(0, 8)
    .copy(data);
  (overrides.authority ?? AUTHORITY).toBuffer().copy(data, 8);
  data.writeBigUInt64LE(BigInt(overrides.minBidBondLamports ?? 1_000_000), 40);
  data.writeBigInt64LE(BigInt(overrides.bidCreationCooldownSecs ?? 60), 48);
  data.writeUInt16LE(overrides.maxBidsPer24h ?? 50, 56);
  data.writeUInt16LE(overrides.maxActiveBidsPerTask ?? 20, 58);
  data.writeBigInt64LE(BigInt(overrides.maxBidLifetimeSecs ?? 604_800), 60);
  data.writeUInt16LE(overrides.acceptedNoShowSlashBps ?? 1_000, 68);
  data[70] = overrides.bump ?? BID_BUMP;
  return data;
}

function moderationConfigData(overrides = {}) {
  const data = Buffer.alloc(96);
  createHash("sha256")
    .update("account:ModerationConfig")
    .digest()
    .subarray(0, 8)
    .copy(data);
  (overrides.authority ?? AUTHORITY).toBuffer().copy(data, 8);
  (overrides.moderationAuthority ?? MODERATOR).toBuffer().copy(data, 40);
  data[72] = overrides.enabled === false ? 0 : 1;
  data.writeBigInt64LE(BigInt(overrides.createdAt ?? 1_000), 73);
  data.writeBigInt64LE(BigInt(overrides.updatedAt ?? 2_000), 81);
  data[89] = overrides.bump ?? MODERATION_BUMP;
  data.writeUInt32LE(overrides.livenessWindowSecs ?? 0, 90);
  if (overrides.trailingReserved) data[94] = 1;
  return data;
}

test("release config readiness rejects dusted/malformed singletons and missing moderation", () => {
  const goodBid = account(bidConfigData());
  const goodModeration = account(moderationConfigData());
  assert.equal(
    assessReleaseConfigInitialization({
      bidAccount: goodBid,
      bidAddress: BID_PDA,
      moderationAccount: goodModeration,
      moderationAddress: MODERATION_PDA,
      protocolAuthority: AUTHORITY,
    }).done,
    true,
  );

  assert.throws(
    () =>
      decodeBidMarketplaceConfigAccount(
        account(Buffer.alloc(0), SYSTEM_PROGRAM_ID),
        BID_PDA,
        { expectedAuthority: AUTHORITY },
      ),
    /owner .* != program/,
    "a system-owned dust account at the PDA must never count as initialization",
  );
  assert.throws(
    () =>
      decodeBidMarketplaceConfigAccount(
        account(bidConfigData({ minBidBondLamports: 0 })),
        BID_PDA,
        { expectedAuthority: AUTHORITY },
      ),
    /economic fields/,
  );
  const wrongDiscriminator = bidConfigData();
  wrongDiscriminator[0] ^= 0xff;
  assert.throws(
    () =>
      decodeBidMarketplaceConfigAccount(account(wrongDiscriminator), BID_PDA),
    /discriminator mismatch/,
  );
  assert.throws(
    () =>
      decodeModerationConfigAccount(
        account(moderationConfigData({ trailingReserved: true })),
        MODERATION_PDA,
        { expectedAuthority: AUTHORITY },
      ),
    /reserved trailing bytes/,
  );
  assert.throws(
    () =>
      assessReleaseConfigInitialization({
        bidAccount: goodBid,
        bidAddress: BID_PDA,
        moderationAccount: null,
        moderationAddress: MODERATION_PDA,
        protocolAuthority: AUTHORITY,
      }),
    /ModerationConfig is absent.*no reviewed moderation authority/,
  );
  const pending = assessReleaseConfigInitialization({
    bidAccount: goodBid,
    bidAddress: BID_PDA,
    moderationAccount: null,
    moderationAddress: MODERATION_PDA,
    protocolAuthority: AUTHORITY,
    intendedModerationAuthority: MODERATOR,
  });
  assert.equal(pending.done, false);
  assert.equal(pending.needed, true);
  assert.equal(pending.moderationReady, false);

  const disabledModeration = account(moderationConfigData({ enabled: false }));
  assert.throws(
    () =>
      assessReleaseConfigInitialization({
        bidAccount: goodBid,
        bidAddress: BID_PDA,
        moderationAccount: disabledModeration,
        moderationAddress: MODERATION_PDA,
        protocolAuthority: AUTHORITY,
      }),
    /enabled=false.*required release state enabled=true/,
    "a disabled moderation gate must not count as default release readiness",
  );
  assert.equal(
    assessReleaseConfigInitialization({
      bidAccount: goodBid,
      bidAddress: BID_PDA,
      moderationAccount: disabledModeration,
      moderationAddress: MODERATION_PDA,
      protocolAuthority: AUTHORITY,
      intendedModerationAuthority: MODERATOR,
      intendedModerationEnabled: false,
    }).done,
    true,
    "an explicitly reviewed disabled policy remains representable",
  );

  const realignment = assessReleaseConfigInitialization({
    bidAccount: goodBid,
    bidAddress: BID_PDA,
    moderationAccount: goodModeration,
    moderationAddress: MODERATION_PDA,
    protocolAuthority: AUTHORITY,
    intendedModerationAuthority: Keypair.generate().publicKey,
  });
  assert.equal(realignment.done, false);
  assert.equal(realignment.needed, true);
  assert.equal(
    realignment.moderationReady,
    false,
    "an explicit moderation-authority rotation must keep init pending even when bid config exists",
  );
});

test("stamp snapshot pins every bid and moderation policy field and rejects missing env", () => {
  const expectedBid = {
    minBidBondLamports: 1_000_000n,
    bidCreationCooldownSecs: 60n,
    maxBidsPer24h: 50,
    maxActiveBidsPerTask: 20,
    maxBidLifetimeSecs: 604_800n,
    acceptedNoShowSlashBps: 1_000,
  };
  const expectedModeration = {
    moderationAuthority: MODERATOR,
    enabled: true,
    livenessWindowSecs: 0,
  };
  const env = reviewedReleaseConfigSnapshotEnv({
    bid: expectedBid,
    moderation: expectedModeration,
  });
  assert.deepEqual(reviewedBidEconomicsFromEnv(env), expectedBid);
  assert.deepEqual(reviewedModerationPolicyFromEnv(env), expectedModeration);

  const bidEnvNames = Object.keys(env).filter((name) =>
    name.startsWith("EXPECTED_BID_"),
  );
  for (const name of bidEnvNames) {
    const incomplete = { ...env };
    delete incomplete[name];
    assert.throws(
      () => reviewedBidEconomicsFromEnv(incomplete),
      new RegExp(`${name} is required`),
    );
  }
  const moderationEnvNames = Object.keys(env).filter((name) =>
    name.startsWith("EXPECTED_MODERATION_"),
  );
  for (const name of moderationEnvNames) {
    const incomplete = { ...env };
    delete incomplete[name];
    assert.throws(
      () => reviewedModerationPolicyFromEnv(incomplete),
      new RegExp(`${name} is required`),
    );
  }
  assert.throws(
    () =>
      reviewedModerationPolicyFromEnv({
        ...env,
        EXPECTED_MODERATION_ENABLED: "TRUE",
      }),
    /must be exactly true or false/,
  );

  const bidMutations = [
    { minBidBondLamports: 1_000_001 },
    { bidCreationCooldownSecs: 61 },
    { maxBidsPer24h: 51 },
    { maxActiveBidsPerTask: 19 },
    { maxBidLifetimeSecs: 604_799 },
    { acceptedNoShowSlashBps: 999 },
  ];
  for (const overrides of bidMutations) {
    assert.throws(
      () =>
        decodeBidMarketplaceConfigAccount(
          account(bidConfigData(overrides)),
          BID_PDA,
          { expectedAuthority: AUTHORITY, expectedEconomics: expectedBid },
        ),
      /!= explicitly intended/,
    );
  }

  for (const overrides of [
    { moderationAuthority: Keypair.generate().publicKey },
    { enabled: false },
    { livenessWindowSecs: 86_400 },
  ]) {
    assert.throws(
      () =>
        decodeModerationConfigAccount(
          account(moderationConfigData(overrides)),
          MODERATION_PDA,
          { expectedAuthority: AUTHORITY, expectedPolicy: expectedModeration },
        ),
      /!= reviewed/,
    );
  }
});

test("post-publish IDL verification requires exact reviewed structure and surface", () => {
  const approvedIdl = {
    address: PROGRAM_ID.toBase58(),
    metadata: { name: "agenc", version: "1.0.0" },
    instructions: [
      { name: "first_ix", args: [{ name: "value", type: "u64" }] },
      { name: "second_ix", args: [] },
    ],
  };
  // Deliberately reorder object keys: Anchor formatting/key order is not policy.
  const fetchedIdl = {
    instructions: [
      { args: [{ type: "u64", name: "value" }], name: "first_ix" },
      { args: [], name: "second_ix" },
    ],
    metadata: { version: "1.0.0", name: "agenc" },
    address: PROGRAM_ID.toBase58(),
  };
  assert.equal(
    assertFetchedIdlMatchesApproved({
      approvedIdl,
      fetchedIdl,
      expectedInstructionCount: 2,
      sourceInstructionNames: ["first_ix", "second_ix"],
    }).instructionCount,
    2,
  );

  const changed = structuredClone(fetchedIdl);
  changed.metadata.version = "1.0.1";
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: changed,
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /content digest/,
  );
  const added = structuredClone(fetchedIdl);
  added.metadata.extra = true;
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: added,
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /content digest/,
  );
  const removed = structuredClone(fetchedIdl);
  delete removed.metadata.name;
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: removed,
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /content digest/,
  );
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: {
          ...fetchedIdl,
          address: Keypair.generate().publicKey.toBase58(),
        },
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /fetched IDL address/,
  );
  const duplicate = structuredClone(fetchedIdl);
  duplicate.instructions[1].name = "first_ix";
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: duplicate,
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /duplicate IDL instructions/,
  );
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: {
          ...fetchedIdl,
          instructions: fetchedIdl.instructions.slice(0, 1),
        },
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /expected exactly 2/,
  );
  assert.throws(
    () =>
      assertFetchedIdlMatchesApproved({
        approvedIdl,
        fetchedIdl: "malformed",
        expectedInstructionCount: 2,
        sourceInstructionNames: ["first_ix", "second_ix"],
      }),
    /not a JSON object/,
  );
});

test("migration account batches reject truncated, oversized, and non-array RPC values", () => {
  assert.deepEqual(assertExactMultipleAccountsResponse([null, null], 2), [
    null,
    null,
  ]);
  assert.throws(
    () => assertExactMultipleAccountsResponse([null], 2),
    /returned 1 account.*2 requested/,
  );
  assert.throws(
    () => assertExactMultipleAccountsResponse([null, null, null], 2),
    /returned 3 account.*2 requested/,
  );
  assert.throws(
    () => assertExactMultipleAccountsResponse({ 0: null }, 1),
    /not an array/,
  );
});

test("migration completion accounts for every expected Task", () => {
  assert.equal(
    isTaskSweepComplete({ old: 0, batch2: 0, new: 3, other: 0 }, 3),
    true,
  );
  assert.equal(
    isTaskSweepComplete({ old: 0, batch2: 0, new: 2, other: 0 }, 3),
    false,
    "a short inventory must not mark the sweep complete",
  );
  assert.equal(
    isTaskSweepComplete({ old: 0, batch2: 0, new: 4, other: 0 }, 3),
    false,
    "an oversized inventory must not mark the sweep complete",
  );
});

test("broader Task inventory exposes a supported-size account with a corrupt discriminator", async () => {
  const corruptTask = Buffer.alloc(382);
  corruptTask.fill(7, 0, 8);
  const corruptAddress = Keypair.generate().publicKey;
  const entry = { pubkey: corruptAddress, account: account(corruptTask) };
  const connection = {
    async getProgramAccounts(_programId, config) {
      return config.filters?.[0]?.dataSize === 382 ? [entry] : [];
    },
  };
  const candidates = await enumerateTaskCandidates(connection);
  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [corruptAddress.toBase58()],
  );
  assert.throws(
    () => inspectTaskMigrationCompatibility(corruptTask),
    /discriminator mismatch/,
  );
});

test("fee CLI accepts only one known action and never executes an implicit plan", () => {
  assert.deepEqual(parseFeeChangeCommand([]), {
    execute: false,
    mode: "plan",
  });
  assert.deepEqual(parseFeeChangeCommand(["--vote"]), {
    execute: false,
    mode: "vote",
  });
  assert.deepEqual(parseFeeChangeCommand(["--finalize", "--execute"]), {
    execute: true,
    mode: "finalize",
  });
  for (const argv of [
    ["--vote", "--finalize"],
    ["--vote", "--vote"],
    ["--vote", "--execute", "--execute"],
    ["--execute"],
  ]) {
    assert.throws(
      () => parseFeeChangeCommand(argv),
      /exactly one action flag|duplicate fee-change argument|--execute requires/,
    );
  }
  assert.throws(
    () => parseFeeChangeCommand(["--vtoe"]),
    /unknown fee-change argument/,
  );
  assert.throws(
    () => parseFeeChangeCommand(["proposal-address"]),
    /unknown fee-change argument/,
  );
});

test("fee governance timing mirrors permanent and proposal-period bounds", () => {
  assert.deepEqual(validateGovernanceInitializationTiming(86_400, 3_600), {
    votingPeriod: 86_400,
    executionDelay: 3_600,
  });
  for (const [votingPeriod, executionDelay] of [
    [0, 3_600],
    [604_801, 3_600],
    [86_400, -1],
    [86_400, 604_801],
  ]) {
    assert.throws(
      () => validateGovernanceInitializationTiming(votingPeriod, executionDelay),
      /must be in/,
    );
  }
  assert.equal(effectiveProposalVotingPeriod(1, 86_400), 86_400);
  assert.equal(effectiveProposalVotingPeriod(100_000, 86_400), 100_000);
  assert.equal(effectiveProposalVotingPeriod(999_999, 86_400), 604_800);
  assert.equal(effectiveProposalVotingPeriod(0, 86_400), 86_400);
  assert.equal(effectiveProposalVotingPeriod(-1, 86_400), 86_400);
  assert.throws(
    () => effectiveProposalVotingPeriod(1, 0),
    /live governance voting period/,
  );
});

test("fee voter selection maximizes capped reputation weight deterministically", () => {
  const lowerWeight = {
    publicKey: new PublicKey(Buffer.alloc(32, 2)),
    account: { stake: 200_000_000n, reputation: 5_000 },
  };
  const higherWeight = {
    publicKey: new PublicKey(Buffer.alloc(32, 3)),
    account: { stake: 100_000_000n, reputation: 10_000 },
  };
  const rules = { maxVoteWeight: 100_000_000n };
  const selected = selectBestGovernanceVoter(
    [lowerWeight, higherWeight],
    rules,
  );
  assert.equal(selected.voter, higherWeight);
  assert.equal(selected.weight, 100_000_000n);

  const tieWinner = {
    publicKey: new PublicKey(Buffer.alloc(32, 1)),
    account: { stake: 100_000_000n, reputation: 10_000 },
  };
  assert.equal(
    selectBestGovernanceVoter([higherWeight, tieWinner], rules).voter,
    tieWinner,
    "equal weights use ascending pubkey rather than RPC response order",
  );
});

test("fee executable binding requires approved exact live bytes and stable custody", () => {
  const binary = Buffer.from("reviewed fee rail SBF");
  const digest = createHash("sha256").update(binary).digest("hex");
  const policy = {
    genesisHash: MAINNET_GENESIS,
    programId: PROGRAM_ID.toBase58(),
    expectedProgramData: Keypair.generate().publicKey.toBase58(),
    loaderProgramId: "BPFLoaderUpgradeab1e11111111111111111111111",
    policySha256: "11".repeat(32),
  };
  const snapshot = {
    contextSlot: 123,
    loaderProgramId: policy.loaderProgramId,
    payload: Buffer.concat([binary, Buffer.alloc(8)]),
    policySha256: policy.policySha256,
    programData: policy.expectedProgramData,
    programId: policy.programId,
    stateDigest: "22".repeat(32),
  };
  assert.equal(
    assertMainnetFeeChangeExecutableBinding({
      genesisHash: MAINNET_GENESIS,
      policy,
      snapshot,
      binaryBytes: binary,
      expectedSoSha256: digest,
    }).actualSoSha256,
    digest,
  );
  assert.equal(
    assertApprovedFeeChangeSbf(binary, digest).binaryBytes,
    binary.length,
  );
  assert.equal(
    assertFeeChangeLoaderSnapshotUnchanged({
      initial: snapshot,
      immediate: { ...snapshot, contextSlot: 124 },
      policy,
      genesisHash: MAINNET_GENESIS,
      binaryBytes: binary,
      expectedSoSha256: digest,
    }).contextSlot,
    124,
  );
  assert.throws(
    () => assertApprovedFeeChangeSbf(binary, "00".repeat(32)),
    /SBF sha256 .* != approved/,
  );
  const wrongLiveBytes = {
    ...snapshot,
    payload: Buffer.from(snapshot.payload),
  };
  wrongLiveBytes.payload[0] ^= 0xff;
  assert.throws(
    () =>
      assertMainnetFeeChangeExecutableBinding({
        genesisHash: MAINNET_GENESIS,
        policy,
        snapshot: wrongLiveBytes,
        binaryBytes: binary,
        expectedSoSha256: digest,
      }),
    /executable bytes do not match/,
  );
  const nonzeroPadding = {
    ...snapshot,
    payload: Buffer.from(snapshot.payload),
  };
  nonzeroPadding.payload[nonzeroPadding.payload.length - 1] = 1;
  assert.throws(
    () =>
      assertMainnetFeeChangeExecutableBinding({
        genesisHash: MAINNET_GENESIS,
        policy,
        snapshot: nonzeroPadding,
        binaryBytes: binary,
        expectedSoSha256: digest,
      }),
    /nonzero bytes after/,
  );
  assert.throws(
    () =>
      assertFeeChangeLoaderSnapshotUnchanged({
        initial: snapshot,
        immediate: { ...snapshot, stateDigest: "33".repeat(32) },
        policy,
        genesisHash: MAINNET_GENESIS,
        binaryBytes: binary,
        expectedSoSha256: digest,
      }),
    /loader state changed/,
  );
  assert.throws(
    () =>
      assertMainnetFeeChangeExecutableBinding({
        genesisHash: MAINNET_GENESIS,
        policy: { ...policy, programId: Keypair.generate().publicKey.toBase58() },
        snapshot,
        binaryBytes: binary,
        expectedSoSha256: digest,
      }),
    /loader policy program/,
  );
});

test("fee finalize decodes a context-pinned on-chain Clock sysvar", () => {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(1_700_000_000n, 32);
  const response = {
    context: { slot: 500 },
    value: {
      data,
      executable: false,
      owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
    },
  };
  assert.deepEqual(
    decodeFeeChangeChainClockResponse(response, { minContextSlot: 499 }),
    { contextSlot: 500, unixTimestamp: 1_700_000_000n },
  );
  assert.throws(
    () => decodeFeeChangeChainClockResponse(response, { minContextSlot: 501 }),
    /below required 501/,
  );
  assert.throws(
    () =>
      decodeFeeChangeChainClockResponse({
        ...response,
        value: { ...response.value, data: Buffer.alloc(39) },
      }),
    /data length 39/,
  );
  assert.throws(
    () =>
      decodeFeeChangeChainClockResponse({
        ...response,
        value: { ...response.value, owner: PublicKey.default },
      }),
    /owner is not the Sysvar program/,
  );
});

function canonicalFeeProposal(feeBps = 500) {
  const proposer = Keypair.generate().publicKey;
  const nonce = 42n;
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const [proposalAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), proposer.toBuffer(), nonceBytes],
    PROGRAM_ID,
  );
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(feeBps);
  const rules = Buffer.alloc(64);
  rules[0] = 1;
  rules.writeBigUInt64LE(10_000_000n, 1);
  rules.writeUInt16LE(5_000, 9);
  rules.writeBigUInt64LE(1_000_000_000n, 11);
  rules.writeUInt16LE(3, 19);
  rules.writeUInt16LE(5_000, 21);
  return {
    proposalAddress,
    proposal: {
      proposer,
      nonce,
      proposalType: { feeChange: {} },
      titleHash: [
        ...createHash("sha256")
          .update(`Set protocol_fee_bps to ${feeBps}`)
          .digest(),
      ],
      payload: [...payload],
      status: { active: {} },
      votesFor: 120_000_000n,
      votesAgainst: 1_000_000n,
      totalVoters: 3,
      quorum: 100_000_000n,
      votingDeadline: 1_000n,
      executionAfter: 2_000n,
      _reserved: [...rules],
    },
  };
}

test("fee vote/finalize binding rejects wrong type, payload, fee, and proposal PDA", () => {
  const fixture = canonicalFeeProposal(500);
  assert.equal(
    assertCanonicalFeeChangeProposal(
      fixture.proposal,
      fixture.proposalAddress,
      500,
    ).intendedFeeBps,
    500,
  );
  assert.throws(
    () =>
      assertCanonicalFeeChangeProposal(
        { ...fixture.proposal, proposalType: { rateLimitChange: {} } },
        fixture.proposalAddress,
        500,
      ),
    /not FeeChange/,
  );
  assert.throws(
    () =>
      assertCanonicalFeeChangeProposal(
        fixture.proposal,
        fixture.proposalAddress,
        501,
      ),
    /payload fee 500.*intended 501/,
  );
  const noncanonicalPayload = {
    ...fixture.proposal,
    payload: [...fixture.proposal.payload],
  };
  noncanonicalPayload.payload[63] = 1;
  assert.throws(
    () =>
      assertCanonicalFeeChangeProposal(
        noncanonicalPayload,
        fixture.proposalAddress,
        500,
      ),
    /nonzero trailing bytes/,
  );
  assert.throws(
    () =>
      assertCanonicalFeeChangeProposal(
        fixture.proposal,
        Keypair.generate().publicKey,
        500,
      ),
    /is not canonical/,
  );
});

test("fee finalize requires a passing live window and an Executed post-image", () => {
  const fixture = canonicalFeeProposal(500);
  assert.equal(
    assertFeeChangeExecutionReady(fixture.proposal, 2_001).executionAfter,
    2_000n,
  );
  assert.throws(
    () =>
      assertFeeChangeExecutionReady(
        { ...fixture.proposal, totalVoters: 2 },
        2_001,
      ),
    /would be Defeated/,
  );
  const corruptRules = [
    {
      field: "min_voter_stake",
      write: (rules) => rules.writeBigUInt64LE(0n, 1),
    },
    {
      field: "min_voter_reputation",
      write: (rules) => rules.writeUInt16LE(4_999, 9),
    },
    {
      field: "min_voter_reputation",
      write: (rules) => rules.writeUInt16LE(10_001, 9),
    },
    {
      field: "max_vote_weight",
      write: (rules) => rules.writeBigUInt64LE(9_999_999n, 11),
    },
    {
      field: "min_distinct_voters",
      write: (rules) => rules.writeUInt16LE(2, 19),
    },
    {
      field: "approval_threshold_bps",
      write: (rules) => rules.writeUInt16LE(0, 21),
    },
    {
      field: "approval_threshold_bps",
      write: (rules) => rules.writeUInt16LE(10_000, 21),
    },
  ];
  for (const { field, write } of corruptRules) {
    const rules = Buffer.from(fixture.proposal._reserved);
    write(rules);
    assert.throws(
      () =>
        assertFeeChangeExecutionReady(
          { ...fixture.proposal, _reserved: [...rules] },
          2_001,
        ),
      new RegExp(`invalid ${field}`),
      `${field} corruption must fail before execute_proposal can mark the proposal Defeated`,
    );
  }
  assert.throws(
    () =>
      assertFeeChangeExecutionReady(
        fixture.proposal,
        2_000 + 7 * 24 * 60 * 60 + 1,
      ),
    /window expired.*Defeated/,
  );
  assert.throws(
    () =>
      assertExecutedFeeChangePostImage(
        { ...fixture.proposal, status: { defeated: {} } },
        500,
        500,
      ),
    /post-status is not Executed/,
    "a defeated proposal must fail even when the fee already had the intended value",
  );
  assert.deepEqual(
    assertExecutedFeeChangePostImage(
      { ...fixture.proposal, status: { executed: {} } },
      500,
      500,
    ),
    { intendedFeeBps: 500, status: "executed" },
  );
});

test("fee signing rail rejects wrong cluster, program, and artifact", () => {
  const idl = {
    address: PROGRAM_ID.toBase58(),
    instructions: [
      { name: "create_proposal" },
      { name: "vote_proposal" },
      { name: "execute_proposal" },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(idl));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const valid = {
    genesisHash: MAINNET_GENESIS,
    programId: PROGRAM_ID,
    idl,
    idlBytes: bytes,
    expectedIdlSha256: digest,
  };
  assert.equal(
    assertMainnetFeeChangeRailBinding(valid).actualIdlSha256,
    digest,
  );
  assert.throws(
    () =>
      assertMainnetFeeChangeRailBinding({ ...valid, genesisHash: "devnet" }),
    /not mainnet-beta/,
  );
  assert.throws(
    () =>
      assertMainnetFeeChangeRailBinding({
        ...valid,
        programId: Keypair.generate().publicKey,
      }),
    /!= pinned AgenC program/,
  );
  assert.throws(
    () =>
      assertMainnetFeeChangeRailBinding({
        ...valid,
        expectedIdlSha256: "00".repeat(32),
      }),
    /IDL sha256 .* != approved/,
  );
  const wrongAddressIdl = {
    ...idl,
    address: Keypair.generate().publicKey.toBase58(),
  };
  const wrongAddressBytes = Buffer.from(JSON.stringify(wrongAddressIdl));
  assert.throws(
    () =>
      assertMainnetFeeChangeRailBinding({
        ...valid,
        idl: wrongAddressIdl,
        idlBytes: wrongAddressBytes,
        expectedIdlSha256: createHash("sha256")
          .update(wrongAddressBytes)
          .digest("hex"),
      }),
    /IDL address .* != pinned program/,
  );
});
