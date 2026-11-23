import { createHash } from "node:crypto";
import { getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import {
  AgentStatus, facade, findAgentPda, findClaimPda, findEscrowPda, findTaskSubmissionPda,
  findWorkerCompletionBondPda, getAgentRegistrationDecoder, getAgentRegistrationDiscriminatorBytes,
  getAgentStatsSize, getTaskClaimDecoder, getTaskClaimDiscriminatorBytes, getTaskClaimSize, getTaskEscrowDecoder,
  getTaskEscrowDiscriminatorBytes, getTaskSubmissionDecoder, getTaskSubmissionSize,
  getTaskSubmissionDiscriminatorBytes, resolveProgramAccountsTransport, SubmissionStatus, values,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import type { ContestAction, ContestEntry, ContestQuote } from "./client/types.js";
import { submissionId } from "./contest-history.js";
import type { ContestEvent } from "./contest-history.js";
import { WalletError } from "./errors.js";
import { snapshotReader, readAgent, readProgramAccount, readProtocolConfig, readTask, requestDeposits,
  requestDescription, sendApproval, type RequestIntent } from "./market.js";
import type { JobRecord, ContestRegistration } from "./store.js";
import { money } from "./views.js";

function accounts(chain: Chain, discriminator: ArrayLike<number>, offset: number, key: Address) {
  return resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({ filters: [
    { memcmp: { offset: 0, bytes: Uint8Array.from(discriminator) } },
    { memcmp: { offset, bytes: Uint8Array.from(getAddressEncoder().encode(key)) } },
  ] });
}

/** A registered creator is required by create_task. Quote a first registration and land it atomically with funding. */
export async function contestRegistration(chain: Chain, payer: Address, newId: string): Promise<ContestRegistration> {
  const [registrations, config] = await Promise.all([
    accounts(chain, getAgentRegistrationDiscriminatorBytes(), 40, payer), readProtocolConfig(chain),
  ]);
  if (config.protocolPaused || (config.disabledTaskTypeMask & (1 << 2)) !== 0) {
    throw new WalletError("NOT_AVAILABLE", "The marketplace is not accepting new contests.");
  }
  for (const item of registrations.sort((a, b) => a.address.localeCompare(b.address))) {
    const account = getAgentRegistrationDecoder().decode(item.data);
    if (account.status !== AgentStatus.Active || account.authority !== payer) continue;
    const agentId = Uint8Array.from(account.agentId);
    if ((await findAgentPda({ agentId }))[0] === item.address) return { agentId: values.bytesToHex(agentId), rent: "0", stake: "0" };
  }
  if (registrations.length) throw new WalletError("NOT_AVAILABLE", "The paying wallet needs an active creator registration.");
  return { agentId: newId, rent: (await chain.getMinimumBalanceForRentExemption(566)).toString(), stake: config.minAgentStake.toString() };
}

export async function contestPostCosts(chain: Chain, payer: Address, registrationId: string) {
  const [ordinary, registration] = await Promise.all([requestDeposits(chain, payer), contestRegistration(chain, payer, registrationId)]);
  const locked = BigInt(registration.rent) + BigInt(registration.stake);
  return { ...ordinary, total: ordinary.total + locked, kept: ordinary.kept + locked, registration };
}

export async function entrantCosts(chain: Chain) {
  const [claim, submission, workerRecord] = await Promise.all([getTaskClaimSize(), getTaskSubmissionSize(), getAgentStatsSize()]
    .map(space => chain.getMinimumBalanceForRentExemption(space)));
  return { entryRentLamports: (claim! + submission!).toString(), workerRecordLamports: workerRecord!.toString() };
}

export async function sendContest(chain: Chain, creator: KeyPairSigner, intent: RequestIntent, registration: ContestRegistration) {
  const agentId = values.hexToBytes(registration.agentId);
  const [creatorAgent] = await findAgentPda({ agentId });
  const { instructions } = await facade.createContestTask({
    creatorAgent, creator, authority: creator, taskId: intent.taskId, description: requestDescription(intent.jobSpecHash),
    constraintHash: null, rewardAmount: intent.rewardLamports, reviewWindowSecs: intent.reviewWindowSecs,
    deadline: intent.deadline, maxWorkers: intent.maxEntries!, requiredCapabilities: intent.requiredCapabilities,
    minReputation: intent.minReputation,
  });
  const register = registration.rent === "0" ? [] : [await facade.registerAgent({
    authority: creator, agentId, endpoint: "https://agenc.ag", metadataUri: null, capabilities: 1n, stakeAmount: BigInt(registration.stake),
  })];
  return (await chain.clientFor(creator).send([...register, ...instructions])).signature;
}

export async function liveContestEntries(chain: Chain, task: Address) {
  const found = await accounts(chain, getTaskSubmissionDiscriminatorBytes(), 8, task);
  const entries = await Promise.all(found.map(async item => {
    const s = getTaskSubmissionDecoder().decode(item.data);
    if (s.task !== task || s.status !== SubmissionStatus.Submitted) return null;
    const [claim] = await findClaimPda({ task, bidder: s.worker });
    if (claim !== s.claim || (await findTaskSubmissionPda({ claim }))[0] !== item.address) return null;
    const agent = await readAgent(chain, s.worker);
    if (!agent) throw new WalletError("NOT_AVAILABLE", "The submitter's account could not be read.");
    const hash = values.bytesToHex(Uint8Array.from(s.proofHash));
    const data = Uint8Array.from(s.resultData);
    const id = submissionId(claim, hash, s.submittedAt, s.submissionCount, values.bytesToHex(data));
    const entry: ContestEntry = { id, worker: s.worker, recipient: agent.authority, hash, dataHex: values.bytesToHex(data), submittedAt: Number(s.submittedAt),
      status: "submitted", text: null, uri: null };
    return { entry, data, claim, submission: item.address, reputation: agent.reputation };
  }));
  return entries.filter(entry => entry !== null).sort((a, b) => a.entry.submittedAt - b.entry.submittedAt || a.entry.id.localeCompare(b.entry.id));
}

type SavedEntry = NonNullable<JobRecord["contestEntries"]>[number];

// Rejection closes the claim. The same worker may re-enter with identical data
// within the same clock second. Keep each submission as a separate review item.
export function identifyEntry(entry: ContestEntry, previous: SavedEntry[]): SavedEntry {
  const matching = previous.filter(e => (e.commitment ?? e.id) === entry.id);
  const open = matching.find(e => e.status === "submitted");
  if (open) return open;
  return matching.length === 0 ? entry : { ...entry, commitment: entry.id,
    id: createHash("sha256").update(JSON.stringify([entry.id, matching.length])).digest("hex") };
}

export async function archiveContestEntries(chain: Chain, previous: SavedEntry[], events: ContestEvent[]) {
  const entries = previous.map(entry => ({ ...entry }));
  for (const event of events) {
    if (event.status === "submitted") {
      const seenLive = entries.find(e => (e.commitment ?? e.id) === event.id && !e.observedEvent);
      if (seenLive) seenLive.observedEvent = true;
      else {
        const agent = await readAgent(chain, event.worker);
        if (!agent) throw new WalletError("NOT_AVAILABLE", "The submitter's record could not be read.");
        entries.push({ ...identifyEntry({ ...event, recipient: agent.authority, text: null, uri: null }, entries), observedEvent: true });
      }
    } else {
      const entry = entries.slice().reverse().find(e => e.worker === event.worker && (e.status === "submitted" || e.status === "closed"));
      if (entry) entry.status = event.status;
    }
  }
  return entries;
}

/** Supply every verified no-show claim to cancel; the program checks the complete roster. */
export async function cancelUnsubmittedContest(chain: Chain, payer: KeyPairSigner, task: Address, workers: number) {
  const found = await accounts(chain, getTaskClaimDiscriminatorBytes(), 8, task);
  const workerAccounts = await Promise.all(found.map(async ({ address, data }) => {
    const c = getTaskClaimDecoder().decode(data);
    const agent = await readAgent(chain, c.worker);
    if (c.task !== task || !agent || (await findClaimPda({ task, bidder: c.worker }))[0] !== address) {
      return contestUnavailable("The entry roster changed. Refresh the contest.");
    }
    return { claim: address, workerAgent: c.worker, workerAuthority: agent.authority };
  }));
  if (workerAccounts.length !== workers) return contestUnavailable("The entry roster changed. Refresh the contest.");
  return (await chain.clientFor(payer).cancelTask({ task, authority: payer, workerAccounts,
    workerBondAuthority: workerAccounts[0]?.workerAuthority ?? payer.address, treasury: (await readProtocolConfig(chain)).treasury })).signature;
}

export function contestUnavailable(message: string): never {
  throw new WalletError("NOT_ALLOWED", message);
}

export async function quoteContestAction(chain: Chain, task: Address, creator: Address,
  input: { entryId: string; action: ContestAction; reason?: string }, id: string, expiresAt: number, rate: number | null, commitment: string): Promise<ContestQuote> {
  if (rate === null) throw new WalletError("NETWORK", "Dollar prices are unavailable. Refresh the contest quote.");
  const [entries, account, clock, config] = await Promise.all([liveContestEntries(chain, task), readTask(chain, task), chain.clusterTime(), readProtocolConfig(chain)]);
  if (!account || Number(account.taskType) !== 2 || account.creator !== creator || account.operatorFeeBps || account.referrerFeeBps) {
    return contestUnavailable("This contest cannot be settled here.");
  }
  const entry = entries.find(e => e.entry.id === commitment);
  if (!entry || entries.length !== account.reserved[1]) return contestUnavailable("The entries changed. Refresh the contest.");
  const release = clock >= Number(account.deadline + facade.CONTEST_SELECTION_WINDOW_SECS);
  if (!["winner", "reject", "release"].includes(input.action) || release !== (input.action === "release")) {
    return contestUnavailable(release ? "Only shares can be released now." : "The selection window is still open.");
  }
  if (input.action === "winner" && entries.length !== 1) return contestUnavailable("Reject the other submissions before choosing a winner.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (input.action === "reject" && (!reason || reason.length > 2000)) throw new WalletError("BAD_REQUEST", "Give a rejection reason in up to 2000 characters.");
  const [escrowPda] = await findEscrowPda({ task });
  const [escrow, balances] = await Promise.all([
    readProgramAccount(chain, escrowPda, getTaskEscrowDiscriminatorBytes(), data => getTaskEscrowDecoder().decode(data)),
    chain.getBalances([entry.claim, entry.submission]),
  ]);
  if (!escrow || escrow.task !== task || balances.length !== 2 || !balances[0] || !balances[1]) return contestUnavailable("The held prize or entry changed. Refresh the contest.");
  const remaining = escrow.amount - escrow.distributed;
  const count = BigInt(entries.length);
  const gross = input.action === "reject" ? 0n : input.action === "winner" ? account.rewardAmount : remaining / count;
  // A concurrent release can assign this recipient the one-lamport rounding remainder.
  const grossLimit = input.action === "release" ? (remaining + count - 1n) / count : gross;
  // Same reputation tiers and positive-fee floor as the coordination program.
  const discount = entry.reputation >= 9500 ? 15 : entry.reputation >= 9000 ? 10 : entry.reputation >= 8000 ? 5 : 0;
  const feeBps = account.protocolFeeBps === 0 ? 0 : Math.max(1, account.protocolFeeBps - discount);
  const fee = gross * BigInt(feeBps) / 10_000n;
  let recordCost = 0n;
  if (input.action === "reject") {
    const cost = await facade.missingRecordCost(snapshotReader(chain), space => chain.getMinimumBalanceForRentExemption(space),
      { creator, workerAgent: entry.entry.worker as Address });
    recordCost = cost.lamports;
  }
  return { id, claimGeneration: Buffer.from(account.reserved).readBigUInt64LE(3).toString(), entryId: input.entryId, action: input.action, reason, recipient: entry.entry.recipient, payer: creator, treasury: config.treasury,
    gross: money(gross, rate), grossLimit: money(grossLimit, rate),
    feeLimit: money(grossLimit * BigInt(account.protocolFeeBps) / 10000n, rate), prize: money(gross - fee, rate), marketFee: money(fee, rate),
    entryRefund: money(balances[0] + balances[1], rate), networkFee: money(chain.transferFeeLamports, rate),
    recordCost: money(recordCost, rate), expiresAt };
}

export async function sendContestAction(chain: Chain, creator: KeyPairSigner, task: Address, entry: ContestEntry, quote: ContestQuote) {
  const worker = entry.worker as Address;
  const workerAuthority = quote.recipient as Address;
  if (quote.action === "winner") return sendApproval(chain, creator, task, worker, { workerAuthority, treasury: quote.treasury as Address });
  const ix = quote.action === "release"
    ? await facade.distributeGhostShare({ task, worker, creator: creator.address, workerAuthority, cranker: creator, treasury: quote.treasury as Address })
    : await facade.rejectTaskResult({ task, worker, workerAuthority, creator, claim: (await findClaimPda({ task, bidder: worker }))[0],
      workerCompletionBond: (await findWorkerCompletionBondPda({ task, workerAuthority }))[0],
      rejectionHash: createHash("sha256").update(JSON.stringify([task, entry.id, quote.reason])).digest() });
  return (await chain.clientFor(creator).send([ix])).signature;
}
