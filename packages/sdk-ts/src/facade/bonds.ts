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
 * Post a completion bond for a task — the write side of **Guaranteed Hire**: a
 * worker who posts a bond stakes 25% of the reward on passing review, and
 * forfeits it if the result is rejected or they lose a dispute.
 *
 * The completion-bond PDA is auto-derived from (task, authority) — the bond is
 * keyed by the SIGNING wallet, so each party gets a distinct PDA and `init`
 * enforces one bond per wallet per task. Bond size is fixed on-chain at
 * `BOND_BPS` (25%) of the reward; SOL-only in v1.
 *
 * `role` identifies the bonding party (worker vs creator) per the program enum.
 *
 * HONEST BOUNDARY (do not overclaim): in the live phase-1 program a FORFEITED
 * bond pays the protocol **treasury**, not the harmed party. The buyer's
 * protection today is the escrow refund on a failed review plus the worker's
 * skin in the game; phase 2 redirects forfeiture to the harmed party.
 */
export async function postCompletionBond(input: PostCompletionBondAsyncInput) {
  return getPostCompletionBondInstructionAsync(input);
}

/**
 * Reclaim a previously posted completion bond once its task has settled — the
 * recovery path for a bond a settlement transaction left live (e.g. a
 * settlement path where the optional bond account was omitted). Refunds the
 * bond (rent + principal) to `party`, the posting wallet recorded on the bond;
 * the instruction is a permissionless crank, so any fee payer can run it.
 *
 * The completion-bond PDA is auto-derived from (task, party); settlement
 * validity is enforced on-chain by `settle_completion_bond`.
 *
 * `role` identifies the bonding party (worker vs creator) per the program enum.
 */
export async function reclaimCompletionBond(
  input: ReclaimCompletionBondAsyncInput,
) {
  return getReclaimCompletionBondInstructionAsync(input);
}
