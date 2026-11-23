import { createHash } from "node:crypto";
import { getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS, getTaskDecoder, getTaskDiscriminatorBytes, AgentStatus, facade, findAgentPda, findClaimPda, findTaskSubmissionPda,
  getAgentRegistrationDecoder, getAgentRegistrationDiscriminatorBytes,
  getTaskAttestorConfigSize, getAgentStatsSize, getTaskClaimDecoder, getTaskClaimDiscriminatorBytes, getTaskClaimSize,
  getTaskSubmissionDecoder, getTaskSubmissionSize,
  getTaskSubmissionDiscriminatorBytes, resolveProgramAccountsTransport, SubmissionStatus, values,
  lighthouse,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import type { ContestEntry } from "./client/types.js";
import { submissionId } from "./contest-history.js";
import type { ContestEvent } from "./contest-history.js";
import { WalletError } from "./errors.js";
import { readAgent, readProtocolConfig, requestDeposits,
  requestDescription, type RequestIntent } from "./market.js";
import type { JobRecord, ContestRegistration } from "./store.js";

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
  if (registrations.some(item => {
    const agent = getAgentRegistrationDecoder().decode(item.data);
    return agent.status !== AgentStatus.Inactive || Buffer.from(agent.reserved).toString("ascii") !== "RETD";
  })) throw new WalletError("NOT_AVAILABLE", "The paying wallet needs an active creator registration.");
  return { agentId: newId, rent: (await chain.getMinimumBalanceForRentExemption(566)).toString(), stake: config.minAgentStake.toString() };
}

export async function contestPostCosts(chain: Chain, payer: Address, registrationId: string) {
  const [ordinary, registration] = await Promise.all([requestDeposits(chain, payer), contestRegistration(chain, payer, registrationId)]);
  const locked = BigInt(registration.rent) + BigInt(registration.stake);
  const attestor = await chain.getMinimumBalanceForRentExemption(getTaskAttestorConfigSize());
  return { ...ordinary, total: ordinary.total + attestor + locked, kept: ordinary.kept + locked, registration };
}

export async function entrantCosts(chain: Chain) {
  const [claim, submission, workerRecord] = await Promise.all([getTaskClaimSize(), getTaskSubmissionSize(), getAgentStatsSize()]
    .map(space => chain.getMinimumBalanceForRentExemption(space)));
  return { entryRentLamports: (claim! + submission!).toString(), workerRecordLamports: workerRecord!.toString() };
}

export async function sendContest(chain: Chain, creator: KeyPairSigner, intent: RequestIntent, registration: ContestRegistration, expiresAt: number) {
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
  return (await chain.clientFor(creator).send([lighthouse.assertClockBefore(expiresAt), ...register, ...instructions])).signature;
}

export async function liveContestEntries(chain: Chain, task: Address, minSlot?: number) {
  const found = await accounts(chain, getTaskSubmissionDiscriminatorBytes(), 8, task);
  const workers = found.map(item => getTaskSubmissionDecoder().decode(item.data).worker);
  const snapshot = await chain.readRawAccounts([task, ...found.map(item => item.address), ...workers], minSlot);
  const header = snapshot[0];
  const live = header && Buffer.from(header.data.subarray(0, 8)).equals(Buffer.from(getTaskDiscriminatorBytes()))
    ? getTaskDecoder().decode(header.data).reserved[1] : 0;
  const entries = await Promise.all(found.map(async (item, index) => {
    const raw = snapshot[1 + index];
    if (!raw || raw.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS || raw.lamports === 0n) return null;
    const s = getTaskSubmissionDecoder().decode(raw.data);
    if (s.task !== task || s.worker !== workers[index] || s.status !== SubmissionStatus.Submitted) return null;
    const [claim] = await findClaimPda({ task, bidder: s.worker });
    if (claim !== s.claim || (await findTaskSubmissionPda({ claim }))[0] !== item.address) return null;
    const worker = snapshot[1 + found.length + index];
    const agent = worker?.owner === AGENC_COORDINATION_PROGRAM_ADDRESS ? getAgentRegistrationDecoder().decode(worker.data) : null;
    if (!agent) throw new WalletError("NOT_AVAILABLE", "The submitter's account could not be read.");
    const hash = values.bytesToHex(Uint8Array.from(s.proofHash));
    const data = Uint8Array.from(s.resultData);
    const id = submissionId(claim, hash, s.submittedAt, s.submissionCount, values.bytesToHex(data));
    const entry: ContestEntry = { id, worker: s.worker, recipient: agent.authority, hash, dataHex: values.bytesToHex(data), submittedAt: Number(s.submittedAt),
      status: "submitted", text: null, uri: null };
    return { entry, data, claim, submission: item.address, reputation: agent.reputation };
  }));
  const confirmed = entries.filter(entry => entry !== null);
  if (confirmed.length !== live) throw new WalletError("NETWORK", "The entry roster changed during the read. Refresh the contest.");
  return confirmed.sort((a, b) => a.entry.submittedAt - b.entry.submittedAt || a.entry.id.localeCompare(b.entry.id));
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
  const current = new Map<string, SavedEntry>();
  for (const event of events) {
    if (event.status === "submitted") {
      let row = entries.find(e => e.eventId === event.eventId)
        ?? entries.find(e => (e.commitment ?? e.id) === event.id && !e.eventId);
      if (!row) {
        const agent = await readAgent(chain, event.worker).catch(() => null);
        row = { id: event.eventId, commitment: event.id, status: "submitted", worker: event.worker, hash: event.hash,
          dataHex: event.dataHex, submittedAt: event.submittedAt, recipient: agent?.authority ?? "Unknown", text: null, uri: null };
        entries.push(row);
      }
      row.eventId = event.eventId;
      row.observedEvent = true;
      current.set(event.worker, row);
    } else {
      const entry = current.get(event.worker) ?? entries.slice().reverse().find(e => e.worker === event.worker &&
        e.settlement?.signature === event.signature);
      if (entry) {
        entry.status = event.status;
        entry.settlement = { signature: event.signature, ...(event.prize !== undefined && { prize: event.prize }),
          ...(event.fee !== undefined && { fee: event.fee }), ...(event.changes && { changes: event.changes }) };
      }
      current.delete(event.worker);
    }
  }
  return entries;
}

export function contestUnavailable(message: string): never {
  throw new WalletError("NOT_ALLOWED", message);
}

export async function contestClaims(chain: Chain, task: Address) {
  const found = await accounts(chain, getTaskClaimDiscriminatorBytes(), 8, task);
  const claims = await Promise.all(found.map(async item => {
    const c = getTaskClaimDecoder().decode(item.data);
    const agent = await readAgent(chain, c.worker);
    if (c.task !== task || !agent || (await findClaimPda({ task, bidder: c.worker }))[0] !== item.address) {
      return contestUnavailable("The entry roster changed. Refresh the contest.");
    }
    return { claim: item.address, workerAgent: c.worker, workerAuthority: agent.authority };
  }));
  return claims.sort((a, b) => a.claim.localeCompare(b.claim));
}
