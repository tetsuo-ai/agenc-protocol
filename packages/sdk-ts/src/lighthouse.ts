// Lighthouse's public Borsh ABI. Each builder declares one read-only target.
// Solana merges top-level privileges across the transaction. A sibling may
// write a coordination PDA inspected here. Lighthouse is immutable on mainnet
// (no upgrade authority), and only an account's owner can change its data or
// debit its lamports. Every target must therefore belong to another program.
// Never pass a signer, fee payer or wallet key. In particular, transferring
// from a system wallet requires its signature, which Lighthouse never gets.
// https://github.com/Jac0xb/lighthouse/tree/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse
import { AccountRole, type Address, type Instruction } from "@solana/kit";

export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95" as Address;
export const RENT = "SysvarRent111111111111111111111111111111111" as Address;
const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;
const silent = 0, equal = 0, lessThan = 3;
const assertData = 2, assertInfo = 5;
function instruction(target: Address, encoded: number[]): Instruction {
  return { programAddress: LIGHTHOUSE, accounts: [{ address: target, role: AccountRole.READONLY }], data: Uint8Array.from(encoded) };
}

function le64(value: bigint) {
  if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError("Value outside u64.");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function assertClockBefore(seconds: number) {
  // Clock::unix_timestamp is an i64 at byte 32. Marketplace deadlines are positive.
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new RangeError("Invalid clock deadline.");
  return instruction(CLOCK, [assertData, silent, 32, 8, ...le64(BigInt(seconds)), lessThan]);
}

export function assertLamports(key: Address, lamports: bigint) {
  return instruction(key, [assertInfo, silent, 0, ...le64(lamports), equal]);
}

function compact(n: number) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Invalid data offset or length.");
  const size: number[] = [];
  while (n >= 128) {
    size.push(128 + n % 128);
    n = Math.floor(n / 128);
  }
  size.push(n);
  return size;
}

export function assertDataHash(key: Address, digest: Uint8Array, length: number) {
  if (digest.length !== 32) throw new RangeError("Expected a 32-byte Keccak digest.");
  return instruction(key, [assertInfo, silent, 8, ...digest, 0, ...compact(length)]);
}

export function assertBytes(key: Address, offset: number, bytes: Uint8Array) {
  // DataValueAssertion::Bytes, with compact offset and byte count.
  return instruction(key, [assertData, silent, ...compact(offset), 11, ...compact(bytes.length), ...bytes, equal]);
}
