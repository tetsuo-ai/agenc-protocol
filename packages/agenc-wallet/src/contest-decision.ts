import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHash } from "node:crypto";
import { getAddressEncoder, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS as program, facade, findAgentStatsPda, findCreatorStatsPda,
  findCreatorCompletionBondPda, findWorkerCompletionBondPda, findTaskSubmissionPda, findEscrowPda, findProtocolConfigPda,
  getAgentRegistrationDecoder, getTaskDecoder, getTaskEncoder, getTaskSubmissionDecoder, getTaskEscrowDecoder, getTaskMarkerSize,
  getTaskMarkerDiscriminatorBytes, getCreatorStatsSize, getAgentStatsSize,
  TaskStatus, SubmissionStatus, values,
  lighthouse,
} from "@tetsuo-ai/marketplace-sdk";
import { SYSTEM_PROGRAM_ADDRESS, type Chain } from "./chain.js";
import { contestClaims, contestUnavailable } from "./contest.js";
import { submissionId } from "./contest-history.js";
import { prepareTidy, readProtocolConfig } from "./market.js";
import { fractionalQuoteUsd } from "./job-money.js";
import { money } from "./views.js";
import type { ContestAction, ContestQuote, ContestTransfer } from "./client/types.js";
import type { JobRecord } from "./store.js";
import { WalletError } from "./errors.js";

type Input = { action: ContestAction; entryId: string; reason?: string };
type Claim = Awaited<ReturnType<typeof contestClaims>>[number];

async function settlementInstruction(chain: Chain, creator: TransactionSigner, task: Address, input: Input, treasury: Address, claims: Claim[], selected?: Claim): Promise<Instruction> {
  if (input.action === "cleanup") {
    return await prepareTidy(chain, creator, task, null) ?? contestUnavailable("There are no contest deposits to collect.");
  }
  if (input.action === "cancel") return facade.cancelTask({ task, authority: creator, treasury, workerAccounts: claims,
    workerBondAuthority: claims[0]?.workerAuthority ?? creator.address });
  if (!selected) return contestUnavailable("The entry changed. Refresh the contest.");
  const { claim, workerAgent: worker, workerAuthority } = selected;
  if (input.action === "reclaim") return facade.reclaimTerminalClaim({ task, worker, claim, authority: creator, creator: creator.address, rentRecipient: workerAuthority, treasury });
  if (input.action === "release") return facade.distributeGhostShare({ task, worker, creator: creator.address, workerAuthority, cranker: creator, treasury });
  const [workerCompletionBond] = await findWorkerCompletionBondPda({ task, workerAuthority });
  if (input.action === "reject") return facade.rejectTaskResult({ task, worker, workerAuthority, creator, claim, workerCompletionBond,
    rejectionHash: createHash("sha256").update(JSON.stringify([task, input.entryId, input.reason?.trim()])).digest() });
  if (input.action !== "winner") return contestUnavailable("Unknown contest action.");
  const [creatorCompletionBond] = await findCreatorCompletionBondPda({ task, creator: creator.address });
  return facade.acceptTaskResult({ task, worker, creator, treasury, workerAuthority, creatorCompletionBond, workerCompletionBond });
}

export async function contestPlan(chain: Chain, job: JobRecord, creator: TransactionSigner, input: Input, id: string,
  expiresAt: number, chainExpiry: number, rate: number | null) {
  if (rate === null) throw new WalletError("NETWORK", "Dollar prices are unavailable. Refresh the contest quote.");
  if ((input.action === "cancel" || input.action === "cleanup") && input.entryId !== "") return contestUnavailable("This action applies to the whole contest.");
  const task = job.task as Address;
  const { treasury } = await readProtocolConfig(chain);
  const clock = await chain.clusterTime();
  const claims = await contestClaims(chain, task);
  const entry = job.contestEntries?.find(e => e.id === input.entryId && e.status === "submitted");
  const selected = claims.find(c => input.action === "reclaim" ? c.claim === input.entryId : c.workerAgent === entry?.worker);
  const reason = input.action === "reject" ? input.reason?.trim() ?? "" : "";
  if (input.action === "reject" && (!reason || reason.length > 2000)) throw new WalletError("BAD_REQUEST", "Give a rejection reason in up to 2000 characters.");
  const ix = await settlementInstruction(chain, creator, task, input, treasury, claims, selected);
  const [config] = await findProtocolConfigPda();
  // The program validates the encoded treasury against config. Its unrelated global counters
  // change on every marketplace settlement. Recipient wallet balances are also unrelated.
  const excluded = new Set<Address>([program, SYSTEM_PROGRAM_ADDRESS, config, creator.address, treasury, ...claims.map(c => c.workerAuthority)]);
  const keys = [...new Set(ix.accounts!.map(a => a.address).filter(address => !excluded.has(address)))];
  keys.push(lighthouse.RENT);
  const raw = await chain.readRawAccounts(keys);
  if (raw.length !== keys.length) return contestUnavailable("The marketplace accounts could not be read.");
  const byKey = new Map(keys.map((key, i) => [key, raw[i]]));
  if (!byKey.get(lighthouse.RENT)?.data.length) return contestUnavailable("Current rent could not be verified. Refresh the quote.");
  const needsRecord = (key: Address) => {
    const existing = byKey.get(key);
    if (existing && existing.owner !== program) return contestUnavailable("The marketplace record has an unexpected balance. Refresh the quote.");
    return !existing;
  };
  const balance = (key: Address) => byKey.get(key)?.lamports ?? 0n;
  const bytes = (key: Address) => {
    const item = byKey.get(key);
    if (item?.owner !== program) return contestUnavailable("The contest record changed. Refresh the quote.");
    return item.data;
  };
  let digest: Uint8Array = new Uint8Array(32);
  const encode = getAddressEncoder();
  for (const [key, account] of byKey) {
    const lamports = Buffer.alloc(8);
    lamports.writeBigUInt64LE(account?.lamports ?? 0n);
    digest = createHash("sha256").update(digest).update(Uint8Array.from(encode.encode(key)))
      .update(Uint8Array.from(encode.encode(account?.owner ?? SYSTEM_PROGRAM_ADDRESS))).update(lamports).update(account?.data ?? new Uint8Array()).digest();
  }
  const marker = Buffer.from(bytes(task).subarray(0, 8)).equals(Buffer.from(getTaskMarkerDiscriminatorBytes()));
  const account = marker ? null : getTaskDecoder().decode(bytes(task));
  if ((!account && input.action !== "cleanup") || (account && (account.taskType !== 2 || !account.reserved[0] || Buffer.from(account.constraintHash).toString("ascii") !== "agenc-manual-validation-v2-seed!" || account.creator !== creator.address || account.operatorFeeBps || account.referrerFeeBps))) {
    return contestUnavailable("This contest cannot be settled here.");
  }
  const [escrowKey] = await findEscrowPda({ task });
  const deposit = facade.CONTEST_ENTRY_DEPOSIT_LAMPORTS;
  const amounts = (n: bigint) => {
    const exact = fractionalQuoteUsd(n, rate);
    return { ...money(n, rate), ...(exact !== undefined && { quotedUsd: exact }) };
  };
  const transfers: ContestTransfer[] = [];
  function transfer(label: string, recipient: Address, n: bigint) {
    if (n < 0n) return contestUnavailable("The contest balances changed.");
    if (n) transfers.push({ label, recipient, amount: amounts(n) });
  }
  let gross = 0n, fee = 0n, refund = 0n, recordCost = 0n;
  const recipient = selected?.workerAuthority ?? creator.address;
  const live = account?.reserved[1] ?? 0;
  const terminal = marker || account?.status === TaskStatus.Completed || account?.status === TaskStatus.Cancelled;
  const estate = byKey.get(escrowKey);
  const escrow = estate?.owner === program ? getTaskEscrowDecoder().decode(estate.data) : null;
  const remaining = escrow ? escrow.amount - escrow.distributed : 0n;
  const bonds = await Promise.all([findCreatorCompletionBondPda({ task, creator: creator.address }),
    findWorkerCompletionBondPda({ task, workerAuthority: selected?.workerAuthority ?? claims[0]?.workerAuthority ?? creator.address })]);
  if (bonds.some(([key]) => balance(key) !== 0n)) return contestUnavailable("This contest has an additional bond and needs a different quote.");
  const [creatorStats] = await findCreatorStatsPda({ authority: creator.address });
  if (input.action === "cleanup") {
    if (!terminal || account?.currentWorkers) return contestUnavailable("Recover the outstanding claims first.");
    let returned = 0n;
    for (const [key, item] of byKey) if (item?.owner === program && (!marker || key !== task)) returned += item.lamports;
    if (!marker) returned -= await chain.getMinimumBalanceForRentExemption(getTaskMarkerSize());
    transfer("Contest record rent", creator.address, returned);
  } else if (input.action === "cancel" || input.action === "reclaim") {
    if (input.action === "cancel") {
      if (terminal || !escrow || live || claims.length !== account!.currentWorkers ||
          (claims.length && clock <= Number(account!.deadline) + 120)) return contestUnavailable("This contest cannot be cancelled now.");
      gross = remaining;
      transfer("Prize refund", creator.address, gross);
      transfer("Prize account rent", creator.address, balance(escrowKey) - gross);
      if (needsRecord(creatorStats)) {
        recordCost = await chain.getMinimumBalanceForRentExemption(getCreatorStatsSize());
        transfer("Creator record rent", creatorStats, recordCost);
      }
    } else if (!terminal || !selected) return contestUnavailable("This claim is not ready to recover.");
    for (const c of input.action === "cancel" ? claims : [selected!]) {
      const agent = getAgentRegistrationDecoder().decode(bytes(c.workerAgent));
      if (agent.authority !== c.workerAuthority) return contestUnavailable("The worker wallet changed.");
      const rent = await chain.getMinimumBalanceForRentExemption(bytes(c.claim).length);
      const claimBalance = balance(c.claim);
      const forfeited = claimBalance >= rent + deposit ? deposit : 0n;
      let returned = claimBalance - forfeited;
      if (input.action === "reclaim") {
        const record = byKey.get((await findTaskSubmissionPda({ claim: c.claim }))[0]);
        if (record?.owner === program) {
          if (getTaskSubmissionDecoder().decode(record.data).status !== SubmissionStatus.Rejected) return contestUnavailable("This submission is still outstanding.");
          returned += record.lamports;
        }
      }
      transfer("No-show deposit", treasury, forfeited);
      transfer("Claim rent return", c.workerAuthority, returned);
      refund += returned;
    }
  } else {
    if (!selected || !entry || !account || !live || terminal) return contestUnavailable("Refresh the entries before settling.");
    const release = clock >= Number(account.deadline + facade.CONTEST_SELECTION_WINDOW_SECS);
    if (release !== (input.action === "release")) return contestUnavailable(release ? "Only shares can be released now." : "The selection window is still open.");
    if (input.action === "winner" && live !== 1) return contestUnavailable("Reject the other submissions before choosing a winner.");
    const [submission] = await findTaskSubmissionPda({ claim: selected.claim });
    const s = getTaskSubmissionDecoder().decode(bytes(submission));
    const agent = getAgentRegistrationDecoder().decode(bytes(selected.workerAgent));
    const commitment = submissionId(selected.claim, values.bytesToHex(Uint8Array.from(s.proofHash)), s.submittedAt, s.submissionCount, values.bytesToHex(Uint8Array.from(s.resultData)));
    if (s.claim !== selected.claim || s.worker !== selected.workerAgent || s.task !== task || s.status !== SubmissionStatus.Submitted ||
        commitment !== (entry.commitment ?? entry.id) || agent.authority !== recipient) return contestUnavailable("The entry changed. Refresh the contest.");
    if (input.action === "reject") {
      const [stats] = await findAgentStatsPda({ creatorAgent: selected.workerAgent });
      for (const [key, space] of [[creatorStats, getCreatorStatsSize()], [stats, getAgentStatsSize()]] as const) {
        if (!needsRecord(key)) continue;
        const rent = await chain.getMinimumBalanceForRentExemption(space);
        recordCost += rent;
        transfer("Marketplace record rent", key, rent);
      }
    } else {
      if (!escrow) return contestUnavailable("The prize changed.");
      gross = release ? remaining / BigInt(live) : account.rewardAmount;
      const discount = agent.reputation >= 9500 ? 15 : agent.reputation >= 9000 ? 10 : agent.reputation >= 8000 ? 5 : 0;
      fee = gross * BigInt(account.protocolFeeBps && Math.max(1, account.protocolFeeBps - discount)) / 10000n;
      transfer("Prize", recipient, gross - fee);
      transfer("Marketplace fee", treasury, fee);
      if (live === 1) transfer("Prize account rent", creator.address, balance(escrowKey) - gross);
    }
    refund = balance(selected.claim) + balance(submission);
    transfer("Entry deposit and rent", recipient, refund);
  }
  const quote: ContestQuote = { id, entryId: input.entryId, action: input.action, reason, recipient, payer: creator.address, treasury,
    stateHash: Buffer.from(digest).toString("hex"), chainExpiry, rate, transfers, ...(entry && { proof: entry.hash }),
    claimGeneration: account ? Buffer.from(account.reserved).readBigUInt64LE(3).toString() : "0",
    gross: amounts(gross), grossLimit: amounts(gross), feeLimit: amounts(fee), prize: amounts(gross - fee), marketFee: amounts(fee),
    entryRefund: amounts(refund), networkFee: amounts(chain.transferFeeLamports), recordCost: amounts(recordCost), expiresAt };
  // Revision 9 validates PDA seeds and authorities itself. Bind the mutable values
  // it reads for this decision in the same transaction, including unsolicited rent top-ups.
  const guardedData = new Set<Address>([task, lighthouse.RENT]);
  if (escrow) guardedData.add(escrowKey);
  if (entry && selected) {
    guardedData.add(selected.workerAgent);
    guardedData.add((await findTaskSubmissionPda({ claim: selected.claim }))[0]);
  }
  const instructions: Instruction[] = [lighthouse.assertClockBefore(chainExpiry)];
  for (const [key, item] of byKey) {
    if (key === lighthouse.RENT && item) {
      instructions.push(lighthouse.assertBytes(lighthouse.RENT, 0, item.data));
      continue;
    }
    if (input.action === "cancel") {
      // Rev 9 requires every live claim and its owner, prohibits cancellation with
      // a submission, and cannot create a completion bond for a contest. Checking
      // only the values that affect this refund fits four workers in one packet.
      if (key === task) {
        const encoded = getTaskEncoder().encode(account!);
        const generation = encoded.length - 32 - 2 - 16 + 3; // referrer, bps, reserved[3..11]
        instructions.push(lighthouse.assertBytes(key, generation, bytes(key).slice(generation, generation + 8)));
        continue;
      }
      if (bonds.some(([bond]) => bond === key)) continue;
      if (key === escrowKey) instructions.push(lighthouse.assertBytes(key, 40, bytes(key).slice(40, 56))); // amount and distributed
    } else if (guardedData.has(key) && item) {
      instructions.push(lighthouse.assertDataHash(key, keccak_256(item.data), item.data.length));
    }
    if (!claims.some(c => c.workerAgent === key)) instructions.push(lighthouse.assertLamports(key, item?.lamports ?? 0n));
  }
  instructions.push(ix);
  return { quote, instructions };
}
