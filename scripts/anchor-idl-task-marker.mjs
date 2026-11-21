// Revision 9 (C): put `TaskMarker` into the protocol IDL artifacts.
//
// `close_task` compacts a closed Task into a 56-byte `TaskMarker` at the task's
// own address. Clients must decode it, but Anchor 0.32.1 lists an account type in
// the IDL only when an instruction context takes it as `Account<T>`, and no
// instruction takes a marker on its own: every reader accepts "a Task or a
// marker" (`close_task`, `reclaim_completion_bond`) or "absent or a marker"
// (`reclaim_orphan_task_child`, the dependency checks), so each loads it by hand.
//
// This module adds the account and its type to the IDL that `anchor idl build`
// produced, and the same entries to the generated TypeScript type. It is checked,
// not trusted:
// - the discriminator must be sha256("account:TaskMarker")[0..8] and equal the
//   pinned `c10bc0c833d06cff` (design Appendix A, `state.rs` unit test);
// - the fields come from the Rust struct in `state.rs` and must equal the pinned
//   layout (creator, status, flags, closed_at, _reserved; 56 bytes with the
//   discriminator), so a change to the struct fails here until it is reviewed;
// - the struct parser and the camelCase conversion are proven on every run
//   against types Anchor itself emitted (`CreatorStats`, `DisputeBond`), so the
//   added entries are exactly what Anchor would have written;
// - the result is deterministic and idempotent: an IDL that already lists the
//   account must already hold exactly these entries.
//
// Used by `scripts/sync-anchor-artifacts.mjs` in both refresh and check modes, so
// `artifacts:check:built` compares the committed artifacts with the patched build.

import { createHash } from "node:crypto";

export const TASK_MARKER_NAME = "TaskMarker";
export const TASK_MARKER_DISCRIMINATOR_HEX = "c10bc0c833d06cff";
export const TASK_MARKER_SIZE = 56;

// The layout clients rely on. Changing the Rust struct must change this too.
const PINNED_FIELDS = [
  { name: "creator", type: "pubkey" },
  { name: "status", type: "u8" },
  { name: "flags", type: "u8" },
  { name: "closed_at", type: "i64" },
  { name: "_reserved", type: { array: ["u8", 6] } },
];

// Types Anchor emitted for structs built from the same constructs (docs, Pubkey,
// integers, byte arrays). They prove the parser and the camelCase rule.
const PROOF_TYPES = ["CreatorStats", "DisputeBond"];

const TYPES_PREFIX = "export type AgencCoordination = ";

const PRIMITIVE_SIZES = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

export function accountDiscriminator(name) {
  return [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];
}

function rustTypeToIdl(rustType, context) {
  const type = rustType.trim();
  if (type === "Pubkey") return "pubkey";
  if (Object.hasOwn(PRIMITIVE_SIZES, type)) return type;
  const array = type.match(/^\[\s*([A-Za-z0-9_]+)\s*;\s*(\d+)\s*\]$/u);
  if (array) return { array: [rustTypeToIdl(array[1], context), Number(array[2])] };
  throw new Error(`${context}: unsupported field type ${JSON.stringify(type)}`);
}

function idlTypeSize(type) {
  if (typeof type === "string") return PRIMITIVE_SIZES[type];
  if (type?.array) return idlTypeSize(type.array[0]) * type.array[1];
  throw new Error(`unsized IDL type ${JSON.stringify(type)}`);
}

function docValue(line) {
  // Anchor stores each `///` line trimmed.
  return line.replace(/^\s*\/\/\//u, "").trim();
}

/// Parse one `#[account]` struct from Rust source into an Anchor IDL type entry
/// (`{ name, docs?, type: { kind: "struct", fields } }`), field docs included.
export function parseAccountStruct(source, name) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `pub struct ${name} {`);
  if (start < 0) throw new Error(`state.rs: struct ${name} not found`);
  if (lines.findIndex((line, index) => index > start && line.trim() === `pub struct ${name} {`) >= 0) {
    throw new Error(`state.rs: struct ${name} defined twice`);
  }

  const docs = [];
  let sawAccount = false;
  for (let index = start - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line.startsWith("///")) {
      docs.unshift(docValue(line));
    } else if (line.startsWith("#[")) {
      if (line === "#[account]") sawAccount = true;
    } else {
      break;
    }
  }
  if (!sawAccount) throw new Error(`state.rs: ${name} is not an #[account] struct`);

  const fields = [];
  let fieldDocs = [];
  for (let index = start + 1; ; index++) {
    if (index >= lines.length) throw new Error(`state.rs: struct ${name} is not closed`);
    const line = lines[index].trim();
    if (line === "}") break;
    if (line === "") continue;
    if (line.startsWith("///")) {
      fieldDocs.push(docValue(line));
      continue;
    }
    const field = line.match(/^pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),$/u);
    if (!field) throw new Error(`state.rs: ${name}: unsupported line ${JSON.stringify(line)}`);
    const entry = { name: field[1] };
    if (fieldDocs.length > 0) entry.docs = fieldDocs;
    entry.type = rustTypeToIdl(field[2], `${name}.${field[1]}`);
    fields.push(entry);
    fieldDocs = [];
  }

  const typeDef = { name };
  if (docs.length > 0) typeDef.docs = docs;
  typeDef.type = { kind: "struct", fields };
  return typeDef;
}

/// The two IDL entries for `TaskMarker`, checked against the pinned layout.
export function taskMarkerIdlEntries(stateSource) {
  const discriminator = accountDiscriminator(TASK_MARKER_NAME);
  if (Buffer.from(discriminator).toString("hex") !== TASK_MARKER_DISCRIMINATOR_HEX) {
    throw new Error("TaskMarker discriminator does not match the pinned c10bc0c833d06cff");
  }
  const typeDef = parseAccountStruct(stateSource, TASK_MARKER_NAME);
  const layout = typeDef.type.fields.map(({ name, type }) => ({ name, type }));
  if (JSON.stringify(layout) !== JSON.stringify(PINNED_FIELDS)) {
    throw new Error(
      `TaskMarker fields in state.rs ${JSON.stringify(layout)} differ from the pinned layout ` +
        `${JSON.stringify(PINNED_FIELDS)}; review the client impact and update both.`,
    );
  }
  const size = 8 + layout.reduce((total, field) => total + idlTypeSize(field.type), 0);
  if (size !== TASK_MARKER_SIZE) {
    throw new Error(`TaskMarker is ${size} bytes, expected ${TASK_MARKER_SIZE}`);
  }
  return { account: { name: TASK_MARKER_NAME, discriminator }, type: typeDef };
}

/// The deploy check (lead item 29): an IDL to publish must list `TaskMarker`, as
/// the committed `artifacts/anchor/idl/agenc_coordination.json` does, with the
/// pinned discriminator and field layout. Anchor's raw `target/idl` output has
/// no TaskMarker entry, so clients built from a published raw IDL could not
/// decode a compacted task. Pure; throws with what is wrong.
export function assertIdlListsTaskMarker(idl) {
  const committed = "publish the committed artifacts/anchor/idl/agenc_coordination.json, not Anchor's raw target/idl output";
  const account = Array.isArray(idl?.accounts)
    ? idl.accounts.find((entry) => entry?.name === TASK_MARKER_NAME)
    : undefined;
  const type = Array.isArray(idl?.types)
    ? idl.types.find((entry) => entry?.name === TASK_MARKER_NAME)
    : undefined;
  if (!account || !type) {
    throw new Error(`IDL has no ${TASK_MARKER_NAME} ${account ? "type" : "account"} entry; ${committed}`);
  }
  if (
    !Array.isArray(account.discriminator) ||
    Buffer.from(account.discriminator).toString("hex") !== TASK_MARKER_DISCRIMINATOR_HEX
  ) {
    throw new Error(
      `IDL ${TASK_MARKER_NAME} discriminator is not the pinned ${TASK_MARKER_DISCRIMINATOR_HEX}; ${committed}`,
    );
  }
  const fields = type.type?.kind === "struct" && Array.isArray(type.type.fields)
    ? type.type.fields.map(({ name, type: fieldType }) => ({ name, type: fieldType }))
    : null;
  if (JSON.stringify(fields) !== JSON.stringify(PINNED_FIELDS)) {
    throw new Error(`IDL ${TASK_MARKER_NAME} fields differ from the pinned layout; ${committed}`);
  }
  return idl;
}

/// Anchor's TypeScript names: heck lowerCamelCase (`closed_at` -> `closedAt`,
/// `_reserved` -> `reserved`, `TaskMarker` -> `taskMarker`).
export function lowerCamel(name) {
  const parts = name.split("_").filter(Boolean);
  if (parts.length === 0) throw new Error(`cannot camelCase ${JSON.stringify(name)}`);
  const [first, ...rest] = parts;
  return (
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")
  );
}

function camelTypeDef(typeDef) {
  const out = { name: lowerCamel(typeDef.name) };
  if (typeDef.docs) out.docs = typeDef.docs;
  out.type = {
    kind: typeDef.type.kind,
    fields: typeDef.type.fields.map((field) => {
      const entry = { name: lowerCamel(field.name) };
      if (field.docs) entry.docs = field.docs;
      entry.type = field.type;
      return entry;
    }),
  };
  return out;
}

function sortedIndex(entries, name) {
  const names = entries.map((entry) => entry.name);
  for (let index = 1; index < names.length; index++) {
    if (!(names[index - 1] < names[index])) {
      throw new Error(`IDL entries are not sorted by name at ${names[index]}`);
    }
  }
  const index = names.findIndex((existing) => existing > name);
  return index < 0 ? names.length : index;
}

function splitTypes(typesText) {
  const at = typesText.indexOf(TYPES_PREFIX);
  if (at < 0 || !typesText.endsWith(";\n")) {
    throw new Error("generated TypeScript types have an unexpected shape");
  }
  const head = typesText.slice(0, at + TYPES_PREFIX.length);
  const body = typesText.slice(at + TYPES_PREFIX.length, -2);
  const value = JSON.parse(body);
  if (JSON.stringify(value, null, 2) !== body) {
    throw new Error("generated TypeScript types do not round-trip as JSON; refusing to patch");
  }
  return { head, value };
}

function proveAgainstAnchor(idl, types, stateSource) {
  for (const name of PROOF_TYPES) {
    const emitted = idl.types.find((entry) => entry.name === name);
    if (!emitted) throw new Error(`IDL proof type ${name} is missing`);
    const parsed = parseAccountStruct(stateSource, name);
    if (JSON.stringify(parsed) !== JSON.stringify(emitted)) {
      throw new Error(`state.rs parser does not reproduce Anchor's ${name} entry; refusing to patch`);
    }
    const emittedTs = types.types.find((entry) => entry.name === lowerCamel(name));
    if (JSON.stringify(camelTypeDef(emitted)) !== JSON.stringify(emittedTs)) {
      throw new Error(`camelCase rule does not reproduce Anchor's ${name} TypeScript entry`);
    }
  }
  // Both files list the same entries in the same order.
  for (const key of ["accounts", "types"]) {
    const expected = idl[key].map((entry) => lowerCamel(entry.name));
    const actual = types[key].map((entry) => entry.name);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`IDL and TypeScript ${key} lists differ`);
    }
  }
}

function insertOnce(list, entry, label) {
  const existing = list.findIndex((candidate) => candidate.name === entry.name);
  if (existing >= 0) {
    if (JSON.stringify(list[existing]) !== JSON.stringify(entry)) {
      throw new Error(`${label} ${entry.name} already present with different content`);
    }
    return false;
  }
  list.splice(sortedIndex(list, entry.name), 0, entry);
  return true;
}

/// Patch the Anchor build output. Returns the new IDL JSON text (Anchor's own
/// pretty format, no trailing newline) and the new TypeScript text.
export function addTaskMarkerToArtifacts({ idlText, typesText, stateSource }) {
  const idl = JSON.parse(idlText);
  if (JSON.stringify(idl, null, 2) !== idlText) {
    throw new Error("IDL JSON does not round-trip; refusing to patch");
  }
  const { head, value: types } = splitTypes(typesText);
  proveAgainstAnchor(idl, types, stateSource);

  const { account, type } = taskMarkerIdlEntries(stateSource);
  insertOnce(idl.accounts, account, "IDL account");
  insertOnce(idl.types, type, "IDL type");
  // The camelCase lists mirror the JSON order, so the same name sorts to the same index.
  const tsAccount = { name: lowerCamel(account.name), discriminator: account.discriminator };
  const tsType = camelTypeDef(type);
  const accountIndex = idl.accounts.findIndex((entry) => entry.name === account.name);
  const typeIndex = idl.types.findIndex((entry) => entry.name === type.name);
  if (!types.accounts.some((entry) => entry.name === tsAccount.name)) {
    types.accounts.splice(accountIndex, 0, tsAccount);
  }
  if (!types.types.some((entry) => entry.name === tsType.name)) {
    types.types.splice(typeIndex, 0, tsType);
  }
  if (
    JSON.stringify(types.accounts[accountIndex]) !== JSON.stringify(tsAccount) ||
    JSON.stringify(types.types[typeIndex]) !== JSON.stringify(tsType)
  ) {
    throw new Error("TypeScript TaskMarker entries are inconsistent with the IDL");
  }
  proveAgainstAnchor(idl, types, stateSource);

  return {
    idlText: JSON.stringify(idl, null, 2),
    typesText: `${head}${JSON.stringify(types, null, 2)};\n`,
  };
}
