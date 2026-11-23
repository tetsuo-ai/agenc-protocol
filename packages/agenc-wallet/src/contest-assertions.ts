// Lighthouse's public Borsh ABI. Each instruction receives only the account it checks.
// https://github.com/Jac0xb/lighthouse/tree/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95" as Address;
export const RENT = "SysvarRent111111111111111111111111111111111" as Address;
const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;
const silent = 0, equal = 0, lessThan = 3;
const assertData = 2, assertInfo = 5;
function instruction(target: Address, encoded: number[]): Instruction {
  return { programAddress: LIGHTHOUSE, accounts: [{ address: target, role: AccountRole.READONLY }], data: Uint8Array.from(encoded) };
}

function le64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

export function assertContestDeadline(seconds: number) {
  // Clock::unix_timestamp is an i64 at byte 32. Both offset and value are positive.
  return instruction(CLOCK, [assertData, silent, 32, 8, ...le64(BigInt(seconds)), lessThan]);
}

export function assertContestBalance(key: Address, lamports: bigint) {
  return instruction(key, [assertInfo, silent, 0, ...le64(lamports), equal]);
}

function compact(n: number) {
  const size: number[] = [];
  while (n >= 128) {
    size.push(128 + n % 128);
    n = Math.floor(n / 128);
  }
  size.push(n);
  return size;
}

export function assertContestData(key: Address, bytes: Uint8Array) {
  return instruction(key, [assertInfo, silent, 8, ...keccak_256(bytes), 0, ...compact(bytes.length)]);
}

export function assertContestBytes(key: Address, offset: number, bytes: Uint8Array) {
  // DataValueAssertion::Bytes, with compact offset and byte count.
  return instruction(key, [assertData, silent, ...compact(offset), 11, ...compact(bytes.length), ...bytes, equal]);
}
