import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");
const idl = JSON.parse(
  readFileSync(
    new URL("../artifacts/anchor/idl/agenc_coordination.json", import.meta.url),
  ),
);
const layout = idl.types.find((type) => type.name === "ProtocolConfig")?.type;
const tag = Buffer.from(
  idl.accounts.find((account) => account.name === "ProtocolConfig")
    .discriminator,
);
const telemetry = new Set([
  "total_agents",
  "total_tasks",
  "completed_tasks",
  "total_value_distributed",
]);

function size(type) {
  if (typeof type === "object" && Array.isArray(type.array))
    return size(type.array[0]) * type.array[1];
  const bytes = { pubkey: 32, u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, bool: 1 }[
    type
  ];
  if (!bytes)
    throw new Error(
      `unsupported ProtocolConfig field type; review monitor for this release`,
    );
  return bytes;
}
if (layout?.kind !== "struct")
  throw new Error("canonical ProtocolConfig is not a struct");
export const PROTOCOL_CONFIG_MONITOR_BYTES =
  8 + layout.fields.reduce((sum, field) => sum + size(field.type), 0);

export function decodeProtocolControls(data) {
  if (
    !Buffer.isBuffer(data) ||
    data.length !== PROTOCOL_CONFIG_MONITOR_BYTES ||
    !data.subarray(0, 8).equals(tag)
  )
    throw new Error("ProtocolConfig does not match the canonical IDL layout");
  let offset = 8;
  function read(type) {
    if (typeof type === "object")
      return Array.from({ length: type.array[1] }, () => read(type.array[0]));
    const start = offset;
    offset += size(type);
    if (type === "pubkey")
      return new PublicKey(data.subarray(start, offset)).toBase58();
    if (type === "u8") return data[start];
    if (type === "u16") return data.readUInt16LE(start);
    if (type === "u32") return data.readUInt32LE(start);
    if (type === "u64") return String(data.readBigUInt64LE(start));
    if (type === "i64") return String(data.readBigInt64LE(start));
    if (data[start] > 1) throw new Error("invalid ProtocolConfig bool");
    return data[start] === 1;
  }
  const result = {};
  for (const field of layout.fields) {
    const value = read(field.type);
    if (!telemetry.has(field.name)) result[field.name] = value;
  }
  const owners = result.multisig_owners.slice(0, result.multisig_owners_len);
  if (
    owners.length !== result.multisig_owners_len ||
    owners.length < 2 ||
    result.multisig_threshold < 1 ||
    result.multisig_threshold >= owners.length ||
    new Set(owners).size !== owners.length ||
    owners.includes(PublicKey.default.toBase58())
  )
    throw new Error("invalid ProtocolConfig multisig control fields");
  return result;
}
