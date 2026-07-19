// E2E harness: runs the ACTUAL compiled agenc-coordination program in litesvm (the real
// Solana VM, in-process) driven by SDK-built (@solana/kit) instructions — fully kit-native
// (litesvm 1.1.0 speaks @solana/kit). This proves the SDK's instructions execute on-chain
// with real signatures, not just that they assemble. ProtocolConfig is seeded directly (its
// real initializer needs an upgradeable ProgramData account litesvm doesn't model).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  lamports,
  pipe,
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getProtocolConfigEncoder,
  findProtocolConfigPda,
  getModerationConfigEncoder,
  findModerationConfigPda,
  getAgentRegistrationEncoder,
  getAgentRegistrationDecoder,
} from "../src/index.js";

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
  opts: {
    minArbiterStake?: bigint;
    multisigOwners?: readonly Address[];
    multisigThreshold?: number;
  } = {},
): Promise<Address> {
  const multisigOwners = [...(opts.multisigOwners ?? [])];
  const multisigThreshold = opts.multisigThreshold ?? 0;
  if (multisigOwners.length > 5) {
    throw new Error("seedProtocolConfig supports at most five multisig owners");
  }
  if (
    (multisigOwners.length === 0 && multisigThreshold !== 0) ||
    (multisigOwners.length > 0 &&
      (multisigThreshold < 2 || multisigThreshold > multisigOwners.length))
  ) {
    throw new Error("seedProtocolConfig received an invalid multisig threshold");
  }
  const [pda, bump] = await findProtocolConfigPda();
  const data = getProtocolConfigEncoder().encode({
    authority: admin,
    treasury: admin,
    disputeThreshold: 50,
    protocolFeeBps: 100,
    minArbiterStake: opts.minArbiterStake ?? 0n,
    minAgentStake: 0n,
    maxClaimDuration: 604800n,
    maxDisputeDuration: 604800n,
    totalAgents: 0n,
    totalTasks: 0n,
    completedTasks: 0n,
    totalValueDistributed: 0n,
    bump,
    multisigThreshold,
    multisigOwnersLen: multisigOwners.length,
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
    // P6.5: the e2e suite runs the FULL-surface .so, so the injected config must
    // read as full-surface (SURFACE_REVISION_FULL = 1), not the canary 0.
    surfaceRevision: 1,
    multisigOwners: [
      ...multisigOwners,
      ...Array.from({ length: 5 - multisigOwners.length }, () => DEFAULT_ADDR),
    ],
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

/** Seed a ModerationConfig account (the hire/moderation paths require it to exist). */
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

/** Set an agent's on-chain stake directly (gives arbiters vote weight without a stake ix). */
export function seedAgentStake(svm: LiteSVM, agentPda: Address, stake: bigint): void {
  const acct = svm.getAccount(agentPda);
  if (!acct || !acct.exists) throw new Error("agent account not found: " + agentPda);
  const agent = getAgentRegistrationDecoder().decode(Uint8Array.from(acct.data));
  const data = getAgentRegistrationEncoder().encode({ ...agent, stake });
  svm.setAccount({
    address: agentPda,
    data,
    executable: false,
    lamports: acct.lamports,
    programAddress: PROGRAM,
    space: BigInt(data.length),
  });
}

/** Build a kit transaction from SDK instructions, sign with the embedded signers, execute. */
export async function send(
  svm: LiteSVM,
  feePayer: KeyPairSigner,
  ixs: Instruction[],
) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const res = svm.sendTransaction(signed);
  if (res instanceof FailedTransactionMetadata) {
    throw new Error("tx failed: " + res.err() + "\n" + res.meta().logs().join("\n"));
  }
  return res;
}

export function accountData(svm: LiteSVM, addr: Address): Uint8Array | null {
  const a = svm.getAccount(addr);
  if (!a || !a.exists) return null;
  return Uint8Array.from(a.data);
}
