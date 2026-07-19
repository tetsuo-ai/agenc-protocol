// Deterministic property-driven fuzzing against the compiled production SBF.
//
// The Rust `fuzz` crate models state transitions. This layer deliberately crosses
// the real instruction-deserialization and account-parsing boundary with every
// production discriminator, malformed bytes, wrong owners/data, duplicate aliases,
// and writable/signer permutations. Persisted seeds make every failure replayable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TransactionInstruction } from "@solana/web3.js";
import {
  IDL,
  PID,
  SO,
  LiteSVM,
  FailedTransactionMetadata,
  Keypair,
  PublicKey,
  SystemProgram,
  send,
} from "./harness.mjs";

const REGRESSION_SEEDS = [0x0a63ec01, 0x51bf129d, 0xd15f00d5];

function instructionDisplayName(name) {
  return name
    .split("_")
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join("");
}

function assertRecognizedInstruction(logs, instruction, label) {
  const marker = `Instruction: ${instructionDisplayName(instruction.name)}`;
  assert.ok(
    logs.includes(marker),
    `${label} never reached the compiled ${instruction.name} dispatcher (missing ${marker}):\n${logs}`,
  );
}

function assertNoProcessorPanic(logs, instruction, label) {
  assert.doesNotMatch(
    logs,
    /panicked at|Program failed to complete|memory violation|access violation/iu,
    `${label} crashed ${instruction.name}:\n${logs}`,
  );
}

function minimalBorshValue(type) {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
      case "u8":
        return Buffer.alloc(1);
      case "u16":
        return Buffer.alloc(2);
      case "u32":
        return Buffer.alloc(4);
      case "i64":
      case "u64":
        return Buffer.alloc(8);
      case "pubkey":
        return Buffer.alloc(32);
      case "string":
        return Buffer.alloc(4);
      default:
        throw new Error(`processor fuzz has no minimal Borsh encoder for ${type}`);
    }
  }
  if ("array" in type) {
    const [elementType, length] = type.array;
    return Buffer.concat(
      Array.from({ length }, () => minimalBorshValue(elementType)),
    );
  }
  if ("option" in type) return Buffer.from([0]);
  if ("vec" in type) return Buffer.alloc(4);
  throw new Error(
    `processor fuzz has no minimal Borsh encoder for ${JSON.stringify(type)}`,
  );
}

function minimallyValidInstructionData(instruction) {
  return Buffer.concat([
    Buffer.from(instruction.discriminator),
    ...instruction.args.map((argument) => minimalBorshValue(argument.type)),
  ]);
}

function deterministicBytes(seed, label, length) {
  const chunks = [];
  let produced = 0;
  for (let counter = 0; produced < length; counter += 1) {
    const chunk = createHash("sha256")
      .update(String(seed))
      .update("\0")
      .update(label)
      .update("\0")
      .update(String(counter))
      .digest();
    chunks.push(chunk);
    produced += chunk.length;
  }
  return Buffer.concat(chunks, produced).subarray(0, length);
}

test("compiled processor rejects deterministic malformed instruction/account corpus without panicking", () => {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const payer = Keypair.fromSeed(Buffer.alloc(32, 0x42));
  svm.airdrop(payer.publicKey, 100_000_000_000n);

  const fakeAccounts = Array.from({ length: 8 }, (_, index) =>
    Keypair.fromSeed(Buffer.alloc(32, index + 1)).publicKey,
  );
  for (const [index, address] of fakeAccounts.entries()) {
    svm.setAccount(address, {
      lamports: 10_000_000,
      data: deterministicBytes(0xabc000 + index, "account-data", index * 17),
      owner:
        index % 2 === 0
          ? PID
          : new PublicKey(
              deterministicBytes(0xabc000 + index, "account-owner", 32),
            ),
      executable: false,
      rentEpoch: 0,
    });
  }

  let cases = 0;
  for (const seed of REGRESSION_SEEDS) {
    for (const instruction of IDL.instructions) {
      const material = deterministicBytes(seed, instruction.name, 600);
      const tailLength = material.readUInt16LE(0) % 513;
      const data = Buffer.concat([
        Buffer.from(instruction.discriminator),
        material.subarray(2, 2 + tailLength),
      ]);
      const keyCount = material[515] % 15;
      const keys = [];
      for (let index = 0; index < keyCount; index += 1) {
        const offset = 516 + index * 3;
        const selector = material[offset] % (fakeAccounts.length + 2);
        const pubkey =
          selector === fakeAccounts.length
            ? payer.publicKey
            : selector === fakeAccounts.length + 1
              ? SystemProgram.programId
              : fakeAccounts[selector];
        keys.push({
          pubkey,
          isSigner:
            pubkey.equals(payer.publicKey) && (material[offset + 1] & 1) === 1,
          isWritable: (material[offset + 2] & 1) === 1,
        });
      }

      const result = send(
        svm,
        new TransactionInstruction({ programId: PID, keys, data }),
        [payer],
      );
      assert.ok(
        result instanceof FailedTransactionMetadata,
        `seed ${seed.toString(16)} unexpectedly accepted malformed ${instruction.name}`,
      );
      const logs = result.meta().logs().join("\n");
      const label = `seed ${seed.toString(16)}`;
      assertRecognizedInstruction(logs, instruction, label);
      assertNoProcessorPanic(logs, instruction, label);
      cases += 1;
      svm.expireBlockhash();
    }
  }

  assert.equal(cases, REGRESSION_SEEDS.length * IDL.instructions.length);
});

test("compiled processor reaches account validation with IDL-shaped deterministic mutations", () => {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const payer = Keypair.fromSeed(Buffer.alloc(32, 0x24));
  svm.airdrop(payer.publicKey, 100_000_000_000n);

  const accountPoolSize = Math.max(
    ...IDL.instructions.map((instruction) => instruction.accounts.length),
  );
  const shapedAccounts = Array.from({ length: accountPoolSize }, (_, index) =>
    Keypair.fromSeed(
      deterministicBytes(0x5bf000 + index, "idl-shaped-account", 32),
    ).publicKey,
  );
  for (const [index, address] of shapedAccounts.entries()) {
    svm.setAccount(address, {
      lamports: 10_000_000,
      data: deterministicBytes(
        0x5bf000 + index,
        "idl-shaped-data",
        8 + ((index * 29) % 257),
      ),
      owner:
        index % 3 === 0
          ? PID
          : index % 3 === 1
            ? SystemProgram.programId
            : new PublicKey(
                deterministicBytes(
                  0x5bf000 + index,
                  "idl-shaped-owner",
                  32,
                ),
              ),
      executable: false,
      rentEpoch: 0,
    });
  }

  let cases = 0;
  for (const seed of REGRESSION_SEEDS) {
    for (const instruction of IDL.instructions) {
      // Unlike the broad malformed corpus above, these bytes are valid Borsh for
      // the instruction's complete IDL argument schema and the account vector has
      // exactly the declared width. Mutations therefore exercise Anchor account
      // ownership/data/constraint checks instead of stopping at dispatch, argument
      // deserialization, or NotEnoughAccountKeys.
      const data = minimallyValidInstructionData(instruction);
      const material = deterministicBytes(
        seed,
        `idl-shaped:${instruction.name}`,
        Math.max(1, instruction.accounts.length * 3),
      );
      const keys = instruction.accounts.map((account, index) => {
        const offset = index * 3;
        const extraSigner =
          account.address === undefined && (material[offset] & 0x07) === 0;
        const isSigner = account.signer === true || extraSigner;
        const pubkey = isSigner
          ? payer.publicKey
          : account.address !== undefined
            ? new PublicKey(account.address)
            : shapedAccounts[material[offset + 1] % shapedAccounts.length];
        const declaredWritable = account.writable === true;
        const flipWritable = (material[offset + 2] & 0x03) === 0;
        return {
          pubkey,
          isSigner,
          isWritable: flipWritable ? !declaredWritable : declaredWritable,
        };
      });

      const result = send(
        svm,
        new TransactionInstruction({ programId: PID, keys, data }),
        [payer],
      );
      const label = `IDL-shaped seed ${seed.toString(16)}`;
      assert.ok(
        result instanceof FailedTransactionMetadata,
        `${label} unexpectedly accepted mutated ${instruction.name}`,
      );
      const logs = result.meta().logs().join("\n");
      assertRecognizedInstruction(logs, instruction, label);
      assertNoProcessorPanic(logs, instruction, label);
      assert.doesNotMatch(
        logs,
        /InstructionDidNotDeserialize|NotEnoughAccountKeys|not enough account keys/iu,
        `${label} did not reach meaningful account validation for ${instruction.name}:\n${logs}`,
      );
      cases += 1;
      svm.expireBlockhash();
    }
  }

  assert.equal(cases, REGRESSION_SEEDS.length * IDL.instructions.length);
});
