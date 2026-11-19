// A posted request as a person reads it: its title, its sentences, what can
// be done with it. No chain here.
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, JobRecord } from "../src/store.js";
import { approvalView, jobView } from "../src/views.js";
import { requestTitle } from "../src/wallet.js";

const NOW = 1_800_000_000_000;
const context = { usdPerSol: 100, now: NOW, network: "sandbox", isOwner: true, changesCanBeSent: false };

function request(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    role: "buying",
    kind: "request",
    agentId: "",
    createdAt: NOW,
    updatedAt: NOW,
    idempotencyKey: null,
    listing: "",
    providerAgent: "",
    title: "Write a haiku about a lighthouse",
    request: "Write a haiku about a lighthouse.",
    acceptance: [],
    priceLamports: "3000000",
    expectedVersion: "0",
    listingSpecHashHex: "",
    payer: "main",
    taskIdHex: "00".repeat(32),
    task: "7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid",
    jobSpec: {},
    jobSpecHashHex: "ab".repeat(32),
    jobSpecUri: null,
    phase: "active",
    hireAttemptAt: null,
    hiredAt: NOW,
    chainStatus: "open",
    deadline: null,
    reviewDeadlineAt: null,
    autoRefundAt: NOW + 7 * 86_400_000,
    outcome: null,
    changesRequested: false,
    result: null,
    rating: null,
    tidied: false,
    signatures: {},
    changes: [],
    error: null,
    ...patch,
  };
}

describe("a request's title", () => {
  it("is its first sentence, without the mark that ends it", () => {
    expect(requestTitle("Write a haiku about a lighthouse.")).toBe("Write a haiku about a lighthouse");
    expect(requestTitle("Can you name my cat? She is grey.")).toBe("Can you name my cat");
    expect(requestTitle("\n\n  A logo for my shop!\nRed and gold.")).toBe("A logo for my shop");
    // A full stop inside a word does not end the sentence.
    expect(requestTitle("Read notes.txt and sum it up.")).toBe("Read notes.txt and sum it up");
  });

  it("is short, and never empty", () => {
    const long = requestTitle(`Translate ${"this long sentence ".repeat(20)}into French`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(requestTitle("...")).toBe("Request");
    expect(requestTitle("   ")).toBe("Request");
  });

  it("takes no longer for text made to be slow", () => {
    const started = performance.now();
    requestTitle(`${" ".repeat(3_998)}x.`);
    requestTitle(`${".".repeat(4_000)}`);
    requestTitle(`a${" .".repeat(2_000)}`);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("a request in Jobs", () => {
  it("says what is happening in its own words", () => {
    expect(jobView(request(), context).statusText).toBe(
      "Waiting for someone to take it. If nobody does, it is cancelled and the reward comes back in 7 days.",
    );
    expect(jobView(request({ phase: "hiring" }), context).statusText).toBe("Posting the request.");
    expect(jobView(request({ chainStatus: "in_progress" }), context).statusText).toBe(
      "Someone took it and is working on it.",
    );
    expect(
      jobView(request({ chainStatus: "pending_validation", reviewDeadlineAt: NOW / 1000 + 86_400 }), context).statusText,
    ).toBe("Delivered. Approve it to pay $0.30. If nobody reviews it, it is paid in 24 hours.");
    expect(jobView(request({ chainStatus: "reject_frozen" }), context).statusText).toBe(
      "You turned this down, so the reward is on hold while it is reviewed.",
    );
    expect(jobView(request({ phase: "done", outcome: "paid" }), context).statusText).toBe("Done. $0.30 was paid for it.");
    expect(jobView(request({ phase: "done", outcome: "refunded" }), context).statusText).toBe(
      "Cancelled. The reward came back.",
    );
  });

  it("is a request, has no service, and cannot be rated", () => {
    const paid = jobView(request({ phase: "done", outcome: "paid" }), { ...context, ratingCostLamports: 2_880_360n });
    expect(paid).toMatchObject({ kind: "request", listing: null, provider: null, canRate: false, ratingCost: null });
    // Before anyone takes it, it can be cancelled, by the person or by the agent that posted it.
    expect(jobView(request(), context).canRefund).toBe(true);
    expect(jobView(request(), { ...context, isOwner: false }).canRefund).toBe(true);
    // A delivery is the person's to turn down, not the agent's.
    const delivered = request({ chainStatus: "pending_validation", providerAgent: "Agent1111111111111111111111111111111111111" });
    expect(jobView(delivered, context)).toMatchObject({ canApprove: true, canRefund: true });
    expect(jobView(delivered, { ...context, isOwner: false })).toMatchObject({ canApprove: true, canRefund: false });
  });

  it("reads an older journal's job, which has no kind, as a hire", () => {
    const old = request({ listing: "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE", title: "Haiku Writer" });
    delete old.kind;
    expect(jobView(old, context)).toMatchObject({ kind: "hire" });
    expect(jobView(old, context).statusText).toMatch(/^Waiting for the provider to start\./);
  });
});

describe("a request waiting for a person's yes", () => {
  const record: ApprovalRecord = {
    id: "ok_1",
    jobId: "job_1",
    agentId: "agent_1",
    kind: "request",
    service: null,
    request: "A sonnet about rain.",
    priceLamports: "60000000",
    depositsLamports: "14718560",
    keptLamports: "8010960",
    fromMainLamports: "74718560",
    createdAt: NOW,
    expiresAt: NOW + 1_800_000,
    status: "pending",
  };

  it("names no service and carries the whole cost", () => {
    const view = approvalView(record, "My assistant", 100);
    expect(view).toMatchObject({ kind: "request", service: null, agentName: "My assistant", request: "A sonnet about rain." });
    expect(view.price.usdCents).toBe(600);
    expect(view.fees.usdCents).toBeCloseTo(80.11, 2);
    expect(view.deposits.usdCents).toBeCloseTo(147.19, 2);
  });

  it("reads an older journal's approval, which has no kind, as a hire", () => {
    const { kind: _kind, ...old } = record;
    const hire = approvalView(
      {
        ...old,
        service: {
          listing: "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE",
          name: "Haiku Writer",
          summary: null,
          category: null,
          price: { lamports: "2000000", usdCents: 20 },
          rating: null,
          ratingCount: 0,
          jobsDone: 0,
          provider: "Agent1111111111111111111111111111111111111",
          deliverySecs: null,
        } as never,
      },
      "My assistant",
      100,
    );
    expect(hire.kind).toBe("hire");
    expect(hire.service).toMatchObject({ name: "Haiku Writer", details: "unavailable", tags: [] });
  });
});
