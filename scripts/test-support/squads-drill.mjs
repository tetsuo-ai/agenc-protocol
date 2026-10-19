// Test-only Squads v4 wire subset: no ALTs, ephemeral signers, spending limits,
// or arbitrary configuration. Independently encoded from the v4 IDL and wire
// layout published with @sqds/multisig 2.1.4 (npm SRI in EXPLORER_METADATA.md).
// https://github.com/Squads-Protocol/v4/tree/main/sdk/multisig
// Keeping this tiny fixture client avoids adding its unused legacy SPL/native
// bigint dependency tree to production tooling. Real deployed SBF validates it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { decodeSquadsV4MultisigAccount } from "../program-upgrade-authority-policy.mjs";
const require = createRequire(
  new URL("../../tests-integration/package.json", import.meta.url),
);
const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");
const id = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const prefix = Buffer.from("multisig");
const u8 = (n) => {
  assert.ok(Number.isInteger(n) && n >= 0 && n <= 255);
  return Buffer.from([n]);
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync([prefix, ...seeds], id);
export const getMultisigPda = ({ createKey }) =>
  pda(prefix, createKey.toBuffer());
export const getVaultPda = ({ multisigPda, index }) =>
  pda(multisigPda.toBuffer(), Buffer.from("vault"), u8(index));
const transactionPda = (multi, index) =>
  pda(multi.toBuffer(), Buffer.from("transaction"), u64(index))[0];
const proposalPda = (multi, index) =>
  pda(
    multi.toBuffer(),
    Buffer.from("transaction"),
    u64(index),
    Buffer.from("proposal"),
  )[0];
const key = (pubkey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
const instruction = (name, keys, data = Buffer.alloc(0)) =>
  new TransactionInstruction({
    programId: id,
    keys,
    data: Buffer.concat([
      createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
      data,
    ]),
  });
const plans = new Map();
export const types = { Permissions: { all: () => ({ mask: 7 }) } };
export const accounts = {
  ProgramConfig: {
    async fromAccountAddress(connection, address) {
      const a = await connection.getAccountInfo(address);
      assert.ok(a?.owner.equals(id));
      assert.ok(
        a.data
          .subarray(0, 8)
          .equals(
            createHash("sha256")
              .update("account:ProgramConfig")
              .digest()
              .subarray(0, 8),
          ),
      );
      return { treasury: new PublicKey(a.data.subarray(48, 80)) };
    },
  },
  Multisig: {
    async fromAccountAddress(connection, address) {
      const a = await connection.getAccountInfo(address);
      const decoded = decodeSquadsV4MultisigAccount(a, address, id);
      return {
        ...decoded,
        configAuthority: new PublicKey(decoded.configAuthority),
      };
    },
  },
};
export const instructions = {
  multisigCreateV2({
    treasury,
    creator,
    multisigPda,
    configAuthority,
    threshold,
    members,
    timeLock,
    createKey,
    rentCollector,
  }) {
    assert.equal(configAuthority, null);
    assert.equal(threshold, 2);
    assert.equal(members.length, 3);
    assert.equal(timeLock, 0);
    assert.equal(rentCollector, null);
    const config = pda(Buffer.from("program_config"))[0];
    return instruction(
      "multisig_create_v2",
      [
        key(config),
        key(treasury, true),
        key(multisigPda, true),
        key(createKey, false, true),
        key(creator, true, true),
        key(SystemProgram.programId),
      ],
      Buffer.concat([
        u8(0),
        u16(threshold),
        u32(members.length),
        ...members.map((m) => {
          assert.equal(m.permissions.mask, 7);
          return Buffer.concat([m.key.toBuffer(), u8(7)]);
        }),
        u32(timeLock),
        u8(0),
        u8(0),
      ]),
    );
  },
  vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator,
    vaultIndex,
    ephemeralSigners,
    transactionMessage,
  }) {
    assert.equal(vaultIndex, 0);
    assert.equal(ephemeralSigners, 0);
    const m = transactionMessage.compileToV0Message();
    assert.equal(m.addressTableLookups.length, 0);
    assert.equal(m.header.numRequiredSignatures, 1);
    assert.ok(
      m.staticAccountKeys[0].equals(getVaultPda({ multisigPda, index: 0 })[0]),
    );
    const {
      numRequiredSignatures: signers,
      numReadonlySignedAccounts: readonlySigners,
      numReadonlyUnsignedAccounts: readonlyNonSigners,
    } = m.header;
    const message = Buffer.concat([
      u8(signers),
      u8(signers - readonlySigners),
      u8(m.staticAccountKeys.length - signers - readonlyNonSigners),
      u8(m.staticAccountKeys.length),
      ...m.staticAccountKeys.map((k) => k.toBuffer()),
      u8(m.compiledInstructions.length),
      ...m.compiledInstructions.map((i) =>
        Buffer.concat([
          u8(i.programIdIndex),
          u8(i.accountKeyIndexes.length),
          Buffer.from(i.accountKeyIndexes),
          u16(i.data.length),
          Buffer.from(i.data),
        ]),
      ),
      u8(0),
    ]);
    plans.set(`${multisigPda}:${transactionIndex}`, m);
    return instruction(
      "vault_transaction_create",
      [
        key(multisigPda, true),
        key(transactionPda(multisigPda, transactionIndex), true),
        key(creator, false, true),
        key(creator, true, true),
        key(SystemProgram.programId),
      ],
      Buffer.concat([u8(0), u8(0), u32(message.length), message, u8(0)]),
    );
  },
  proposalCreate({ multisigPda, creator, transactionIndex }) {
    return instruction(
      "proposal_create",
      [
        key(multisigPda),
        key(proposalPda(multisigPda, transactionIndex), true),
        key(creator, false, true),
        key(creator, true, true),
        key(SystemProgram.programId),
      ],
      Buffer.concat([u64(transactionIndex), u8(0)]),
    );
  },
  proposalApprove({ multisigPda, transactionIndex, member }) {
    return instruction(
      "proposal_approve",
      [
        key(multisigPda),
        key(member, true, true),
        key(proposalPda(multisigPda, transactionIndex), true),
      ],
      u8(0),
    );
  },
  async vaultTransactionExecute({
    connection,
    multisigPda,
    transactionIndex,
    member,
  }) {
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connection.rpcEndpoint).hostname,
      ),
      "test adapter only accepts loopback RPC",
    );
    const m = plans.get(`${multisigPda}:${transactionIndex}`);
    assert.ok(m, "only execute the exact message stored by this drill");
    const transaction = transactionPda(multisigPda, transactionIndex);
    const a = await connection.getAccountInfo(transaction);
    assert.ok(a?.owner.equals(id));
    const remaining = m.staticAccountKeys.map((k, i) =>
      key(k, m.isAccountWritable(i), false),
    );
    return {
      lookupTableAccounts: [],
      instruction: instruction("vault_transaction_execute", [
        key(multisigPda),
        key(proposalPda(multisigPda, transactionIndex), true),
        key(transaction),
        key(member, false, true),
        ...remaining,
      ]),
    };
  },
};
