// Paying for an approval.
//
// The marketplace lets a job be posted, or a service be hired, only once an
// approver has recorded that its words passed the safety check. Recording
// takes a deposit from the approver that never comes back, so the approver
// does not pay it. It signs the record and hands the transaction to whoever
// asked, who pays the deposit and the fee and sends it.
//
// That transaction was built somewhere else and is about to be signed with
// one of this wallet's keys, so nothing in it is taken on trust. It is read
// back byte for byte and compared with what this wallet asked for, and
// anything else is refused. What a key can lose by signing a transaction that
// passes is the record's deposit plus the fee of two signatures.
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationConfigPda,
  findTaskModerationPda,
  getListingModerationSize,
  getRecordListingModerationDiscriminatorBytes,
  getRecordListingModerationInstructionDataDecoder,
  getRecordTaskModerationDiscriminatorBytes,
  getRecordTaskModerationInstructionDataDecoder,
  getTaskModerationSize,
} from "@tetsuo-ai/marketplace-sdk";
import { BASE_FEE_LAMPORTS, SYSTEM_PROGRAM_ADDRESS, type Chain } from "./chain.js";
import { WalletError } from "./errors.js";
import type { ApprovalPayment } from "./services.js";

/** What an approval is for: a job's request, or a service's description. */
export type ApprovalTarget =
  | { kind: "task"; task: Address; hash: Uint8Array }
  | { kind: "listing"; listing: Address; hash: Uint8Array };

/** The fee of the approval's transaction: the payer's signature and the approver's. */
export const APPROVAL_FEE_LAMPORTS = 2n * BASE_FEE_LAMPORTS;

/** The largest transaction the network carries. */
const MAX_TRANSACTION_BYTES = 1232;
/** The only verdict worth paying for. */
const STATUS_CLEAN = 0;
const SYSTEM_TRANSFER = 2;

/** The deposit behind the permanent record one approval creates. Never returned. */
export function approvalDeposit(chain: Chain, kind: ApprovalTarget["kind"]): Promise<bigint> {
  return chain.getMinimumBalanceForRentExemption(
    kind === "task" ? getTaskModerationSize() : getListingModerationSize(),
  );
}

/** Everything one approval costs the wallet that asks for it. */
export async function approvalCost(chain: Chain, kind: ApprovalTarget["kind"]): Promise<bigint> {
  return (await approvalDeposit(chain, kind)) + APPROVAL_FEE_LAMPORTS;
}

function refuse(why: string): never {
  throw new WalletError(
    "NETWORK",
    "The marketplace's safety check sent back something this wallet will not sign. Nothing was paid.",
    { cause: new Error(`approval transaction refused: ${why}`) },
  );
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export interface CheckedApproval {
  /** The transaction, decoded. Signed by the approver, not yet by the payer. */
  transaction: Transaction;
  /** What it moves from the payer to the approver. Zero when the record exists. */
  depositLamports: bigint;
}

/**
 * Read an approver's transaction back and refuse it unless it is exactly:
 *
 *  - paid for by `payer` and signed by `payer` and `moderator`, nobody else;
 *  - with no account that is not written out in it (no lookup tables);
 *  - at most a plain transfer from `payer` to `moderator` of no more than
 *    `maxDepositLamports`, and then
 *  - one "record this approval" instruction of the marketplace program, for
 *    this target and this hash, as passed, in which `payer` takes no part.
 *
 * Nothing else may be in it: no other program, no fee bidding, no second
 * transfer. Pure: no network, nothing signed.
 */
export async function checkApprovalTransaction(
  wire: Uint8Array,
  expected: {
    payer: Address;
    moderator: Address;
    target: ApprovalTarget;
    maxDepositLamports: bigint;
  },
): Promise<CheckedApproval> {
  if (wire.length === 0 || wire.length > MAX_TRANSACTION_BYTES) refuse("not the size of a transaction");
  if (expected.payer === expected.moderator) refuse("the payer is the approver");

  let transaction: Transaction;
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    transaction = getTransactionDecoder().decode(wire);
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    refuse("it does not decode");
  }
  if (message.version !== 0) refuse("not a version 0 message");
  // What gets signed is the message's own bytes. They must say exactly what
  // was just read from them and nothing more.
  if (
    !sameBytes(
      getCompiledTransactionMessageEncoder().encode(message),
      transaction.messageBytes,
    )
  ) {
    refuse("the message holds more than was read");
  }
  if ("addressTableLookups" in message && (message.addressTableLookups?.length ?? 0) > 0) {
    refuse("it uses lookup tables");
  }

  const accounts: readonly Address[] = message.staticAccounts;
  if (new Set(accounts).size !== accounts.length) refuse("an account is named twice");
  if (message.header.numSignerAccounts !== 2 || message.header.numReadonlySignerAccounts !== 0) {
    refuse("the wrong number of signers");
  }
  if (accounts[0] !== expected.payer) refuse("somebody else pays the fee");
  if (accounts[1] !== expected.moderator) refuse("somebody else signs the approval");
  const signers = Object.keys(transaction.signatures);
  if (
    signers.length !== 2 ||
    !(expected.payer in transaction.signatures) ||
    transaction.signatures[expected.moderator] == null
  ) {
    refuse("the approver has not signed it");
  }

  const instructions = message.instructions;
  if (instructions.length !== 1 && instructions.length !== 2) refuse("the wrong number of steps");

  let depositLamports = 0n;
  if (instructions.length === 2) {
    const transfer = instructions[0]!;
    const indices = transfer.accountIndices ?? [];
    const data = transfer.data ?? new Uint8Array();
    if (accounts[transfer.programAddressIndex] !== SYSTEM_PROGRAM_ADDRESS) {
      refuse("the first step is not a transfer");
    }
    if (indices.length !== 2 || indices[0] !== 0 || indices[1] !== 1) {
      refuse("the transfer is not from the payer to the approver");
    }
    if (data.length !== 12) refuse("the transfer is malformed");
    const view = new DataView(Uint8Array.from(data).buffer);
    if (view.getUint32(0, true) !== SYSTEM_TRANSFER) refuse("the first step is not a plain transfer");
    depositLamports = view.getBigUint64(4, true);
    if (depositLamports === 0n || depositLamports > expected.maxDepositLamports) {
      refuse(`the transfer is ${depositLamports}, above the deposit of ${expected.maxDepositLamports}`);
    }
  }

  const approval = instructions[instructions.length - 1]!;
  if (accounts[approval.programAddressIndex] !== AGENC_COORDINATION_PROGRAM_ADDRESS) {
    refuse("the approval is not the marketplace's");
  }
  const { target, moderator } = expected;
  const [config] = await findModerationConfigPda();
  const [roster] = await findModerationAttestorPda({ attestor: moderator });
  const [record] =
    target.kind === "task"
      ? await findTaskModerationPda({ task: target.task, jobSpecHash: target.hash, moderator })
      : await findListingModerationPda({
          listing: target.listing,
          jobSpecHash: target.hash,
          moderator,
        });
  const subject = target.kind === "task" ? target.task : target.listing;
  const named = (approval.accountIndices ?? []).map((index) => accounts[index]);
  // The fifth place holds the approver's roster entry, or the program's own
  // address when the approver is the marketplace's authority and has none.
  if (
    named.length !== 6 ||
    named[0] !== config ||
    named[1] !== subject ||
    named[2] !== moderator ||
    named[3] !== record ||
    (named[4] !== roster && named[4] !== AGENC_COORDINATION_PROGRAM_ADDRESS) ||
    named[5] !== SYSTEM_PROGRAM_ADDRESS
  ) {
    refuse("the approval is for something else");
  }
  if (named.includes(expected.payer)) refuse("the payer takes part in the approval");

  const decoder =
    target.kind === "task"
      ? getRecordTaskModerationInstructionDataDecoder()
      : getRecordListingModerationInstructionDataDecoder();
  const discriminator =
    target.kind === "task"
      ? getRecordTaskModerationDiscriminatorBytes()
      : getRecordListingModerationDiscriminatorBytes();
  const data = approval.data ?? new Uint8Array();
  if (data.length !== decoder.fixedSize) refuse("the approval is malformed");
  const fields = decoder.decode(data);
  if (!sameBytes(fields.discriminator, discriminator)) refuse("the second step is not an approval");
  if (!sameBytes(fields.jobSpecHash, target.hash)) refuse("the approval is for other words");
  if (fields.status !== STATUS_CLEAN) refuse("the approval does not pass the words");

  return { transaction, depositLamports };
}

/**
 * Check an approver's transaction and add the payer's signature. Throws
 * before signing when anything about it is off. Sends nothing.
 */
export async function signApproval(
  chain: Chain,
  payer: KeyPairSigner,
  payment: ApprovalPayment,
  target: ApprovalTarget,
): Promise<CheckedApproval> {
  const checked = await checkApprovalTransaction(payment.transaction, {
    payer: payer.address,
    moderator: payment.moderator,
    target,
    maxDepositLamports: await approvalDeposit(chain, target.kind),
  });
  const transaction = await partiallySignTransaction([payer.keyPair], checked.transaction);
  if (Object.values(transaction.signatures).some((signature) => signature == null)) {
    refuse("it is not fully signed");
  }
  return { transaction, depositLamports: checked.depositLamports };
}
