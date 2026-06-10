// Hand-rolled ComputeBudget program instructions (zero dependencies, browser-safe).
// The wire format is stable and tiny, so the SDK encodes it directly instead of
// pulling in a compute-budget client package:
//   SetComputeUnitLimit = [u8 tag = 2, u32le units]
//   SetComputeUnitPrice = [u8 tag = 3, u64le microLamports]
import { address, type Instruction } from "@solana/kit";

/** The on-chain ComputeBudget program address. */
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address(
  "ComputeBudget111111111111111111111111111111",
);

const SET_COMPUTE_UNIT_LIMIT_TAG = 2;
const SET_COMPUTE_UNIT_PRICE_TAG = 3;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * Build a `SetComputeUnitLimit` ComputeBudget instruction.
 *
 * Encodes `[u8 tag = 2, u32le units]` against the ComputeBudget program — the
 * exact bytes the Solana runtime expects, with no extra dependency.
 *
 * @param units - The compute-unit limit for the transaction (u32; 0..=4_294_967_295).
 * @returns The encoded ComputeBudget instruction (no accounts).
 *
 * @example
 * ```ts
 * const ix = getSetComputeUnitLimitInstruction(600_000);
 * // ix.data => Uint8Array [2, 0xc0, 0x27, 0x09, 0x00]
 * ```
 */
export function getSetComputeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > U32_MAX) {
    throw new RangeError(
      `computeUnitLimit must be an integer in [0, ${U32_MAX}], got ${units}`,
    );
  }
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT_TAG;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}

/**
 * Build a `SetComputeUnitPrice` ComputeBudget instruction.
 *
 * Encodes `[u8 tag = 3, u64le microLamports]` against the ComputeBudget program.
 *
 * @param microLamports - The priority-fee price per compute unit, in
 * micro-lamports (u64). Accepts `number` or `bigint`.
 * @returns The encoded ComputeBudget instruction (no accounts).
 *
 * @example
 * ```ts
 * const ix = getSetComputeUnitPriceInstruction(5_000n);
 * // ix.data => Uint8Array [3, 0x88, 0x13, 0, 0, 0, 0, 0, 0]
 * ```
 */
export function getSetComputeUnitPriceInstruction(
  microLamports: bigint | number,
): Instruction {
  const value =
    typeof microLamports === "bigint" ? microLamports : BigInt(microLamports);
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(
      `computeUnitPrice must be in [0, ${U64_MAX}], got ${value}`,
    );
  }
  const data = new Uint8Array(9);
  data[0] = SET_COMPUTE_UNIT_PRICE_TAG;
  new DataView(data.buffer).setBigUint64(1, value, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}
