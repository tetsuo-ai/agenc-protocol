// Minimal litesvm harness for the agenc-cli e2e — runs the ACTUAL compiled
// agenc-coordination program in-process (litesvm 1.1.0, kit-native).
// Mirrors packages/agenc-worker/tests-e2e/harness.ts; ProtocolConfig and
// ModerationConfig are INJECTED via svm.setAccount because their real
// initializers need an upgradeable ProgramData account litesvm doesn't model.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  lamports,
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getProtocolConfigEncoder,
  findProtocolConfigPda,
  getModerationConfigEncoder,
  findModerationConfigPda,
} from "@tetsuo-ai/marketplace-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SO = path.resolve(
  __dirname,
  "../../../programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
export const PROGRAM = AGENC_COORDINATION_PROGRAM_ADDRESS;
const DEFAULT_ADDR = address("11111111111111111111111111111111");

export function freshSvm(): LiteSVM {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM, SO);
  const c = svm.getClock();
  c.unixTimestamp = 1_700_000_000n;
  svm.setClock(c);
  return svm;
}

export async function fundedSigner(svm: LiteSVM): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(100_000_000_000n));
  return signer;
}

/** Seed a ProtocolConfig account using the SDK's own generated encoder. */
export async function seedProtocolConfig(
  svm: LiteSVM,
  admin: Address,
): Promise<Address> {
  const [pda, bump] = await findProtocolConfigPda();
  const data = getProtocolConfigEncoder().encode({
    authority: admin,
    treasury: admin,
    disputeThreshold: 50,
    protocolFeeBps: 100,
    minArbiterStake: 0n,
    minAgentStake: 0n,
    maxClaimDuration: 604800n,
    maxDisputeDuration: 604800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold: 0,
    multisigOwnersLen: 0,
    taskCreationCooldown: 0n,
    maxTasksPer24h: 0,
    disputeInitiationCooldown: 0n,
    maxDisputesPer24h: 0,
    minStakeForDispute: 0n,
    slashPercentage: 50,
    stateUpdateCooldown: 0n,
    votingPeriod: 86400n,
    protocolVersion: 1,
    minSupportedVersion: 1,
    protocolPaused: false,
    disabledTaskTypeMask: 0,
    // This suite runs the FULL-surface .so, so the injected config must read
    // as full-surface (SURFACE_REVISION_FULL = 1), not the canary 0.
    surfaceRevision: 1,
    multisigOwners: [DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR],
  });
  svm.setAccount({
    address: pda,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: PROGRAM,
    space: BigInt(data.length),
  });
  return pda;
}

/** Seed a ModerationConfig account (the fail-closed hire gate requires it). */
export async function seedModerationConfig(
  svm: LiteSVM,
  admin: Address,
  moderationAuthority: Address,
  enabled = true,
): Promise<Address> {
  const [pda, bump] = await findModerationConfigPda();
  const data = getModerationConfigEncoder().encode({
    authority: admin,
    moderationAuthority,
    enabled,
    createdAt: 0n,
    updatedAt: 0n,
    bump,
    reserved: new Uint8Array(6),
  });
  svm.setAccount({
    address: pda,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: PROGRAM,
    space: BigInt(data.length),
  });
  return pda;
}

export function accountData(svm: LiteSVM, addr: Address): Uint8Array | null {
  const a = svm.getAccount(addr);
  if (!a || !a.exists) return null;
  return Uint8Array.from(a.data);
}

export { FailedTransactionMetadata };
