import {
  appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type Blockhash, type Instruction,
} from "@solana/kit";
import { DEFAULT_COMPUTE_UNIT_LIMIT, getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@tetsuo-ai/marketplace-sdk";

export function workSimulationMessage(payer: Address, ix: Instruction, blockhash: Blockhash, limit = DEFAULT_COMPUTE_UNIT_LIMIT, price?: bigint) {
  const instructions = [getSetComputeUnitLimitInstruction(limit), ...(price === undefined ? [] : [getSetComputeUnitPriceInstruction(price)]), ix];
  const tx = compileTransaction(pipe(createTransactionMessage({ version: 0 }),
    msg => setTransactionMessageFeePayer(payer, msg),
    msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 0n }, msg),
    msg => appendTransactionMessageInstructions(instructions, msg)));
  return { tx, accounts: getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts };
}

export function balanceChanges(accounts: readonly Address[], before: readonly bigint[], after: readonly bigint[], fee: bigint) {
  if (accounts.length !== before.length || before.length !== after.length) throw new Error("Incomplete transaction preview.");
  const changes = accounts.flatMap((address, i) => before[i] === after[i] ? [] : [{ address, delta: (after[i]! - before[i]!).toString() }]);
  if (changes.reduce((sum, row) => sum + BigInt(row.delta), fee) !== 0n) throw new Error("The transaction preview does not balance.");
  return { changes, fee: fee.toString() };
}
