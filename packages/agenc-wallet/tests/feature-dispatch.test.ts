import { describe, expect, it, vi } from "vitest";
import { featureRoutes } from "../src/feature-dispatch.js";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { AgencWallet } from "../src/wallet.js";

const owner = { role: "owner" as const, agentId: null };
const agent = { role: "agent" as const, agentId: "agent_1" };
const code = (call: () => unknown) => Promise.resolve().then(call).then(() => "ok", (error: { code?: string }) => error.code);
const routes = (wallet: object = {}) => featureRoutes(wallet as AgencWallet);

describe("feature routes use the feature owners' handlers", () => {
  it("refuses an agent every owner money route before the wallet is reached", async () => {
    const quoteTransfer = vi.fn(async () => ({ id: "q" }));
    const table = routes({ quoteTransfer, pendingTransfers: quoteTransfer, contestRegistrations: quoteTransfer });
    for (const method of ["wallet.transferQuote", "wallet.confirmTransfer", "wallet.pendingTransfers", "wallet.operationOutcome",
      "wallet.moneyHistory", "jobs.publishReview", "jobs.contestRegistrations", "jobs.contestStake", "jobs.retireRegistration"] as const) {
      expect(await code(() => (table[method] as (p: unknown, s: unknown) => Promise<unknown>)({ id: "x", jobId: "j" }, agent)), method).toBe("NOT_ALLOWED");
    }
    expect(quoteTransfer).not.toHaveBeenCalled();
    expect(await table["wallet.transferQuote"]({ kind: "fund", agentId: "agent_1", amount: { usdCents: 5 } }, owner)).toEqual({ id: "q" });
    expect(await code(() => table["wallet.pendingTransfers"]({}, owner))).toBe("ok");
  });

  it("forwards the complete money history query", async () => {
    const moneyHistory = vi.fn(async () => ({ rows: [] }));
    const query = { account: "acct", jobId: "job", before: { account: "acct", signature: "sig" }, limit: 50 };
    await routes({ moneyHistory })["wallet.moneyHistory"](query, owner);
    expect(moneyHistory).toHaveBeenCalledWith(query);
  });

  it("lets a seller read only its own operation", async () => {
    const sellerOperation = vi.fn(async () => ({ state: "done" }));
    const table = routes({ sellerOperation });
    expect(await code(() => table["earn.operation"]({ agentId: "agent_2", quoteId: "q" }, agent))).toBe("NOT_ALLOWED");
    await table["earn.operation"]({ agentId: "agent_1", quoteId: "q" }, agent);
    expect(sellerOperation).toHaveBeenCalledWith("agent_1", "q");
  });

  it("routes listing preferences for the owner only", async () => {
    const setListingInquiries = vi.fn(async () => ({ inquiries: true }));
    const table = routes({ setListingInquiries });
    const params = { agentId: "agent_1", listing: "L".repeat(32), inquiries: true };
    expect(await code(() => table["listings.preferences"](params, agent))).toBe("NOT_ALLOWED");
    expect(await table["listings.preferences"](params, owner)).toEqual({ inquiries: true });
    expect(setListingInquiries).toHaveBeenCalledWith("agent_1", params.listing, true);
    expect(AGENT_METHODS).not.toContain("listings.preferences");
  });

  it("keeps supplier consent and refresh on the owner channel", async () => {
    const childHires = { authorizeShare: vi.fn(async () => "grant"), refresh: vi.fn(async () => ({})) };
    const table = routes({ childHires });
    expect(await code(() => table["child.authorizeShare"]({ jobId: "j", binding: {} as never }, agent))).toBe("NOT_ALLOWED");
    expect(await code(() => table["child.refresh"]({ parentTask: "t", quoteId: "q" }, agent))).toBe("NOT_ALLOWED");
    expect(await table["child.authorizeShare"]({ jobId: "j", binding: {} as never }, owner)).toBe("grant");
    for (const method of ["child.policy", "child.authorizeShare", "child.refresh", "child.decide", "wallet.pendingTransfers", "jobs.contestRegistrations"]) {
      expect(AGENT_METHODS, method).not.toContain(method);
    }
  });

  it("reaches real wallet methods for every money and listing route (no stand-in left)", () => {
    const methods = [
      "quoteTransfer", "confirmTransfer", "pendingTransfers", "operationOutcome", "moneyHistory", "quoteRating",
      "publishOrdinaryReview", "contestRegistrations", "quoteContestRetirement", "retireContestRegistration",
      "sellerOperation", "setListingInquiries", "listingExchange", "postListingMessage",
    ];
    for (const method of methods) {
      expect(typeof (AgencWallet.prototype as unknown as Record<string, unknown>)[method], method).toBe("function");
    }
  });
});

describe("delivery reads and acknowledgements (track B wiring)", () => {
  it("routes owner reads to the owner path and payer reads to the agent's own path", async () => {
    const readOwnerDeliveryChunk = vi.fn(async () => ({ base64: "" }));
    const readDeliveryChunk = vi.fn(async () => ({ base64: "", challenge: "c" }));
    const table = routes({ readOwnerDeliveryChunk, readDeliveryChunk });
    await table["jobs.readDeliveryChunk"]({ jobId: "job_1", part: "text", offset: 0 }, owner);
    expect(readOwnerDeliveryChunk).toHaveBeenCalledWith("job_1", "text", 0);
    await table["jobs.readDeliveryChunk"]({ jobId: "job_1", part: "text", offset: 0 }, agent);
    expect(readDeliveryChunk).toHaveBeenCalledWith("job_1", "agent_1", "text", 0);
  });

  it("lets only the paying agent acknowledge received bytes", async () => {
    const acknowledgeDeliveryChunk = vi.fn(async () => ({ inspected: true }));
    const table = routes({ acknowledgeDeliveryChunk });
    const ack = { manifest: "a".repeat(64), part: "text", offset: 0, proof: "b".repeat(64) };
    expect(await code(() => table["jobs.acknowledgeDeliveryChunk"]({ jobId: "job_1", ack }, owner))).toBe("NOT_ALLOWED");
    expect(await table["jobs.acknowledgeDeliveryChunk"]({ jobId: "job_1", ack }, agent)).toEqual({ inspected: true });
    expect(acknowledgeDeliveryChunk).toHaveBeenCalledWith("job_1", "agent_1", ack);
    expect(AGENT_METHODS).toContain("jobs.acknowledgeDeliveryChunk");
  });
});
