import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, hireIx, makeProgram, send, expectOk, expectFail, decode,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  id32, arr, enc, pda, BN, SystemProgram, warpSeconds,
} from "./harness.mjs";

// Unknown schema bytes cannot be produced by valid instructions. Corrupt only
// that precondition in LiteSVM, then exercise the real production SBF readers.
for (const byte of [4, 5]) {
  for (const relaxed of [false, true]) {
    test(`#278: unknown ModerationConfig byte ${byte} fails closed, relaxed=${relaxed}`, async () => {
      const w = await freshWorld();
      const admin = makeProgram(w.admin);
      expectOk(send(w.svm, await admin.methods.moderationHeartbeat(86400)
        .accounts({ moderationConfig: w.modCfg, authority: w.admin.publicKey })
        .instruction(), [w.admin]), "set supported liveness carve");
      const jobHash = id32();
      const existing = await hireIx(w, { taskJobSpecHash: jobHash });
      expectOk(send(w.svm, existing.ix, [w.buyer]), "fund while config is valid");
      const taskMod = taskModV2Pda(existing.task, jobHash, w.modAuth.publicKey)[0];
      const recordTask = await makeProgram(w.modAuth).methods
        .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(id32()), arr(id32()), new BN(0))
        .accounts({ moderationConfig: w.modCfg, task: existing.task, taskModeration: taskMod,
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
        .instruction();
      expectOk(send(w.svm, recordTask, [w.modAuth]), "attest while config is valid");
      const beforeConfig = w.svm.getAccount(w.modCfg);
      const corrupted = Buffer.from(beforeConfig.data);
      corrupted[corrupted.length - 6 + byte] = 1;
      w.svm.setAccount(w.modCfg, { ...beforeConfig, data: corrupted });
      if (relaxed) warpSeconds(w.svm, 86401);
      const newHire = await hireIx(w, { taskJobSpecHash: jobHash });
      expectFail(send(w.svm, newHire.ix, [w.buyer]), "InvalidModerationConfig", "registered hire");
      assert.equal(w.svm.getAccount(newHire.task), null);
      assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

      const taskId = id32();
      const task = pda([enc("task"), w.buyer.publicKey.toBuffer(), taskId])[0];
      expectFail(send(w.svm, await w.buyerProg.methods
        .hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1), new BN(3600), null, 0, w.modAuth.publicKey, arr(jobHash))
        .accounts({ task, escrow: pda([enc("escrow"), task.toBuffer()])[0],
          hireRecord: pda([enc("hire"), task.toBuffer()])[0],
          taskValidationConfig: pda([enc("task_validation"), task.toBuffer()])[0],
          listing: w.listing, providerAgent: w.providerAgent, protocolConfig: w.protocolPda,
          moderationConfig: w.modCfg, listingModeration: w.defaultListingModeration,
          moderationAttestor: null, moderationBlock: moderationBlockPda(w.specHash)[0],
          authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
          creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.buyer]), "InvalidModerationConfig", "humanless hire");
      assert.equal(w.svm.getAccount(task), null);

      const jobSpec = pda([enc("task_job_spec"), existing.task.toBuffer()])[0];
      expectFail(send(w.svm, await w.buyerProg.methods
        .setTaskJobSpec(arr(jobHash), "agenc://job-spec/278", w.modAuth.publicKey)
        .accounts({ protocolConfig: w.protocolPda, task: existing.task, moderationConfig: w.modCfg,
          taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0],
          taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.buyer]), "InvalidModerationConfig", "publication");
      assert.equal(w.svm.getAccount(jobSpec), null);
      w.svm.expireBlockhash();
      expectFail(send(w.svm, recordTask, [w.modAuth]), "InvalidModerationConfig", "task attestation");
      expectFail(send(w.svm, await makeProgram(w.modAuth).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(id32()), arr(id32()), new BN(0))
        .accounts({ moderationConfig: w.modCfg, listing: w.listing,
          listingModeration: listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey)[0],
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
        .instruction(), [w.modAuth]), "InvalidModerationConfig", "listing attestation");
      expectFail(send(w.svm, await admin.methods.moderationHeartbeat(null)
        .accounts({ moderationConfig: w.modCfg, authority: w.admin.publicKey })
        .instruction(), [w.admin]), "InvalidModerationConfig", "heartbeat cannot reinterpret unknown schema");
      expectFail(send(w.svm, await admin.methods.configureTaskModeration(w.modAuth.publicKey, true)
        .accounts({ protocolConfig: w.protocolPda, moderationConfig: w.modCfg,
          authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.admin]), "InvalidModerationConfig", "configure cannot erase unknown schema");
      assert.deepEqual(Buffer.from(w.svm.getAccount(w.modCfg).data), corrupted);
    });
  }
}
