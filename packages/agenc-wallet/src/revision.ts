// The marketplace program revision this service signs for, and the gate that
// holds every marketplace transaction to it.
//
// Revision 9 changed the accounts most marketplace instructions take, so a
// transaction built here does not work on a program still on revision 8, or
// on a later one, and some fail only after money moved. Before it signs
// anything that calls the marketplace program, the service reads the
// program's own stamp (ProtocolConfig.surface_revision), as the attest
// service does, and refuses with nothing signed unless the stamp is the
// revision it was built for. Reads, and plain transfers of the wallet's own
// money, need no stamp and keep working on any revision.
import type { Address, Instruction } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findProtocolConfigPda,
  readSurfaceRevision,
  SURFACE_REVISION_CURRENT,
  type MarketplaceClient,
} from "@tetsuo-ai/marketplace-sdk";
import { WalletError } from "./errors.js";

/** The marketplace program revision this service signs for. */
export const SIGNING_REVISION = SURFACE_REVISION_CURRENT;

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** The refusal for a program stamped `revision`, or null when it is the one this signs for. */
export function revisionRefusal(revision: number): WalletError | null {
  if (revision === SIGNING_REVISION) return null;
  if (revision > SIGNING_REVISION) {
    return new WalletError(
      "NOT_AVAILABLE",
      `The marketplace program is on revision ${revision}, and this version of the service signs only for revision ${SIGNING_REVISION}. Nothing was signed. Update it to keep using the marketplace.`,
      { retryable: false },
    );
  }
  return new WalletError(
    "NOT_AVAILABLE",
    revision === 0
      ? `The marketplace program does not say which revision it is on, and this version of the service signs only for revision ${SIGNING_REVISION}. Nothing was signed. Try again later.`
      : `The marketplace program is still on revision ${revision}, and this version of the service signs only for revision ${SIGNING_REVISION}. Nothing was signed. Try again once the marketplace moves to revision ${SIGNING_REVISION}.`,
    { retryable: true },
  );
}

/**
 * Read the program's stamp and refuse unless it is {@link SIGNING_REVISION}.
 * A missing or foreign ProtocolConfig reads as unstamped (0).
 */
export async function assertSigningRevision(
  readRaw: (account: Address) => Promise<{ data: Uint8Array; owner: Address } | null>,
): Promise<void> {
  const [config] = await findProtocolConfigPda();
  let revision: number;
  try {
    const account = await readRaw(config);
    revision =
      account === null || account.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS
        ? 0
        : readSurfaceRevision(account.data);
  } catch (error) {
    throw new WalletError(
      "NETWORK",
      "The marketplace program's revision could not be read, so nothing was signed. Try again in a moment.",
      { cause: error, retryable: true },
    );
  }
  const refusal = revisionRefusal(revision);
  if (refusal !== null) throw refusal;
}

/** True when the instructions only move lamports (no marketplace call). */
export function onlyPlainTransfers(instructions: unknown): boolean {
  return (
    Array.isArray(instructions) &&
    instructions.length > 0 &&
    (instructions as readonly Instruction[]).every(
      (instruction) =>
        instruction.programAddress === SYSTEM_PROGRAM ||
        instruction.programAddress === COMPUTE_BUDGET_PROGRAM ||
        (instruction.programAddress === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" &&
          !instruction.accounts?.length && Buffer.from(instruction.data ?? []).toString().startsWith("agenc.operation.v1 ")),
    )
  );
}

/**
 * The same client, but every call that signs runs `gate` first, except a
 * plain transfer. The client's fields pass through untouched. Every method of
 * a marketplace client sends, so every method is gated.
 */
export function revisionGatedClient(
  client: MarketplaceClient,
  gate: () => Promise<void>,
): MarketplaceClient {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (!(property === "send" && onlyPlainTransfers(args[0]))) await gate();
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
