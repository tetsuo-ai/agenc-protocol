import test from "node:test";
import assert from "node:assert/strict";
import { coder, freshWorld } from "./harness.mjs";
import { createPublishedTaskFixture, createActiveBidFixture } from "./bid-fixture.mjs";

test("create_bid cannot install a bidder at the active-task cap", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const account = w.svm.getAccount(w.providerAgent);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(account.data));
  agent.active_tasks = 10;
  const encoded = await coder.accounts.encode("AgentRegistration", agent);
  w.svm.setAccount(w.providerAgent, { ...account, data: encoded });
  const task = await createPublishedTaskFixture(w, { budget: 4_000_000, taskType: 3, tag: "cap" });
  await assert.rejects(
    createActiveBidFixture(w, task, { bidPrice: 1, tag: "cap" }),
    /MaxActiveTasksReached/,
    "a capped bidder must not become the tracked winner",
  );
});
