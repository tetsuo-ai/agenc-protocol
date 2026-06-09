// In-process litesvm integration tests for the on-chain skill marketplace
// instructions of agenc-coordination: register_skill, update_skill, rate_skill,
// purchase_skill. Executes the COMPILED program (target/deploy/agenc_coordination.so).
//
// Mirrors the style of marketplace.test.mjs and reuses the shared harness.
//
// Run:  cd .. && node --test tests-integration/skills.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  freshWorld,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

const MIN_SKILL_PRICE = 1_000;

// Register a brand-new agent under a fresh wallet (active, default reputation 5000).
// Returns { kp, agentPda, agentId, prog }.
async function registerExtraAgent(w, { capabilities = 1, endpoint = "http://extra.test" } = {}) {
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
  return { kp, agentPda, agentId, prog };
}

// Build (and send) a register_skill ix. authorWallet signs; authorAgent is the
// PDA owned by authorWallet. Returns { skill, skillId } on success.
async function registerSkill(w, { authorWallet, authorAgent, authorProg, price = MIN_SKILL_PRICE, priceMint = null }) {
  const skillId = id32();
  const [skill] = pda([enc("skill"), authorAgent.toBuffer(), Buffer.from(skillId)]);
  const res = send(
    w.svm,
    await authorProg.methods
      .registerSkill(
        arr(skillId),
        arr(Buffer.alloc(32, 7)), // name (non-zero)
        arr(Buffer.alloc(32, 9)), // content_hash (non-zero)
        new BN(price),
        priceMint,
        arr(Buffer.alloc(64, 3)), // tags
      )
      .accounts({ skill, author: authorAgent, protocolConfig: w.protocolPda, authority: authorWallet.publicKey, systemProgram: SystemProgram.programId })
      .instruction(),
    [authorWallet],
  );
  return { skill, skillId, res };
}

// Purchase `skill` (SOL path) as `buyer`. Returns { purchaseRecord, res }.
async function purchaseSkillSol(w, { skill, buyerWallet, buyerAgent, buyerProg, authorAgent, authorWallet, expectedPrice }) {
  const [purchaseRecord] = pda([enc("skill_purchase"), skill.toBuffer(), buyerAgent.toBuffer()]);
  const res = send(
    w.svm,
    await buyerProg.methods
      .purchaseSkill(new BN(expectedPrice))
      .accounts({
        skill,
        purchaseRecord,
        buyer: buyerAgent,
        authorAgent,
        authorWallet,
        protocolConfig: w.protocolPda,
        treasury: w.admin.publicKey, // treasury == protocol authority in injectProtocolConfig
        authority: buyerWallet.publicKey,
        systemProgram: SystemProgram.programId,
        priceMint: null,
        buyerTokenAccount: null,
        authorTokenAccount: null,
        treasuryTokenAccount: null,
        tokenProgram: null,
      })
      .instruction(),
    [buyerWallet],
  );
  return { purchaseRecord, res };
}

// ---------------------------------------------------------------------------
// register_skill
// ---------------------------------------------------------------------------

test("register_skill: creates an active skill PDA owned by the author agent", async () => {
  const w = await freshWorld();
  // Provider agent acts as the skill author.
  const { skill, skillId, res } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: 500_000,
  });
  expectOk(res, "register_skill");

  const s = decode(w.svm, "SkillRegistration", skill);
  assert.ok(s, "skill account should exist");
  assert.equal(s.author.toBase58(), w.providerAgent.toBase58());
  assert.deepEqual(Buffer.from(s.skill_id).toString("hex"), Buffer.from(skillId).toString("hex"));
  assert.equal(s.price.toString(), "500000");
  assert.equal(s.is_active, true);
  assert.equal(s.version, 1);
  assert.equal(s.rating_count, 0);
  assert.equal(s.download_count, 0);
  assert.equal(s.price_mint, null);
});

test("register_skill: rejects price below MIN_SKILL_PRICE", async () => {
  const w = await freshWorld();
  const { res } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: MIN_SKILL_PRICE - 1,
  });
  expectFail(res, "SkillPriceBelowMinimum", "register_skill below-min price");
});

test("register_skill: rejects wrong authority for the author agent (has_one)", async () => {
  const w = await freshWorld();
  // buyer wallet tries to author a skill under the provider's agent PDA.
  const skillId = id32();
  const [skill] = pda([enc("skill"), w.providerAgent.toBuffer(), Buffer.from(skillId)]);
  const res = send(
    w.svm,
    await w.buyerProg.methods
      .registerSkill(
        arr(skillId),
        arr(Buffer.alloc(32, 7)),
        arr(Buffer.alloc(32, 9)),
        new BN(MIN_SKILL_PRICE),
        null,
        arr(Buffer.alloc(64, 3)),
      )
      .accounts({ skill, author: w.providerAgent, protocolConfig: w.protocolPda, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(),
    [w.buyer],
  );
  expectFail(res, "UnauthorizedAgent", "register_skill wrong authority");
});

// ---------------------------------------------------------------------------
// update_skill
// ---------------------------------------------------------------------------

test("update_skill: bumps version, updates content/price, and can deactivate", async () => {
  const w = await freshWorld();
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: 100_000,
  });
  const before = decode(w.svm, "SkillRegistration", skill);
  assert.equal(before.version, 1);

  const newHash = id32();
  const res = send(
    w.svm,
    await w.providerProg.methods
      .updateSkill(arr(newHash), new BN(250_000), null, false) // is_active = false
      .accounts({ skill, author: w.providerAgent, protocolConfig: w.protocolPda, authority: w.provider.publicKey })
      .instruction(),
    [w.provider],
  );
  expectOk(res, "update_skill");

  const after = decode(w.svm, "SkillRegistration", skill);
  assert.equal(after.version, 2, "version should increment");
  assert.equal(after.price.toString(), "250000");
  assert.equal(after.is_active, false);
  assert.deepEqual(Buffer.from(after.content_hash).toString("hex"), Buffer.from(newHash).toString("hex"));
});

test("update_skill: rejects a wrong signer authority (UnauthorizedAgent)", async () => {
  const w = await freshWorld();
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: 100_000,
  });
  // Pass the correct author agent (so the [b"skill", author.key(), skill_id]
  // seeds still resolve to the real PDA) but sign as the buyer wallet. The
  // author agent's `has_one = authority` guard rejects the foreign signer.
  // (The SkillUnauthorizedUpdate constraint is unreachable in practice because
  // the PDA seeds already bind the skill to its author agent.)
  const res = send(
    w.svm,
    await w.buyerProg.methods
      .updateSkill(arr(id32()), new BN(250_000), null, null)
      .accounts({ skill, author: w.providerAgent, protocolConfig: w.protocolPda, authority: w.buyer.publicKey })
      .instruction(),
    [w.buyer],
  );
  expectFail(res, "UnauthorizedAgent", "update_skill wrong authority");
});

// ---------------------------------------------------------------------------
// purchase_skill (moves money)
// ---------------------------------------------------------------------------

test("purchase_skill: SOL path pays author + treasury and records the purchase", async () => {
  const w = await freshWorld();
  const price = 1_000_000;
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price,
  });

  const authorWallet = w.provider.publicKey;
  const treasury = w.admin.publicKey;
  const authorBefore = Number(w.svm.getBalance(authorWallet));
  const treasuryBefore = Number(w.svm.getBalance(treasury));

  // protocol_fee_bps = 100 (1%) from injectProtocolConfig.
  const protocolFee = Math.floor((price * 100) / 10000);
  const authorShare = price - protocolFee;

  const { purchaseRecord, res } = await purchaseSkillSol(w, {
    skill,
    buyerWallet: w.buyer, buyerAgent: w.buyerAgent, buyerProg: w.buyerProg,
    authorAgent: w.providerAgent, authorWallet,
    expectedPrice: price,
  });
  expectOk(res, "purchase_skill");

  const authorAfter = Number(w.svm.getBalance(authorWallet));
  const treasuryAfter = Number(w.svm.getBalance(treasury));
  assert.equal(authorAfter - authorBefore, authorShare, "author should receive author_share");
  assert.equal(treasuryAfter - treasuryBefore, protocolFee, "treasury should receive protocol_fee");

  const pr = decode(w.svm, "PurchaseRecord", purchaseRecord);
  assert.ok(pr, "purchase record should exist");
  assert.equal(pr.skill.toBase58(), skill.toBase58());
  assert.equal(pr.buyer.toBase58(), w.buyerAgent.toBase58());
  assert.equal(pr.price_paid.toString(), String(price));

  const s = decode(w.svm, "SkillRegistration", skill);
  assert.equal(s.download_count, 1, "download_count incremented");
});

test("purchase_skill: rejects when on-chain price exceeds expected_price (SkillPriceChanged)", async () => {
  const w = await freshWorld();
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: 1_000_000,
  });
  const { res } = await purchaseSkillSol(w, {
    skill,
    buyerWallet: w.buyer, buyerAgent: w.buyerAgent, buyerProg: w.buyerProg,
    authorAgent: w.providerAgent, authorWallet: w.provider.publicKey,
    expectedPrice: 999_999, // less than skill.price
  });
  expectFail(res, "SkillPriceChanged", "purchase_skill stale price");
});

test("purchase_skill: rejects author buying own skill (SkillSelfPurchase)", async () => {
  const w = await freshWorld();
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price: 1_000_000,
  });
  // The provider (author) tries to buy: buyer agent == author agent.
  const [purchaseRecord] = pda([enc("skill_purchase"), skill.toBuffer(), w.providerAgent.toBuffer()]);
  const res = send(
    w.svm,
    await w.providerProg.methods
      .purchaseSkill(new BN(1_000_000))
      .accounts({
        skill, purchaseRecord,
        buyer: w.providerAgent, authorAgent: w.providerAgent, authorWallet: w.provider.publicKey,
        protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
        systemProgram: SystemProgram.programId,
        priceMint: null, buyerTokenAccount: null, authorTokenAccount: null, treasuryTokenAccount: null, tokenProgram: null,
      })
      .instruction(),
    [w.provider],
  );
  expectFail(res, "SkillSelfPurchase", "purchase_skill self-purchase");
});

// ---------------------------------------------------------------------------
// rate_skill (requires a paid purchase record by a distinct rater agent)
// ---------------------------------------------------------------------------

test("rate_skill: a paying buyer rates the skill (reputation-weighted)", async () => {
  const w = await freshWorld();
  const price = 1_000_000;
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price,
  });

  // The buyer agent purchases first (rater must have a paid purchase record).
  const { purchaseRecord, res: pres } = await purchaseSkillSol(w, {
    skill,
    buyerWallet: w.buyer, buyerAgent: w.buyerAgent, buyerProg: w.buyerProg,
    authorAgent: w.providerAgent, authorWallet: w.provider.publicKey,
    expectedPrice: price,
  });
  expectOk(pres, "rate_skill: purchase");

  const rating = 4;
  const [ratingAccount] = pda([enc("skill_rating"), skill.toBuffer(), w.buyerAgent.toBuffer()]);
  const res = send(
    w.svm,
    await w.buyerProg.methods
      .rateSkill(rating, null)
      .accounts({
        skill, ratingAccount, rater: w.buyerAgent, purchaseRecord,
        protocolConfig: w.protocolPda, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.buyer],
  );
  expectOk(res, "rate_skill");

  const ra = decode(w.svm, "SkillRating", ratingAccount);
  assert.ok(ra, "rating account should exist");
  assert.equal(ra.rating, rating);
  assert.equal(ra.skill.toBase58(), skill.toBase58());
  assert.equal(ra.rater.toBase58(), w.buyerAgent.toBase58());

  const s = decode(w.svm, "SkillRegistration", skill);
  assert.equal(s.rating_count, 1, "rating_count incremented");
  // reputation defaults to 5000 -> total_rating = rating * 5000.
  assert.equal(s.total_rating.toString(), String(rating * ra.rater_reputation));
});

test("rate_skill: rejects an out-of-range rating value (SkillInvalidRating)", async () => {
  const w = await freshWorld();
  const price = 1_000_000;
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price,
  });
  const { purchaseRecord, res: pres } = await purchaseSkillSol(w, {
    skill,
    buyerWallet: w.buyer, buyerAgent: w.buyerAgent, buyerProg: w.buyerProg,
    authorAgent: w.providerAgent, authorWallet: w.provider.publicKey,
    expectedPrice: price,
  });
  expectOk(pres, "rate_skill invalid: purchase");

  const [ratingAccount] = pda([enc("skill_rating"), skill.toBuffer(), w.buyerAgent.toBuffer()]);
  const res = send(
    w.svm,
    await w.buyerProg.methods
      .rateSkill(6, null) // out of 1..=5
      .accounts({
        skill, ratingAccount, rater: w.buyerAgent, purchaseRecord,
        protocolConfig: w.protocolPda, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.buyer],
  );
  expectFail(res, "SkillInvalidRating", "rate_skill out-of-range");
});

test("rate_skill: a distinct rater agent (not the buyer) also works after purchasing", async () => {
  const w = await freshWorld();
  const price = 1_000_000;
  const { skill } = await registerSkill(w, {
    authorWallet: w.provider, authorAgent: w.providerAgent, authorProg: w.providerProg,
    price,
  });

  // A brand-new third agent purchases, then rates.
  const rater = await registerExtraAgent(w, { endpoint: "http://rater.test" });
  const { purchaseRecord, res: pres } = await purchaseSkillSol(w, {
    skill,
    buyerWallet: rater.kp, buyerAgent: rater.agentPda, buyerProg: rater.prog,
    authorAgent: w.providerAgent, authorWallet: w.provider.publicKey,
    expectedPrice: price,
  });
  expectOk(pres, "distinct rater: purchase");

  const [ratingAccount] = pda([enc("skill_rating"), skill.toBuffer(), rater.agentPda.toBuffer()]);
  const res = send(
    w.svm,
    await rater.prog.methods
      .rateSkill(5, null)
      .accounts({
        skill, ratingAccount, rater: rater.agentPda, purchaseRecord,
        protocolConfig: w.protocolPda, authority: rater.kp.publicKey, systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [rater.kp],
  );
  expectOk(res, "distinct rater: rate");

  const s = decode(w.svm, "SkillRegistration", skill);
  assert.equal(s.rating_count, 1, "rating_count incremented by distinct rater");
});
