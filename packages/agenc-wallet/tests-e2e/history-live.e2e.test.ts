// rt13-a bug 4 and rt12-a: Home showed a move of money at once, but an open wallet history
// listed it only after the next housekeeping pass (a worker's setup rows about 60 s late,
// a contest's deposits back still missing two minutes later, with no Lately line).
// A read of the history catches up first, and says so while it cannot.
import { afterEach, expect, it } from "vitest";
import { moneyHandlers } from "../src/money-handlers.js";
import { SOL, startWorld, type World } from "./harness.js";

let w: World;
afterEach(async () => { await w?.wallet.close(); });
const owner = { role: "owner", agentId: null } as const;
const brief = { request: "Enter a poem about rain.", acceptance: ["Use three lines."], reward: { lamports: "90000001" }, contestEntries: 3, reviewWindowSecs: 60 };

it("lists a funding to an agent on the next read, with no housekeeping pass", async () => {
  w = await startWorld();
  const history = moneyHandlers(w.wallet)["wallet.moneyHistory"];
  const agent = await w.wallet.createAgent("Helper");
  await history({}, owner);
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount: { lamports: String(SOL / 10n) } });
  const sent = await w.wallet.confirmTransfer(q.id);
  const page = await history({}, owner);
  expect(page.rows.filter(r => r.signature === sent.signature).map(r => r.kind).sort()).toEqual(["transfer", "transfer"]);
  expect(page.catchingUp).toBe(false);
});

it("lists a contest's deposits back on the next read, with a Lately line that names them the same way", async () => {
  w = await startWorld();
  const { wallet } = w;
  const history = moneyHandlers(wallet)["wallet.moneyHistory"];
  const post = (await wallet.quotePost(brief)).approval!;
  const job = await wallet.decideApproval(post.id, true);
  const refund = (await wallet.refundJob(job.id, true)).contestQuote!;
  await wallet.decideContest(job.id, refund.id, true);
  await history({}, owner);
  const tidy = (await wallet.quoteContest(job.id, { entryId: "", action: "cleanup" })).contestQuote!;
  const before = await w.balance(wallet.mainAddress);
  await wallet.decideContest(job.id, tidy.id, true);
  const back = (await w.balance(wallet.mainAddress)) - before;
  expect(back > 0n).toBe(true);
  const page = await history({}, owner);
  const row = page.rows.find(r => r.account === wallet.mainAddress && r.kind === "rent");
  expect(row?.delta).toBe(String(back));
  expect(page.catchingUp).toBe(false);
  const line = (await wallet.listActivity()).find(a => a.signature === row!.signature);
  expect(line).toMatchObject({ kind: "tidied", text: expect.stringMatching(/^Collected the deposits from /) });
  expect(line!.amount?.lamports).toBe(String(back + BigInt(tidy.networkFee.lamports)));
});

it("says it is still catching up while a move of money this app made is not in it yet", async () => {
  let down = false;
  w = await startWorld({ chain: base => ({ ...base, accountChanges: async (...args) => {
    if (down) throw new Error("history unavailable");
    return base.accountChanges!(...args);
  } }) });
  const history = moneyHandlers(w.wallet)["wallet.moneyHistory"];
  const agent = await w.wallet.createAgent("Helper");
  expect((await history({}, owner)).catchingUp).toBe(false);
  down = true;
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount: { lamports: String(SOL / 10n) } });
  const sent = await w.wallet.confirmTransfer(q.id);
  const behind = await history({}, owner);
  expect(behind.rows.some(r => r.signature === sent.signature)).toBe(false);
  expect(behind.catchingUp).toBe(true);
  down = false;
  const caught = await history({}, owner);
  expect(caught.rows.some(r => r.signature === sent.signature)).toBe(true);
  expect(caught.catchingUp).toBe(false);
});
