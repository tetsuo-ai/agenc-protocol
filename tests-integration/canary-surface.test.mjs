// Opt-in compiled LiteSVM coverage for the complete frozen mainnet-canary surface.
//
// The wire-shape gate and dispatcher probe prove that all 25 discriminators remain
// present, but they do not prove that the deployed canary handlers can deserialize
// real accounts, enforce authority/timing guards, mutate state, or release funds.
// This file exercises those semantic boundaries against the actual canary .so.
//
// Run after `npm run canary:build && npm run canary:idl` with:
//   AGENC_CANARY_LITESVM=1 node --test tests-integration/canary-*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  REPO,
  SO,
  PID,
  coder,
  enc,
  arr,
  pda,
  id32,
  send,
  expectOk,
  expectFail,
  decode,
  isClosed,
  injectProtocolConfig,
  injectModerationConfig,
  setMultisig,
  setMinAgentStake,
  setProtocolPaused,
  deregisterRemaining,
  Program,
  AnchorProvider,
  BN,
  Wallet,
  LiteSVM,
  FailedTransactionMetadata,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "./harness.mjs";

const RUN_CANARY = process.env.AGENC_CANARY_LITESVM === "1";
const CANARY_IDL = RUN_CANARY
  ? JSON.parse(
      fs.readFileSync(
        path.join(REPO, "target/idl/agenc_coordination.canary.json"),
        "utf8",
      ),
    )
  : null;

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const OLD_CONFIG_SIZE = 349;
const NEW_CONFIG_SIZE = 351;
const OLD_TASK_SIZE = 382;
const NEW_TASK_SIZE = 466;
const START_TIME = 1_700_000_000;

function makeCanaryProgram(payer) {
  assert.ok(CANARY_IDL, "canary IDL must be loaded for compiled coverage");
  assert.equal(CANARY_IDL.instructions.length, 25, "frozen canary surface size");
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:9999"),
    new Wallet(payer),
    { commitment: "processed" },
  );
  return new Program(CANARY_IDL, provider);
}

function newCanarySvm() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(START_TIME);
  svm.setClock(clock);
  return svm;
}

function fund(svm, ...keypairs) {
  for (const keypair of keypairs) {
    svm.airdrop(keypair.publicKey, 100_000_000_000n);
  }
}

function promoteSigner(instruction, publicKey) {
  const meta = instruction.keys.find((key) => key.pubkey.equals(publicKey));
  assert.ok(meta, `missing account meta for ${publicKey.toBase58()}`);
  meta.isSigner = true;
  return instruction;
}

function setClock(svm, unixTimestamp) {
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(unixTimestamp);
  svm.setClock(clock);
  svm.expireBlockhash();
}

function programDataAddress() {
  return PublicKey.findProgramAddressSync(
    [PID.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

function putProgramData(svm, upgradeAuthority) {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0); // UpgradeableLoaderState::ProgramData
  data.writeBigUInt64LE(1n, 4);
  data[12] = 1; // Some(upgrade_authority)
  upgradeAuthority.toBuffer().copy(data, 13);
  const address = programDataAddress();
  svm.setAccount(address, {
    lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: BPF_LOADER_UPGRADEABLE,
    executable: false,
    rentEpoch: 0,
  });
  return address;
}

async function setMinSupportedVersion(svm, value) {
  const [protocolConfig] = pda([enc("protocol")]);
  const account = svm.getAccount(protocolConfig);
  const config = coder.accounts.decode(
    "ProtocolConfig",
    Buffer.from(account.data),
  );
  config.min_supported_version = value;
  const data = await coder.accounts.encode("ProtocolConfig", config);
  svm.setAccount(protocolConfig, {
    ...account,
    data,
    owner: PID,
  });
}

async function registerCanaryAgent(
  svm,
  protocolConfig,
  authority,
  { capabilities = 1, endpoint = "http://agent.test", stake = 0 } = {},
) {
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  const program = makeCanaryProgram(authority);
  expectOk(
    send(
      svm,
      await program.methods
        .registerAgent(
          arr(agentId),
          new BN(capabilities),
          endpoint,
          null,
          new BN(stake),
        )
        .accounts({
          agent,
          protocolConfig,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [authority],
    ),
    `canary:register ${endpoint}`,
  );
  return { agentId, agent, program };
}

async function createCanaryTask(
  svm,
  protocolConfig,
  creator,
  creatorAgent,
  { reward = 2_000_000, deadlineOffset = 3_600 } = {},
) {
  const program = makeCanaryProgram(creator);
  const taskId = id32();
  const [task] = pda([enc("task"), creator.publicKey.toBuffer(), taskId]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [authorityRateLimit] = pda([
    enc("authority_rate_limit"),
    creator.publicKey.toBuffer(),
  ]);
  const description = Buffer.alloc(64);
  id32().copy(description);
  const deadline = Number(svm.getClock().unixTimestamp) + deadlineOffset;

  expectOk(
    send(
      svm,
      await program.methods
        .createTask(
          arr(taskId),
          new BN(1),
          arr(description),
          new BN(reward),
          1,
          new BN(deadline),
          0,
          null,
          0,
          null,
          null,
          0,
        )
        .accounts({
          task,
          escrow,
          protocolConfig,
          creatorAgent,
          authorityRateLimit,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [creator],
    ),
    "canary:create task",
  );

  return { taskId, task, escrow, deadline, reward, program };
}

async function setupReviewWorld({
  submit = false,
  deadlineOffset = 3_600,
  reviewWindow = 120,
} = {}) {
  const svm = newCanarySvm();
  const admin = Keypair.generate();
  const creator = Keypair.generate();
  const workerAuthority = Keypair.generate();
  const moderator = Keypair.generate();
  const crank = Keypair.generate();
  const attacker = Keypair.generate();
  fund(svm, admin, creator, workerAuthority, moderator, crank, attacker);

  const protocolConfig = await injectProtocolConfig(svm, admin);
  const moderationConfig = await injectModerationConfig(
    svm,
    admin,
    moderator,
    true,
  );
  const creatorRegistration = await registerCanaryAgent(
    svm,
    protocolConfig,
    creator,
    { endpoint: "http://creator.test" },
  );
  const workerRegistration = await registerCanaryAgent(
    svm,
    protocolConfig,
    workerAuthority,
    { endpoint: "http://worker.test" },
  );
  const created = await createCanaryTask(
    svm,
    protocolConfig,
    creator,
    creatorRegistration.agent,
    { deadlineOffset },
  );

  const creatorProgram = creatorRegistration.program;
  const workerProgram = workerRegistration.program;
  const moderatorProgram = makeCanaryProgram(moderator);
  const [validation] = pda([enc("task_validation"), created.task.toBuffer()]);
  const [attestorConfig] = pda([enc("task_attestor"), created.task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), created.task.toBuffer()]);
  expectOk(
    send(
      svm,
      await creatorProgram.methods
        .configureTaskValidation(1, new BN(reviewWindow), 0, null)
        .accounts({
          task: created.task,
          taskValidationConfig: validation,
          taskAttestorConfig: attestorConfig,
          protocolConfig,
          hireRecord,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [creator],
    ),
    "canary:configure CreatorReview",
  );

  const jobSpecHash = id32();
  const [taskModeration] = pda([
    enc("task_moderation"),
    created.task.toBuffer(),
    jobSpecHash,
  ]);
  expectOk(
    send(
      svm,
      await moderatorProgram.methods
        .recordTaskModeration(
          arr(jobSpecHash),
          0,
          0,
          new BN(0),
          arr(Buffer.alloc(32, 1)),
          arr(Buffer.alloc(32, 2)),
          new BN(0),
        )
        .accounts({
          moderationConfig,
          task: created.task,
          taskModeration,
          moderator: moderator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [moderator],
    ),
    "canary:record task moderation",
  );

  const [taskJobSpec] = pda([
    enc("task_job_spec"),
    created.task.toBuffer(),
  ]);
  expectOk(
    send(
      svm,
      await creatorProgram.methods
        .setTaskJobSpec(
          arr(jobSpecHash),
          "agenc://job-spec/sha256/canary-surface",
        )
        .accounts({
          protocolConfig,
          task: created.task,
          moderationConfig,
          taskModeration,
          taskJobSpec,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [creator],
    ),
    "canary:set task job spec",
  );

  const [claim] = pda([
    enc("claim"),
    created.task.toBuffer(),
    workerRegistration.agent.toBuffer(),
  ]);
  expectOk(
    send(
      svm,
      await workerProgram.methods
        .claimTaskWithJobSpec()
        .accounts({
          task: created.task,
          taskJobSpec,
          claim,
          protocolConfig,
          worker: workerRegistration.agent,
          authority: workerAuthority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [workerAuthority],
    ),
    "canary:claim task",
  );

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  if (submit) {
    const resultData = Buffer.alloc(64);
    id32().copy(resultData);
    expectOk(
      send(
        svm,
        await workerProgram.methods
          .submitTaskResult(arr(id32()), arr(resultData))
          .accounts({
            task: created.task,
            claim,
            taskValidationConfig: validation,
            taskSubmission: submission,
            protocolConfig,
            worker: workerRegistration.agent,
            authority: workerAuthority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [workerAuthority],
      ),
      "canary:submit task result",
    );
  }

  return {
    svm,
    admin,
    creator,
    workerAuthority,
    moderator,
    crank,
    attacker,
    protocolConfig,
    moderationConfig,
    creatorAgent: creatorRegistration.agent,
    worker: workerRegistration.agent,
    creatorProgram,
    workerProgram,
    validation,
    hireRecord,
    taskJobSpec,
    claim,
    submission,
    ...created,
  };
}

function acceptAccounts(world, signer, operator = null) {
  return {
    task: world.task,
    claim: world.claim,
    escrow: world.escrow,
    taskValidationConfig: world.validation,
    taskSubmission: world.submission,
    worker: world.worker,
    protocolConfig: world.protocolConfig,
    treasury: world.admin.publicKey,
    creator: signer.publicKey,
    workerAuthority: world.workerAuthority.publicKey,
    hireRecord: null,
    operator,
    referrer: null,
    systemProgram: SystemProgram.programId,
  };
}

test(
  "canary initialize_protocol requires real upgrade custody and treasury consent",
  { skip: !RUN_CANARY },
  async () => {
    const svm = newCanarySvm();
    const authority = Keypair.generate();
    const secondSigner = Keypair.generate();
    const thirdOwner = Keypair.generate();
    const treasury = Keypair.generate();
    fund(svm, authority, secondSigner, thirdOwner, treasury);
    const programData = putProgramData(svm, authority.publicKey);
    const [protocolConfig] = pda([enc("protocol")]);
    const program = makeCanaryProgram(authority);
    const owners = [
      authority.publicKey,
      secondSigner.publicKey,
      thirdOwner.publicKey,
    ];
    const build = async () =>
      program.methods
        .initializeProtocol(
          67,
          321,
          new BN(2_000_000),
          new BN(1_000_000),
          2,
          owners,
        )
        .accounts({
          protocolConfig,
          treasury: treasury.publicKey,
          authority: authority.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: programData, isSigner: false, isWritable: false },
        ])
        .instruction();

    // The frozen IDL predates the treasury signer flag. The handler must still
    // fail closed unless the client explicitly promotes the account meta.
    expectFail(
      send(svm, await build(), [authority, secondSigner]),
      "TreasuryNotSpendable",
      "canary initialize without treasury consent",
    );
    assert.equal(decode(svm, "ProtocolConfig", protocolConfig), null);

    svm.expireBlockhash();
    const initialize = promoteSigner(await build(), treasury.publicKey);
    expectOk(
      send(svm, initialize, [authority, secondSigner, treasury]),
      "canary initialize with custody consent",
    );
    const config = decode(svm, "ProtocolConfig", protocolConfig);
    assert.equal(config.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58());
    assert.equal(config.protocol_fee_bps, 321);
    assert.equal(config.multisig_threshold, 2);
    assert.equal(config.multisig_owners_len, 3);
    assert.equal(config.protocol_paused, false, "restricted canary initializes live");
    assert.equal(config.surface_revision, 0, "canary remains conservative revision 0");

    svm.expireBlockhash();
    assert.ok(
      send(
        svm,
        promoteSigner(await build(), treasury.publicKey),
        [authority, secondSigner, treasury],
      ) instanceof FailedTransactionMetadata,
      "protocol bootstrap cannot be replayed",
    );
  },
);

test(
  "canary admin surface enforces authority/multisig/custody guards and persists every config mutation",
  { skip: !RUN_CANARY },
  async () => {
    const svm = newCanarySvm();
    const admin = Keypair.generate();
    const owner2 = Keypair.generate();
    const owner3 = Keypair.generate();
    const attacker = Keypair.generate();
    const moderator = Keypair.generate();
    const newTreasury = Keypair.generate();
    for (const signer of [
      admin,
      owner2,
      owner3,
      attacker,
      moderator,
      newTreasury,
    ]) {
      fund(svm, signer);
    }
    const protocolConfig = await injectProtocolConfig(svm, admin);
    await setMultisig(
      svm,
      [admin.publicKey, owner2.publicKey, owner3.publicKey],
      2,
    );
    const [moderationConfig] = pda([enc("moderation_config")]);
    const adminProgram = makeCanaryProgram(admin);
    const attackerProgram = makeCanaryProgram(attacker);
    const approvals = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
    ];

    expectFail(
      send(
        svm,
        await attackerProgram.methods
          .configureTaskModeration(moderator.publicKey, true)
          .accounts({
            protocolConfig,
            moderationConfig,
            authority: attacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [attacker],
      ),
      "UnauthorizedAgent",
      "canary moderation config wrong authority",
    );
    expectOk(
      send(
        svm,
        await adminProgram.methods
          .configureTaskModeration(moderator.publicKey, true)
          .accounts({
            protocolConfig,
            moderationConfig,
            authority: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [admin],
      ),
      "canary configure moderation",
    );
    const moderation = decode(svm, "ModerationConfig", moderationConfig);
    assert.equal(
      moderation.moderation_authority.toBase58(),
      moderator.publicKey.toBase58(),
    );
    assert.equal(moderation.enabled, true);

    const fee = (value, metas) =>
      adminProgram.methods
        .updateProtocolFee(value)
        .accounts({ protocolConfig, authority: admin.publicKey })
        .remainingAccounts(metas)
        .instruction();
    expectFail(
      send(svm, await fee(250, approvals.slice(0, 1)), [admin]),
      "MultisigNotEnoughSigners",
      "canary fee single approval",
    );
    expectOk(
      send(svm, await fee(250, approvals), [admin, owner2]),
      "canary update fee",
    );
    assert.equal(decode(svm, "ProtocolConfig", protocolConfig).protocol_fee_bps, 250);

    const treasuryInstruction = () =>
      adminProgram.methods
        .updateTreasury()
        .accounts({
          protocolConfig,
          newTreasury: newTreasury.publicKey,
          authority: admin.publicKey,
        })
        .remainingAccounts(approvals)
        .instruction();
    expectFail(
      send(svm, await treasuryInstruction(), [admin, owner2]),
      "TreasuryNotSpendable",
      "canary treasury rotation without new custody consent",
    );
    svm.expireBlockhash();
    expectOk(
      send(
        svm,
        promoteSigner(await treasuryInstruction(), newTreasury.publicKey),
        [admin, owner2, newTreasury],
      ),
      "canary rotate treasury",
    );
    assert.equal(
      decode(svm, "ProtocolConfig", protocolConfig).treasury.toBase58(),
      newTreasury.publicKey.toBase58(),
    );

    await setMinAgentStake(svm, 2_000_000);
    const limits = (taskCooldown) =>
      adminProgram.methods
        .updateRateLimits(
          new BN(taskCooldown),
          7,
          new BN(300),
          3,
          new BN(1_000_000),
        )
        .accounts({ protocolConfig, authority: admin.publicKey })
        .remainingAccounts(approvals)
        .instruction();
    expectFail(
      send(svm, await limits(0), [admin, owner2]),
      "RateLimitBelowMinimum",
      "canary zero task cooldown",
    );
    svm.expireBlockhash();
    expectOk(
      send(svm, await limits(120), [admin, owner2]),
      "canary update rate limits",
    );
    let config = decode(svm, "ProtocolConfig", protocolConfig);
    assert.equal(Number(config.task_creation_cooldown), 120);
    assert.equal(config.max_tasks_per_24h, 7);
    assert.equal(Number(config.dispute_initiation_cooldown), 300);
    assert.equal(config.max_disputes_per_24h, 3);
    assert.equal(Number(config.min_stake_for_dispute), 1_000_000);

    await setMinSupportedVersion(svm, 0);
    const minVersion = (version) =>
      adminProgram.methods
        .updateMinVersion(version)
        .accounts({ protocolConfig, authority: admin.publicKey })
        .remainingAccounts(approvals)
        .instruction();
    expectOk(
      send(svm, await minVersion(1), [admin, owner2]),
      "canary raise minimum version",
    );
    assert.equal(decode(svm, "ProtocolConfig", protocolConfig).min_supported_version, 1);
    svm.expireBlockhash();
    expectFail(
      send(svm, await minVersion(0), [admin, owner2]),
      "InvalidMigrationTarget",
      "canary minimum-version rollback",
    );

    const launch = (paused, mask, revision) =>
      adminProgram.methods
        .updateLaunchControls(paused, mask, revision)
        .accounts({ protocolConfig, authority: admin.publicKey })
        .remainingAccounts(approvals)
        .instruction();
    expectFail(
      send(svm, await launch(true, 3, 1), [admin, owner2]),
      "InvalidSurfaceRevision",
      "canary cannot advertise a nonzero surface revision",
    );
    svm.expireBlockhash();
    expectOk(
      send(svm, await launch(true, 3, 0), [admin, owner2]),
      "canary update launch controls",
    );
    config = decode(svm, "ProtocolConfig", protocolConfig);
    assert.equal(config.protocol_paused, true);
    assert.equal(config.disabled_task_type_mask, 3);
    assert.equal(config.surface_revision, 0);

    const newOwner = Keypair.generate();
    const nextOwners = [owner2.publicKey, owner3.publicKey, newOwner.publicKey];
    const rotationApprovals = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
      { pubkey: owner3.publicKey, isSigner: true, isWritable: false },
    ];
    expectFail(
      send(
        svm,
        await adminProgram.methods
          .updateMultisig(3, nextOwners)
          .accounts({ protocolConfig, authority: admin.publicKey })
          .remainingAccounts(rotationApprovals)
          .instruction(),
        [admin, owner2, owner3],
      ),
      "MultisigInvalidThreshold",
      "canary unreachable multisig threshold",
    );
    svm.expireBlockhash();
    expectOk(
      send(
        svm,
        await adminProgram.methods
          .updateMultisig(2, nextOwners)
          .accounts({ protocolConfig, authority: admin.publicKey })
          .remainingAccounts(rotationApprovals)
          .instruction(),
        [admin, owner2, owner3],
      ),
      "canary rotate multisig",
    );
    config = decode(svm, "ProtocolConfig", protocolConfig);
    assert.equal(config.multisig_threshold, 2);
    assert.equal(config.multisig_owners_len, 3);
    assert.deepEqual(
      config.multisig_owners.slice(0, 3).map((owner) => owner.toBase58()),
      nextOwners.map((owner) => owner.toBase58()),
    );
  },
);

test(
  "canary migrate_task and migrate_protocol enforce multisig and safely grow legacy accounts",
  { skip: !RUN_CANARY },
  async () => {
    const svm = newCanarySvm();
    const admin = Keypair.generate();
    const creator = Keypair.generate();
    const owner2 = Keypair.generate();
    fund(svm, admin, creator, owner2);
    const protocolConfig = await injectProtocolConfig(svm, admin);
    const creatorRegistration = await registerCanaryAgent(
      svm,
      protocolConfig,
      creator,
      { endpoint: "http://migration-creator.test" },
    );
    const created = await createCanaryTask(
      svm,
      protocolConfig,
      creator,
      creatorRegistration.agent,
    );
    assert.equal(svm.getAccount(created.task).data.length, NEW_TASK_SIZE);

    await setMultisig(svm, [admin.publicKey, owner2.publicKey], 2);
    const approvals = [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
    ];
    const fullTask = svm.getAccount(created.task);
    svm.setAccount(created.task, {
      ...fullTask,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(OLD_TASK_SIZE))),
      data: Buffer.from(fullTask.data).subarray(0, OLD_TASK_SIZE),
      owner: PID,
    });
    const adminProgram = makeCanaryProgram(admin);
    const migrateTask = (dryRun, metas) =>
      adminProgram.methods
        .migrateTask(dryRun)
        .accounts({
          protocolConfig,
          task: created.task,
          payer: admin.publicKey,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(metas)
        .instruction();

    expectFail(
      send(svm, await migrateTask(false, approvals.slice(0, 1)), [admin]),
      "MultisigNotEnoughSigners",
      "canary migrate task single approval",
    );
    assert.equal(svm.getAccount(created.task).data.length, OLD_TASK_SIZE);
    expectOk(
      send(svm, await migrateTask(true, approvals), [admin, owner2]),
      "canary migrate task dry run",
    );
    assert.equal(svm.getAccount(created.task).data.length, OLD_TASK_SIZE);
    expectOk(
      send(svm, await migrateTask(false, approvals), [admin, owner2]),
      "canary migrate task",
    );
    assert.equal(svm.getAccount(created.task).data.length, NEW_TASK_SIZE);
    assert.ok(
      Number(svm.getAccount(created.task).lamports) >=
        Number(svm.minimumBalanceForRentExemption(BigInt(NEW_TASK_SIZE))),
      "task rent topped up",
    );
    const migratedTask = decode(svm, "Task", created.task);
    assert.equal(migratedTask.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(migratedTask.operator.toBase58(), PublicKey.default.toBase58());
    assert.equal(migratedTask.referrer.toBase58(), PublicKey.default.toBase58());

    const fullConfig = svm.getAccount(protocolConfig);
    assert.equal(fullConfig.data.length, NEW_CONFIG_SIZE);
    const feeBefore = decode(svm, "ProtocolConfig", protocolConfig).protocol_fee_bps;
    svm.setAccount(protocolConfig, {
      ...fullConfig,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(OLD_CONFIG_SIZE))),
      data: Buffer.from(fullConfig.data).subarray(0, OLD_CONFIG_SIZE),
      owner: PID,
    });
    const migrateProtocol = (metas) =>
      adminProgram.methods
        .migrateProtocol(1)
        .accounts({
          protocolConfig,
          payer: admin.publicKey,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(metas)
        .instruction();
    expectFail(
      send(svm, await migrateProtocol(approvals.slice(0, 1)), [admin]),
      "MultisigNotEnoughSigners",
      "canary migrate protocol single approval",
    );
    assert.equal(svm.getAccount(protocolConfig).data.length, OLD_CONFIG_SIZE);
    expectOk(
      send(svm, await migrateProtocol(approvals), [admin, owner2]),
      "canary migrate protocol",
    );
    assert.equal(svm.getAccount(protocolConfig).data.length, NEW_CONFIG_SIZE);
    const migratedConfig = decode(svm, "ProtocolConfig", protocolConfig);
    assert.equal(migratedConfig.surface_revision, 0);
    assert.equal(migratedConfig.protocol_fee_bps, feeBefore);
  },
);

test(
  "canary agent lifecycle authorizes update/suspend/unsuspend and leaves a permanent retirement tombstone",
  { skip: !RUN_CANARY },
  async () => {
    const svm = newCanarySvm();
    const admin = Keypair.generate();
    const authority = Keypair.generate();
    const attacker = Keypair.generate();
    fund(svm, admin, authority, attacker);
    const protocolConfig = await injectProtocolConfig(svm, admin);
    const registration = await registerCanaryAgent(
      svm,
      protocolConfig,
      authority,
      { endpoint: "http://lifecycle.test" },
    );
    const attackerProgram = makeCanaryProgram(attacker);
    const adminProgram = makeCanaryProgram(admin);

    expectFail(
      send(
        svm,
        await attackerProgram.methods
          .updateAgent(new BN(3), "http://stolen.test", null, 1)
          .accounts({ agent: registration.agent, authority: attacker.publicKey })
          .instruction(),
        [attacker],
      ),
      "UnauthorizedAgent",
      "canary agent update wrong authority",
    );
    expectOk(
      send(
        svm,
        await registration.program.methods
          .updateAgent(
            new BN(3),
            "https://updated.test",
            "agenc://metadata/updated",
            1,
          )
          .accounts({ agent: registration.agent, authority: authority.publicKey })
          .instruction(),
        [authority],
      ),
      "canary update agent",
    );
    let agent = decode(svm, "AgentRegistration", registration.agent);
    assert.equal(Number(agent.capabilities), 3);
    assert.equal(agent.endpoint, "https://updated.test");
    assert.equal(agent.metadata_uri, "agenc://metadata/updated");

    expectFail(
      send(
        svm,
        await attackerProgram.methods
          .suspendAgent()
          .accounts({
            agent: registration.agent,
            protocolConfig,
            authority: attacker.publicKey,
          })
          .instruction(),
        [attacker],
      ),
      "UnauthorizedUpgrade",
      "canary suspend wrong authority",
    );
    expectOk(
      send(
        svm,
        await adminProgram.methods
          .suspendAgent()
          .accounts({
            agent: registration.agent,
            protocolConfig,
            authority: admin.publicKey,
          })
          .instruction(),
        [admin],
      ),
      "canary suspend agent",
    );
    agent = decode(svm, "AgentRegistration", registration.agent);
    assert.ok(agent.status.Suspended !== undefined);

    const [reputationStake] = pda([
      enc("reputation_stake"),
      registration.agent.toBuffer(),
    ]);
    const deregister = () =>
      registration.program.methods
        .deregisterAgent()
        .accounts({
          agent: registration.agent,
          protocolConfig,
          reputationStake,
          authority: authority.publicKey,
        })
        .remainingAccounts(deregisterRemaining(registration.agent))
        .instruction();
    expectFail(
      send(svm, await deregister(), [authority]),
      "AgentSuspended",
      "canary sanctioned identity cannot retire",
    );
    expectOk(
      send(
        svm,
        await adminProgram.methods
          .unsuspendAgent()
          .accounts({
            agent: registration.agent,
            protocolConfig,
            authority: admin.publicKey,
          })
          .instruction(),
        [admin],
      ),
      "canary unsuspend agent",
    );
    assert.ok(
      decode(svm, "AgentRegistration", registration.agent).status.Inactive !==
        undefined,
    );

    // The successful retirement is byte-identical to the earlier sanctioned
    // attempt. Advance the blockhash so LiteSVM executes it against the new
    // Unsuspended state instead of rejecting it as an already-seen transaction.
    svm.expireBlockhash();
    expectOk(send(svm, await deregister(), [authority]), "canary retire agent");
    agent = decode(svm, "AgentRegistration", registration.agent);
    assert.ok(agent, "retired identity remains program-owned");
    assert.equal(Number(agent.stake), 0);
    assert.equal(
      Number(decode(svm, "ProtocolConfig", protocolConfig).total_agents),
      0,
    );

    svm.expireBlockhash();
    assert.ok(
      send(
        svm,
        await registration.program.methods
          .registerAgent(
            arr(registration.agentId),
            new BN(1),
            "http://squatter.test",
            null,
            new BN(0),
          )
          .accounts({
            agent: registration.agent,
            protocolConfig,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [authority],
      ) instanceof FailedTransactionMetadata,
      "retired agent_id cannot be re-registered",
    );
  },
);

test(
  "canary CreatorReview money paths accept normally or reject and reopen while paused",
  { skip: !RUN_CANARY },
  async (t) => {
    await t.test("creator accept pays once and closes worker-funded children", async () => {
      const world = await setupReviewWorld({ submit: true });
      await setProtocolPaused(world.svm, true);
      const workerBefore = world.svm.getBalance(world.workerAuthority.publicKey);
      const treasuryBefore = world.svm.getBalance(world.admin.publicKey);
      const accept = await world.creatorProgram.methods
        .acceptTaskResult()
        .accounts(acceptAccounts(world, world.creator))
        .instruction();
      expectOk(
        send(world.svm, accept, [world.creator]),
        "canary creator accept while paused",
      );
      const taskAccount = decode(world.svm, "Task", world.task);
      assert.ok(taskAccount.status.Completed !== undefined);
      assert.equal(taskAccount.current_workers, 0);
      assert.ok(isClosed(world.svm, world.escrow));
      assert.ok(isClosed(world.svm, world.claim));
      assert.ok(isClosed(world.svm, world.submission));
      assert.ok(world.svm.getBalance(world.workerAuthority.publicKey) > workerBefore);
      assert.ok(world.svm.getBalance(world.admin.publicKey) > treasuryBefore);
      world.svm.expireBlockhash();
      assert.ok(
        send(world.svm, accept, [world.creator]) instanceof FailedTransactionMetadata,
        "accept settlement cannot be replayed",
      );
    });

    await t.test("creator reject validates evidence and atomically releases the slot", async () => {
      const world = await setupReviewWorld({ submit: true });
      await setProtocolPaused(world.svm, true);
      const accounts = {
        task: world.task,
        claim: world.claim,
        taskValidationConfig: world.validation,
        taskSubmission: world.submission,
        worker: world.worker,
        protocolConfig: world.protocolConfig,
        creator: world.creator.publicKey,
        workerAuthority: world.workerAuthority.publicKey,
      };
      expectFail(
        send(
          world.svm,
          await world.creatorProgram.methods
            .rejectTaskResult(arr(Buffer.alloc(32)))
            .accounts(accounts)
            .instruction(),
          [world.creator],
        ),
        "InvalidEvidenceHash",
        "canary reject zero evidence",
      );
      world.svm.expireBlockhash();
      expectOk(
        send(
          world.svm,
          await world.creatorProgram.methods
            .rejectTaskResult(arr(id32()))
            .accounts(accounts)
            .instruction(),
          [world.creator],
        ),
        "canary reject while paused",
      );
      const taskAccount = decode(world.svm, "Task", world.task);
      assert.ok(taskAccount.status.Open !== undefined);
      assert.equal(taskAccount.current_workers, 0);
      assert.equal(decode(world.svm, "AgentRegistration", world.worker).active_tasks, 0);
      assert.ok(isClosed(world.svm, world.claim));
      assert.ok(isClosed(world.svm, world.submission));
      assert.ok(!isClosed(world.svm, world.escrow), "rejected work leaves reward escrowed");
    });
  },
);

test(
  "canary expire_claim is permissionless after grace and remains available while paused",
  { skip: !RUN_CANARY },
  async () => {
    const world = await setupReviewWorld({ submit: false, deadlineOffset: 60 });
    await setProtocolPaused(world.svm, true);
    const accounts = {
      authority: world.crank.publicKey,
      task: world.task,
      escrow: world.escrow,
      claim: world.claim,
      worker: world.worker,
      protocolConfig: world.protocolConfig,
      taskValidationConfig: world.validation,
      taskSubmission: null,
      rentRecipient: world.workerAuthority.publicKey,
      workerCompletionBond: null,
      bondCreator: null,
      systemProgram: SystemProgram.programId,
    };
    const build = () =>
      makeCanaryProgram(world.crank).methods
        .expireClaim()
        .accounts(accounts)
        .instruction();
    expectFail(
      send(world.svm, await build(), [world.crank]),
      "ClaimNotExpired",
      "canary premature claim expiry",
    );

    const expiresAt = Number(decode(world.svm, "TaskClaim", world.claim).expires_at);
    setClock(world.svm, expiresAt + 61);
    const workerBefore = world.svm.getBalance(world.workerAuthority.publicKey);
    const escrowBefore = decode(world.svm, "TaskEscrow", world.escrow);
    expectOk(
      send(world.svm, await build(), [world.crank]),
      "canary permissionless expiry while paused",
    );
    const taskAccount = decode(world.svm, "Task", world.task);
    assert.ok(taskAccount.status.Open !== undefined);
    assert.equal(taskAccount.current_workers, 0);
    assert.equal(decode(world.svm, "AgentRegistration", world.worker).active_tasks, 0);
    assert.ok(isClosed(world.svm, world.claim));
    assert.ok(world.svm.getBalance(world.workerAuthority.publicKey) > workerBefore);
    assert.ok(
      Number(decode(world.svm, "TaskEscrow", world.escrow).distributed) >
        Number(escrowBefore.distributed),
      "cleanup reward is accounted in escrow.distributed",
    );
    world.svm.expireBlockhash();
    assert.ok(
      send(world.svm, await build(), [world.crank]) instanceof FailedTransactionMetadata,
      "expired claim cannot be replayed",
    );
  },
);

test(
  "canary cancel_task refunds escrow and drains a live no-show claim while paused",
  { skip: !RUN_CANARY },
  async () => {
    const world = await setupReviewWorld({ submit: false, deadlineOffset: 60 });
    await setProtocolPaused(world.svm, true);
    setClock(world.svm, world.deadline + 1);
    const workerAccounts = [
      { pubkey: world.claim, isSigner: false, isWritable: true },
      { pubkey: world.worker, isSigner: false, isWritable: true },
      {
        pubkey: world.workerAuthority.publicKey,
        isSigner: false,
        isWritable: true,
      },
    ];
    const build = (signer) =>
      makeCanaryProgram(signer).methods
        .cancelTask()
        .accounts({
          task: world.task,
          escrow: world.escrow,
          authority: signer.publicKey,
          protocolConfig: world.protocolConfig,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(workerAccounts)
        .instruction();

    expectFail(
      send(world.svm, await build(world.attacker), [world.attacker]),
      "UnauthorizedTaskAction",
      "canary non-creator cancel",
    );
    const creatorBefore = world.svm.getBalance(world.creator.publicKey);
    const workerBefore = world.svm.getBalance(world.workerAuthority.publicKey);
    expectOk(
      send(world.svm, await build(world.creator), [world.creator]),
      "canary cancel live no-show while paused",
    );
    const taskAccount = decode(world.svm, "Task", world.task);
    assert.ok(taskAccount.status.Cancelled !== undefined);
    assert.equal(taskAccount.current_workers, 0);
    assert.equal(decode(world.svm, "AgentRegistration", world.worker).active_tasks, 0);
    assert.ok(isClosed(world.svm, world.claim));
    assert.ok(isClosed(world.svm, world.escrow));
    assert.ok(world.svm.getBalance(world.creator.publicKey) > creatorBefore);
    assert.ok(world.svm.getBalance(world.workerAuthority.publicKey) > workerBefore);
  },
);
