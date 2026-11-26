import { AGENC_COORDINATION_PROGRAM_ADDRESS, findEscrowPda, findTaskPda } from "@tetsuo-ai/marketplace-sdk";
import type { Address } from "@solana/kit";
import { WalletError } from "./errors.js";

// Agave RESERVED_PAYEE_KEYS in completion_helpers.rs, plus the default address.
const unpayable = new Set<string>([
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  "AddressLookupTab1e1111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "Feature111111111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "StakeConfig11111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "11111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Sysvar1111111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarEpochRewards1111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarLastRestartS1ot1111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarRewards111111111111111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "ZkTokenProof1111111111111111111111111111111",
  "ZkE1Gama1Proof11111111111111111111111111111",
]);

export function checkOperator(operator: string | null, bps: number): void {
  if (bps && (!operator || unpayable.has(operator)))
    throw new WalletError("BAD_REQUEST", "This address cannot receive an operator payment.");
}

export async function checkHireOperator(operator: string | null, bps: number, payer: Address, taskId: Uint8Array): Promise<void> {
  checkOperator(operator, bps);
  if (!bps) return;
  const [task] = await findTaskPda({ creator: payer, taskId });
  const [escrow] = await findEscrowPda({ task });
  if (operator === payer || operator === task || operator === escrow)
    throw new WalletError("NOT_ALLOWED", "The operator conflicts with the paying address or a payment account for this hire.");
}
