import { createHash, randomUUID } from "node:crypto";
import { address, type Address } from "@solana/kit";
import {
  facade,
  findClaimPda,
  findHireRecordPda,
  getHireRecordDecoder,
  getHireRecordDiscriminatorBytes,
  getTaskClaimDecoder,
  getTaskClaimDiscriminatorBytes,
  TaskStatus,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { fetchAndVerifyJobSpec, parseJobBrief } from "@tetsuo-ai/agenc-worker";
import type { Chain } from "./chain.js";
import type {
  ChildEscrow,
  ChildHirePolicy,
  ChildHireRequest,
  ChildPayout,
  ChildRoomGrant,
} from "./client/child-hire.js";
import { CHILD_SHARE_PREFIX, childSharePayload } from "./client/child-hire.js";
import type { ApprovalView, JobTerms } from "./client/types.js";
import { WalletError } from "./errors.js";
import { sellerProceeds } from "./seller-terms.js";
import type { MarketServices } from "./services.js";
import { money } from "./views.js";

import { childHolds, childState, type ChildHireRecord } from "./child-hire-store.js";
import type { ChildHireView, ChildResult } from "./client/child-hire.js";
import type { AgencWallet } from "./wallet.js";
import type { StateStore, AgentRecord, ApprovalRecord, JobRecord } from "./store.js";
import { microcents, reserveJobSpend, remainingJobMicrocents } from "./job-money.js";
import {
  readAgent,
  readProgramAccount,
  readTask,
  type ListingTerms,
  inspectJob,
  readHireableListing,
  readListing,
  snapshotReader,
  readProtocolConfig,
  readSubmission,
} from "./market.js";
import { splitDelivery, deliveryFileProblem, deliveryFileType } from "./client/delivery-files.js";

export function refuseChild(message: string): never {
  throw new WalletError("NOT_ALLOWED", message);
}
export function childDigest(fields: unknown): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export function checkedChildPolicy(value: ChildHirePolicy): ChildHirePolicy {
  if (
    !value ||
    !Array.isArray(value.allowedListings) ||
    !value.allowedListings.length ||
    value.allowedListings.length > 16 ||
    new Set(value.allowedListings).size !== value.allowedListings.length ||
    typeof value.maxDebitLamports !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.maxDebitLamports) ||
    BigInt(value.maxDebitLamports) > 0xffffffffffffffffn ||
    ![value.returnBeforeSecs, value.reviewWindowSecs].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= 604800,
    ) ||
    !["public-brief", "buyer-approved-input"].includes(value.sharing)
  )
    refuseChild("Check the supplier policy, spending cap and return times.");
  return {
    allowedListings: value.allowedListings.map(address).sort(),
    maxDebitLamports: value.maxDebitLamports,
    returnBeforeSecs: value.returnBeforeSecs,
    reviewWindowSecs: value.reviewWindowSecs,
    sharing: value.sharing,
  };
}
export function checkedChildRequest(value: ChildHireRequest): ChildHireRequest {
  if (
    !value ||
    Object.keys(value).some((k) => !["listing", "brief", "outputs", "privateCommitment"].includes(k)) ||
    typeof value.brief !== "string" ||
    !value.brief.trim() ||
    value.brief.length > 4000 ||
    !Array.isArray(value.outputs) ||
    !value.outputs.length ||
    value.outputs.length > 6 ||
    value.outputs.some((name) => typeof name !== "string" || (name !== "text" && !deliveryFileType(name))) ||
    new Set(value.outputs.map((s) => s.toLowerCase())).size !== value.outputs.length ||
    (value.privateCommitment !== undefined && !/^[0-9a-f]{64}$/.test(value.privateCommitment))
  )
    refuseChild("Choose a service, public brief and required outputs.");
  return {
    listing: address(value.listing),
    brief: value.brief.trim(),
    outputs: [...value.outputs],
    ...(value.privateCommitment && {
      privateCommitment: value.privateCommitment,
    }),
  };
}
/** Plain agreed criteria survive both the hosted and practice spec publishers. */
export function childPolicyCriterion(policy: ChildHirePolicy) {
  return "Allow one seller-funded supplier under policy " + childDigest(checkedChildPolicy(policy));
}
export function childShareCriterion(supplier: string, request: ChildHireRequest) {
  return (
    CHILD_SHARE_PREFIX +
    createHash("sha256")
      .update(childSharePayload(address(supplier), checkedChildRequest(request)))
      .digest("hex")
  );
}
export const CHILD_LINEAGE = "Supplier job for parent ";
export function sameGrant(a: ChildRoomGrant, b: ChildRoomGrant) {
  return (
    a.parentTask === b.parentTask &&
    a.sellerAgentId === b.sellerAgentId &&
    a.claimedAt === b.claimedAt &&
    a.roomId === b.roomId
  );
}
export async function parentClaim(
  chain: Chain,
  services: MarketServices,
  grant: ChildRoomGrant,
  payer: string,
) {
  if (!grant.roomId || grant.roomId.length > 128) refuseChild("The room grant is unavailable.");
  const task = address(grant.parentTask);
  const [hirePda] = await findHireRecordPda({ task });
  const [account, hire, now] = await Promise.all([
    readTask(chain, task),
    readProgramAccount(chain, hirePda, getHireRecordDiscriminatorBytes(), (b) =>
      getHireRecordDecoder().decode(b),
    ),
    chain.clusterTime(),
  ]);
  if (!account || account.status !== TaskStatus.InProgress || !hire || hire.task !== task)
    refuseChild("The parent needs a live service claim.");
  const worker = hire.designatedProvider;
  const [claimPda] = await findClaimPda({ task, bidder: worker });
  const [claim, agent, spec] = await Promise.all([
    readProgramAccount(chain, claimPda, getTaskClaimDiscriminatorBytes(), (b) =>
      getTaskClaimDecoder().decode(b),
    ),
    readAgent(chain, worker),
    fetchAndVerifyJobSpec({
      task,
      readAccount: chain.readAccount,
      ...(services.resolveAgencUri && {
        resolveAgencUri: services.resolveAgencUri,
      }),
    }),
  ]);
  if (
    !claim ||
    claim.task !== task ||
    claim.worker !== worker ||
    claim.isCompleted ||
    claim.claimedAt.toString() !== grant.claimedAt ||
    agent?.authority !== payer
  )
    refuseChild("The parent claim or paying seller changed.");
  const raw = JSON.parse(new TextDecoder().decode(spec.content));
  const brief = parseJobBrief(raw);
  const deadline = Math.min(
    Number(account.deadline),
    brief.terms?.deadline ?? Infinity,
    Number(claim.expiresAt) || Infinity,
  );
  if (now >= deadline || brief.acceptance.some((s) => s.startsWith(CHILD_LINEAGE)))
    refuseChild("A supplier cannot hire another supplier or use an expired claim.");
  return {
    task,
    listing: hire.listing,
    worker,
    creator: account.creator,
    deadline,
    now,
    criteria: brief.acceptance,
    privateInputs: Boolean(
      raw.privateInputs || brief.acceptance.some((line) => line.startsWith("Private input handoff v1: ")),
    ),
    gross: account.rewardAmount,
    marketBps: account.protocolFeeBps,
    operatorBps: hire.operatorFeeBps,
  };
}
export function childPayout(
  quote: ApprovalView,
  terms: ListingTerms,
  rate: number,
  practice: boolean,
): ChildPayout {
  const bound = (quote.terms as (JobTerms & { hire?: ChildPayout }) | undefined)?.hire;
  if (bound) return bound;
  if (!practice || !quote.marketFee)
    refuseChild("Update the wallet to review the supplier's exact listing split.");
  const proceeds = sellerProceeds(terms.priceLamports, terms.operatorFeeBps, quote.marketFee.bps, rate);
  return {
    listingVersion: terms.version.toString(),
    price: quote.price,
    operator: terms.operator,
    operatorFeeBps: terms.operatorFeeBps,
    operatorFee: proceeds.operatorFee,
    marketplaceFeeBps: quote.marketFee.bps,
    maximumMarketplaceFee: quote.marketFee.amount,
    minimumSellerNet: proceeds.sellerNet!,
    minimumSellerNetIfOperatorCannotReceive: proceeds.sellerNetIfForfeited!,
  };
}
export function childParentNet(parent: Awaited<ReturnType<typeof parentClaim>>, rate: number) {
  return sellerProceeds(parent.gross, parent.operatorBps, parent.marketBps, rate).sellerNet!;
}

export async function escrowStatus(
  chain: Chain,
  cached: ChildEscrow,
  worker: Address,
  creatorRole: boolean,
): Promise<ChildEscrow> {
  if (!cached.task) return cached;
  const seen = await inspectJob(chain, address(cached.task), worker);
  if (!seen) return { ...cached, status: "unknown", action: "Check receipt" };
  const status = (
    {
      open: "waiting",
      in_progress: "working",
      pending_validation: "delivered",
      completed: "paid",
      cancelled: "refunded",
      disputed: "in_review",
      reject_frozen: "in_review",
    } as const
  )[seen.status];
  const deadline = seen.deadline || cached.deadline;
  const now = await chain.clusterTime();
  const action =
    status === "delivered" && creatorRole
      ? "Review delivery"
      : (status === "waiting" || (status === "working" && deadline && now >= deadline)) && creatorRole
        ? "Review refund"
        : status === "in_review"
          ? "View review options"
          : null;
  return {
    ...cached,
    status,
    deadline,
    reviewEndsAt:
      seen.turnDown?.rulingUntil ??
      seen.turnDown?.disputeUntil ??
      (seen.submission?.reviewDeadlineAt || cached.reviewEndsAt),
    action,
  };
}

interface ChildWalletPorts {
  chain: Chain;
  services: MarketServices;
  store: StateStore;
  agent(id: string): AgentRecord;
  now(): number;
  rate(): Promise<number>;
  room(agent: AgentRecord, rate: number, except?: string): bigint;
  lock<T>(key: string, action: () => Promise<T>): Promise<T>;
  quote(
    input: Parameters<AgencWallet["hire"]>[0],
  ): Promise<{ job: JobRecord; approval: ApprovalRecord; view: ApprovalView }>;
  advance(jobId: string): Promise<void>;
  notify(id: string): void;
  /** B's reader completes inspection against the current round, including protected files. */
  privateStage(
    grant: ChildRoomGrant,
    request: ChildHireRequest,
    supplier: string,
    saved?: string,
  ): Promise<string>;
  evidence?(
    job: JobRecord,
    names: string[],
  ): Promise<Pick<ChildResult, "text" | "files" | "round" | "deliveryHash"> | null>;
}

export class ChildHires {
  constructor(private readonly p: ChildWalletPorts) {}
  #record(parent: string) {
    const record = childState(this.p.store.state).childHires?.[address(parent)];
    if (!record) throw new WalletError("NOT_FOUND", "No supplier request exists for this parent.");
    return record;
  }
  async setPolicy(sellerAgentId: string, listing: string, input: ChildHirePolicy | null) {
    const agent = this.p.agent(sellerAgentId);
    const offer = await readListing(this.p.chain, address(listing));
    if (!offer || (await readAgent(this.p.chain, offer.providerAgent))?.authority !== agent.address)
      refuseChild("Choose a service sold by the paying agent.");
    const policy = input === null ? null : checkedChildPolicy(input);
    if (policy?.allowedListings.includes(listing)) refuseChild("The parent service cannot supply itself.");
    this.p.store.update((state) => {
      const policies = (childState(state).childPolicies ??= {});
      if (policy) policies[listing] = policy;
      else delete policies[listing];
    });
    return policy;
  }
  async #context(grant: ChildRoomGrant, input: ChildHireRequest, saved?: string) {
    const payer = this.p.agent(grant.sellerAgentId);
    const [parent, service] = await Promise.all([
      parentClaim(this.p.chain, this.p.services, grant, payer.address),
      readHireableListing(this.p.chain, address(input.listing)),
    ]);
    const policy = childState(this.p.store.state).childPolicies?.[parent.listing];
    if (
      !policy ||
      !parent.criteria.includes(childPolicyCriterion(policy)) ||
      !policy.allowedListings.includes(input.listing)
    )
      refuseChild("The parent buyer and seller must agree to this supplier policy.");
    const supplier = await readAgent(this.p.chain, service.providerAgent);
    if (
      !supplier ||
      service.providerAgent === parent.worker ||
      parent.listing === input.listing ||
      [payer.address, parent.creator].includes(supplier.authority)
    )
      refuseChild("Choose an independent supplier.");
    let supplierCommitment: string | undefined;
    if (input.privateCommitment || parent.privateInputs) {
      if (
        policy.sharing !== "buyer-approved-input" ||
        !input.privateCommitment ||
        !parent.criteria.includes(childShareCriterion(supplier.authority, input))
      )
        refuseChild("The original buyer must approve this input and public brief for this supplier.");
      supplierCommitment = await this.p.privateStage(grant, input, supplier.authority, saved);
    }
    const cutoff = parent.deadline - policy.returnBeforeSecs;
    if (!service.deliverySecs || parent.now + service.deliverySecs + policy.reviewWindowSecs > cutoff)
      refuseChild("The supplier's delivery and review would run past the parent cutoff.");
    return {
      payer,
      parent,
      service,
      supplier: supplier.authority,
      policy,
      cutoff,
      supplierCommitment,
    };
  }
  async request(grant: ChildRoomGrant, request: ChildHireRequest): Promise<ChildHireView> {
    const input = checkedChildRequest(request);
    const fingerprint = childDigest(input);
    return this.p.lock("child:" + address(grant.parentTask), async () => {
      const existing = childState(this.p.store.state).childHires?.[grant.parentTask];
      if (existing) {
        if (!sameGrant(existing.grant, grant) || existing.fingerprint !== fingerprint)
          refuseChild("This parent already requested its one supplier.");
        await parentClaim(this.p.chain, this.p.services, grant, this.p.agent(grant.sellerAgentId).address);
        if (existing.view.phase !== "approval" || existing.view.quote.expiresAt > this.p.now())
          return this.timeline(grant.parentTask);
      }
      const { parent, service, supplier, policy, payer, cutoff, supplierCommitment } = await this.#context(
        grant,
        input,
        existing?.supplierCommitment,
      );
      if (
        Object.values(childState(this.p.store.state).childHires ?? {}).some(
          (r) => r.view.child.task === parent.task,
        )
      )
        refuseChild("A supplier cannot hire another supplier.");
      const purchaseKey = existing?.view.purchaseKey ?? "child/" + parent.task + "/" + randomUUID();
      const draft = await this.p.quote({
        agentId: payer.id,
        listing: input.listing,
        request: input.brief,
        acceptance: [
          ...(supplierCommitment
            ? ["Return the agreed protected outputs."]
            : input.outputs.map((name) => "Deliver " + name)),
          CHILD_LINEAGE + parent.task,
        ],
        ...(supplierCommitment && { privateCommitment: supplierCommitment }),
        reviewWindowSecs: policy.reviewWindowSecs,
        deadline: parent.now + service.deliverySecs!,
        idempotencyKey: purchaseKey,
        expectedSpecHash: Buffer.from(service.specHash).toString("hex"),
        expectedPriceLamports: String(service.priceLamports),
      });
      if (
        supplierCommitment &&
        !parseJobBrief(draft.job.jobSpec).acceptance.includes("Private input handoff v1: " + supplierCommitment)
      )
        refuseChild("The supplier service must support the approved private handoff.");
      const quote = draft.view;
      if (draft.job.payer !== "agent" || !quote.total || !draft.approval.quoteRate)
        refuseChild("Fund the selling agent before requesting a supplier.");
      const rate = draft.approval.quoteRate;
      const daily = this.p.room(payer, rate);
      const reviewRecords = await facade.missingRecordCost(
        snapshotReader(this.p.chain),
        (size) => this.p.chain.getMinimumBalanceForRentExemption(size),
        { creator: address(payer.address), workerAgent: service.providerAgent },
      );
      // Up to two corrections and a final decision. Include both review records at today's rent.
      const reviewReserve = reviewRecords.lamports + 3n * this.p.chain.transferFeeLamports;
      const total = BigInt(quote.total.lamports) + reviewReserve;
      if (total > BigInt(policy.maxDebitLamports) || total > daily)
        refuseChild("The full supplier cost exceeds the parent cap or daily allowance.");
      const config = await readProtocolConfig(this.p.chain);
      const parentView: ChildEscrow = {
        jobId: "earn_" + payer.id + "_" + parent.task,
        task: parent.task,
        status: "working",
        deadline: parent.deadline,
        reviewEndsAt: null,
        action: null,
        signature: null,
      };
      const view: ChildHireView = {
        phase: "approval",
        purchaseKey,
        parent: parentView,
        child: {
          jobId: draft.job.id,
          task: null,
          status: "needs_approval",
          deadline: quote.terms!.deadline,
          reviewEndsAt: null,
          action: null,
          signature: null,
        },
        payer: payer.address,
        sellerAgentId: payer.id,
        supplier: service.providerAgent,
        supplierAuthority: supplier,
        treasury: config.treasury,
        parentSellerNet: childParentNet(parent, rate),
        request: input,
        policy,
        quote,
        payout: childPayout(quote, service, rate, this.p.chain.network === "sandbox"),
        reviewReserve: money(reviewReserve, rate),
        maxDebit: money(total, rate),
        dailyAvailable: money(daily, rate),
        cap: money(policy.maxDebitLamports, rate),
        cutoff,
        importReceipt: null,
      };
      this.p.store.update((state) => {
        (childState(state).childHires ??= {})[parent.task] = {
          grant: { ...grant },
          parentListing: parent.listing,
          parentWorker: parent.worker,
          view,
          fingerprint,
          ...(supplierCommitment && { supplierCommitment }),
          draft: { job: draft.job, approval: draft.approval },
        };
      });
      this.p.notify(quote.id);
      return structuredClone(view);
    });
  }
  async checkFunding(record: ChildHireRecord, job: JobRecord) {
    const { view } = record;
    if (view.request.privateCommitment && !record.supplierCommitment)
      refuseChild("The supplier file approval is missing. Review the private handoff.");
    const { service, policy, supplier, cutoff, payer } = await this.#context(
      record.grant,
      view.request,
      record.supplierCommitment,
    );
    const rate = await this.p.rate();
    const payout = view.payout;
    if (
      job.payer !== "agent" ||
      job.agentId !== payer.id ||
      job.id !== view.child.jobId ||
      job.idempotencyKey !== view.purchaseKey ||
      view.payer !== payer.address ||
      view.supplierAuthority !== supplier ||
      cutoff !== view.cutoff ||
      childDigest(policy) !== childDigest(view.policy) ||
      service.version.toString() !== payout.listingVersion ||
      service.priceLamports.toString() !== payout.price.lamports ||
      service.operator !== payout.operator ||
      service.operatorFeeBps !== payout.operatorFeeBps ||
      view.quote.expiresAt <= this.p.now() ||
      service.providerAgent !== view.supplier ||
      Buffer.from(service.specHash).toString("hex") !== job.listingSpecHashHex
    )
      refuseChild("The supplier quote, parent claim or policy changed. Review the terms again.");
    const published = parseJobBrief(job.jobSpec);
    if (
      published.request !== view.request.brief ||
      JSON.stringify(published.acceptance) !== JSON.stringify(job.acceptance) ||
      !published.acceptance.includes(CHILD_LINEAGE + record.grant.parentTask) ||
      (await values.canonicalJobSpecHash(job.jobSpec)).hex !== job.jobSpecHashHex
    )
      refuseChild("The supplier brief or its parent binding changed.");
    const debit = BigInt(view.maxDebit.lamports);
    const available = await this.p.chain.getBalance(address(payer.address));
    const floor = await this.p.chain.getMinimumBalanceForRentExemption(0);
    if (
      !job.approvedCosts ||
      available <
        BigInt(job.priceLamports) +
          BigInt(job.approvedCosts.total) +
          floor +
          BigInt(view.reviewReserve.lamports)
    )
      refuseChild("The selling agent cannot cover the hire and its review costs.");
    if (debit > this.p.room(this.p.agent(job.agentId), rate, job.id))
      refuseChild("The selling agent's daily allowance is too low.");
    const approvedRate =
      record.draft?.approval.quoteRate ?? this.p.store.state.approvals[view.quote.id]?.quoteRate;
    if (!approvedRate || rate > approvedRate)
      refuseChild("The dollar cost changed. Review the supplier quote again.");
  }
  async decide(parentTask: string, quoteId: string, approve: boolean) {
    return this.p.lock("child:" + address(parentTask), async () => {
      const record = this.#record(parentTask);
      const { view } = record;
      if (typeof approve !== "boolean" || view.quote.id !== quoteId)
        refuseChild("Review the current supplier quote in Market.");
      if (view.phase === "declined" || view.phase === "imported" || view.phase === "funded")
        return this.timeline(parentTask);
      if (!approve) {
        if (view.phase !== "approval") refuseChild("This supplier purchase was already approved.");
        this.p.store.update((state) => {
          const r = childState(state).childHires![parentTask]!;
          r.view.phase = "declined";
          r.view.child.status = "declined";
          delete r.draft;
        });
      } else {
        if (record.draft) {
          const { job, approval } = record.draft;
          await this.p.lock("wallet:" + job.agentId, async () => {
            await this.checkFunding(record, job);
            const rate = approval.quoteRate!;
            const max = BigInt(view.maxDebit.lamports);
            this.p.store.update((state) => {
              const agent = state.agents[job.agentId]!;
              const r = childState(state).childHires![parentTask]!;
              const charge = microcents(max, rate);
              if (
                max > BigInt(r.view.policy.maxDebitLamports) ||
                max > this.p.room(agent, rate) ||
                charge > remainingJobMicrocents(agent, this.p.now())
              )
                refuseChild("The seller's remaining daily allowance is too low.");
              // The parent slot, ordinary allowance and ordinary keyed job commit together.
              reserveJobSpend(
                agent,
                job.id,
                microcents(BigInt(view.quote.total!.lamports), rate),
                0n,
                this.p.now(),
                true,
              );
              (childHolds(agent).childHolds ??= {})[job.id] = {
                purchase: view.quote.total!.lamports,
                review: view.reviewReserve.lamports,
                rate,
                funded: false,
              };
              state.jobs[job.id] = {
                ...job,
                ownerApproved: true,
                phase: "cleared",
              };
              state.approvals[approval.id] = {
                ...approval,
                status: "approved",
              };
              r.approvedAt = this.p.now();
              r.view.phase = "dispatching";
              delete r.draft;
            });
          });
        }
        await this.p.advance(view.child.jobId);
      }
      this.p.notify(quoteId);
      return this.timeline(parentTask);
    });
  }
  async timeline(parentTask: string): Promise<ChildHireView> {
    const record = this.#record(parentTask);
    const view = structuredClone(record.view);
    const state = this.p.store.state;
    const job =
      state.jobs[view.child.jobId] ??
      state.callReceipts?.[JSON.stringify([view.sellerAgentId, "hire", view.purchaseKey])];
    if (job) {
      view.child.task = job.hiredAt !== null ? job.task : null;
      view.child.signature = job.signatures.accept ?? job.signatures.cancel ?? job.signatures.hire ?? null;
      view.phase =
        job.hiredAt !== null
          ? view.importReceipt
            ? "imported"
            : "funded"
          : job.phase === "failed"
            ? "failed"
            : "dispatching";
      view.child.status = job.phase === "failed" ? "failed" : job.hiredAt === null ? "starting" : "waiting";
      view.child.action = job.error ?? (view.phase === "dispatching" ? "Check purchase receipt" : null);
    } else if (view.phase === "approval" && view.quote.expiresAt <= this.p.now()) view.phase = "expired";
    const unknown = (s: ChildEscrow): ChildEscrow => ({
      ...s,
      status: "unknown",
      action: "Check receipt",
    });
    const parentWorker = address(record.parentWorker);
    [view.parent, view.child] = await Promise.all([
      parentWorker
        ? escrowStatus(this.p.chain, view.parent, parentWorker, false).catch(() => unknown(view.parent))
        : unknown(view.parent),
      escrowStatus(this.p.chain, view.child, address(view.supplier), true).catch(() => unknown(view.child)),
    ]);
    return view;
  }
  async delivery(grant: ChildRoomGrant): Promise<ChildResult> {
    return this.p.lock("child:" + address(grant.parentTask), async () => {
      const r = this.#record(grant.parentTask);
      if (!sameGrant(r.grant, grant)) refuseChild("This supplier delivery belongs to another room or claim.");
      const parent = await parentClaim(this.p.chain, this.p.services, grant, r.view.payer);
      if (parent.now >= r.view.cutoff) refuseChild("The supplier return cutoff has passed.");
      const job = this.p.store.state.jobs[r.view.child.jobId];
      if (!job?.task || job.hiredAt === null || job.agentId !== grant.sellerAgentId)
        refuseChild("The supplier hire has no confirmed task yet.");
      const data =
        (await this.p.evidence?.(job, r.view.request.outputs)) ?? (await this.#practiceEvidence(job, r.view));
      if (data.round === 0 && r.delivered && r.delivered.hash === data.deliveryHash)
        data.round = r.delivered.round;
      const receipt = childDigest([
        grant.parentTask,
        grant.claimedAt,
        grant.roomId,
        job.task,
        data.round,
        data.deliveryHash,
        childDigest(data.text),
        data.files.map((f) => [f.name, f.bytes, f.sha256]),
      ]);
      if (r.delivered && r.delivered.receipt !== receipt)
        refuseChild("The supplier delivery changed after import was prepared.");
      this.p.store.update((state) => {
        childState(state).childHires![grant.parentTask]!.delivered = {
          receipt,
          hash: data.deliveryHash,
          round: data.round,
        };
      });
      return {
        ...data,
        parentTask: grant.parentTask,
        claimedAt: grant.claimedAt,
        roomId: grant.roomId,
        childTask: job.task,
        purchaseKey: r.view.purchaseKey,
        receipt,
      };
    });
  }
  async #practiceEvidence(job: JobRecord, view: ChildHireView) {
    if (this.p.chain.network !== "sandbox" || view.request.privateCommitment)
      refuseChild("The verified delivery reader is required for this job.");
    const current = () => readSubmission(this.p.chain, address(job.task!), address(view.supplier));
    const sub = await current();
    if (!sub) refuseChild("The supplier has no current delivery.");
    const deliveryHash = Buffer.from(sub.account.proofHash).toString("hex");
    const result = await this.p.services.fetchResult({
      proofHashHex: deliveryHash,
      resultData: Uint8Array.from(sub.account.resultData),
    });
    if (
      !result ||
      result.bytes.length > 262144 ||
      createHash("sha256").update(result.bytes).digest("hex") !== deliveryHash
    )
      refuseChild("The supplier delivery could not be verified.");
    const { text, files: listed } = splitDelivery(
      new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
    );
    if (
      !view.request.outputs.every((name) =>
        name === "text" ? !!text.trim() : listed.some((f) => f.name === name),
      )
    )
      refuseChild("The supplier delivery is missing a required output.");
    const files = await Promise.all(
      listed.map(async (file) => {
        const bytes = await this.p.services.fetchFile(file.sha256);
        if (
          !bytes ||
          bytes.length !== file.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
          deliveryFileProblem(file.name, bytes)
        )
          refuseChild("A supplier file could not be verified.");
        return { ...file, base64: Buffer.from(bytes).toString("base64") };
      }),
    );
    const again = await current();
    if (
      !again ||
      sub.account.submissionCount !== again.account.submissionCount ||
      !Buffer.from(again.account.proofHash).equals(Buffer.from(sub.account.proofHash))
    )
      refuseChild("The supplier submitted a new delivery. Read it again.");
    return { deliveryHash, round: sub.account.submissionCount, text, files };
  }
  async acknowledgeImport(grant: ChildRoomGrant, receipt: string) {
    const r = this.#record(grant.parentTask);
    if (!sameGrant(r.grant, grant) || !r.delivered || r.delivered.receipt !== receipt)
      refuseChild("The room did not import this verified delivery.");
    await parentClaim(this.p.chain, this.p.services, grant, r.view.payer);
    if ((await this.p.chain.clusterTime()) >= r.view.cutoff)
      refuseChild("The supplier return cutoff has passed.");
    this.p.store.update((state) => {
      childState(state).childHires![grant.parentTask]!.view.importReceipt = receipt;
    });
  }
}

/** Use B's payer-scoped reader when present in the installed wallet. */
interface DeliveryReader {
  jobDelivery?: AgencWallet["jobDelivery"];
  jobFile?(jobId: string, sha256: string, agentId: string): ReturnType<AgencWallet["jobFile"]>;
  readDeliveryChunk?(
    jobId: string,
    agentId: string,
    part: string,
    offset: number,
  ): Promise<{
    binding: {
      task: string;
      worker: string;
      round: number;
      deliveryHash: string;
    };
    manifest: string;
    totalBytes: number;
    offset: number;
    base64: string;
  }>;
  requireDeliveryInspection?(jobId: string, agentId: string, hash: string, round: number): Promise<void>;
}
export async function readChildEvidence(wallet: DeliveryReader, job: JobRecord, outputs: string[]) {
  if (!wallet.readDeliveryChunk || !wallet.requireDeliveryInspection || !wallet.jobDelivery || !wallet.jobFile)
    return null;
  const metadata = await wallet.jobDelivery!(job.id, false, job.agentId);
  if (!metadata.verified || !metadata.hash || metadata.textTruncated)
    refuseChild("The supplier delivery has no verified manifest.");
  if (job.outcome === "paid") {
    const files: ChildResult["files"] = [];
    for (const f of metadata.files) {
      const file = await wallet.jobFile!(job.id, f.sha256, job.agentId);
      if (file.sha256 !== f.sha256 || file.bytes !== f.bytes || file.name !== f.name)
        refuseChild("The settled supplier file changed.");
      files.push(file);
    }
    const text = metadata.text ?? "";
    if (!outputs.every((name) => (name === "text" ? !!text.trim() : files.some((f) => f.name === name))))
      refuseChild("The supplier omitted a required output.");
    // The settled commitment is final. Round zero denotes a delivery authenticated from a settlement receipt.
    return { text, files, round: 0, deliveryHash: metadata.hash };
  }
  let manifest: string | undefined;
  let hash = "";
  let round = 0;
  async function read(part: string) {
    const chunks: Buffer[] = [];
    let offset = 0;
    let size: number | undefined;
    do {
      const chunk = await wallet.readDeliveryChunk!(job.id, job.agentId, part, offset);
      const bytes = Buffer.from(chunk.base64, "base64");
      if (
        (manifest !== undefined && manifest !== chunk.manifest) ||
        chunk.binding.task !== job.task ||
        chunk.binding.worker !== job.providerAgent ||
        chunk.offset !== offset ||
        !Number.isSafeInteger(chunk.totalBytes) ||
        chunk.totalBytes < 0 ||
        chunk.totalBytes > 262144 ||
        (size !== undefined && size !== chunk.totalBytes) ||
        offset + bytes.length > chunk.totalBytes ||
        (!bytes.length && offset !== chunk.totalBytes)
      )
        refuseChild("The supplier evidence changed while it was being read.");
      manifest = chunk.manifest;
      round = chunk.binding.round;
      hash = chunk.binding.deliveryHash;
      size = chunk.totalBytes;
      chunks.push(bytes);
      offset += bytes.length;
    } while (offset < size);
    return Buffer.concat(chunks);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await read("text"));
  if (outputs.includes("text") && !text.trim()) refuseChild("The supplier omitted the required text.");
  const files = [];
  const names = new Set([...outputs.filter((s) => s !== "text"), ...metadata.files.map((f) => f.name)]);
  for (const name of names) {
    const bytes = await read(name);
    if (deliveryFileProblem(name, bytes)) refuseChild("The supplier file could not be verified.");
    files.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    });
  }
  if (hash !== metadata.hash) refuseChild("The supplier delivery was replaced.");
  await wallet.requireDeliveryInspection(job.id, job.agentId, hash, round);
  return { text, files, deliveryHash: hash, round };
}

/** Dispatch for D's owner-only socket methods; no method is granted to paired chats. */
export function childHireHandlers(wallet: AgencWallet) {
  type Params<K extends keyof import("./client/child-hire.js").ChildHireMethods> =
    import("./client/child-hire.js").ChildHireMethods[K]["params"];
  return {
    "child.policy": (p: Params<"child.policy">) =>
      wallet.childHires.setPolicy(p.sellerAgentId, p.listing, p.policy),
    "child.request": (p: Params<"child.request">) => wallet.childHires.request(p.grant, p.request),
    "child.timeline": (p: Params<"child.timeline">) => wallet.childHires.timeline(p.parentTask),
    "child.decide": (p: Params<"child.decide">) => wallet.childHires.decide(p.parentTask, p.quoteId, p.approve),
    "child.delivery": async (p: Params<"child.delivery">) => {
      const { text, files, ...binding } = await wallet.childHires.delivery(p.grant);
      return {
        ...binding,
        textBytes: Buffer.byteLength(text),
        files: files.map(({ base64: _, ...file }) => file),
      };
    },
    "child.part": async (p: Params<"child.part">) => {
      const result = await wallet.childHires.delivery(p.grant);
      const file = result.files.find((f) => f.name === p.part);
      const bytes = p.part === "text" ? Buffer.from(result.text) : file && Buffer.from(file.base64, "base64");
      if (
        result.receipt !== p.receipt ||
        !bytes ||
        !Number.isSafeInteger(p.offset) ||
        p.offset < 0 ||
        p.offset > bytes.length
      )
        return refuseChild("The selected supplier part changed.");
      return {
        base64: bytes.subarray(p.offset, p.offset + 24 * 1024).toString("base64"),
        total: bytes.length,
      };
    },
    "child.imported": async (p: Params<"child.imported">) => {
      await wallet.childHires.acknowledgeImport(p.grant, p.receipt);
      return { imported: true as const };
    },
  };
}

/** C calls this before hashing and publishing standard listing metadata, E reads the verified payload. */
export function withChildDependency(
  spec: Record<string, unknown>,
  payer: string,
  input: ChildHirePolicy,
): Record<string, unknown> {
  const policy = checkedChildPolicy(input);
  const custom = spec.custom as { listingMetadata?: Record<string, unknown> } | undefined;
  if (!custom?.listingMetadata) refuseChild("The supplier terms need a service listing.");
  return {
    ...spec,
    custom: {
      ...custom,
      listingMetadata: {
        ...custom.listingMetadata,
        childHire: { version: 1, payingSeller: address(payer), policy },
      },
    },
  };
}
export function readChildDependency(verifiedSpec: Record<string, unknown>, sellerAuthority: string) {
  const value = (
    verifiedSpec.custom as
      | {
          listingMetadata?: {
            childHire?: {
              version: number;
              payingSeller: string;
              policy: ChildHirePolicy;
            };
          };
        }
      | undefined
  )?.listingMetadata?.childHire;
  if (value === undefined) return null;
  if (value?.version !== 1 || value.payingSeller !== sellerAuthority)
    refuseChild("The supplier funding terms do not match the seller.");
  const policy = checkedChildPolicy(value.policy);
  return { policy, criterion: childPolicyCriterion(policy) };
}
