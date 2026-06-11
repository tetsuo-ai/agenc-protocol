// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import {
  getPostCompletionBondInstructionAsync,
  getReclaimCompletionBondInstructionAsync,
  findCompletionBondPda,
  type PostCompletionBondAsyncInput,
  type ReclaimCompletionBondAsyncInput,
} from "../generated/index.js";

export {
  findCompletionBondPda,
};

/**
 * Post a completion bond for a task. The completion-bond PDA is auto-derived from
 * (task, authority) — the bond is keyed by the SIGNING wallet, so each party gets a
 * distinct PDA and `init` enforces one bond per wallet per task.
 *
 * `role` identifies the bonding party (worker vs creator) per the program enum.
 */
export async function postCompletionBond(input: PostCompletionBondAsyncInput) {
  return getPostCompletionBondInstructionAsync(input);
}

/**
 * Reclaim a previously posted completion bond. The completion-bond PDA is auto-derived
 * from (task, party); settlement is validated on-chain by `settle_completion_bond`.
 *
 * `role` identifies the bonding party (worker vs creator) per the program enum.
 */
export async function reclaimCompletionBond(
  input: ReclaimCompletionBondAsyncInput,
) {
  return getReclaimCompletionBondInstructionAsync(input);
}
