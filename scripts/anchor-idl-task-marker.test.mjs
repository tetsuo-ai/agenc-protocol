// Revision 9 (C): the TaskMarker entries added to the protocol IDL artifacts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TASK_MARKER_DISCRIMINATOR_HEX,
  accountDiscriminator,
  addTaskMarkerToArtifacts,
  lowerCamel,
  parseAccountStruct,
} from "./anchor-idl-task-marker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { BorshAccountsCoder } = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const committedIdlText = read("artifacts/anchor/idl/agenc_coordination.json");
const committedTypesText = read("artifacts/anchor/types/agenc_coordination.ts");
const stateSource = read("programs/agenc-coordination/src/state.rs");
const TYPES_PREFIX = "export type AgencCoordination = ";

// The Anchor build output is the committed artifacts without the TaskMarker
// entries: rebuild that input from the committed files.
function withoutTaskMarker() {
  const idl = JSON.parse(committedIdlText);
  idl.accounts = idl.accounts.filter((entry) => entry.name !== "TaskMarker");
  idl.types = idl.types.filter((entry) => entry.name !== "TaskMarker");
  const at = committedTypesText.indexOf(TYPES_PREFIX) + TYPES_PREFIX.length;
  const types = JSON.parse(committedTypesText.slice(at, -2));
  types.accounts = types.accounts.filter((entry) => entry.name !== "taskMarker");
  types.types = types.types.filter((entry) => entry.name !== "taskMarker");
  return {
    idlText: JSON.stringify(idl, null, 2),
    typesText: `${committedTypesText.slice(0, at)}${JSON.stringify(types, null, 2)};\n`,
  };
}

test("the committed artifacts are the Anchor output plus exactly the checked TaskMarker entries", () => {
  const raw = withoutTaskMarker();
  assert.notEqual(raw.idlText, committedIdlText, "committed IDL lists TaskMarker");
  const patched = addTaskMarkerToArtifacts({ ...raw, stateSource });
  assert.equal(patched.idlText, committedIdlText);
  assert.equal(patched.typesText, committedTypesText);
  // Idempotent: patching the committed artifacts changes nothing.
  const again = addTaskMarkerToArtifacts({
    idlText: committedIdlText,
    typesText: committedTypesText,
    stateSource,
  });
  assert.equal(again.idlText, committedIdlText);
  assert.equal(again.typesText, committedTypesText);
});

test("TaskMarker discriminator and layout are the design's", () => {
  assert.equal(TASK_MARKER_DISCRIMINATOR_HEX, "c10bc0c833d06cff");
  assert.equal(Buffer.from(accountDiscriminator("TaskMarker")).toString("hex"), "c10bc0c833d06cff");
  const idl = JSON.parse(committedIdlText);
  assert.deepEqual(
    idl.accounts.find((entry) => entry.name === "TaskMarker").discriminator,
    [0xc1, 0x0b, 0xc0, 0xc8, 0x33, 0xd0, 0x6c, 0xff],
  );
  const fields = idl.types
    .find((entry) => entry.name === "TaskMarker")
    .type.fields.map(({ name, type }) => [name, type]);
  assert.deepEqual(fields, [
    ["creator", "pubkey"],
    ["status", "u8"],
    ["flags", "u8"],
    ["closed_at", "i64"],
    ["_reserved", { array: ["u8", 6] }],
  ]);
});

test("the generated coders decode a 56-byte marker", () => {
  const coder = new BorshAccountsCoder(JSON.parse(committedIdlText));
  const creator = new PublicKey(Buffer.alloc(32, 7));
  const data = Buffer.alloc(56);
  data.set([0xc1, 0x0b, 0xc0, 0xc8, 0x33, 0xd0, 0x6c, 0xff], 0);
  creator.toBuffer().copy(data, 8);
  data[40] = 3; // Completed
  data[41] = 0b11; // ended a live hire, fee-qualified
  data.writeBigInt64LE(1_700_000_123n, 42);
  const marker = coder.decode("TaskMarker", data);
  assert.ok(marker.creator.equals(creator));
  assert.equal(marker.status, 3);
  assert.equal(marker.flags, 3);
  assert.equal(marker.closed_at.toString(), "1700000123");
  assert.deepEqual([...marker._reserved], [0, 0, 0, 0, 0, 0]);
  assert.equal(coder.size("TaskMarker"), 56);
  // A Task discriminator is not a marker.
  assert.throws(() => coder.decode("TaskMarker", Buffer.concat([Buffer.alloc(8), data.subarray(8)])));
});

test("a changed TaskMarker struct fails the pinned layout check", () => {
  const raw = withoutTaskMarker();
  for (const [from, to] of [
    ["    pub flags: u8,\n    /// When the task was compacted.", "    pub flags: u16,\n    /// When the task was compacted."],
    ["    pub closed_at: i64,", "    pub compacted_at: i64,"],
    ["    pub _reserved: [u8; 6],\n}\n\nimpl TaskMarker", "    pub _reserved: [u8; 7],\n}\n\nimpl TaskMarker"],
  ]) {
    assert.equal(stateSource.split(from).length, 2, `fixture ${from} is unique`);
    assert.throws(
      () => addTaskMarkerToArtifacts({ ...raw, stateSource: stateSource.replace(from, to) }),
      /TaskMarker/u,
    );
  }
});

test("a conflicting existing entry or a non round-tripping input is refused", () => {
  const idl = JSON.parse(committedIdlText);
  idl.accounts.find((entry) => entry.name === "TaskMarker").discriminator[0] ^= 1;
  assert.throws(
    () =>
      addTaskMarkerToArtifacts({
        idlText: JSON.stringify(idl, null, 2),
        typesText: committedTypesText,
        stateSource,
      }),
    /already present with different content/u,
  );
  assert.throws(
    () =>
      addTaskMarkerToArtifacts({
        idlText: `${committedIdlText}\n`,
        typesText: committedTypesText,
        stateSource,
      }),
    /round-trip/u,
  );
});

test("the struct parser and camelCase rule reproduce types Anchor emitted", () => {
  const idl = JSON.parse(committedIdlText);
  for (const name of ["CreatorStats", "DisputeBond", "TaskMarker"]) {
    assert.deepEqual(parseAccountStruct(stateSource, name), idl.types.find((entry) => entry.name === name));
  }
  assert.equal(lowerCamel("TaskMarker"), "taskMarker");
  assert.equal(lowerCamel("closed_at"), "closedAt");
  assert.equal(lowerCamel("_reserved"), "reserved");
});
