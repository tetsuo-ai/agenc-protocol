// A turned-down job as a person reads it (revision 9), on both sides: the
// buyer, who is refunded unless a ruling pays the provider, and the
// provider, who may dispute with a bond. No chain here.
import { describe, expect, it } from "vitest";
import type { JobRecord } from "../src/store.js";
import { jobView } from "../src/views.js";

const NOW = 1_800_000_000_000;
const NOW_SECS = NOW / 1000;
const context = { usdPerSol: 100, now: NOW, network: "sandbox", isOwner: true, changesCanBeSent: false };

function hire(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    role: "buying",
    kind: "hire",
    agentId: "agt_1",
    createdAt: NOW,
    updatedAt: NOW,
    idempotencyKey: null,
    listing: "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid",
    providerAgent: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
    title: "Haiku Writer",
    request: "A haiku.",
    acceptance: [],
    priceLamports: "2000000",
    expectedVersion: "1",
    listingSpecHashHex: "cd".repeat(32),
    payer: "agent",
    taskIdHex: "00".repeat(32),
    task: "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid",
    jobSpec: {},
    jobSpecHashHex: "ab".repeat(32),
    jobSpecUri: null,
    phase: "active",
    hireAttemptAt: null,
    hiredAt: NOW,
    chainStatus: "reject_frozen",
    deadline: null,
    reviewDeadlineAt: NOW_SECS + 3 * 86_400,
    autoRefundAt: null,
    outcome: null,
    changesRequested: false,
    result: null,
    rating: null,
    tidied: false,
    signatures: {},
    changes: [],
    error: null,
    turnDown: {
      disputable: true,
      disputeUntil: NOW_SECS + 3 * 86_400,
      bondLamports: "10000000",
      rulingUntil: null,
      disputeOpen: true,
    },
    ...patch,
  };
}

const working = (patch: Partial<JobRecord> = {}) =>
  hire({ role: "working", id: "earn_agt_1_7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid", ...patch });

describe("a turned-down job, for the buyer", () => {
  it("says the provider may dispute, and the price comes back if it does not", () => {
    const view = jobView(hire(), context);
    expect(view.status).toBe("in_review");
    expect(view.statusText).toBe(
      "You turned this down. The time to dispute it ends in 3 days. If nobody disputes it, the price comes back then.",
    );
    expect(view.turnDown).toEqual({
      disputable: true,
      disputeEndsAt: (NOW_SECS + 3 * 86_400) * 1000,
      disputed: false,
      bond: { lamports: "10000000", usdCents: 100 },
      ifNobodyActs: "buyer_refunded",
      providerSuspended: false,
    });
    // The buyer never disputes its own turn-down.
    expect(view.canDispute).toBe(false);
  });

  it("reads a turn-down just made as one under the new rule, before its clock is read back", () => {
    // The answer to a turn-down carries its clock; when the read-back failed,
    // the job has no turn-down and no clock yet, and that is never the old rule.
    const { turnDown: _turnDown, ...base } = hire({ reviewDeadlineAt: null });
    const view = jobView(base, context);
    expect(view.status).toBe("in_review");
    expect(view.statusText).toBe(
      "You turned this down. If the provider does not dispute it in time, the price comes back.",
    );
    expect(view.turnDown).toEqual({
      disputable: true,
      disputeEndsAt: null,
      disputed: false,
      bond: null,
      ifNobodyActs: "buyer_refunded",
      providerSuspended: false,
    });
    expect(view.statusText).not.toMatch(/while it is reviewed|is paid/);
  });

  it("says a disputed turn-down is ruled by the reviewers, and the price comes back if nobody rules", () => {
    const view = jobView(
      hire({
        reviewDeadlineAt: NOW_SECS + 2 * 86_400,
        turnDown: {
          disputable: true,
          disputeUntil: NOW_SECS - 86_400,
          bondLamports: "10000000",
          rulingUntil: NOW_SECS + 2 * 86_400,
          disputeOpen: false,
        },
      }),
      context,
    );
    expect(view.statusText).toBe(
      "Your turn-down was disputed. The reviewers' time to rule ends in 2 days. If they rule for you, the price comes back with the bond. If nobody rules, the price comes back.",
    );
    expect(view.turnDown?.disputed).toBe(true);
    expect(view.reviewEndsAt).toBe((NOW_SECS + 2 * 86_400) * 1000);
  });

  it("keeps the old rule for a turn-down made before revision 9", () => {
    const view = jobView(hire({ turnDown: { disputable: false, disputeUntil: NOW_SECS + 3600, bondLamports: "10000000", rulingUntil: null, disputeOpen: false }, reviewDeadlineAt: NOW_SECS + 3600 }), context);
    expect(view.statusText).toBe(
      "You turned this down, so the price is on hold while it is reviewed. If the reviewer agrees with you it comes back. If nobody rules, the provider is paid in about an hour.",
    );
    expect(view.turnDown).toMatchObject({ disputable: false, ifNobodyActs: "provider_paid", bond: null });
  });

  it("states the one-time cost of the buyer's record while a turn-down or cancel is possible", () => {
    const { turnDown: _turnDown, ...base } = hire({ chainStatus: "pending_validation" });
    const delivered: JobRecord = base;
    expect(jobView(delivered, { ...context, firstRecordCostLamports: 1_305_560n }).firstRecordCost).toMatchObject({
      lamports: "1305560",
    });
    expect(jobView(delivered, { ...context, firstRecordCostLamports: 0n }).firstRecordCost).toBeNull();
    expect(jobView(delivered, context).firstRecordCost).toBeNull();
    // Every turn-down goes on the provider's record since revision 9.
    expect(jobView(delivered, context).turnDownRecorded).toBe(true);
  });
});

describe("a turned-down job, for the provider", () => {
  it("offers the person a dispute for the bond, in its window only, and never to an agent", () => {
    const view = jobView(working(), context);
    expect(view.statusText).toBe(
      "The buyer turned this down. You can dispute that for a bond of $1.00. The time to dispute it ends in 3 days. If you do not dispute it, the price goes back to the buyer.",
    );
    expect(view.canDispute).toBe(true);
    expect(jobView(working(), { ...context, isOwner: false }).canDispute).toBe(false);
    // The window is judged by the cluster's clock, read on each look.
    const late = jobView(
      working({
        turnDown: {
          disputable: true,
          disputeUntil: NOW_SECS - 1,
          bondLamports: "10000000",
          rulingUntil: null,
          disputeOpen: false,
        },
      }),
      context,
    );
    expect(late.canDispute).toBe(false);
    expect(late.statusText).toBe(
      "The buyer turned this down and nobody disputed it in time, so the price goes back to the buyer.",
    );
  });

  it("says what each ruling does once the person disputed", () => {
    const view = jobView(
      working({
        reviewDeadlineAt: NOW_SECS + 86_400,
        turnDown: {
          disputable: true,
          disputeUntil: NOW_SECS - 100,
          bondLamports: "10000000",
          rulingUntil: NOW_SECS + 86_400,
          disputeOpen: false,
        },
      }),
      context,
    );
    expect(view.canDispute).toBe(false);
    expect(view.statusText).toBe(
      "You disputed the buyer's turn-down. The reviewers' time to rule ends in 24 hours. If they rule for you, you are paid and your bond comes back. If they rule for the buyer, the buyer gets the bond. If nobody rules, the price goes back to the buyer and your bond comes back.",
    );
  });

  it("says what a refund that is due needs before it can be paid", () => {
    const { turnDown: _turnDown, ...waiting } = hire({
      chainStatus: "open",
      refundBlockedLamports: "1000000",
    });
    expect(jobView(waiting, context).statusText).toBe(
      "This job is due for its refund, which needs $0.10 more: a first cancel starts your marketplace record. Add it and the price comes back.",
    );
    // What to add is rounded up, never down; without a rate it is exact SOL.
    const { turnDown: _other, ...odd } = hire({ chainStatus: "open", refundBlockedLamports: "1000001" });
    expect(jobView(odd, context).statusText).toMatch(/needs \$0\.11 more:/);
    expect(jobView(waiting, { ...context, usdPerSol: null }).statusText).toMatch(/needs 0\.001 SOL more:/);
  });

  it("offers no dispute when the marketplace suspended the provider's agent", () => {
    const suspended = working({
      turnDown: {
        disputable: true,
        disputeUntil: NOW_SECS + 3 * 86_400,
        bondLamports: "10000000",
        rulingUntil: null,
        disputeOpen: true,
        providerSuspended: true,
      },
    });
    const view = jobView(suspended, context);
    expect(view.canDispute).toBe(false);
    expect(view.turnDown?.providerSuspended).toBe(true);
    expect(view.statusText).toBe(
      "The buyer turned this down. The marketplace has suspended your agent, and a suspended agent cannot dispute. When the time to dispute ends in 3 days, the price goes back to the buyer.",
    );
    // Lifted again: the offer is back.
    expect(jobView(working(), context).canDispute).toBe(true);
  });

  it("does not call an unpaid job a cancellation", () => {
    const { turnDown: _turnDown, ...done } = working({ phase: "done", outcome: "refunded", chainStatus: "cancelled" });
    const view = jobView(done, context);
    expect(view.statusText).toBe("This job was not paid. The price went back to the buyer.");
  });
});
