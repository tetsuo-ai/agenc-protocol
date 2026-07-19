// Direct LiteSVM execution coverage for reclaim_orphan_task_child.
//
// Current close_task deliberately retains the parent while any child might
// remain, so a genuine orphan can only come from historical program versions.
// These tests inject byte-accurate historical account images, then execute the
// real compiled instruction. This keeps the recovery proof realistic without
// reintroducing an unsafe legacy close path solely for test setup.

import test from "node:test";
import assert from "node:assert/strict";
import {
  arr,
  coder,
  enc,
  expectFail,
  expectOk,
  id32,
  injectProtocolConfig,
  isClosed,
  makeProgram,
  pda,
  PID,
  send,
  SO,
  BN,
  Keypair,
  LiteSVM,
  SystemProgram,
} from "./harness.mjs";

const CHILD_LAMPORTS = 2_000_000;
const AGENT_REGISTRATION_SIZE = 566;

function freshRecoveryWorld() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const clock = svm.getClock();
  clock.unixTimestamp = 1_700_000_000n;
  svm.setClock(clock);
  const cranker = Keypair.generate();
  svm.airdrop(cranker.publicKey, 10_000_000_000n);
  return { svm, cranker, program: makeProgram(cranker) };
}

function fundedRecipient(svm) {
  const recipient = Keypair.generate();
  svm.airdrop(recipient.publicKey, 1_000_000_000n);
  return recipient;
}

async function injectAccount(
  svm,
  address,
  accountName,
  value,
  { owner = PID, lamports = CHILD_LAMPORTS, dataLength = null } = {},
) {
  let data = await coder.accounts.encode(accountName, value);
  if (dataLength !== null) {
    assert.ok(data.length <= dataLength, `${accountName} fixture exceeds allocated space`);
    const allocated = Buffer.alloc(dataLength);
    data.copy(allocated);
    data = allocated;
  }
  svm.setAccount(address, {
    lamports,
    data,
    owner,
    executable: false,
    rentEpoch: 0,
  });
  return data;
}

async function jobSpecFixture(svm, overrides = {}) {
  const task = overrides.task ?? Keypair.generate().publicKey;
  const recipient = overrides.recipient ?? fundedRecipient(svm);
  const [canonicalChild, canonicalBump] = pda([enc("task_job_spec"), task.toBuffer()]);
  const child = overrides.child ?? canonicalChild;
  const bump = overrides.bump ?? canonicalBump;
  await injectAccount(
    svm,
    child,
    "TaskJobSpec",
    {
      task,
      creator: recipient.publicKey,
      job_spec_hash: arr(id32()),
      job_spec_uri: "agenc://job-spec/sha256/recovery-test",
      created_at: new BN(1),
      updated_at: new BN(1),
      bump,
      _reserved: Array(7).fill(0),
    },
    overrides.accountOptions,
  );
  return {
    child,
    task,
    recipient,
    workerAgent: SystemProgram.programId,
    lamports: CHILD_LAMPORTS,
  };
}

async function validationFixture(svm, { pendingCount = 0 } = {}) {
  const task = Keypair.generate().publicKey;
  const recipient = fundedRecipient(svm);
  const [child, bump] = pda([enc("task_validation"), task.toBuffer()]);
  const reserved = Array(7).fill(0);
  reserved[1] = pendingCount & 0xff;
  reserved[2] = (pendingCount >> 8) & 0xff;
  await injectAccount(svm, child, "TaskValidationConfig", {
    task,
    creator: recipient.publicKey,
    mode: { CreatorReview: {} },
    review_window_secs: new BN(3600),
    created_at: new BN(1),
    updated_at: new BN(1),
    bump,
    _reserved: reserved,
  });
  return {
    child,
    task,
    recipient,
    workerAgent: SystemProgram.programId,
    lamports: CHILD_LAMPORTS,
  };
}

async function attestorFixture(svm) {
  const task = Keypair.generate().publicKey;
  const recipient = fundedRecipient(svm);
  const [child, bump] = pda([enc("task_attestor"), task.toBuffer()]);
  await injectAccount(svm, child, "TaskAttestorConfig", {
    task,
    creator: recipient.publicKey,
    attestor: Keypair.generate().publicKey,
    created_at: new BN(1),
    updated_at: new BN(1),
    bump,
    _reserved: Array(7).fill(0),
  });
  return {
    child,
    task,
    recipient,
    workerAgent: SystemProgram.programId,
    lamports: CHILD_LAMPORTS,
  };
}

async function moderationFixture(svm, { legacy = false } = {}) {
  const task = Keypair.generate().publicKey;
  const recipient = fundedRecipient(svm);
  const jobSpecHash = id32();
  const seeds = legacy
    ? [enc("task_moderation"), task.toBuffer(), Buffer.from(jobSpecHash)]
    : [
        enc("task_moderation_v2"),
        task.toBuffer(),
        Buffer.from(jobSpecHash),
        recipient.publicKey.toBuffer(),
      ];
  const [child, bump] = pda(seeds);
  await injectAccount(svm, child, "TaskModeration", {
    task,
    creator: Keypair.generate().publicKey,
    job_spec_hash: arr(jobSpecHash),
    status: 0,
    risk_score: 0,
    category_mask: new BN(0),
    policy_hash: arr(id32()),
    scanner_hash: arr(id32()),
    recorded_at: new BN(1),
    expires_at: new BN(0),
    moderator: recipient.publicKey,
    bump,
    _reserved: Array(7).fill(0),
  });
  return {
    child,
    task,
    recipient,
    workerAgent: SystemProgram.programId,
    lamports: CHILD_LAMPORTS,
  };
}

function agentValue(agentId, authority, bump, { registeredAt = 1 } = {}) {
  return {
    agent_id: arr(agentId),
    authority,
    capabilities: new BN(1),
    status: { Active: {} },
    endpoint: "http://recovery-worker.test",
    metadata_uri: "",
    registered_at: new BN(registeredAt),
    last_active: new BN(1),
    tasks_completed: new BN(0),
    total_earned: new BN(0),
    reputation: 3000,
    active_tasks: 0,
    stake: new BN(0),
    bump,
    last_task_created: new BN(0),
    last_dispute_initiated: new BN(0),
    task_count_24h: 0,
    dispute_count_24h: 0,
    rate_limit_window_start: new BN(0),
    active_dispute_votes: 0,
    last_vote_timestamp: new BN(0),
    last_state_update: new BN(0),
    disputes_as_defendant: 0,
    _reserved: Array(4).fill(0),
  };
}

async function injectWorkerAgent(
  svm,
  authority = fundedRecipient(svm),
  { registeredAt = 1 } = {},
) {
  const agentId = id32();
  const [workerAgent, bump] = pda([enc("agent"), Buffer.from(agentId)]);
  await injectAccount(
    svm,
    workerAgent,
    "AgentRegistration",
    agentValue(agentId, authority.publicKey, bump, { registeredAt }),
    { lamports: 3_000_000, dataLength: AGENT_REGISTRATION_SIZE },
  );
  return { authority, workerAgent };
}

async function submissionFixture(
  svm,
  { status = "Accepted", worker = null, submittedAt = 10 } = {},
) {
  const task = Keypair.generate().publicKey;
  const claim = Keypair.generate().publicKey;
  const registeredWorker = worker ?? (await injectWorkerAgent(svm));
  const [child, bump] = pda([enc("task_submission"), claim.toBuffer()]);
  await injectAccount(svm, child, "TaskSubmission", {
    task,
    claim,
    worker: registeredWorker.workerAgent,
    status: { [status]: {} },
    proof_hash: arr(id32()),
    result_data: arr(Buffer.alloc(64, 7)),
    submission_count: 1,
    submitted_at: new BN(submittedAt),
    review_deadline_at: new BN(submittedAt + 1),
    accepted_at: new BN(status === "Accepted" ? submittedAt + 1 : 0),
    rejected_at: new BN(status === "Rejected" ? submittedAt + 1 : 0),
    rejection_hash: arr(Buffer.alloc(32)),
    bump,
    _reserved: Array(5).fill(0),
  });
  return {
    child,
    task,
    recipient: registeredWorker.authority,
    workerAgent: registeredWorker.workerAgent,
    lamports: CHILD_LAMPORTS,
  };
}

async function validationVoteFixture(svm) {
  const submission = Keypair.generate().publicKey;
  const recipient = fundedRecipient(svm);
  const [child, bump] = pda([
    enc("task_validation_vote"),
    submission.toBuffer(),
    recipient.publicKey.toBuffer(),
  ]);
  await injectAccount(svm, child, "TaskValidationVote", {
    submission,
    reviewer: recipient.publicKey,
    reviewer_agent: Keypair.generate().publicKey,
    submission_round: 2,
    approved: true,
    voted_at: new BN(1),
    bump,
    _reserved: Array(5).fill(0),
  });
  return {
    child,
    // The existing parentTask ABI slot carries the stored TaskSubmission for
    // vote children. Its absence is what makes the vote provably orphaned.
    task: submission,
    recipient,
    workerAgent: SystemProgram.programId,
    lamports: CHILD_LAMPORTS,
  };
}

async function reclaimIx(world, fixture, overrides = {}) {
  const builder = world.program.methods
    .reclaimOrphanTaskChild()
    .accounts({
      child: overrides.child ?? fixture.child,
      parentTask: overrides.parentTask ?? fixture.task,
      workerAgent: overrides.workerAgent ?? fixture.workerAgent,
      rentRecipient: overrides.rentRecipient ?? fixture.recipient.publicKey,
      authority: world.cranker.publicKey,
    });
  if (overrides.remainingAccounts) {
    builder.remainingAccounts(overrides.remainingAccounts);
  }
  return builder.instruction();
}

async function installRecoveryTreasury(world) {
  const treasury = fundedRecipient(world.svm);
  const protocolPda = await injectProtocolConfig(world.svm, treasury);
  return { protocolPda, treasury };
}

function treasurySuffix(protocolPda, treasury) {
  return [
    { pubkey: protocolPda, isSigner: false, isWritable: false },
    { pubkey: treasury.publicKey, isSigner: false, isWritable: true },
  ];
}

async function expectReclaimed(world, fixture, label) {
  const before = world.svm.getBalance(fixture.recipient.publicKey);
  expectOk(
    send(world.svm, await reclaimIx(world, fixture), [world.cranker]),
    label,
  );
  const after = world.svm.getBalance(fixture.recipient.publicKey);
  assert.equal(after - before, BigInt(fixture.lamports), `${label}: exact rent returned`);
  assert.ok(isClosed(world.svm, fixture.child), `${label}: child closed`);
}

test("reclaim_orphan_task_child reclaims every rent-only child kind to its stored payer", async () => {
  const world = freshRecoveryWorld();
  const fixtures = [
    [await jobSpecFixture(world.svm), "TaskJobSpec -> creator"],
    [await validationFixture(world.svm), "TaskValidationConfig -> creator"],
    [await attestorFixture(world.svm), "TaskAttestorConfig -> creator"],
    [await moderationFixture(world.svm), "TaskModeration v2 -> moderator"],
    [await moderationFixture(world.svm, { legacy: true }), "TaskModeration legacy -> moderator"],
    [await submissionFixture(world.svm), "terminal TaskSubmission -> worker authority"],
    [await validationVoteFixture(world.svm), "TaskValidationVote -> reviewer"],
  ];
  for (const [fixture, label] of fixtures) {
    await expectReclaimed(world, fixture, label);
  }
});

test("reclaim_orphan_task_child refuses a live parent", async () => {
  const world = freshRecoveryWorld();
  const fixture = await jobSpecFixture(world.svm);
  world.svm.setAccount(fixture.task, {
    lamports: 3_000_000,
    data: Buffer.alloc(8, 1),
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  expectFail(
    send(world.svm, await reclaimIx(world, fixture), [world.cranker]),
    "OrphanTaskParentStillLive",
    "live parent",
  );
  assert.equal(world.svm.getBalance(fixture.child), BigInt(CHILD_LAMPORTS));
});

test("reclaim_orphan_task_child refuses noncanonical child addresses and stored bumps", async () => {
  const world = freshRecoveryWorld();

  const task = Keypair.generate().publicKey;
  const [, canonicalBump] = pda([enc("task_job_spec"), task.toBuffer()]);
  const wrongAddress = Keypair.generate().publicKey;
  const wrongAddressFixture = await jobSpecFixture(world.svm, {
    task,
    child: wrongAddress,
    bump: canonicalBump,
  });
  expectFail(
    send(world.svm, await reclaimIx(world, wrongAddressFixture), [world.cranker]),
    "InvalidInput",
    "noncanonical child address",
  );

  const wrongBumpTask = Keypair.generate().publicKey;
  const [, bump] = pda([enc("task_job_spec"), wrongBumpTask.toBuffer()]);
  const wrongBumpFixture = await jobSpecFixture(world.svm, {
    task: wrongBumpTask,
    bump: (bump + 1) & 0xff,
  });
  expectFail(
    send(world.svm, await reclaimIx(world, wrongBumpFixture), [world.cranker]),
    "InvalidInput",
    "incorrect stored bump",
  );
});

test("reclaim_orphan_task_child refuses validation debt and an active submission", async () => {
  const world = freshRecoveryWorld();
  const indebtedValidation = await validationFixture(world.svm, { pendingCount: 1 });
  expectFail(
    send(world.svm, await reclaimIx(world, indebtedValidation), [world.cranker]),
    "TaskChildRequiresDedicatedCleanup",
    "validation config with pending debt",
  );

  const activeSubmission = await submissionFixture(world.svm, { status: "Submitted" });
  expectFail(
    send(world.svm, await reclaimIx(world, activeSubmission), [world.cranker]),
    "TaskChildRequiresDedicatedCleanup",
    "active Submitted child",
  );
});

test("reclaim_orphan_task_child derives recipient and worker instead of trusting the cranker", async () => {
  const world = freshRecoveryWorld();
  const forgedRecipient = fundedRecipient(world.svm);
  const jobSpec = await jobSpecFixture(world.svm);
  expectFail(
    send(
      world.svm,
      await reclaimIx(world, jobSpec, { rentRecipient: forgedRecipient.publicKey }),
      [world.cranker],
    ),
    "TaskChildRentRecipientRequired",
    "forged rent recipient",
  );

  const submission = await submissionFixture(world.svm);
  const forgedWorker = await injectWorkerAgent(world.svm);
  expectFail(
    send(
      world.svm,
      await reclaimIx(world, submission, { workerAgent: forgedWorker.workerAgent }),
      [world.cranker],
    ),
    "SubmissionRentAccountsRequired",
    "forged worker registration",
  );

  const forgedSubmissionRecipient = fundedRecipient(world.svm);
  expectFail(
    send(
      world.svm,
      await reclaimIx(world, submission, {
        rentRecipient: forgedSubmissionRecipient.publicKey,
      }),
      [world.cranker],
    ),
    "TaskChildRentRecipientRequired",
    "forged submission recipient",
  );
});

test("reclaim_orphan_task_child refuses foreign-owned and malformed children", async () => {
  const world = freshRecoveryWorld();
  const foreignOwned = await jobSpecFixture(world.svm, {
    accountOptions: { owner: SystemProgram.programId },
  });
  expectFail(
    send(world.svm, await reclaimIx(world, foreignOwned), [world.cranker]),
    "InvalidAccountOwner",
    "foreign-owned child",
  );

  const malformedTask = Keypair.generate().publicKey;
  const [malformedChild] = pda([enc("task_job_spec"), malformedTask.toBuffer()]);
  const malformedRecipient = fundedRecipient(world.svm);
  world.svm.setAccount(malformedChild, {
    lamports: CHILD_LAMPORTS,
    data: Buffer.from("not-an-anchor-account"),
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  const malformedFixture = {
    child: malformedChild,
    task: malformedTask,
    recipient: malformedRecipient,
    workerAgent: SystemProgram.programId,
  };
  expectFail(
    send(world.svm, await reclaimIx(world, malformedFixture), [world.cranker]),
    "OrphanTaskChildUnsupported",
    "malformed program-owned child",
  );
});

test("reclaim_orphan_task_child sends absent and dusted worker identities only to the canonical treasury", async () => {
  for (const dustLamports of [0, 1]) {
    const world = freshRecoveryWorld();
    const { protocolPda, treasury } = await installRecoveryTreasury(world);
    const agentId = id32();
    const [workerAgent] = pda([enc("agent"), Buffer.from(agentId)]);
    if (dustLamports > 0) {
      world.svm.setAccount(workerAgent, {
        lamports: dustLamports,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
        rentEpoch: 0,
      });
    }
    const fixture = await submissionFixture(world.svm, {
      worker: { workerAgent, authority: treasury },
    });
    const before = world.svm.getBalance(treasury.publicKey);
    expectOk(
      send(
        world.svm,
        await reclaimIx(world, fixture, {
          rentRecipient: treasury.publicKey,
          remainingAccounts: treasurySuffix(protocolPda, treasury),
        }),
        [world.cranker],
      ),
      `closed worker treasury recovery (dust=${dustLamports})`,
    );
    assert.equal(
      world.svm.getBalance(treasury.publicKey) - before,
      BigInt(fixture.lamports),
      "exact child rent reaches the configured treasury",
    );
    assert.ok(isClosed(world.svm, fixture.child));
  }
});

test("reclaim_orphan_task_child never pays an equal-time or later AgentRegistration clone", async () => {
  for (const cloneRegisteredAt of [100, 101]) {
    const world = freshRecoveryWorld();
    const { protocolPda, treasury } = await installRecoveryTreasury(world);
    const cloneAuthority = fundedRecipient(world.svm);
    const clone = await injectWorkerAgent(world.svm, cloneAuthority, {
      registeredAt: cloneRegisteredAt,
    });
    const fixture = await submissionFixture(world.svm, {
      worker: clone,
      submittedAt: 100,
    });
    const cloneBefore = world.svm.getBalance(cloneAuthority.publicKey);
    const treasuryBefore = world.svm.getBalance(treasury.publicKey);
    expectOk(
      send(
        world.svm,
        await reclaimIx(world, fixture, {
          rentRecipient: treasury.publicKey,
          remainingAccounts: treasurySuffix(protocolPda, treasury),
        }),
        [world.cranker],
      ),
      `clone routed to treasury (registered_at=${cloneRegisteredAt})`,
    );
    assert.equal(
      world.svm.getBalance(cloneAuthority.publicKey),
      cloneBefore,
      "clone authority receives no rent",
    );
    assert.equal(
      world.svm.getBalance(treasury.publicKey) - treasuryBefore,
      BigInt(fixture.lamports),
      "treasury receives the exact rent",
    );
  }
});

test("reclaim_orphan_task_child treasury suffix is exact and failures are atomic", async () => {
  const world = freshRecoveryWorld();
  const { protocolPda, treasury } = await installRecoveryTreasury(world);
  const fakeTreasury = fundedRecipient(world.svm);
  const agentId = id32();
  const [workerAgent] = pda([enc("agent"), Buffer.from(agentId)]);
  const fixture = await submissionFixture(world.svm, {
    worker: { workerAgent, authority: treasury },
  });
  const childBefore = world.svm.getAccount(fixture.child);
  const treasuryBefore = world.svm.getBalance(treasury.publicKey);
  const fakeBefore = world.svm.getBalance(fakeTreasury.publicKey);

  const attempts = [
    {
      label: "missing recovery suffix",
      code: "SubmissionRentAccountsRequired",
      rentRecipient: treasury.publicKey,
      remainingAccounts: [],
    },
    {
      label: "swapped recovery suffix",
      code: "CorruptedData",
      rentRecipient: treasury.publicKey,
      remainingAccounts: [
        { pubkey: treasury.publicKey, isSigner: false, isWritable: true },
        { pubkey: protocolPda, isSigner: false, isWritable: false },
      ],
    },
    {
      label: "fake configured treasury",
      code: "InvalidTreasury",
      rentRecipient: fakeTreasury.publicKey,
      remainingAccounts: [
        { pubkey: protocolPda, isSigner: false, isWritable: false },
        { pubkey: fakeTreasury.publicKey, isSigner: false, isWritable: true },
      ],
    },
    {
      label: "extra recovery suffix account",
      code: "SubmissionRentAccountsRequired",
      rentRecipient: treasury.publicKey,
      remainingAccounts: [
        ...treasurySuffix(protocolPda, treasury),
        { pubkey: fakeTreasury.publicKey, isSigner: false, isWritable: false },
      ],
    },
  ];

  for (const attempt of attempts) {
    world.svm.expireBlockhash();
    expectFail(
      send(
        world.svm,
        await reclaimIx(world, fixture, {
          rentRecipient: attempt.rentRecipient,
          remainingAccounts: attempt.remainingAccounts,
        }),
        [world.cranker],
      ),
      attempt.code,
      attempt.label,
    );
    const childAfter = world.svm.getAccount(fixture.child);
    assert.equal(childAfter.lamports, childBefore.lamports, `${attempt.label}: lamports atomic`);
    assert.deepEqual(
      Buffer.from(childAfter.data),
      Buffer.from(childBefore.data),
      `${attempt.label}: data atomic`,
    );
    assert.equal(world.svm.getBalance(treasury.publicKey), treasuryBefore);
    assert.equal(world.svm.getBalance(fakeTreasury.publicKey), fakeBefore);
  }
});
