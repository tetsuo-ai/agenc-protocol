// Opt-in LiteSVM regression for the frozen mainnet-canary binary.
// Run after `npm run canary:build` with:
//   AGENC_CANARY_LITESVM=1 node --test tests-integration/canary-*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  TransactionInstruction,
} from "@solana/web3.js";
import {
  REPO,
  SO,
  IDL,
  PID,
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
  warpSeconds,
  Program,
  AnchorProvider,
  BN,
  Wallet,
  LiteSVM,
  FailedTransactionMetadata,
  Connection,
  Keypair,
  SystemProgram,
} from "./harness.mjs";

const RUN_CANARY = process.env.AGENC_CANARY_LITESVM === "1";
// Keep the normal production wildcard suite runnable from a clean checkout.
// A skipped node:test callback is not entered, but top-level module evaluation
// still runs; reading the ignored canary IDL here unconditionally used to make
// the production release gate fail with ENOENT before it could register the skip.
const CANARY_IDL = RUN_CANARY
  ? JSON.parse(
      fs.readFileSync(
        path.join(REPO, "target/idl/agenc_coordination.canary.json"),
        "utf8",
      ),
    )
  : null;

function makeCanaryProgram(payer) {
  assert.ok(
    CANARY_IDL,
    "canary IDL must be loaded for the opt-in compiled test",
  );
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:9999"),
    new Wallet(payer),
    { commitment: "processed" },
  );
  return new Program(CANARY_IDL, provider);
}

test(
  "canary compiled dispatcher recognizes every frozen instruction discriminator",
  { skip: !RUN_CANARY },
  () => {
    const svm = new LiteSVM();
    svm.addProgramFromFile(PID, SO);
    const payer = Keypair.generate();
    svm.airdrop(payer.publicKey, 10_000_000_000n);
    assert.equal(CANARY_IDL.instructions.length, 25, "frozen canary surface size");

    for (const instruction of CANARY_IDL.instructions) {
      const result = send(
        svm,
        new TransactionInstruction({
          programId: PID,
          keys: [],
          data: Buffer.from(instruction.discriminator),
        }),
        [payer],
      );
      assert.ok(
        result instanceof FailedTransactionMetadata,
        `${instruction.name}: account-less dispatch must fail`,
      );
      const logs = result.meta().logs().join("\n");
      const displayName = instruction.name
        .split("_")
        .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
        .join("");
      assert.match(
        logs,
        new RegExp(`Instruction: ${displayName}`),
        `${instruction.name}: compiled dispatcher did not recognize the frozen discriminator`,
      );
      assert.doesNotMatch(
        logs,
        /panicked at|memory allocation failed|Access violation|Program failed to complete/i,
        `${instruction.name}: malformed account surface must fail without a processor panic`,
      );
      svm.expireBlockhash();
    }

    // A full-surface binary is a superset and would satisfy every positive
    // discriminator assertion above. Prove the loaded artifact is actually
    // the restricted canary by requiring one production-only instruction to
    // miss the compiled dispatcher entirely.
    const productionOnly = IDL.instructions.find(
      ({ name }) => name === "create_dependent_task",
    );
    assert.ok(productionOnly, "full IDL must expose create_dependent_task");
    const productionOnlyResult = send(
      svm,
      new TransactionInstruction({
        programId: PID,
        keys: [],
        data: Buffer.from(productionOnly.discriminator),
      }),
      [payer],
    );
    assert.ok(
      productionOnlyResult instanceof FailedTransactionMetadata,
      "production-only discriminator must fail against the canary binary",
    );
    const productionOnlyLogs = productionOnlyResult.meta().logs().join("\n");
    assert.match(productionOnlyLogs, /InstructionFallbackNotFound/);
    assert.doesNotMatch(
      productionOnlyLogs,
      /Instruction: CreateDependentTask/,
      "canary binary must not dispatch production-only instructions",
    );
  },
);

test(
  "canary CreatorReview timeout: permissionless crank settles exactly once without redirecting creator rent",
  { skip: !RUN_CANARY },
  async () => {
    const svm = new LiteSVM();
    svm.addProgramFromFile(PID, SO);
    const clock = svm.getClock();
    clock.unixTimestamp = 1_700_000_000n;
    svm.setClock(clock);

    const admin = Keypair.generate();
    const creator = Keypair.generate();
    const workerAuthority = Keypair.generate();
    const moderator = Keypair.generate();
    const crank = Keypair.generate();
    const wrongRecipient = Keypair.generate();
    for (const keypair of [
      admin,
      creator,
      workerAuthority,
      moderator,
      crank,
      wrongRecipient,
    ]) {
      svm.airdrop(keypair.publicKey, 100_000_000_000n);
    }

    const protocolConfig = await injectProtocolConfig(svm, admin);
    const moderationConfig = await injectModerationConfig(svm, admin, moderator, true);
    const creatorProgram = makeCanaryProgram(creator);
    const workerProgram = makeCanaryProgram(workerAuthority);
    const moderatorProgram = makeCanaryProgram(moderator);
    const crankProgram = makeCanaryProgram(crank);

    const creatorAgentId = id32();
    const [creatorAgent] = pda([enc("agent"), creatorAgentId]);
    expectOk(
      send(
        svm,
        await creatorProgram.methods
          .registerAgent(arr(creatorAgentId), new BN(1), "http://creator.test", null, new BN(0))
          .accounts({
            agent: creatorAgent,
            protocolConfig,
            authority: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [creator],
      ),
      "canary:register creator",
    );

    const workerAgentId = id32();
    const [worker] = pda([enc("agent"), workerAgentId]);
    expectOk(
      send(
        svm,
        await workerProgram.methods
          .registerAgent(arr(workerAgentId), new BN(1), "http://worker.test", null, new BN(0))
          .accounts({
            agent: worker,
            protocolConfig,
            authority: workerAuthority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [workerAuthority],
      ),
      "canary:register worker",
    );

    const reward = 2_000_000;
    const taskId = id32();
    const [task] = pda([enc("task"), creator.publicKey.toBuffer(), taskId]);
    const [escrow] = pda([enc("escrow"), task.toBuffer()]);
    const [authorityRateLimit] = pda([
      enc("authority_rate_limit"),
      creator.publicKey.toBuffer(),
    ]);
    const description = Buffer.alloc(64);
    description.set(id32(), 0);
    const deadline = Number(svm.getClock().unixTimestamp) + 3_600;
    expectOk(
      send(
        svm,
        await creatorProgram.methods
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

    const [validation] = pda([enc("task_validation"), task.toBuffer()]);
    const [attestorConfig] = pda([enc("task_attestor"), task.toBuffer()]);
    const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
    const reviewWindow = 30;
    expectOk(
      send(
        svm,
        await creatorProgram.methods
          .configureTaskValidation(1, new BN(reviewWindow), 0, null)
          .accounts({
            task,
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
      task.toBuffer(),
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
            task,
            taskModeration,
            moderator: moderator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [moderator],
      ),
      "canary:moderate task",
    );

    const [taskJobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
    expectOk(
      send(
        svm,
        await creatorProgram.methods
          .setTaskJobSpec(arr(jobSpecHash), "agenc://job-spec/sha256/canary-timeout")
          .accounts({
            protocolConfig,
            task,
            moderationConfig,
            taskModeration,
            taskJobSpec,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [creator],
      ),
      "canary:publish job spec",
    );

    const [claim] = pda([enc("claim"), task.toBuffer(), worker.toBuffer()]);
    expectOk(
      send(
        svm,
        await workerProgram.methods
          .claimTaskWithJobSpec()
          .accounts({
            task,
            taskJobSpec,
            claim,
            protocolConfig,
            worker,
            authority: workerAuthority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [workerAuthority],
      ),
      "canary:claim",
    );

    const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
    const resultData = Buffer.alloc(64);
    resultData.set(id32(), 0);
    expectOk(
      send(
        svm,
        await workerProgram.methods
          .submitTaskResult(arr(id32()), arr(resultData))
          .accounts({
            task,
            claim,
            taskValidationConfig: validation,
            taskSubmission: submission,
            protocolConfig,
            worker,
            authority: workerAuthority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [workerAuthority],
      ),
      "canary:submit",
    );

    const acceptAccounts = (operator) => ({
      task,
      claim,
      escrow,
      taskValidationConfig: validation,
      taskSubmission: submission,
      worker,
      protocolConfig,
      treasury: admin.publicKey,
      creator: crank.publicKey,
      workerAuthority: workerAuthority.publicKey,
      hireRecord: null,
      operator,
      referrer: null,
      systemProgram: SystemProgram.programId,
    });

    const preDeadline = await crankProgram.methods
      .acceptTaskResult()
      .accounts(acceptAccounts(creator.publicKey))
      .instruction();
    expectFail(
      send(svm, preDeadline, [crank]),
      "ReviewWindowNotElapsed",
      "canary:pre-deadline crank",
    );

    warpSeconds(svm, reviewWindow);
    const wrongCreatorRecipient = await crankProgram.methods
      .acceptTaskResult()
      .accounts(acceptAccounts(wrongRecipient.publicKey))
      .instruction();
    expectFail(
      send(svm, wrongCreatorRecipient, [crank]),
      "InvalidCreator",
      "canary:redirected creator rent",
    );

    const workerBalanceBefore = svm.getBalance(workerAuthority.publicKey);
    const treasuryBalanceBefore = svm.getBalance(admin.publicKey);
    const creatorBalanceBefore = svm.getBalance(creator.publicKey);
    const protocolBefore = decode(svm, "ProtocolConfig", protocolConfig);
    const settle = await crankProgram.methods
      .acceptTaskResult()
      .accounts(acceptAccounts(creator.publicKey))
      .instruction();
    expectOk(send(svm, settle, [crank]), "canary:timeout settle");

    const settledTask = decode(svm, "Task", task);
    assert.ok(settledTask.status.Completed !== undefined, "task completed");
    assert.equal(settledTask.current_workers, 0, "task worker slot released");
    assert.equal(
      decode(svm, "AgentRegistration", worker).active_tasks,
      0,
      "worker active-task slot released",
    );
    assert.equal(
      decode(svm, "TaskValidationConfig", validation)._reserved[1],
      0,
      "pending review counter released",
    );
    assert.ok(isClosed(svm, escrow), "escrow closed");
    assert.ok(isClosed(svm, claim), "claim rent returned to worker");
    assert.ok(isClosed(svm, submission), "submission rent returned to worker");
    assert.ok(svm.getBalance(workerAuthority.publicKey) > workerBalanceBefore, "worker paid");
    assert.ok(svm.getBalance(admin.publicKey) > treasuryBalanceBefore, "treasury paid");
    assert.ok(
      svm.getBalance(creator.publicKey) > creatorBalanceBefore,
      "escrow rent returned to the stored creator, not the crank",
    );
    assert.equal(
      Number(decode(svm, "ProtocolConfig", protocolConfig).completed_tasks),
      Number(protocolBefore.completed_tasks) + 1,
      "protocol completion count incremented exactly once",
    );

    svm.expireBlockhash();
    const replay = send(svm, settle, [crank]);
    assert.ok(replay instanceof FailedTransactionMetadata, "settlement replay must fail");
  },
);
