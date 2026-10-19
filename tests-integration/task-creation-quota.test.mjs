// Compiled-SBF boundary tests. Clock/counter corruption fixtures are explicit;
// the companion RPC suite actually creates more than 255 funded tasks.
import test from "node:test";
import assert from "node:assert/strict";
import { PID, coder, freshWorld, configureTestMultisig, setSurfaceRevision,
  makeProgram, pda, enc, arr, id32, decode, send, sendMany, expectOk, expectFail,
  warpSeconds, hireIx, moderationBlockPda, BN, Keypair, SystemProgram } from "./harness.mjs";

const quotaAddress = (wallet) => pda([enc("authority_task_quota"), wallet.toBuffer()])[0];
const legacyAddress = (wallet) => pda([enc("authority_rate_limit"), wallet.toBuffer()])[0];
async function mutate(w, name, key, change) {
  const account = w.svm.getAccount(key), value = decode(w.svm, name, key);
  change(value);
  w.svm.setAccount(key, { ...account, data: await coder.accounts.encode(name, value) });
}
async function world() {
  const w = await freshWorld({});
  w.multisig = await configureTestMultisig(w);
  await setSurfaceRevision(w.svm, 7);
  await mutate(w, "ProtocolConfig", w.protocolPda, (c) => {
    c.task_creation_cooldown = new BN(1); c.max_tasks_per_24h = 255;
  });
  return w;
}
async function configure(w, max = 256, enabled = true, wallet = w.buyer.publicKey, approvals = w.multisig) {
  return makeProgram(w.admin).methods.configureTaskCreationQuota(wallet, max, enabled)
    .accounts({ protocolConfig: w.protocolPda, taskQuota: quotaAddress(wallet),
      quotaAuthorityRateLimit: legacyAddress(wallet), authority: w.admin.publicKey,
      systemProgram: SystemProgram.programId }).remainingAccounts(approvals.remainingAccounts).instruction();
}
async function grant(w, max = 256, enabled = true) {
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await configure(w, max, enabled), w.multisig.approvers), "approve wallet quota");
}
function withQuota(ix, wallet) {
  ix.keys.push({ pubkey: quotaAddress(wallet), isSigner: false, isWritable: true });
  return ix;
}
async function create(w, { extended = true, kind = "registered", agent = w.buyerAgent, parentTask } = {}) {
  const taskId = id32(), now = Number(w.svm.getClock().unixTimestamp);
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), taskId]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const description = Buffer.alloc(64); id32().copy(description);
  const base = { task, escrow, protocolConfig: w.protocolPda,
    authorityRateLimit: legacyAddress(w.buyer.publicKey), creator: w.buyer.publicKey,
    systemProgram: SystemProgram.programId };
  let ix;
  if (kind === "registered" || kind === "dependent") {
    const method = kind === "registered"
      ? w.buyerProg.methods.createTask(arr(taskId), new BN(1), arr(description), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
      : w.buyerProg.methods.createDependentTask(arr(taskId), new BN(1), arr(description), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 3, 0, null);
    ix = await method.accounts({ ...base, creatorAgent: agent, authority: w.buyer.publicKey,
      ...(parentTask ? { parentTask } : {}), rewardMint: null, creatorTokenAccount: null,
      tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null }).instruction();
  } else if (kind === "humanless") {
    ix = await w.buyerProg.methods.createTaskHumanless(arr(taskId), new BN(1), arr(description),
      new BN(1_000_000), new BN(now + 3600), 0, new BN(3600), null, 0).accounts({ ...base,
      taskValidationConfig: pda([enc("task_validation"), task.toBuffer()])[0] }).instruction();
  } else if (kind === "hire") {
    const result = await hireIx(w); if (extended) withQuota(result.ix, w.buyer.publicKey); return result;
  } else {
    ix = await w.buyerProg.methods.hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1),
      new BN(3600), null, 0, w.modAuth.publicKey, arr(id32())).accounts({ ...base,
      hireRecord: pda([enc("hire"), task.toBuffer()])[0],
      taskValidationConfig: pda([enc("task_validation"), task.toBuffer()])[0],
      listing: w.listing, providerAgent: w.providerAgent, moderationConfig: w.modCfg,
      listingModeration: w.defaultListingModeration, moderationAttestor: null,
      moderationBlock: moderationBlockPda(w.specHash)[0] }).instruction();
  }
  if (extended) withQuota(ix, w.buyer.publicKey);
  return { ix, task, escrow };
}

test("#124: quota approval requires the actual M-of-N and finite 256..1000 bounds", async () => {
  const w = await world();
  const one = { remainingAccounts: [w.multisig.remainingAccounts[0]] };
  expectFail(send(w.svm, await configure(w, 256, true, w.buyer.publicKey, one), [w.admin]), "MultisigNotEnoughSigners", "single owner");
  assert.equal(w.svm.getAccount(quotaAddress(w.buyer.publicKey)), null);
  for (const max of [0, 1, 255, 1001, 0xffffffff]) {
    expectFail(send(w.svm, await configure(w, max), w.multisig.approvers), "InvalidTaskQuota", "finite quota bound");
    assert.equal(w.svm.getAccount(quotaAddress(w.buyer.publicKey)), null);
  }
  w.svm.airdrop(quotaAddress(w.buyer.publicKey), 1000n); // pre-funding cannot prevent approval.
  await grant(w, 1000);
  assert.equal(w.svm.getAccount(quotaAddress(w.buyer.publicKey)).data.length, 64);
  assert.equal(w.svm.getAccount(legacyAddress(w.buyer.publicKey)).data.length, 67);
  assert.equal(w.svm.getAccount(w.protocolPda).data.length, 351);
});

test("#124: all five task entry paths share the u32 quota; omission keeps the legacy ceiling", async () => {
  const w = await world();
  // Explicit boundary fixture: no actual-RPC volume claim is made here.
  await grant(w, 259);
  await mutate(w, "AuthorityRateLimit", legacyAddress(w.buyer.publicKey), (v) => {
    v.task_count_24h = 254; v.dispute_count_24h = 7; v.last_dispute_initiated = new BN(1234);
  });
  const parent = await create(w);
  expectOk(send(w.svm, parent.ix, [w.buyer]), "255th creation");
  warpSeconds(w.svm, 1);
  expectFail(send(w.svm, (await create(w, { extended: false })).ix, [w.buyer]), "RateLimitExceeded", "omitted quota");
  for (const kind of ["humanless", "hire", "hireHumanless", "dependent"]) {
    warpSeconds(w.svm, 1);
    expectOk(send(w.svm, (await create(w, { kind, parentTask: parent.task })).ix, [w.buyer]), kind);
  }
  const quota = decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey));
  assert.equal(quota.task_count_24h, 259);
  const legacy = decode(w.svm, "AuthorityRateLimit", legacyAddress(w.buyer.publicKey));
  assert.equal(legacy.task_count_24h, 255);
  assert.equal(legacy.dispute_count_24h, 7);
  assert.equal(legacy.last_dispute_initiated.toNumber(), 1234);
  for (const kind of ["registered", "humanless", "hire", "hireHumanless", "dependent"]) {
    warpSeconds(w.svm, 1);
    const attempted = await create(w, { kind, parentTask: parent.task });
    expectFail(send(w.svm, attempted.ix, [w.buyer]), "RateLimitExceeded", `${kind} exhausted`);
    assert.equal(w.svm.getAccount(attempted.task), null);
  }
});

test("#124: the 256th funded creation needs an approved wide quota, carrying all 255 legacy writes", async () => {
  const w = await world();
  await setSurfaceRevision(w.svm, 6);
  for (let count = 0; count < 255; count++) {
    warpSeconds(w.svm, 1);
    expectOk(send(w.svm, (await create(w, { extended: false })).ix, [w.buyer]), `legacy creation ${count + 1}`);
  }
  warpSeconds(w.svm, 1);
  expectFail(send(w.svm, (await create(w, { extended: false })).ix, [w.buyer]), "RateLimitExceeded", "legacy ceiling");
  await grant(w);
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey)).task_count_24h, 255);
  await setSurfaceRevision(w.svm, 7);
  expectOk(send(w.svm, (await create(w)).ix, [w.buyer]), "256th funded creation");
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey)).task_count_24h, 256);
});

test("#124: activating, alternating legacy writes, disabling and re-enabling never reset usage", async () => {
  const w = await world();
  expectOk(send(w.svm, (await create(w, { extended: false })).ix, [w.buyer]), "legacy first");
  await grant(w);
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey)).task_count_24h, 1);
  for (const extended of [true, false, true]) {
    warpSeconds(w.svm, 1);
    expectOk(send(w.svm, (await create(w, { extended })).ix, [w.buyer]), "mixed creation");
  }
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey)).task_count_24h, 4);
  await grant(w, 256, false);
  warpSeconds(w.svm, 1);
  expectOk(send(w.svm, (await create(w)).ix, [w.buyer]), "disabled grant retains legacy capacity");
  await grant(w, 1000, true);
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey)).task_count_24h, 5);
  await mutate(w, "AuthorityRateLimit", legacyAddress(w.buyer.publicKey), (v) => { v.task_count_24h = 255; });
  await mutate(w, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey), (v) => { v.task_count_24h = 300; });
  await grant(w, 256);
  warpSeconds(w.svm, 1);
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "RateLimitExceeded", "lowered cap preserves consumed budget");
  await grant(w, 256, false); await grant(w, 256, true);
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "RateLimitExceeded", "re-enable does not replenish");
});

test("#124: wallet binding, writable suffix, revision and reserved bytes fail closed", async () => {
  const w = await world(); await grant(w);
  await setSurfaceRevision(w.svm, 6);
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "TaskQuotaUnavailable", "older surface");
  await setSurfaceRevision(w.svm, 7);
  for (const change of [
    (ix) => { ix.keys.at(-1).pubkey = quotaAddress(w.provider.publicKey); },
    (ix) => { ix.keys.at(-1).isWritable = false; },
    (ix) => { ix.keys.push(ix.keys.at(-1)); },
  ]) {
    const built = await create(w); change(built.ix);
    expectFail(send(w.svm, built.ix, [w.buyer]), "InvalidTaskQuotaAccount", "invalid suffix");
    assert.equal(w.svm.getAccount(built.task), null);
  }
  await mutate(w, "AuthorityTaskQuota", quotaAddress(w.buyer.publicKey), (v) => { v._reserved[0] = 1; });
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "CorruptedData", "reserved flag");
});

test("#124: a failed atomic batch rolls back task funding and both counter families", async () => {
  const w = await world(); await grant(w);
  const beforeLegacy = Buffer.from(w.svm.getAccount(legacyAddress(w.buyer.publicKey)).data);
  const beforeQuota = Buffer.from(w.svm.getAccount(quotaAddress(w.buyer.publicKey)).data);
  const first = await create(w), second = await create(w, { kind: "humanless" });
  expectFail(sendMany(w.svm, [first.ix, second.ix], [w.buyer]), "CooldownNotElapsed", "same-second batch");
  for (const job of [first, second]) {
    assert.equal(w.svm.getAccount(job.task), null); assert.equal(w.svm.getAccount(job.escrow), null);
  }
  assert.deepEqual(Buffer.from(w.svm.getAccount(legacyAddress(w.buyer.publicKey)).data), beforeLegacy);
  assert.deepEqual(Buffer.from(w.svm.getAccount(quotaAddress(w.buyer.publicKey)).data), beforeQuota);
});

test("#124: exact calendar-day reset and backward clock preserve dispute cooldown semantics", async () => {
  const w = await world(); await grant(w);
  const legacyKey = legacyAddress(w.buyer.publicKey), quotaKey = quotaAddress(w.buyer.publicKey);
  const start = decode(w.svm, "AuthorityRateLimit", legacyKey).rate_limit_window_start.toNumber();
  await mutate(w, "AuthorityRateLimit", legacyKey, (v) => {
    v.task_count_24h = 255; v.dispute_count_24h = 10; v.last_dispute_initiated = new BN(start + 86399);
  });
  await mutate(w, "AuthorityTaskQuota", quotaKey, (v) => { v.task_count_24h = 256; });
  const clock = w.svm.getClock(); clock.unixTimestamp = BigInt(start + 86399); w.svm.setClock(clock);
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "RateLimitExceeded", "one second before reset");
  warpSeconds(w.svm, 1);
  expectOk(send(w.svm, (await create(w)).ix, [w.buyer]), "exact new calendar day");
  const legacy = decode(w.svm, "AuthorityRateLimit", legacyKey), quota = decode(w.svm, "AuthorityTaskQuota", quotaKey);
  assert.equal(quota.task_count_24h, 1); assert.equal(legacy.task_count_24h, 1);
  assert.equal(legacy.dispute_count_24h, 0);
  assert.equal(legacy.last_dispute_initiated.toNumber(), start + 86399);
  const backwards = w.svm.getClock(); backwards.unixTimestamp -= 60n; w.svm.setClock(backwards);
  expectFail(send(w.svm, (await create(w)).ix, [w.buyer]), "CooldownNotElapsed", "backward clock");
  assert.equal(decode(w.svm, "AuthorityTaskQuota", quotaKey).task_count_24h, 1);
});
