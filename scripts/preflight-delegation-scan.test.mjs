import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  classifyContinuity,
  decodeAgentRegistration,
  decodeDelegation,
  redactRpcText,
  scanDelegations,
} from "./preflight-delegation-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function borshString(value) {
  const bytes = Buffer.from(value, "utf8");
  const result = Buffer.alloc(4 + bytes.length);
  result.writeUInt32LE(bytes.length, 0);
  bytes.copy(result, 4);
  return result;
}

function agentBuffer({
  registeredAt,
  endpoint = "https://worker",
  metadata = "ipfs://agent",
  agentId = Buffer.alloc(32, 7),
  authority = new PublicKey(Buffer.alloc(32, 8)),
  retired = false,
}) {
  const [, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(566);
  discriminator("AgentRegistration").copy(data, 0);
  agentId.copy(data, 8);
  authority.toBuffer().copy(data, 40);
  data[80] = 1;
  let offset = 81;
  for (const value of [endpoint, metadata]) {
    const encoded = borshString(value);
    encoded.copy(data, offset);
    offset += encoded.length;
  }
  data.writeBigInt64LE(registeredAt, offset);
  data[offset + 44] = bump;
  if (retired) Buffer.from("RETD", "ascii").copy(data, offset + 89);
  return data;
}

function delegationBuffer(
  createdAt,
  delegator = Buffer.alloc(32, 3),
  delegatee = Buffer.alloc(32, 4),
  bump = 0,
) {
  const data = Buffer.alloc(99);
  discriminator("ReputationDelegation").copy(data, 0);
  delegator.copy(data, 8);
  delegatee.copy(data, 40);
  data.writeUInt16LE(100, 72);
  data.writeBigInt64LE(createdAt, 82);
  data[90] = bump;
  return data;
}

test("decodes registered_at after capabilities, status, endpoint, and metadata", () => {
  const decoded = decodeAgentRegistration(
    agentBuffer({ registeredAt: 1_726_000_123n, endpoint: "x", metadata: "longer-value" }),
  );
  assert.equal(decoded.registeredAt, 1_726_000_123n);
  assert.deepEqual(decoded.agentId, Buffer.alloc(32, 7));
});

test("rejects the former byte-72 endpoint parser assumption", () => {
  const malformed = agentBuffer({ registeredAt: 42n });
  // Byte 72 is capabilities, not a String length. Make it look enormous; the real
  // decoder skips capabilities and still reaches the correct endpoint at byte 81.
  malformed.writeUInt32LE(0xffff_ffff, 72);
  assert.equal(decodeAgentRegistration(malformed).registeredAt, 42n);
});

test("fails closed on malformed variable-length fields and discriminators", () => {
  const truncated = agentBuffer({ registeredAt: 7n }).subarray(0, 84);
  assert.throws(() => decodeAgentRegistration(truncated), /unexpected account size/);
  const wrong = agentBuffer({ registeredAt: 7n });
  wrong[0] ^= 0xff;
  assert.throws(() => decodeAgentRegistration(wrong), /discriminator mismatch/);
});

test("decodes the exact delegation layout and rejects size/timestamp ambiguity", () => {
  const decoded = decodeDelegation(delegationBuffer(99n));
  assert.equal(decoded.createdAt, 99n);
  assert.equal(decoded.amount, 100);
  assert.throws(() => decodeDelegation(Buffer.alloc(98)), /unexpected account size/);
  assert.throws(() => decodeDelegation(Buffer.alloc(100)), /unexpected account size/);
  assert.throws(() => decodeDelegation(delegationBuffer(0n)), /invalid timestamp/);
  const zeroAmount = delegationBuffer(99n);
  zeroAmount.writeUInt16LE(0, 72);
  assert.throws(() => decodeDelegation(zeroAmount), /amount: invalid 0/);
  const expiredBeforeCreation = delegationBuffer(99n);
  expiredBeforeCreation.writeBigInt64LE(98n, 74);
  assert.throws(
    () => decodeDelegation(expiredBeforeCreation),
    /is not zero or after created_at/,
  );
  const reserved = delegationBuffer(99n);
  reserved[98] = 1;
  assert.throws(() => decodeDelegation(reserved), /reserved bytes are non-zero/);
});

test("continuity classifier blocks same-second and cloned registrations", () => {
  assert.equal(classifyContinuity(9n, 10n), "safe");
  assert.equal(classifyContinuity(10n, 10n), "same-second");
  assert.equal(classifyContinuity(11n, 10n), "clone");
});

test("RPC redaction never retains endpoint credentials, path, or query", () => {
  const secret = "https://user:pass@rpc.example/private/key?api-key=secret";
  const websocket = "wss://socket-secret.example/ws?token=hidden";
  const redacted = redactRpcText(`request failed at ${secret} or ${websocket}`);
  assert.equal(
    redacted,
    "request failed at <redacted-rpc> or <redacted-rpc>",
  );
  for (const token of ["user", "pass", "rpc.example", "private", "secret"]) {
    assert.equal(redacted.includes(token), false);
  }
});

test("scan refuses a non-mainnet genesis before account enumeration", async () => {
  let enumerated = false;
  await assert.rejects(
    scanDelegations({
      getGenesisHash: async () => "devnet",
      getProgramAccounts: async () => {
        enumerated = true;
        return [];
      },
    }),
    /wrong cluster genesis/,
  );
  assert.equal(enumerated, false);
});

test("scan reports orphaned, same-second, cloned, and canonical live delegations as blockers", async () => {
  const agentId = Buffer.alloc(32, 11);
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const delegatee = new PublicKey(Buffer.alloc(32, 12));
  const [delegationPubkey, delegationBump] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("reputation_delegation"),
        agentPda.toBuffer(),
        delegatee.toBuffer(),
      ],
      PROGRAM_ID,
    );

  async function run(registeredAt) {
    return scanDelegations({
      getGenesisHash: async () => MAINNET_GENESIS,
      getProgramAccounts: async () => [
        {
          pubkey: delegationPubkey,
          account: {
            owner: PROGRAM_ID,
            data: delegationBuffer(
              100n,
              agentPda.toBuffer(),
              delegatee.toBuffer(),
              delegationBump,
            ),
          },
        },
      ],
      getAccountInfo: async () =>
        registeredAt === null
          ? null
          : {
              owner: PROGRAM_ID,
              data: agentBuffer({ registeredAt, agentId }),
            },
    });
  }

  const orphaned = await run(null);
  assert.equal(orphaned.blockers[0]?.kind, "orphaned");
  assert.equal(orphaned.records[0]?.continuity, "absent");
  assert.equal(orphaned.records[0]?.cleanupRoute, "treasury");
  assert.equal(orphaned.records[0]?.remainingAccountsRequired, true);
  const sameSecond = await run(100n);
  assert.equal(sameSecond.blockers[0]?.kind, "same-second");
  assert.equal(sameSecond.records[0]?.cleanupRoute, "treasury");
  const clone = await run(101n);
  assert.equal(clone.blockers[0]?.kind, "clone");
  assert.equal(clone.records[0]?.cleanupRoute, "treasury");
  const canonical = await run(99n);
  assert.equal(canonical.blockers.length, 1);
  assert.equal(canonical.blockers[0]?.kind, "live-delegation-cutover");
  assert.equal(canonical.records[0]?.continuity, "continuous");
  assert.equal(canonical.records[0]?.cleanupRoute, "authority");
  assert.equal(canonical.records[0]?.remainingAccountsRequired, false);
  assert.ok(canonical.records[0]?.authority.equals(new PublicKey(Buffer.alloc(32, 8))));
});
