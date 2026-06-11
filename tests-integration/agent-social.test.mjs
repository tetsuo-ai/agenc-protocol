// In-process litesvm integration tests for the agent-social instructions of
// agenc-coordination: update_agent, deregister_agent, suspend_agent,
// unsuspend_agent, post_to_feed, upvote_post.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
// Mirrors the style of marketplace.test.mjs and reuses the shared harness.
//
// Run:  cd .. && node --test tests-integration/agent-social.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld,
  BN, Keypair, PublicKey, SystemProgram, FailedTransactionMetadata,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Local helpers (not exported from the harness).
// ---------------------------------------------------------------------------

// Set an AgentRegistration's `reputation` in place (no real reputation flow
// needed for tests). Feed posting requires reputation >= 5500 and upvoting
// >= 5200, but new agents start at the neutral 5000 — so we bump it directly,
// the same pattern injectAgentStake uses for `stake`.
async function setAgentReputation(svm, agentPda, reputation) {
  const acct = svm.getAccount(agentPda);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  agent.reputation = reputation;
  const data = await coder.accounts.encode("AgentRegistration", agent);
  svm.setAccount(agentPda, {
    lamports: Number(acct.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

// Advance the litesvm clock by `secs` seconds.
function warp(svm, secs) {
  const c = svm.getClock();
  c.unixTimestamp = c.unixTimestamp + BigInt(secs);
  svm.setClock(c);
}

// Register a brand-new agent (real instruction) controlled by a fresh keypair.
// Returns { kp, prog, agentPda, agentId }. The protocol config injected by
// freshWorld is reused; min_agent_stake is 0 so no stake is required.
async function registerAgent(w, { capabilities = 1, endpoint = "http://extra.test" } = {}) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(agentId), new BN(capabilities), endpoint, null, new BN(0))
        .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [kp],
    ),
    "register extra agent",
  );
  return { kp, prog, agentPda, agentId };
}

// ---------------------------------------------------------------------------
// update_agent
// ---------------------------------------------------------------------------

test("update_agent: owner edits capabilities + endpoint + status (state changes)", async () => {
  const w = await freshWorld({});
  // The freshWorld provider agent was just registered with capabilities=1 and
  // last_state_update=0; clock is ~1.7e9 so the 60s cooldown is satisfied.
  const before = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(before.capabilities.toString(), "1", "starts with capabilities=1");
  assert.ok(before.status.Active !== undefined, "starts Active");

  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .updateAgent(new BN(7), "http://provider.updated", "ipfs://meta", 0 /* Inactive */)
        .accounts({ agent: w.providerAgent, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "update agent",
  );

  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(after.capabilities.toString(), "7", "capabilities updated to 7");
  assert.equal(after.endpoint, "http://provider.updated", "endpoint updated");
  assert.equal(after.metadata_uri, "ipfs://meta", "metadata_uri updated");
  assert.ok(after.status.Inactive !== undefined, "status set to Inactive");
  assert.ok(after.last_state_update > 0, "last_state_update advanced");
});

test("update_agent: a non-authority cannot update the agent (UnauthorizedAgent)", async () => {
  const w = await freshWorld({});
  // The buyer signs but the agent's has_one authority is the provider.
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .updateAgent(new BN(2), null, null, null)
        .accounts({ agent: w.providerAgent, authority: w.buyer.publicKey })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority update",
  );
});

test("update_agent: a second update inside the cooldown is rejected (UpdateTooFrequent)", async () => {
  const w = await freshWorld({});
  // First update sets last_state_update = now.
  expectOk(
    send(
      w.svm,
      await w.providerProg.methods
        .updateAgent(new BN(3), null, null, null)
        .accounts({ agent: w.providerAgent, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "first update",
  );
  // Immediate second update (clock not advanced) trips the 60s cooldown.
  w.svm.expireBlockhash(); // avoid byte-identical dedupe (args differ anyway, but be safe)
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .updateAgent(new BN(4), null, null, null)
        .accounts({ agent: w.providerAgent, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "UpdateTooFrequent",
    "second update inside cooldown",
  );
});

// ---------------------------------------------------------------------------
// deregister_agent
// ---------------------------------------------------------------------------

test("deregister_agent: closes the agent PDA and decrements total_agents", async () => {
  const w = await freshWorld({});
  const a = await registerAgent(w);
  const totalBefore = decode(w.svm, "ProtocolConfig", w.protocolPda).total_agents.toString();

  const authBalBefore = Number(w.svm.getBalance(a.kp.publicKey));
  expectOk(
    send(
      w.svm,
      await a.prog.methods
        .deregisterAgent()
        .accounts({ agent: a.agentPda, protocolConfig: w.protocolPda, authority: a.kp.publicKey })
        .instruction(),
      [a.kp],
    ),
    "deregister agent",
  );

  assert.ok(isClosed(w.svm, a.agentPda), "agent PDA closed");
  assert.ok(Number(w.svm.getBalance(a.kp.publicKey)) > authBalBefore, "rent refunded to authority");
  const totalAfter = decode(w.svm, "ProtocolConfig", w.protocolPda).total_agents.toString();
  assert.equal(Number(totalAfter), Number(totalBefore) - 1, "total_agents decremented");
});

test("deregister_agent: a non-authority cannot deregister (UnauthorizedAgent)", async () => {
  const w = await freshWorld({});
  const a = await registerAgent(w);
  // The buyer signs but is not the agent's authority.
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .deregisterAgent()
        .accounts({ agent: a.agentPda, protocolConfig: w.protocolPda, authority: w.buyer.publicKey })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority deregister",
  );
  assert.ok(!isClosed(w.svm, a.agentPda), "agent PDA still open after rejected deregister");
});

// ---------------------------------------------------------------------------
// suspend_agent  (protocol authority only)
// ---------------------------------------------------------------------------

test("suspend_agent: protocol authority suspends an agent (status -> Suspended)", async () => {
  const w = await freshWorld({});
  const adminProg = makeProgram(w.admin);
  expectOk(
    send(
      w.svm,
      await adminProg.methods
        .suspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "suspend agent",
  );
  const agent = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.ok(agent.status.Suspended !== undefined, "status is Suspended");
});

test("suspend_agent: a non-protocol-authority cannot suspend (UnauthorizedUpgrade)", async () => {
  const w = await freshWorld({});
  // The provider owns the agent but is NOT the protocol authority (admin is).
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .suspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "UnauthorizedUpgrade",
    "non-authority suspend",
  );
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Active !== undefined, "still Active");
});

test("suspend_agent: suspending an already-suspended agent is rejected (AgentSuspended)", async () => {
  const w = await freshWorld({});
  const adminProg = makeProgram(w.admin);
  const suspendIx = async () =>
    adminProg.methods
      .suspendAgent()
      .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
      .instruction();
  expectOk(send(w.svm, await suspendIx(), [w.admin]), "first suspend");
  w.svm.expireBlockhash(); // identical second tx would be deduped
  expectFail(send(w.svm, await suspendIx(), [w.admin]), "AgentSuspended", "double suspend");
});

// ---------------------------------------------------------------------------
// unsuspend_agent  (protocol authority only)
// ---------------------------------------------------------------------------

test("unsuspend_agent: protocol authority restores a suspended agent to Inactive", async () => {
  const w = await freshWorld({});
  const adminProg = makeProgram(w.admin);
  expectOk(
    send(
      w.svm,
      await adminProg.methods
        .suspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "suspend before unsuspend",
  );
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Suspended !== undefined, "is Suspended");

  expectOk(
    send(
      w.svm,
      await adminProg.methods
        .unsuspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "unsuspend agent",
  );
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Inactive !== undefined, "restored to Inactive");
});

test("unsuspend_agent: unsuspending a non-suspended agent is rejected (InvalidInput)", async () => {
  const w = await freshWorld({});
  const adminProg = makeProgram(w.admin);
  // Agent is Active (never suspended) -> handler requires status == Suspended.
  expectFail(
    send(
      w.svm,
      await adminProg.methods
        .unsuspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "InvalidInput",
    "unsuspend non-suspended agent",
  );
});

test("unsuspend_agent: a non-protocol-authority cannot unsuspend (UnauthorizedUpgrade)", async () => {
  const w = await freshWorld({});
  const adminProg = makeProgram(w.admin);
  expectOk(
    send(
      w.svm,
      await adminProg.methods
        .suspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "suspend agent",
  );
  // The provider (agent owner, not protocol authority) cannot unsuspend.
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .unsuspendAgent()
        .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
        .instruction(),
      [w.provider],
    ),
    "UnauthorizedUpgrade",
    "non-authority unsuspend",
  );
  assert.ok(decode(w.svm, "AgentRegistration", w.providerAgent).status.Suspended !== undefined, "still Suspended");
});

// ---------------------------------------------------------------------------
// post_to_feed
// ---------------------------------------------------------------------------

// Build a post_to_feed instruction for the freshWorld provider agent. The agent
// must be Active, have reputation >= 5500 and account age >= 3600s.
async function buildPost(w, { contentHash, nonce, topic, parentPost = null } = {}) {
  const ch = contentHash ?? crypto.randomBytes(32);
  const nn = nonce ?? crypto.randomBytes(32);
  const tp = topic ?? Buffer.alloc(32, 9);
  const [post] = pda([enc("post"), w.providerAgent.toBuffer(), Buffer.from(nn)]);
  const ix = await w.providerProg.methods
    .postToFeed(arr(ch), arr(nn), arr(tp), parentPost)
    .accounts({ post, author: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return { ix, post, contentHash: ch, nonce: nn, topic: tp };
}

test("post_to_feed: an eligible Active agent creates a FeedPost PDA", async () => {
  const w = await freshWorld({});
  await setAgentReputation(w.svm, w.providerAgent, 5500); // meets MIN_FEED_POST_REPUTATION
  warp(w.svm, 3600); // satisfy MIN_FEED_POST_ACCOUNT_AGE_SECS

  const { ix, post, contentHash, topic } = await buildPost(w);
  expectOk(send(w.svm, ix, [w.provider]), "post to feed");

  const fp = decode(w.svm, "FeedPost", post);
  assert.equal(fp.author.toBase58(), w.providerAgent.toBase58(), "author == provider agent");
  assert.equal(Buffer.from(fp.content_hash).toString("hex"), Buffer.from(contentHash).toString("hex"), "content_hash stored");
  assert.equal(Buffer.from(fp.topic).toString("hex"), Buffer.from(topic).toString("hex"), "topic stored");
  assert.equal(fp.upvote_count, 0, "new post has 0 upvotes");
  assert.equal(fp.parent_post, null, "no parent");
  assert.ok(fp.created_at > 0, "created_at set");
});

test("post_to_feed: insufficient reputation is rejected (InsufficientReputation)", async () => {
  const w = await freshWorld({});
  // Fresh probationary reputation is 3000 (P6.7), still < the 5500 feed-post floor. Warp
  // age so reputation is the only failing gate.
  warp(w.svm, 3600);
  const { ix } = await buildPost(w);
  expectFail(send(w.svm, ix, [w.provider]), "InsufficientReputation", "post below reputation floor");
});

test("post_to_feed: a non-authority for the author agent is rejected (UnauthorizedAgent)", async () => {
  const w = await freshWorld({});
  await setAgentReputation(w.svm, w.providerAgent, 5500);
  warp(w.svm, 3600);
  // The buyer signs and pays, but the author agent's authority is the provider.
  const nonce = crypto.randomBytes(32);
  const [post] = pda([enc("post"), w.providerAgent.toBuffer(), Buffer.from(nonce)]);
  expectFail(
    send(
      w.svm,
      await w.buyerProg.methods
        .postToFeed(arr(crypto.randomBytes(32)), arr(nonce), arr(Buffer.alloc(32, 9)), null)
        .accounts({ post, author: w.providerAgent, protocolConfig: w.protocolPda, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority post",
  );
});

test("post_to_feed: a zero content hash is rejected (FeedInvalidContentHash)", async () => {
  const w = await freshWorld({});
  await setAgentReputation(w.svm, w.providerAgent, 5500);
  warp(w.svm, 3600);
  const { ix } = await buildPost(w, { contentHash: Buffer.alloc(32, 0) });
  expectFail(send(w.svm, ix, [w.provider]), "FeedInvalidContentHash", "zero content hash");
});

// ---------------------------------------------------------------------------
// upvote_post
// ---------------------------------------------------------------------------

// Create an eligible feed post (by the provider agent) and return its handles.
async function seedPost(w) {
  await setAgentReputation(w.svm, w.providerAgent, 5500);
  warp(w.svm, 3600);
  const { ix, post, nonce } = await buildPost(w);
  expectOk(send(w.svm, ix, [w.provider]), "seed feed post");
  return { post, nonce };
}

test("upvote_post: a second agent upvotes (count -> 1, FeedVote recorded)", async () => {
  const w = await freshWorld({});
  const { post } = await seedPost(w);

  // A distinct voter agent that meets the upvote eligibility gates.
  const voter = await registerAgent(w);
  await setAgentReputation(w.svm, voter.agentPda, 5200); // MIN_FEED_UPVOTE_REPUTATION
  warp(w.svm, 900); // MIN_FEED_UPVOTE_ACCOUNT_AGE_SECS

  const [vote] = pda([enc("upvote"), post.toBuffer(), voter.agentPda.toBuffer()]);
  expectOk(
    send(
      w.svm,
      await voter.prog.methods
        .upvotePost()
        .accounts({ post, vote, voter: voter.agentPda, protocolConfig: w.protocolPda, authority: voter.kp.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [voter.kp],
    ),
    "upvote post",
  );

  assert.equal(decode(w.svm, "FeedPost", post).upvote_count, 1, "upvote_count incremented to 1");
  const fv = decode(w.svm, "FeedVote", vote);
  assert.equal(fv.post.toBase58(), post.toBase58(), "vote.post wired");
  assert.equal(fv.voter.toBase58(), voter.agentPda.toBase58(), "vote.voter == upvoter agent");
});

test("upvote_post: the author cannot upvote their own post (FeedSelfUpvote)", async () => {
  const w = await freshWorld({});
  const { post } = await seedPost(w);
  // The provider agent authored the post; it also meets the (lower) upvote
  // reputation/age gates, so the self-upvote guard is the failing check.
  const [vote] = pda([enc("upvote"), post.toBuffer(), w.providerAgent.toBuffer()]);
  expectFail(
    send(
      w.svm,
      await w.providerProg.methods
        .upvotePost()
        .accounts({ post, vote, voter: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.provider],
    ),
    "FeedSelfUpvote",
    "self upvote",
  );
  assert.equal(decode(w.svm, "FeedPost", post).upvote_count, 0, "count unchanged after rejected self-upvote");
});

test("upvote_post: a double upvote on the same (post, voter) PDA is rejected", async () => {
  const w = await freshWorld({});
  const { post } = await seedPost(w);
  const voter = await registerAgent(w);
  await setAgentReputation(w.svm, voter.agentPda, 5200);
  warp(w.svm, 900);

  const [vote] = pda([enc("upvote"), post.toBuffer(), voter.agentPda.toBuffer()]);
  const upvoteIx = async () =>
    voter.prog.methods
      .upvotePost()
      .accounts({ post, vote, voter: voter.agentPda, protocolConfig: w.protocolPda, authority: voter.kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction();

  expectOk(send(w.svm, await upvoteIx(), [voter.kp]), "first upvote");
  assert.equal(decode(w.svm, "FeedPost", post).upvote_count, 1, "first upvote counted");

  // The FeedVote PDA already exists -> a second upvote fails at init (a tx-level
  // create_account error, so assert failure without a specific log match).
  w.svm.expireBlockhash();
  assert.ok(
    (await send(w.svm, await upvoteIx(), [voter.kp])) instanceof FailedTransactionMetadata,
    "duplicate upvote rejected by init",
  );
  assert.equal(decode(w.svm, "FeedPost", post).upvote_count, 1, "count stays at 1 after rejected double upvote");
});
