import { createNoopSigner, getAddressEncoder, type Address } from "@solana/kit";
import { facade, findAgentPda, getTaskDecoder, getTaskDiscriminatorBytes, resolveProgramAccountsTransport, TASK_CREATOR_OFFSET, TaskStatus, TaskType, values } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import { isRetiredAgent, listingsOf, readAgent } from "./market.js";
import type { StateStore } from "./store.js";
import { WalletError } from "./errors.js";
import { money } from "./views.js";
import { operationFingerprint } from "./operation-receipts.js";

export async function contestStake(chain: Chain, store: StateStore, authority: Address, jobId: string, rate: number | null, expiresAt: number) {
  const state = store.state;
  const job = state.jobs[jobId];
  const reg = job ? (job.role === "buying" && job.payer === "main" && job.terms?.contest ? job.contestRegistration : undefined)
    : state.contestRegistrations?.[jobId] ?? store.archive.contest(jobId);
  if (!reg)
    throw new WalletError("NOT_FOUND", "No main-funded contest registration was found.");
  const [registration] = await findAgentPda({ agentId: values.hexToBytes(reg.agentId) });
  const [agent, raw, listings] = await Promise.all([readAgent(chain, registration), chain.readRawAccount(registration), listingsOf(chain, registration)]);
  if (!agent || !raw || agent.authority !== authority) throw new WalletError("NOT_ALLOWED", "The wallet does not own this registration.");
  const related = Object.values(state.jobs).filter(j => j.contestRegistration?.agentId === reg.agentId);
  const sharedJobs = [...new Set([...store.archive.contestJobs(reg.agentId), ...related.map(j => j.id), ...Object.keys(state.contestRegistrations ?? {})
    .filter(id => state.contestRegistrations![id]!.agentId === reg.agentId)])].sort();
  const obligations = related.filter(j => !["failed", "declined", "done"].includes(j.phase)).map(j => j.id);
  // Revision 9 contests refer to their creator authority. A restored or
  // shared registration can still protect contests outside this journal.
  const tasks = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({ filters: [
    { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskDiscriminatorBytes()) } },
    { memcmp: { offset: TASK_CREATOR_OFFSET, bytes: Uint8Array.from(getAddressEncoder().encode(authority)) } },
  ] });
  for (const entry of tasks) {
    const task = getTaskDecoder().decode(entry.data);
    if (task.creator === authority && task.taskType === TaskType.Competitive &&
        task.status !== TaskStatus.Completed && task.status !== TaskStatus.Cancelled &&
        !related.some(job => job.task === entry.address && obligations.includes(job.id)))
      obligations.push(`Open contest ${entry.address}`);
  }
  if (agent.activeTasks) obligations.push(`${agent.activeTasks} active tasks`);
  if (agent.activeDisputeVotes || agent.disputesAsDefendant) obligations.push("Unresolved disputes");
  if (listings.some(x => Number(x.listing.state) !== facade.ListingState.Retired)) obligations.push("Service listing");
  if (isRetiredAgent(agent)) obligations.push("Permanently retired");
  const floor = await chain.getMinimumBalanceForRentExemption(raw.data.length);
  const fee = chain.transferFeeLamports;
  const gross = raw.lamports - floor;
  if (gross < agent.stake || gross <= 0n) obligations.push("No recoverable stake");
  if (!obligations.length) {
    const ix = await facade.deregisterAgent({ agent: registration, authority: createNoopSigner(authority) });
    const sim = await chain.simulateWork?.(authority, ix);
    if (!sim || sim.fee !== String(fee) || !sim.changes.some(c => c.address === authority && BigInt(c.delta) === gross - fee))
      obligations.push("The chain could not confirm the retirement figures or eligibility.");
  }
  const id = operationFingerprint([chain.network, jobId, registration, authority, sharedJobs, obligations,
    String(agent.stake), String(floor), String(gross), String(fee), expiresAt]);
  return { id, jobId, registration, authority, expiresAt, sharedJobs, reusedRegistration: reg.stake === "0",
    obligations, stake: money(agent.stake, rate), retainedRent: money(floor, rate), fee: money(fee, rate), credit: money(gross > 0n ? gross : 0n, rate),
    netCredit: money(gross - fee, rate) };
}
export type ContestStakeQuote = Awaited<ReturnType<typeof contestStake>>;

declare module "./store.js" { interface WalletState { retirementQuotes?: Record<string, ContestStakeQuote> } }
