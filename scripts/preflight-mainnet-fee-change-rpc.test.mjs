import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  agentAuthorityMemcmpFilter,
  assertFinalizedFeeChangeAccountAgreement,
  assertSecondaryFeeChangeMainnetGenesis,
  fetchAgentsOwnedBy,
  readAgreedFinalizedFeeChangeProposal,
  requireDistinctSecondaryFeeChangeRpcUrl,
  submitLocallySignedTransaction,
} from "./mainnet-fee-change.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const IDL = JSON.parse(
  readFileSync(
    new URL("../artifacts/anchor/idl/agenc_coordination.json", import.meta.url),
    "utf8",
  ),
);
const coder = new anchor.BorshCoder(IDL);
const programCoder = new anchor.Program(
  IDL,
  new anchor.AnchorProvider(
    new Connection("http://127.0.0.1:8899"),
    new anchor.Wallet(Keypair.generate()),
    {},
  ),
).coder;

function finalizedResponse(data, overrides = {}) {
  return {
    context: { slot: overrides.slot ?? 123 },
    value: {
      data: Buffer.from(data),
      executable: overrides.executable ?? false,
      lamports: overrides.lamports ?? 3_456_789,
      owner: overrides.owner ?? PROGRAM_ID,
      rentEpoch: overrides.rentEpoch ?? 0,
    },
  };
}

async function encodedFeeProposal(feeBps = 500) {
  const proposer = Keypair.generate().publicKey;
  const proposerAuthority = Keypair.generate().publicKey;
  const nonce = 42n;
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const [proposalAddress, bump] = PublicKey.findProgramAddressSync(
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
  const data = await coder.accounts.encode("Proposal", {
    proposer,
    proposer_authority: proposerAuthority,
    nonce: new anchor.BN(nonce.toString()),
    proposal_type: { FeeChange: {} },
    title_hash: [
      ...createHash("sha256")
        .update(`Set protocol_fee_bps to ${feeBps}`)
        .digest(),
    ],
    description_hash: [...Buffer.alloc(32)],
    payload: [...payload],
    status: { Active: {} },
    created_at: new anchor.BN(100),
    voting_deadline: new anchor.BN(1_000),
    execution_after: new anchor.BN(2_000),
    executed_at: new anchor.BN(0),
    votes_for: new anchor.BN(120_000_000),
    votes_against: new anchor.BN(1_000_000),
    total_voters: 3,
    quorum: new anchor.BN(100_000_000),
    bump,
    _reserved: [...rules],
  });
  return { data, proposalAddress };
}

test("agent authority GPA uses the canonical byte-40 memcmp filter", async () => {
  const authority = Keypair.generate().publicKey;
  assert.deepEqual(agentAuthorityMemcmpFilter(authority), {
    memcmp: { offset: 40, bytes: authority.toBase58() },
  });

  const matching = {
    publicKey: Keypair.generate().publicKey,
    account: { authority },
  };
  let receivedFilters;
  const programClient = {
    account: {
      agentRegistration: {
        async all(filters) {
          receivedFilters = filters;
          return [matching];
        },
      },
    },
  };
  assert.deepEqual(
    await fetchAgentsOwnedBy(programClient, authority),
    [matching],
  );
  assert.deepEqual(receivedFilters, [
    { memcmp: { offset: 40, bytes: authority.toBase58() } },
  ]);

  await assert.rejects(
    () =>
      fetchAgentsOwnedBy(
        {
          account: {
            agentRegistration: {
              async all() {
                return [{
                  publicKey: Keypair.generate().publicKey,
                  account: { authority: Keypair.generate().publicKey },
                }];
              },
            },
          },
        },
        authority,
      ),
    /outside the authority filter/,
  );
});

test("executing fee rails require a different RPC host on mainnet-beta", () => {
  assert.equal(
    requireDistinctSecondaryFeeChangeRpcUrl(
      "https://primary.example/rpc",
      "https://secondary.example/rpc",
    ),
    "https://secondary.example/rpc",
  );
  assert.deepEqual(
    assertSecondaryFeeChangeMainnetGenesis(MAINNET_GENESIS),
    { genesisHash: MAINNET_GENESIS },
  );
  assert.throws(
    () =>
      requireDistinctSecondaryFeeChangeRpcUrl(
        "https://primary.example/one",
        "http://primary.example/two",
      ),
    /host distinct/,
  );
  assert.throws(
    () =>
      requireDistinctSecondaryFeeChangeRpcUrl(
        "https://primary.example/one",
        "https://PRIMARY.EXAMPLE./two",
      ),
    /host distinct/,
  );
  assert.throws(
    () =>
      requireDistinctSecondaryFeeChangeRpcUrl(
        "https://primary.example/rpc",
        "",
      ),
    /SECONDARY_RPC_URL is required/,
  );
  assert.throws(
    () => assertSecondaryFeeChangeMainnetGenesis("devnet-genesis"),
    /secondary RPC genesis .* is not mainnet-beta/,
  );
});

test("dual finalized reads require exact Proposal AccountInfo agreement", () => {
  const data = Buffer.from("identical finalized proposal bytes");
  const agreed = assertFinalizedFeeChangeAccountAgreement({
    primaryResponse: finalizedResponse(data, { slot: 500 }),
    secondaryResponse: finalizedResponse(data, { slot: 497 }),
  });
  assert.equal(agreed.primaryContextSlot, 500);
  assert.equal(agreed.secondaryContextSlot, 497);
  assert.equal(agreed.data.equals(data), true);
  assert.match(agreed.stateDigest, /^[0-9a-f]{64}$/);

  const changedData = Buffer.from(data);
  changedData[0] ^= 0xff;
  assert.throws(
    () =>
      assertFinalizedFeeChangeAccountAgreement({
        primaryResponse: finalizedResponse(data),
        secondaryResponse: finalizedResponse(changedData),
      }),
    /account disagreement.*data/,
  );
  assert.throws(
    () =>
      assertFinalizedFeeChangeAccountAgreement({
        primaryResponse: finalizedResponse(data),
        secondaryResponse: finalizedResponse(data, { lamports: 3_456_790 }),
      }),
    /account disagreement.*lamports/,
  );
  assert.throws(
    () =>
      assertFinalizedFeeChangeAccountAgreement({
        primaryResponse: finalizedResponse(data),
        secondaryResponse: finalizedResponse(data, {
          owner: Keypair.generate().publicKey,
        }),
      }),
    /secondary RPC finalized Proposal owner .* !=/,
  );
});

test("agreed finalized raw bytes are decoded and rebound to exact fee intent", async () => {
  const fixture = await encodedFeeProposal(500);
  const calls = [];
  const rpc = (slot, data = fixture.data) => ({
    async getAccountInfoAndContext(address, options) {
      calls.push({ address: address.toBase58(), options, slot });
      return finalizedResponse(data, { slot });
    },
  });
  const agreed = await readAgreedFinalizedFeeChangeProposal({
    primaryConnection: rpc(800),
    secondaryConnection: rpc(798),
    accountCoder: programCoder,
    proposalAddress: fixture.proposalAddress,
    intendedFeeBps: 500,
  });
  assert.equal(agreed.proposal.payload[0], 244);
  assert.deepEqual(
    calls.map(({ address, options }) => ({ address, options })),
    [
      {
        address: fixture.proposalAddress.toBase58(),
        options: { commitment: "finalized" },
      },
      {
        address: fixture.proposalAddress.toBase58(),
        options: { commitment: "finalized" },
      },
    ],
  );

  await assert.rejects(
    () =>
      readAgreedFinalizedFeeChangeProposal({
        primaryConnection: rpc(810),
        secondaryConnection: rpc(809),
        accountCoder: coder,
        proposalAddress: fixture.proposalAddress,
        intendedFeeBps: 501,
      }),
    /payload fee 500.*intended 501/,
  );

  const changed = Buffer.from(fixture.data);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(
    () =>
      readAgreedFinalizedFeeChangeProposal({
        primaryConnection: rpc(820),
        secondaryConnection: rpc(819, changed),
        accountCoder: coder,
        proposalAddress: fixture.proposalAddress,
        intendedFeeBps: 500,
      }),
    /account disagreement.*data/,
  );
});

test("fee broadcasts preserve signatures and context-check confirmation", () => {
  const source = readFileSync(
    new URL("./mainnet-fee-change.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function sendIx(");
  const end = source.indexOf("\nasync function main()", start);
  const sendSource = source.slice(start, end);
  const helperStart = source.indexOf(
    "export async function submitLocallySignedTransaction(",
  );
  const helperEnd = source.indexOf("\nconst PROGRAM_ID_STR", helperStart);
  const helperSource = source.slice(helperStart, helperEnd);
  assert.ok(start >= 0 && end > start, "sendIx source boundary is present");
  assert.ok(
    helperStart >= 0 && helperEnd > helperStart,
    "raw-send helper source boundary is present",
  );
  assert.doesNotMatch(sendSource, /\.rpc\(\)/);
  assert.match(sendSource, /submitLocallySignedTransaction/);
  assert.match(helperSource, /sendRawTransaction/);
  assert.ok(
    helperSource.indexOf("SIGNED") < helperSource.indexOf("sendRawTransaction"),
    "local signature must be printed before network I/O",
  );
  assert.ok(
    sendSource.indexOf("submitLocallySignedTransaction") <
      sendSource.indexOf("confirmTransaction"),
    "submission must complete before confirmation",
  );
  assert.match(sendSource, /confirmation\?\.context\?\.slot/);
  assert.match(sendSource, /transaction \$\{sig\} was submitted/);
  assert.match(sendSource, /postConfirmation/);
});

test("fee broadcast reports the local signature when the RPC response is lost", async () => {
  const signature = Buffer.alloc(64, 7);
  const wireBytes = Buffer.from("signed fee-change transaction");
  const logs = [];
  let sendCalls = 0;
  const transaction = {
    signature,
    serialize() {
      return wireBytes;
    },
  };
  const connection = {
    async sendRawTransaction(receivedBytes, options) {
      sendCalls += 1;
      assert.equal(logs.length, 1, "local signature is logged before network I/O");
      assert.match(logs[0], /^SIGNED fee vote: /);
      assert.equal(Buffer.from(receivedBytes).equals(wireBytes), true);
      assert.deepEqual(options, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      throw new Error("response socket closed");
    },
  };

  let thrown;
  try {
    await submitLocallySignedTransaction({
      connection,
      transaction,
      label: "fee vote",
      sendOptions: {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      },
      log: (message) => logs.push(message),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  const localSignature = logs[0].replace("SIGNED fee vote: ", "");
  assert.match(thrown.message, new RegExp(localSignature));
  assert.match(thrown.message, /UNKNOWN BROADCAST OUTCOME/);
  assert.match(thrown.message, /Do not resubmit/);
  assert.equal(sendCalls, 1);
  assert.equal(logs.some((line) => line.startsWith("SUBMITTED ")), false);
});
