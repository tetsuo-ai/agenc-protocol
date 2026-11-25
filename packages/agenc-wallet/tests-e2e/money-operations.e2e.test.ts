import { generateKeyPairSigner, getBase64EncodedWireTransaction, type Address } from "@solana/kit";
import { getTaskDecoder, getTaskEncoder } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { confirmPayout, REVIEW_ALLOWANCE, SOL, startWorld, type World } from "./harness.js";

let w: World;
afterEach(async () => { await w?.wallet.close(); });

it.each(["before send", "after send"])("persists exact transfer bytes and recovers after restart %s", async when => {
  let interrupt = false, unknown = true;
  const wires: string[] = [];
  w = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    if (!interrupt) return base.sendAndConfirm(tx);
    wires.push(getBase64EncodedWireTransaction(tx));
    if (wires.length === 1) {
      if (when === "after send") await base.sendAndConfirm(tx);
      throw new Error("Disconnected");
    }
    return base.sendAndConfirm(tx);
  } }), chain: chain => ({ ...chain, reviewSendOutcome: r => unknown ? Promise.resolve("pending") : chain.reviewSendOutcome!(r) }) });
  const target = (await generateKeyPairSigner()).address;
  const original = await w.balance(w.wallet.mainAddress);
  const q = await w.wallet.quoteTransfer({ kind: "withdraw", to: target, amount: { lamports: String(SOL) } });
  expect(await w.balance(w.wallet.mainAddress)).toBe(original);
  interrupt = true;
  const pending = await w.wallet.confirmTransfer(q.id);
  expect(pending.state).toBe("pending");
  await w.wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.operationOutcome(q.id))?.signature).toBe(pending.signature);
  expect(wires).toHaveLength(1);
  unknown = false;
  const [a,b] = await Promise.all([w.wallet.confirmTransfer(q.id), w.wallet.confirmTransfer(q.id)]);
  expect(a).toMatchObject({ state: "confirmed", signature: pending.signature });
  expect(b).toEqual(a);
  expect(new Set(wires).size).toBe(1);
  expect(await w.balance(target)).toBe(SOL);
  expect(original - await w.balance(w.wallet.mainAddress)).toBe(BigInt(q.maximumDebit.lamports));
});

it("rechecks all, keeps separate intentional partial transfers, and quotes the exact final credit", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const a = await wallet.createAgent("Writer");
  for (let n = 0; n < 2; n++) {
    const q = await wallet.quoteTransfer({ kind: "fund", agentId: a.id, amount: { lamports: String(SOL) } });
    const pair = await Promise.all([wallet.confirmTransfer(q.id), wallet.confirmTransfer(q.id)]);
    expect(pair[0].signature).toBe(pair[1].signature);
  }
  const request = { kind: "reclaim", agentId: a.id, amount: "all" } as const;
  const stale = await wallet.quoteTransfer(request);
  sandbox.fund(a.address as Address, 1000000n);
  await expect(wallet.confirmTransfer(stale.id)).rejects.toThrow(/figures/);
  const before = await w.balance(wallet.mainAddress);
  const q = await wallet.quoteTransfer(request);
  await wallet.confirmTransfer(q.id);
  expect(await w.balance(wallet.mainAddress) - before).toBe(BigInt(q.credit.lamports));
  expect(await w.balance(a.address)).toBe(BigInt(q.retained.lamports));
});

it("keeps concurrent external deposits during escrow and links refund and rent to their signature", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Reader");
  const hire = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  await wallet.decideApproval(hire.approval!.id, true);
  sandbox.fund(wallet.mainAddress, 7000000n);
  sandbox.fund(wallet.mainAddress, 9000000n);
  await wallet.tick();
  const deposits = wallet.moneyHistory().rows.filter(r => r.kind === "deposit");
  expect(deposits.map(d => d.delta)).toEqual(expect.arrayContaining(["7000000", "9000000"]));
  expect(new Set(deposits.map(d => d.signature)).size).toBe(deposits.length);
  await wallet.close();
  w.wallet = await w.reopen();
  await w.wallet.tick();
  expect(w.wallet.moneyHistory().rows.filter(r => r.kind === "deposit")).toHaveLength(deposits.length);
  w.clock.now += 61 * 60_000;
  sandbox.advanceClock(61 * 60);
  for (let n = 0; n < 4; n++) await w.wallet.tick();
  const rows = w.wallet.moneyHistory(hire.job.id).rows.filter(row => row.account === w.wallet.mainAddress);
  for (const kind of ["refund", "rent"]) {
    const row = rows.find(row => row.kind === kind);
    expect(row?.signature).toBeTruthy();
    expect(BigInt(row!.delta)).toBeGreaterThan(0n);
    expect(await sandbox.chain.accountChange!(w.wallet.mainAddress, row!.signature)).toMatchObject({ delta: row!.delta, payerFee: row!.payerFee });
  }
});

it("binds the original payer, stars and cost, enforces allowance, and reads the landed score", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const a = await wallet.createAgent("Reviewer");
  const main = await wallet.hire({ agentId: a.id, listing: w.listing, request: "A main-funded poem." });
  await wallet.decideApproval(main.approval!.id, true);
  await sandbox.workOnce();
  await confirmPayout(wallet, main.job.id);
  await expect(wallet.quoteRating(main.job.id, 3, false, a.id)).rejects.toThrow();
  const paid = await wallet.getJob(main.job.id, true);
  expect(paid).toMatchObject({ reputation: { before: expect.any(Number), after: expect.any(Number), signature: expect.any(String) } });
  const q = await wallet.quoteRating(main.job.id, 3, true);
  await expect(wallet.rateJob(main.job.id, 3, false, a.id, q.id)).rejects.toThrow();
  await expect(wallet.rateJob(main.job.id, 4, true, undefined, q.id)).rejects.toThrow();
  const conflict = await wallet.quoteRating(main.job.id, 1, true);
  const spentBefore = BigInt((await wallet.overview()).agents.find(x => x.id === a.id)!.spent.lamports);
  expect((await wallet.rateJob(main.job.id, 3, true, undefined, q.id)).rating).toBe(3);
  const after = await w.balance(wallet.mainAddress);
  expect((await wallet.rateJob(main.job.id, 1, true, undefined, conflict.id)).rating).toBe(3);
  expect(await w.balance(wallet.mainAddress)).toBe(after);
  // rt5 A 2: the stars' debit is spent on the job, once, and Lately says so.
  const spentAfter = BigInt((await wallet.overview()).agents.find(x => x.id === a.id)!.spent.lamports);
  expect(spentAfter - spentBefore).toBe(BigInt(q.maximumDebit.lamports));
  const notes = (await wallet.listActivity()).filter(entry => entry.text.startsWith("Paid for the stars on"));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.amount?.lamports).toBe(q.maximumDebit.lamports);

  await wallet.setPolicy(a.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(a.id, { lamports: String(SOL) });
  const own = await wallet.hire({ agentId: a.id, listing: w.listing, request: "An agent-funded poem." });
  await sandbox.workOnce();
  await confirmPayout(wallet, own.job.id);
  const agentQ = await wallet.quoteRating(own.job.id, 5, false, a.id);
  await wallet.setBudget(a.id, 0);
  const balance = await w.balance(a.address);
  await expect(wallet.rateJob(own.job.id, 5, false, a.id, agentQ.id)).rejects.toThrow(/allowance/);
  expect(await w.balance(a.address)).toBe(balance);
});

it("lets the owner confirm stars on an agent-paid hire when the agent asks every time, within its daily cap", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const a = await wallet.createAgent("Asker");
  await wallet.setPolicy(a.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(a.id, { lamports: String(SOL) });
  const own = await wallet.hire({ agentId: a.id, listing: w.listing, request: "An agent-funded poem." });
  await sandbox.workOnce();
  await confirmPayout(wallet, own.job.id);
  // "Asks you every time": the agent may not spend on its own, but the owner's yes to the exact quote may.
  await wallet.setPolicy(a.id, { askAboveCents: 0, refill: REVIEW_ALLOWANCE });
  const agentQ = await wallet.quoteRating(own.job.id, 4, false, a.id);
  await expect(wallet.rateJob(own.job.id, 4, false, a.id, agentQ.id)).rejects.toThrow(/allowance/);
  const ownerQ = await wallet.quoteRating(own.job.id, 4, true);
  const before = await w.balance(a.address);
  expect((await wallet.rateJob(own.job.id, 4, true, undefined, ownerQ.id)).rating).toBe(4);
  expect(before - await w.balance(a.address)).toBe(BigInt(ownerQ.maximumDebit.lamports));
});

it("still holds an owner-confirmed agent-paid rating to the agent's daily cap", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const a = await wallet.createAgent("Capped");
  await wallet.setPolicy(a.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(a.id, { lamports: String(SOL) });
  const own = await wallet.hire({ agentId: a.id, listing: w.listing, request: "An agent-funded poem." });
  await sandbox.workOnce();
  await confirmPayout(wallet, own.job.id);
  const ownerQ = await wallet.quoteRating(own.job.id, 4, true);
  await wallet.setBudget(a.id, 0);
  const before = await w.balance(a.address);
  await expect(wallet.rateJob(own.job.id, 4, true, undefined, ownerQ.id)).rejects.toThrow(/allowance/);
  expect(await w.balance(a.address)).toBe(before);
});

it("refuses retirement until the main-funded contest ends, then verifies the landed credit", async () => {
  w = await startWorld();
  const { wallet, sandbox } = w;
  const q = await wallet.quotePost({ request: "A poem.", reward: { lamports: "90000001" }, contestEntries: 2,
    reviewWindowSecs: 60, deadline: await sandbox.chain.clusterTime() + 900 });
  const job = await wallet.decideApproval(q.approval!.id, true);
  const blocked = await wallet.quoteContestRetirement(job.id);
  expect(blocked.obligations).toContain(job.id);
  await expect(wallet.retireContestRegistration(blocked.id)).rejects.toThrow(/obligations/);
  sandbox.advanceClock(901);
  const refund = await wallet.refundJob(job.id, true);
  await wallet.decideContest(job.id, refund.contestQuote!.id, true);
  await wallet.tick();
  const eligible = await wallet.quoteContestRetirement(job.id);
  expect(eligible.obligations).toEqual([]);
  const before = await w.balance(wallet.mainAddress);
  const outcome = await wallet.retireContestRegistration(eligible.id);
  expect(outcome).toMatchObject({ state: "confirmed", actualCreditLamports: eligible.credit.lamports });
  expect(await w.balance(wallet.mainAddress) - before).toBe(BigInt(eligible.netCredit.lamports));
  expect((await wallet.retireContestRegistration(eligible.id)).signature).toBe(outcome.signature);
});

it("recovers a dropped purchase reply by ID with the original listing, payer and signature", async () => {
  w = await startWorld();
  const a = await w.wallet.createAgent("Buyer");
  await w.wallet.setPolicy(a.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  await w.wallet.fundAgent(a.id, { lamports: String(SOL) });
  const request = { agentId: a.id, listing: w.listing, request: "A short poem.", idempotencyKey: "purchase-one" };
  const [one, duplicate] = await Promise.all([w.wallet.hire(request), w.wallet.hire(request)]);
  expect(one.job.id).toBe(duplicate.job.id);
  const after = await w.balance(a.address);
  await w.wallet.close();
  w.wallet = await w.reopen();
  const recovered = await w.wallet.callOutcome(a.id, "hire", request.idempotencyKey);
  expect(recovered.receipt).toMatchObject({ jobId: one.job.id, operationId: "purchase-one", listing: w.listing,
    payer: a.address, signatures: { hire: expect.any(String) } });
  await expect(w.wallet.hire({ ...request, request: "Different order." })).rejects.toThrow(/terms/);
  expect(await w.balance(a.address)).toBe(after);
  const second = await w.wallet.hire({ ...request, idempotencyKey: "purchase-two" });
  expect(second.job.id).not.toBe(one.job.id);
  expect(await w.balance(a.address)).toBeLessThan(after);
});

it("signs an ordinary review for its verified worker, reusing the same signed document after a lost relay reply", async () => {
  const packets: string[] = [];
  w = await startWorld({ config: { reviewRelay: async (_url, init) => {
    packets.push(String(init?.body));
    if (packets.length === 1) throw new Error("Lost reply");
    return Response.json({ verified: true });
  } } });
  const { wallet, sandbox } = w;
  const q = await wallet.quotePost({ request: "Write a poem.", reward: { lamports: "20000000" } });
  const job = await wallet.decideApproval(q.approval!.id, true);
  expect(await sandbox.workOnce()).toBe(1);
  expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
  await confirmPayout(wallet, job.id);
  await expect(wallet.publishOrdinaryReview(job.id, 4, "Clear and concise.")).rejects.toThrow(/Lost/);
  await wallet.close();
  w.wallet = await w.reopen();
  const result = await w.wallet.publishOrdinaryReview(job.id, 4, "Clear and concise.");
  expect(packets[0]).toBe(packets[1]);
  expect(result.review).toMatchObject({ task: job.task, creator: w.wallet.mainAddress, worker: expect.any(String), settlement: expect.any(String) });
});

it("identifies the funded listing, terms and signature after restarting the seller wallet", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 150 } });
  const seller = await w.wallet.createAgent("Seller");
  const input = { name: "Editing", summary: "Line edits", price: { lamports: "3000999" } };
  const q = await w.wallet.quoteEarn(seller.id, input);
  await w.wallet.setOffer(seller.id, input, undefined, q.quoteId);
  const first = w.wallet.sellerOperation(seller.id, q.quoteId)!;
  expect(first).toMatchObject({ state: "confirmed", seller: seller.address, priceLamports: "3000999", fundedLamports: q.fromMain.lamports,
    fundingSignature: expect.any(String), listingId: expect.stringMatching(/^[a-f0-9]{64}$/), network: "sandbox" });
  await w.wallet.close();
  w.wallet = await w.reopen();
  expect(w.wallet.sellerOperation(seller.id, q.quoteId)).toMatchObject({ quoteId: q.quoteId, terms: first.terms, listingId: first.listingId,
    fundingSignature: first.fundingSignature });
  expect(w.wallet.sellerOperation(seller.id, "different")).toBeNull();
  await w.wallet.close();
  w.wallet = await w.reopen({ chain: { ...w.sandbox.chain, network: "localnet" } });
  expect(() => w.wallet.sellerOperation(seller.id, q.quoteId)).toThrow(/different network/);
});

it("refuses a paid hire whose on-chain protocol fee does not qualify", async () => {
  let disqualified: string | undefined;
  w = await startWorld({ chain: chain => ({ ...chain, async readAccountInfo(account) {
    const row = await chain.readAccountInfo(account);
    if (!row || account !== disqualified) return row;
    const task = getTaskDecoder().decode(row.data);
    const reserved = Uint8Array.from(task.reserved);
    reserved[12] = 0;
    return { ...row, data: Uint8Array.from(getTaskEncoder().encode({ ...task, reserved })) };
  } }) });
  const buyer = await w.wallet.createAgent("Buyer");
  const { approval, job } = await w.wallet.hire({ agentId: buyer.id, listing: w.listing, request: "One poem." });
  const funded = await w.wallet.decideApproval(approval!.id, true);
  await w.sandbox.workOnce();
  await confirmPayout(w.wallet, job.id);
  const quote = await w.wallet.quoteRating(job.id, 3, true);
  disqualified = funded.task!;
  const before = await w.balance(w.wallet.mainAddress);
  await expect(w.wallet.rateJob(job.id, 3, true, undefined, quote.id)).rejects.toThrow(/qualify/);
  await expect(w.wallet.quoteRating(job.id, 4, true)).rejects.toThrow(/qualify/);
  expect(await w.balance(w.wallet.mainAddress)).toBe(before);
});

it("keeps an expired signature with missing history reserved and rejects chat transfers", async () => {
  let lost = false, sends = 0;
  w = await startWorld({
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      if (lost) { sends++; throw new Error("Transport closed"); }
      return base.sendAndConfirm(tx);
    } }),
    chain: base => ({ ...base, operationBlockhashValid: async () => false, reviewSendOutcome: async () => "expired" }),
  });
  const { moneyHandlers } = await import("../src/money-handlers.js");
  const owner = { role: "owner", agentId: null } as const;
  const agent = { role: "agent", agentId: (await w.wallet.createAgent("Observer")).id } as const;
  const methods = moneyHandlers(w.wallet);
  const request = { kind: "withdraw", to: (await generateKeyPairSigner()).address, amount: { lamports: String(SOL) } } as const;
  await expect(methods["wallet.transferQuote"](request, agent)).rejects.toThrow(/owner/);
  const quote = await methods["wallet.transferQuote"](request, owner);
  await expect(methods["wallet.confirmTransfer"]({ id: quote.id }, agent)).rejects.toThrow(/owner/);
  lost = true;
  const pending = await methods["wallet.confirmTransfer"]({ id: quote.id }, owner);
  expect(pending.state).toBe("pending");
  w.clock.now += 86400_000;
  await w.wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.confirmTransfer(quote.id)).signature).toBe(pending.signature);
  await expect(w.wallet.quoteTransfer(request)).rejects.toThrow(/awaiting confirmation/);
  expect(sends).toBe(1);
  expect(await w.balance(request.to)).toBe(0n);
});

it("holds the main balance for an unresolved seller debit, including a different recipient", async () => {
  let loseReply = false, uncertain = false;
  w = await startWorld({
    earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
      mode: "sandboxed", envAllowlist: [], timeoutMs: 10000 } },
    transport: base => ({ ...base, async sendAndConfirm(tx) {
      const answer = await base.sendAndConfirm(tx);
      if (loseReply) { loseReply = false; throw Error("Reply lost"); }
      return answer;
    } }),
    chain: base => ({ ...base, listingSendOutcome: r => uncertain ? Promise.resolve("pending") : base.listingSendOutcome!(r) }),
  });
  const seller = await w.wallet.createAgent("Seller");
  const other = await w.wallet.createAgent("Other agent");
  const offer = { name: "Index", summary: "Make an index", price: { usdCents: 15 }, setupId: "seller-index" };
  const quote = await w.wallet.quoteEarn(seller.id, offer);
  loseReply = uncertain = true;
  await expect(w.wallet.setOffer(seller.id, offer, undefined, quote.quoteId)).rejects.toThrow();
  expect(w.wallet.sellerOperation(seller.id, quote.quoteId)?.state).toBe("pending");
  const request = { kind: "fund", agentId: other.id, amount: { lamports: String(SOL) } } as const;
  const before = await w.balance(w.wallet.mainAddress);
  await expect(w.wallet.quoteTransfer(request)).rejects.toThrow(/awaiting confirmation/);
  uncertain = false;
  await w.wallet.quoteTransfer(request);
  expect(w.wallet.sellerOperation(seller.id, quote.quoteId)?.state).toBe("confirmed");
  expect(await w.balance(w.wallet.mainAddress)).toBe(before);
});
