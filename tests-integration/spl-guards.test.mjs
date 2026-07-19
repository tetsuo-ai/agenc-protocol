// Audit F-7 + F-4: SPL/token-task guards.
//
// F-7: reject_and_freeze had no reward_mint guard, but both frozen exits settle
// SOL-only — one freeze on an SPL task would lock 100% of the token escrow. It now
// rejects token tasks (RejectFrozenSolOnly), mirroring the contest/bond/ghost-split
// SOL-only guards.
//
// F-4: expire_claim's 1000-lamport cleanup reward is debited from the escrow PDA,
// which on token tasks holds ONLY its rent (the reward tokens live in the token
// escrow ATA) — the debit breaks rent exemption (InsufficientFundsForRent) and
// bricks expire_claim for every token task. The reward is now skipped on token
// tasks (SOL path unchanged).
//
// Revert-sensitive: removing the F-7 guard lets the freeze proceed; removing the
// F-4 skip makes the token expire_claim fail at the runtime rent check.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  enc, arr, pda, id32,
  makeProgram, send, sendMany, expectOk, expectFail, decode, isClosed, tokenAmount,
  freshWorld, taskModV2Pda, moderationBlockPda,
  BN, Keypair,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const REWARD = 5_000_000;

// Create a mint + funded buyer ATA, then a token-denominated task
// (CreatorReview when manual, AUTO otherwise) with moderation published and the
// provider's claim (+ optional submission).
async function setupTokenTask(w, { submit = false, manual = true } = {}) {
  const mint = Keypair.generate();
  const rent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(sendMany(w.svm, [
    SystemProgram.createAccount({ fromPubkey: w.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null),
  ], [w.admin, mint]), "spl:mint");
  const buyerAta = getAssociatedTokenAddressSync(mint.publicKey, w.buyer.publicKey);
  expectOk(sendMany(w.svm, [
    createAssociatedTokenAccountInstruction(w.admin.publicKey, buyerAta, w.buyer.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, buyerAta, w.admin.publicKey, REWARD),
  ], [w.admin]), "spl:ata+fund");

  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(REWARD), 1, new BN(now + 3600), 0, null, 0, mint.publicKey, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: mint.publicKey, creatorTokenAccount: buyerAta, tokenEscrowAta: escrowAta, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })
    .instruction(), [w.buyer]), "token create_task");
  if (manual) {
    expectOk(send(w.svm, await w.buyerProg.methods
      .configureTaskValidation(1, new BN(3600), 0, null)
      .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "configure CreatorReview");
  }

  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/spl", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec,
      hireRecord: pda([enc("hire"), task.toBuffer()])[0], legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  if (submit) {
    const desc2 = Buffer.alloc(64);
    desc2.set(crypto.randomBytes(32), 0);
    expectOk(send(w.svm, await w.providerProg.methods
      .submitTaskResult(arr(id32()), arr(desc2))
      .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.provider]), "submit");
  }

  return { mint, task, escrow, escrowAta, validation, claim, submission };
}

test("F-7: reject_and_freeze is rejected on a token task (RejectFrozenSolOnly)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenTask(w, { submit: true });

  const ataBefore = tokenAmount(w.svm, r.escrowAta);
  expectFail(
    send(w.svm, await w.buyerProg.methods
      .rejectAndFreeze(arr(id32()))
      .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: null, systemProgram: null })
      .instruction(), [w.buyer]),
    "RejectFrozenSolOnly",
    "reject_and_freeze refuses token tasks (F-7)",
  );

  // Nothing froze and nothing moved: task still PendingValidation, tokens untouched.
  assert.ok(decode(w.svm, "Task", r.task).status.PendingValidation !== undefined, "task not frozen");
  assert.equal(tokenAmount(w.svm, r.escrowAta), ataBefore, "token escrow untouched by the rejected freeze");
});

test("F-4: expire_claim works on a token task and moves NO lamports out of the escrow PDA", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenTask(w, { submit: false, manual: false });

  // Warp past claim expiry + the 60s grace window so a neutral caller can expire.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n;
  w.svm.setClock(clk);

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const escrowLamportsBefore = Number(w.svm.getBalance(r.escrow));
  // expire_claim's pure-no-show path requires the (canonical) bond accounts (#71);
  // no bond was posted, so the derived empty PDA no-ops.
  const [workerBond] = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()]);

  expectOk(send(w.svm, await makeProgram(cleaner).methods
    .expireClaim()
    .accounts({
      authority: cleaner.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBond, bondCreator: w.buyer.publicKey,
      treasury: null, systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [cleaner]), "expire_claim on a token task (pre-fix: InsufficientFundsForRent)");

  // The cleanup reward was skipped: not one lamport left the rent-only escrow PDA,
  // and the token-denominated distributed counter was not polluted.
  assert.equal(Number(w.svm.getBalance(r.escrow)), escrowLamportsBefore, "escrow PDA lamports unchanged (rent intact)");
  assert.equal(Number(decode(w.svm, "TaskEscrow", r.escrow).distributed), 0, "no lamport pollution of distributed");
  assert.ok(isClosed(w.svm, r.claim), "claim closed");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "worker count freed");
});
