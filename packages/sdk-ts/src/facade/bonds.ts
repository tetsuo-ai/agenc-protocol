// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
import { AccountRole, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getPostCompletionBondInstructionDataEncoder,
  getReclaimCompletionBondInstructionAsync,
  findCompletionBondPda,
  findClaimPda,
  findProtocolConfigPda,
  type PostCompletionBondAsyncInput,
  type ReclaimCompletionBondAsyncInput,
} from "../generated/index.js";
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";
import { snapshotStructuredClone } from "../values/structured-clone.js";

export { findCompletionBondPda };

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
type PostCompletionBondBase = Omit<
  PostCompletionBondAsyncInput,
  "role" | "protocolConfig" | "worker" | "workerClaim"
> & {
  /** Defaults to the canonical [protocol] PDA. */
  protocolConfig?: Address;
  /** Required for every dependent task; appended at remaining account slot 0. */
  dependencyParent?: Address;
};

export type PostCreatorCompletionBondInput = PostCompletionBondBase & {
  role: 0;
  worker?: never;
  workerClaim?: never;
};

export type PostWorkerCompletionBondInput = PostCompletionBondBase & {
  role: 1;
  /** Canonical AgentRegistration for the signing worker authority. */
  worker: Address;
  /** Defaults to [claim, task, worker]. */
  workerClaim?: Address;
};

export type PostCompletionBondInput =
  | PostCreatorCompletionBondInput
  | PostWorkerCompletionBondInput;

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;

export async function postCompletionBond(input: PostCompletionBondInput) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  if (stableInput.role !== 0 && stableInput.role !== 1) {
    throw new Error(
      "postCompletionBond: role must be 0 (creator) or 1 (worker)",
    );
  }
  if (
    stableInput.role === 0 &&
    (stableInput.worker || stableInput.workerClaim)
  ) {
    throw new Error(
      "postCompletionBond: creator role must omit worker and workerClaim",
    );
  }
  if (stableInput.role === 1 && !stableInput.worker) {
    throw new Error(
      "postCompletionBond: worker role requires the worker AgentRegistration address",
    );
  }

  const protocolConfig =
    stableInput.protocolConfig ?? (await findProtocolConfigPda())[0];
  const completionBond =
    stableInput.completionBond ??
    (
      await findCompletionBondPda({
        task: stableInput.task,
        party: stableInput.authority.address,
      })
    )[0];
  const worker =
    stableInput.role === 1
      ? stableInput.worker
      : AGENC_COORDINATION_PROGRAM_ADDRESS;
  const workerClaim =
    stableInput.role === 1
      ? (stableInput.workerClaim ??
        (
          await findClaimPda({
            task: stableInput.task,
            bidder: stableInput.worker,
          })
        )[0])
      : AGENC_COORDINATION_PROGRAM_ADDRESS;

  return {
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    accounts: [
      // Revision 5: Task is read-only; protocol config entry-gates new custody.
      { address: stableInput.task, role: AccountRole.READONLY },
      { address: protocolConfig, role: AccountRole.READONLY },
      { address: completionBond, role: AccountRole.WRITABLE },
      { address: worker, role: AccountRole.READONLY },
      { address: workerClaim, role: AccountRole.READONLY },
      {
        address: stableInput.authority.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: stableInput.authority,
      },
      {
        address: stableInput.systemProgram ?? SYSTEM_PROGRAM_ADDRESS,
        role: AccountRole.READONLY,
      },
      ...(stableInput.dependencyParent
        ? [
            {
              address: stableInput.dependencyParent,
              role: AccountRole.READONLY,
            } as const,
          ]
        : []),
    ],
    data: getPostCompletionBondInstructionDataEncoder().encode({
      role: stableInput.role,
    }),
  };
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
  return getReclaimCompletionBondInstructionAsync(
    snapshotStructuredClone(input, "reclaimCompletionBond: input"),
  );
}
