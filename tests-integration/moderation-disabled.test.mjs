import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, hireIx, configureTestMultisig, makeProgram, send, expectOk,
  expectFail, decode, id32, arr, enc, pda, moderationBlockPda, taskModV2Pda,
  warpSeconds, BN, SystemProgram,
} from "./harness.mjs";

// Uses the production SBF. Only Clock is advanced to exercise the production
// one-day liveness minimum; authority config/heartbeat/BLOCK writes are real ix.
for (const enabled of [false, true]) {
  for (const humanless of [false, true]) {
    test(`#274: enabled=${enabled}, humanless=${humanless}: exact liveness boundary, publish, claim, BLOCK, re-arm`, async () => {
      const w = await freshWorld({ moderationEnabled: enabled });
      const admin = makeProgram(w.admin);
      expectOk(send(w.svm, await admin.methods
        .configureTaskModeration(w.modAuth.publicKey, enabled)
        .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg,
          authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.admin]), "set actual config");
      expectOk(send(w.svm, await admin.methods.moderationHeartbeat(86400)
        .accounts({ moderationConfig: w.modCfg, authority: w.admin.publicKey })
        .instruction(), [w.admin]), "set one-day window");
      const jobHash = id32();
      async function hire() {
        if (!humanless) return hireIx(w, { taskJobSpecHash: jobHash });
        const taskId = id32();
        const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), taskId]);
        const [escrow] = pda([enc("escrow"), task.toBuffer()]);
        const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
        const ix = await w.buyerProg.methods
          .hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1), new BN(3600), null, 0, w.modAuth.publicKey, arr(jobHash))
          .accounts({ task, escrow, hireRecord,
            taskValidationConfig: pda([enc("task_validation"), task.toBuffer()])[0],
            listing: w.listing, providerAgent: w.providerAgent, protocolConfig: w.protocolPda,
            moderationConfig: w.modCfg, listingModeration: null, moderationAttestor: null,
            moderationBlock: moderationBlockPda(w.specHash)[0],
            authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
            creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
          .instruction();
        return { ix, task, escrow, hireRecord };
      }
      const rejected = await hire();
      expectFail(send(w.svm, rejected.ix, [w.buyer]), "TaskModerationRequired", "fresh strict mode");
      assert.equal(w.svm.getAccount(rejected.task), null);
      assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0);
      warpSeconds(w.svm, 86400);
      expectFail(send(w.svm, (await hire()).ix, [w.buyer]), "TaskModerationRequired", "equal boundary stays strict");
      warpSeconds(w.svm, 1);
      const relaxed = await hire();
      expectOk(send(w.svm, relaxed.ix, [w.buyer]), "silence relaxes hire");
      const [taskJobSpec] = pda([enc("task_job_spec"), relaxed.task.toBuffer()]);
      expectOk(send(w.svm, await w.buyerProg.methods
        .setTaskJobSpec(arr(jobHash), "agenc://job-spec/274-relaxed", w.modAuth.publicKey)
        .accounts({ protocolConfig: w.protocolPda, task: relaxed.task,
          moderationConfig: w.modCfg, taskModeration: taskModV2Pda(relaxed.task, jobHash, w.modAuth.publicKey)[0],
          moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0],
          taskJobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.buyer]), "relaxed task is publishable without attestation");
      expectOk(send(w.svm, await w.providerProg.methods.claimTaskWithJobSpec()
        .accounts({ task: relaxed.task, taskJobSpec, hireRecord: relaxed.hireRecord,
          legacyListing: null, moderationBlock: moderationBlockPda(jobHash)[0],
          claim: pda([enc("claim"), relaxed.task.toBuffer(), w.providerAgent.toBuffer()])[0],
          protocolConfig: w.protocolPda, worker: w.providerAgent,
          authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.provider]), "relaxed task is claimable");
      assert.equal(decode(w.svm, "Task", relaxed.task).current_workers, 1);

      const multisig = await configureTestMultisig(w);
      expectOk(send(w.svm, await admin.methods.setModerationBlock(arr(w.specHash), arr(id32()), "agenc://ruling/274")
        .accounts({ protocolConfig: w.protocolPda, moderationBlock: moderationBlockPda(w.specHash)[0],
          authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
        .remainingAccounts(multisig.remainingAccounts).instruction(), multisig.approvers), "set BLOCK while relaxed");
      expectFail(send(w.svm, (await hire()).ix, [w.buyer]), "ContentBlocked", "deadman never relaxes BLOCK");
      expectOk(send(w.svm, await admin.methods.clearModerationBlock()
        .accounts({ protocolConfig: w.protocolPda, moderationBlock: moderationBlockPda(w.specHash)[0],
          authority: w.admin.publicKey })
        .remainingAccounts(multisig.remainingAccounts).instruction(), multisig.approvers), "clear BLOCK");
      expectOk(send(w.svm, await admin.methods.moderationHeartbeat(null)
        .accounts({ moderationConfig: w.modCfg, authority: w.admin.publicKey })
        .instruction(), [w.admin]), "heartbeat re-arms");
      expectFail(send(w.svm, (await hire()).ix, [w.buyer]), "TaskModerationRequired", "re-armed hire fails closed");
    });
  }
}
