// A hire that is held up (owner real test 3, bug 7): the provider gave it
// back, or it is still working, and a service at its limit of open jobs.
// Each says what happened and when the price comes back. No chain here.
import { describe, expect, it } from "vitest";
import type { JobRecord } from "../src/store.js";
import { jobView } from "../src/views.js";
import { busyServiceText, hireRefundAt } from "../src/hire-wait-words.js";

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
    chainStatus: "open",
    deadline: null,
    reviewDeadlineAt: null,
    autoRefundAt: null,
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

describe("a held-up hire, for the buyer", () => {
  it("says the provider gave it back and when the price comes back", () => {
    const view = jobView(hire({ providerGaveBack: true, autoRefundAt: NOW + 45 * 60_000, deadline: NOW_SECS + 45 * 60 }), context);
    expect(view.status).toBe("waiting");
    expect(view.statusText).toBe(
      "The provider took this job and gave it back without doing it. The price comes back in 45 minutes, when the job is cancelled. You can cancel it now in Jobs to get it back sooner.",
    );
    expect(view.statusText).not.toMatch(/Waiting for the provider to start/);
    expect(view.canRefund).toBe(true);
  });

  it("still says waiting to start for a hire nobody took", () => {
    const view = jobView(hire({ autoRefundAt: NOW + 45 * 60_000 }), context);
    expect(view.statusText).toBe(
      "Waiting for the provider to start. If nobody does, the job is cancelled and the price comes back in 45 minutes.",
    );
  });

  it("says when the price comes back for a started hire that delivers nothing", () => {
    const view = jobView(hire({ chainStatus: "in_progress", deadline: NOW_SECS + 58 * 60 }), context);
    expect(view.status).toBe("working");
    expect(view.statusText).toBe(
      "The provider is working on it. If nothing is delivered in time, the job is cancelled and the price comes back in about an hour.",
    );
  });

  it("refunds a started hire at its deadline plus the wallet's grace, and an open one at its start window", () => {
    expect(hireRefundAt({ chainStatus: "in_progress", deadline: NOW_SECS, autoRefundAt: null })).toBe(NOW + 120_000);
    expect(hireRefundAt({ chainStatus: "open", deadline: NOW_SECS, autoRefundAt: NOW + 1 })).toBe(NOW + 1);
    expect(hireRefundAt({ chainStatus: "pending_validation", deadline: NOW_SECS, autoRefundAt: null })).toBeNull();
  });
});

describe("a service at its limit of open jobs", () => {
  it("names the buyer's own unfinished hire of it and when it is free at the latest", () => {
    expect(busyServiceText(1, { title: "Sea haiku", refundAt: NOW + 2 * 3_600_000, canCancel: true }, NOW)).toBe(
      "That service takes one job at a time, and your earlier hire of it (Sea haiku) is not finished. It is busy until that job is delivered or cancelled, in 2 hours at the latest. You can cancel that job in Jobs.",
    );
    expect(busyServiceText(1, { title: "Sea haiku", refundAt: null, canCancel: false }, NOW)).toBe(
      "That service takes one job at a time, and your earlier hire of it (Sea haiku) is not finished. It is busy until that job is delivered or cancelled.",
    );
  });

  it("says why it is busy when the jobs are other buyers'", () => {
    expect(busyServiceText(3, null, NOW)).toBe(
      "That service takes 3 jobs at a time and is doing that many now. It takes new jobs again when one is delivered or cancelled. Try again later.",
    );
  });
});
