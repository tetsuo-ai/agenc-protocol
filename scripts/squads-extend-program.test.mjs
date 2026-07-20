import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCredentialFreeCliRpcUrl,
  buildExtensionMessage,
  buildCreateProposalCliArgs,
  decodeExtensionMessage,
  EXTENSION_POLICY,
  verifyPreExtensionState,
} from "./squads-extend-program.mjs";

// Produced independently by squads-multisig 2.1.0
// TransactionMessage::try_compile(...).try_to_vec().
const OFFICIAL_SQUADS_FIXTURE_BASE64 =
  "AQECBa48tSlwxTRUCjeST5CF+8gOgTSwPXPZfkRCli49C//KwmtSgRo0Zzf3g4VB3OY2D2/ancTjR1s6kpb5YhrUbIzyTwZjQCaGvZn+Y82/+nVRTbbSKIfGIqrvTvbb7UT16AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqj2kU6IobDiEBU+92OuKwDCuT0WwSTSwFN6EASAAAABBAUBAgADAAgACQAAAIB7AQAA";

test("builds the exact independently compiled Squads extension message", async () => {
  const message = await buildExtensionMessage();
  assert.deepEqual(
    Buffer.from(message.bytes),
    Buffer.from(OFFICIAL_SQUADS_FIXTURE_BASE64, "base64"),
  );
  assert.equal(message.sha256, EXTENSION_POLICY.expectedMessageSha256);
});

test("binds the reviewed multisig and vault index to the official Squads program", async () => {
  await assert.rejects(
    buildExtensionMessage({
      ...EXTENSION_POLICY,
      multisig: EXTENSION_POLICY.systemProgram,
    }),
    /derived Squads vault .* differs from reviewed/,
  );
  await assert.rejects(
    buildExtensionMessage({
      ...EXTENSION_POLICY,
      vaultIndex: 256,
    }),
    /Squads vault index does not fit in u8/,
  );
});

test("binds the checked loader call, authority, payer, and exact capacity", async () => {
  const message = await buildExtensionMessage();
  const decoded = decodeExtensionMessage(message.bytes);
  assert.deepEqual(
    {
      numSigners: decoded.numSigners,
      numWritableSigners: decoded.numWritableSigners,
      numWritableNonSigners: decoded.numWritableNonSigners,
    },
    { numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 2 },
  );
  assert.equal(decoded.accountKeys[0], EXTENSION_POLICY.vault);
  assert.equal(
    decoded.accountKeys[decoded.instructions[0].programIdIndex],
    EXTENSION_POLICY.loader,
  );
  assert.deepEqual(
    decoded.instructions[0].accountIndexes.map((index) => decoded.accountKeys[index]),
    [
      EXTENSION_POLICY.programData,
      EXTENSION_POLICY.program,
      EXTENSION_POLICY.vault,
      EXTENSION_POLICY.systemProgram,
      EXTENSION_POLICY.vault,
    ],
  );
  const loaderData = Buffer.from(decoded.instructions[0].data);
  assert.equal(loaderData.readUInt32LE(0), 9);
  assert.equal(loaderData.readUInt32LE(4), EXTENSION_POLICY.additionalBytes);
  assert.equal(
    EXTENSION_POLICY.previousPayloadCapacity + EXTENSION_POLICY.additionalBytes,
    EXTENSION_POLICY.requiredPayloadBytes,
  );
});

test("decoder rejects truncation and trailing bytes", async () => {
  const message = await buildExtensionMessage();
  assert.throws(
    () => decodeExtensionMessage(message.bytes.slice(0, -1)),
    /truncated/,
  );
  assert.throws(
    () =>
      decodeExtensionMessage(
        Uint8Array.from([...message.bytes, 0]),
      ),
    /trailing/,
  );
});

test("refuses RPC URL shapes that the Squads CLI could leak as credentials", () => {
  assert.equal(
    assertCredentialFreeCliRpcUrl("https://api.mainnet-beta.solana.com"),
    "https://api.mainnet-beta.solana.com/",
  );
  for (const rpcUrl of [
    "http://api.mainnet-beta.solana.com",
    "https://user:secret@rpc.example",
    "https://rpc.example/secret-token",
    "https://rpc.example/?api-key=secret",
    "https://rpc.example/#secret",
  ]) {
    assert.throws(
      () => assertCredentialFreeCliRpcUrl(rpcUrl),
      /credential-free HTTPS/,
    );
  }
});

test("passes the pinned program and every serialized byte to the Squads CLI", async () => {
  const message = await buildExtensionMessage();
  const args = buildCreateProposalCliArgs(
    {
      rpcUrl: EXTENSION_POLICY.defaultRpcUrl,
      keypair: "/reviewed/member.json",
      priorityFeeLamports: "5000",
    },
    message.bytes,
  );
  assert.equal(args[0], "vault-transaction-create");
  assert.equal(
    args[args.indexOf("--program-id") + 1],
    EXTENSION_POLICY.squadsProgram,
  );
  assert.equal(
    args[args.indexOf("--multisig-pubkey") + 1],
    EXTENSION_POLICY.multisig,
  );
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--transaction-message") {
      forwarded.push(Number(args[index + 1]));
      index += 1;
    }
  }
  assert.deepEqual(Uint8Array.from(forwarded), message.bytes);
});

function programDataFixture({
  authority = EXTENSION_POLICY.vault,
  payloadBytes = EXTENSION_POLICY.previousPayloadCapacity,
} = {}) {
  const data = Buffer.alloc(payloadBytes + 45);
  data.writeUInt32LE(3, 0);
  data[12] = 1;
  const fixture = Buffer.from(OFFICIAL_SQUADS_FIXTURE_BASE64, "base64");
  // The reviewed vault is the first account key in the independently compiled
  // message (after its 4-byte header).
  fixture.copy(data, 13, 4, 36);
  if (authority !== EXTENSION_POLICY.vault) data.fill(0, 13, 45);
  return data;
}

test("pre-extension verifier binds mainnet, loader state, rent, and vault funding", async () => {
  const calls = [];
  const rpc = async (_url, method) => {
    calls.push(method);
    if (method === "getGenesisHash") return EXTENSION_POLICY.mainnetGenesis;
    if (method === "getAccountInfo") {
      return {
        context: { slot: 123 },
        value: {
          data: [programDataFixture().toString("base64"), "base64"],
          executable: false,
          lamports: 15_196_443_120,
          owner: EXTENSION_POLICY.loader,
        },
      };
    }
    if (method === "getMinimumBalanceForRentExemption") return 15_872_621_040;
    if (method === "getBalance") return { value: 700_000_000 };
    throw new Error(`unexpected ${method}`);
  };
  const state = await verifyPreExtensionState("https://rpc.invalid", undefined, rpc);
  assert.equal(state.requiredTopUpLamports, 676_177_920);
  assert.equal(state.contextSlot, 123);
  assert.deepEqual(calls, [
    "getGenesisHash",
    "getAccountInfo",
    "getMinimumBalanceForRentExemption",
    "getBalance",
  ]);
});

test("pre-extension verifier refuses wrong cluster, repeat extension, and underfunding", async () => {
  await assert.rejects(
    verifyPreExtensionState("https://rpc.invalid", undefined, async () => "devnet"),
    /not reviewed mainnet-beta/,
  );
  const rpc = async (_url, method) => {
    if (method === "getGenesisHash") return EXTENSION_POLICY.mainnetGenesis;
    if (method === "getAccountInfo") {
      return {
        context: { slot: 123 },
        value: {
          data: [
            programDataFixture({ payloadBytes: EXTENSION_POLICY.requiredPayloadBytes }).toString(
              "base64",
            ),
            "base64",
          ],
          executable: false,
          lamports: 15_872_621_040,
          owner: EXTENSION_POLICY.loader,
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    verifyPreExtensionState("https://rpc.invalid", undefined, rpc),
    /duplicate or stale extension/,
  );

  const underfundedRpc = async (_url, method) => {
    if (method === "getGenesisHash") return EXTENSION_POLICY.mainnetGenesis;
    if (method === "getAccountInfo") {
      return {
        context: { slot: 123 },
        value: {
          data: [programDataFixture().toString("base64"), "base64"],
          executable: false,
          lamports: 15_196_443_120,
          owner: EXTENSION_POLICY.loader,
        },
      };
    }
    if (method === "getMinimumBalanceForRentExemption") return 15_872_621_040;
    if (method === "getBalance") return { value: 1 };
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    verifyPreExtensionState("https://rpc.invalid", undefined, underfundedRpc),
    /vault needs 676177920 lamports/,
  );
});
