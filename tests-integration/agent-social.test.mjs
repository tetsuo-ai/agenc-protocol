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
  freshWorld, deregisterRemaining, setSurfaceRevision, setProtocolPaused, sendMany,
  BN, Keypair, PublicKey, SystemProgram, FailedTransactionMetadata,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Local helpers (not exported from the harness).
// ---------------------------------------------------------------------------

// Set an AgentRegistration's `reputation` in place (no real reputation flow
// needed for tests). Feed posting requires reputation >= 5500 and upvoting
// >= 5200, but new agents start at 3000 — so we bump it directly,
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
async function registerAgent(
  w,
  { capabilities = 1, endpoint = "http://extra.test", stakeAmount = 0, kp = Keypair.generate() } = {},
) {
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(agentId), new BN(capabilities), endpoint, null, new BN(stakeAmount))
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

test("deregister_agent: refunds stake, retires the identity permanently, and decrements total_agents", async () => {
  const w = await freshWorld({});
  const registrationStake = 1_000_000;
  const a = await registerAgent(w, { stakeAmount: registrationStake });
  const totalBefore = decode(w.svm, "ProtocolConfig", w.protocolPda).total_agents.toString();
  const agentBalanceBefore = Number(w.svm.getBalance(a.agentPda));
  expectOk(
    send(
      w.svm,
      await a.prog.methods
        .deregisterAgent()
        .accounts({ agent: a.agentPda, protocolConfig: w.protocolPda, reputationStake: pda([enc("reputation_stake"), a.agentPda.toBuffer()])[0], authority: a.kp.publicKey })
        .remainingAccounts(deregisterRemaining(a.agentPda))
        .instruction(),
      [a.kp],
    ),
    "deregister agent",
  );

  assert.ok(!isClosed(w.svm, a.agentPda), "identity tombstone remains on-chain");
  const retired = decode(w.svm, "AgentRegistration", a.agentPda);
  assert.ok(retired.status.Inactive !== undefined, "retired identity is not active");
  assert.deepEqual(
    Buffer.from(retired._reserved),
    Buffer.from("RETD"),
    "reserved tail carries the permanent-retirement marker",
  );
  assert.equal(retired.stake.toString(), "0", "tracked registration stake cleared");
  assert.equal(
    agentBalanceBefore - Number(w.svm.getBalance(a.agentPda)),
    registrationStake,
    "tracked registration stake refunded while rent stays with the tombstone",
  );
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
        .accounts({ agent: a.agentPda, protocolConfig: w.protocolPda, reputationStake: pda([enc("reputation_stake"), a.agentPda.toBuffer()])[0], authority: w.buyer.publicKey })
        .instruction(),
      [w.buyer],
    ),
    "UnauthorizedAgent",
    "non-authority deregister",
  );
  assert.ok(!isClosed(w.svm, a.agentPda), "agent PDA still open after rejected deregister");
});

test("deregister_agent: a suspended agent cannot erase the operator sanction", async () => {
  const w = await freshWorld({});
  const a = await registerAgent(w);
  const adminProg = makeProgram(w.admin);

  expectOk(
    send(
      w.svm,
      await adminProg.methods
        .suspendAgent()
        .accounts({
          agent: a.agentPda,
          protocolConfig: w.protocolPda,
          authority: w.admin.publicKey,
        })
        .instruction(),
      [w.admin],
    ),
    "suspend agent before attempted deregistration",
  );

  expectFail(
    send(
      w.svm,
      await a.prog.methods
        .deregisterAgent()
        .accounts({
          agent: a.agentPda,
          protocolConfig: w.protocolPda,
          reputationStake: pda([enc("reputation_stake"), a.agentPda.toBuffer()])[0],
          authority: a.kp.publicKey,
        })
        .remainingAccounts(deregisterRemaining(a.agentPda))
        .instruction(),
      [a.kp],
    ),
    "AgentSuspended",
    "suspended agent deregistration",
  );

  const agent = decode(w.svm, "AgentRegistration", a.agentPda);
  assert.ok(agent, "the sanctioned identity must remain on-chain");
  assert.ok(agent.status.Suspended !== undefined, "the suspension must remain intact");
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

// Corruption/boundary fixtures below are confined to LiteSVM. The companion
// feed-authority-votes.rpc.test.ts earns eligibility and waits age on real RPC.
async function mutateAccount(w, name, key, change) {
  const account = w.svm.getAccount(key);
  const value = decode(w.svm, name, key);
  change(value);
  const data = Buffer.alloc(account.data.length);
  (await coder.accounts.encode(name, value)).copy(data);
  w.svm.setAccount(key, { ...account, data });
}

async function eligibleVoter(w, kp) {
  const voter = await registerAgent(w, { kp });
  await setAgentReputation(w.svm, voter.agentPda, 5200);
  warp(w.svm, 900);
  return voter;
}

async function walletVote(w, post, voter, overrides = {}) {
  const [authorityVote] = pda([enc("authority_upvote"), post.toBuffer(), voter.kp.publicKey.toBuffer()]);
  return voter.prog.methods.upvotePostByAuthority().accounts({
    post, authorityVote, voter: voter.agentPda, author: w.providerAgent,
    protocolConfig: w.protocolPda, authority: voter.kp.publicKey,
    systemProgram: SystemProgram.programId, ...overrides,
  }).instruction();
}

function receiptAddress(post, voter) {
  return pda([enc("authority_upvote"), post.toBuffer(), voter.kp.publicKey.toBuffer()])[0];
}

test("#275: legacy agent-vote wire fails closed without creating a receipt", async () => {
  const w = await freshWorld({});
  const { post } = await seedPost(w);
  const voter = await eligibleVoter(w);
  const [vote] = pda([enc("upvote"), post.toBuffer(), voter.agentPda.toBuffer()]);
  const before = Buffer.from(w.svm.getAccount(post).data);
  const ix = await voter.prog.methods.upvotePost().accounts({ post, vote,
    voter: voter.agentPda, protocolConfig: w.protocolPda, authority: voter.kp.publicKey,
    systemProgram: SystemProgram.programId }).instruction();
  expectFail(send(w.svm, ix, [voter.kp]), "FeedAgentVotingRetired", "retired legacy vote");
  assert.equal(w.svm.getAccount(vote), null);
  assert.deepEqual(Buffer.from(w.svm.getAccount(post).data), before);
});

test("#275: distinct wallets count once, preserve historical prefix and legacy votes", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const voter = await eligibleVoter(w);
  const other = await eligibleVoter(w);
  // A historical post and receipt are fixtures; the prospective votes are real
  // compiled-program instructions. No caller-selected historical deduplication.
  await mutateAccount(w, "FeedPost", post, (value) => { value.upvote_count = 9; });
  const [legacy, bump] = pda([enc("upvote"), post.toBuffer(), voter.agentPda.toBuffer()]);
  const historical = await coder.accounts.encode("FeedVote", { post, voter: voter.agentPda,
    timestamp: new BN(100), bump, _reserved: [0, 0, 0, 0] });
  w.svm.setAccount(legacy, { lamports: 10_000_000, data: historical,
    owner: PID, executable: false, rentEpoch: 0 });
  const before = Buffer.from(w.svm.getAccount(post).data);
  assert.equal(before.length, 190, "historical maximum post allocation unchanged");
  const encoded = await coder.accounts.encode("FeedPost", decode(w.svm, "FeedPost", post));
  const walletCountOffset = encoded.length - 8;
  for (const who of [voter, other]) expectOk(send(w.svm, await walletVote(w, post, who), [who.kp]), "wallet vote");
  const after = decode(w.svm, "FeedPost", post);
  assert.equal(after.wallet_upvote_count, 2);
  assert.equal(after.upvote_count, 9, "legacy aggregate remains separate");
  const afterBytes = Buffer.from(w.svm.getAccount(post).data);
  before.writeUInt32LE(2, walletCountOffset);
  assert.deepEqual(afterBytes, before, "only the reserved-tail wallet counter changed");
  assert.deepEqual(Buffer.from(w.svm.getAccount(legacy).data), historical);
  const receipt = decode(w.svm, "FeedAuthorityVote", receiptAddress(post, voter));
  assert.equal(receipt.authority.toBase58(), voter.kp.publicKey.toBase58());
  assert.equal(receipt.voter.toBase58(), voter.agentPda.toBase58());
  assert.equal(w.svm.getAccount(receiptAddress(post, voter)).data.length, 117);
});

test("#275: different agents under one wallet share one immutable receipt", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const first = await eligibleVoter(w);
  const second = await eligibleVoter(w, first.kp);
  const ixs = [await walletVote(w, post, first), await walletVote(w, post, second)];
  for (const ordered of [ixs, [...ixs].reverse()]) {
    expectFail(sendMany(w.svm, ordered, [first.kp]), "FeedAuthorityAlreadyVoted", "atomic duplicates");
    assert.equal(w.svm.getAccount(receiptAddress(post, first)), null, "rent allocation rolled back");
    assert.equal(decode(w.svm, "FeedPost", post).wallet_upvote_count, 0);
  }
  expectOk(send(w.svm, ixs[0], [first.kp]), "first agent votes");
  const original = Buffer.from(w.svm.getAccount(receiptAddress(post, first)).data);
  for (const ix of [ixs[1], ixs[0]]) {
    w.svm.expireBlockhash();
    expectFail(send(w.svm, ix, [first.kp]), "FeedAuthorityAlreadyVoted", "same wallet repeat");
    assert.deepEqual(Buffer.from(w.svm.getAccount(receiptAddress(post, first)).data), original);
    assert.equal(decode(w.svm, "FeedPost", post).wallet_upvote_count, 1);
  }
});

test("#275: same-agent and cross-agent self-votes both reject by immutable wallet authority", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const sibling = await eligibleVoter(w, w.provider);
  const author = { kp: w.provider, agentPda: w.providerAgent, prog: w.providerProg };
  for (const voter of [author, sibling]) {
    expectFail(send(w.svm, await walletVote(w, post, voter), [voter.kp]), "FeedSelfUpvote", "author wallet vote");
    assert.equal(w.svm.getAccount(receiptAddress(post, voter)), null);
  }
  assert.equal(decode(w.svm, "FeedPost", post).wallet_upvote_count, 0);
});

test("#275: author retirement preserves the identity check and allows unrelated voters", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const sibling = await eligibleVoter(w, w.provider);
  const other = await eligibleVoter(w);
  expectOk(send(w.svm, await w.providerProg.methods.deregisterAgent()
    .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
    .remainingAccounts(deregisterRemaining(w.providerAgent)).instruction(), [w.provider]), "retire author");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).authority.toBase58(), w.provider.publicKey.toBase58());
  expectFail(send(w.svm, await walletVote(w, post, sibling), [sibling.kp]), "FeedSelfUpvote", "retired author's sibling");
  expectOk(send(w.svm, await walletVote(w, post, other), [other.kp]), "vote on retired author's post");
  assert.equal(decode(w.svm, "FeedPost", post).wallet_upvote_count, 1);
});

test("#275: author, voter authority and wallet receipt PDA cannot be substituted", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const voter = await eligibleVoter(w);
  expectFail(send(w.svm, await walletVote(w, post, voter, { author: voter.agentPda }), [voter.kp]),
    "InvalidInput", "unrelated author identity");
  const [otherReceipt] = pda([enc("authority_upvote"), post.toBuffer(), w.buyer.publicKey.toBuffer()]);
  expectFail(send(w.svm, await walletVote(w, post, voter, { authority: w.buyer.publicKey, authorityVote: otherReceipt }), [w.buyer]),
    "UnauthorizedAgent", "wrong voter authority");
  expectFail(send(w.svm, await walletVote(w, post, voter, { authorityVote: otherReceipt }), [voter.kp]),
    "ConstraintSeeds", "another wallet's receipt PDA");
  assert.equal(w.svm.getAccount(receiptAddress(post, voter)), null);
  assert.equal(w.svm.getAccount(otherReceipt), null);
  assert.equal(decode(w.svm, "FeedPost", post).wallet_upvote_count, 0);
});

test("#275: revision gate, reputation floor, age boundary and pause remain effective", async () => {
  const w = await freshWorld({});
  const { post } = await seedPost(w);
  const voter = await registerAgent(w);
  await setAgentReputation(w.svm, voter.agentPda, 5200);
  warp(w.svm, 899);
  const ix = await walletVote(w, post, voter);
  const reject = (error) => {
    w.svm.expireBlockhash();
    expectFail(send(w.svm, ix, [voter.kp]), error, error);
    assert.equal(w.svm.getAccount(receiptAddress(post, voter)), null);
  };
  await setSurfaceRevision(w.svm, 5);
  reject("FeedAuthorityVotingUnavailable");
  await setSurfaceRevision(w.svm, 6);
  reject("CooldownNotElapsed");
  warp(w.svm, 1);
  await setAgentReputation(w.svm, voter.agentPda, 5199);
  reject("InsufficientReputation");
  await setAgentReputation(w.svm, voter.agentPda, 5200);
  await setProtocolPaused(w.svm, true);
  reject("ProtocolPaused");
  await setProtocolPaused(w.svm, false);
  w.svm.expireBlockhash();
  expectOk(send(w.svm, ix, [voter.kp]), "exact eligibility boundary");
});

test("#275: suspended voters cannot vote even with sufficient age and reputation", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const voter = await eligibleVoter(w);
  expectOk(send(w.svm, await makeProgram(w.admin).methods.suspendAgent().accounts({
    agent: voter.agentPda, protocolConfig: w.protocolPda, authority: w.admin.publicKey,
  }).instruction(), [w.admin]), "suspend voter");
  expectFail(send(w.svm, await walletVote(w, post, voter), [voter.kp]), "AgentNotActive", "suspended voter");
  assert.equal(w.svm.getAccount(receiptAddress(post, voter)), null);
});

test("#275: reserved-tail corruption and counter overflow roll back receipt initialization", async () => {
  const w = await freshWorld({});
  await setSurfaceRevision(w.svm, 6);
  const { post } = await seedPost(w);
  const voter = await eligibleVoter(w);
  const ix = await walletVote(w, post, voter);
  await mutateAccount(w, "FeedPost", post, (value) => { value._reserved[3] = 1; });
  expectFail(send(w.svm, ix, [voter.kp]), "CorruptedData", "reserved tail");
  await mutateAccount(w, "FeedPost", post, (value) => {
    value._reserved[3] = 0; value.wallet_upvote_count = 0xffffffff;
  });
  const original = Buffer.from(w.svm.getAccount(post).data);
  w.svm.expireBlockhash();
  expectFail(send(w.svm, ix, [voter.kp]), "ArithmeticOverflow", "counter overflow");
  assert.equal(w.svm.getAccount(receiptAddress(post, voter)), null);
  assert.deepEqual(Buffer.from(w.svm.getAccount(post).data), original);
});

