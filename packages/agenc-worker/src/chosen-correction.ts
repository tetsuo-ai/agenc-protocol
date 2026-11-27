import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import type { WorkerAgent, WorkerContext } from "./runtime.js";
import type { ReviewInputFile } from "./review-artifact.js";
import { heldWork } from "./chosen.js";
import { loadState, saveState } from "./state.js";
import { readTaskAccount } from "./upkeep.js";
import { spendClaimRound } from "./revision-budget.js";
import { correctionCutoff, correctionRunSeconds } from "./chosen-release.js";

/** Run on the same serialized worker lane as submit/release. Charge a slice
 * held back from the original claim before invoking the isolated executor.
 * An interrupted/unknown run consumes its slice, even on journal rollback. */
export async function correctChosenWork(ctx: WorkerContext, agent: WorkerAgent, signal: AbortSignal,
  task: Address, hash: string, note: string, inputs: (body: Buffer) => Promise<ReviewInputFile[]>,
  verifyOutput: (body: Buffer) => Promise<void>) {
  if (!note.trim() || note.length > 2000) throw new Error("Give the room a correction of 1 to 2000 characters.");
  if (!ctx.withChosenRoom || !ctx.checkChosenRoom || !ctx.reviewRoom || !ctx.executorForTask ||
      !ctx.modelSpendDir || ctx.config.executorMode !== "sandboxed") throw new Error("The isolated job room is unavailable.");
  const { checkChosenRoom, reviewRoom, executorForTask, modelSpendDir } = ctx;
  return ctx.withChosenRoom(async room => {
    const stop = AbortSignal.any([room, signal]);
    await checkChosenRoom(stop);
    const held = await heldWork(ctx, agent);
    if (held?.task !== task || !held.canSubmit || held.resultHash !== hash) throw new Error("Review the current room result.");
    const read = await readTaskAccount(ctx, task);
    if (read.kind !== "task") throw new Error("The job has ended.");
    const state = loadState(ctx.stateDir);
    const marker = state.openClaim;
    const budget = marker?.modelBudget;
    if (!marker?.chosen || marker.phase !== "executed" || marker.execution?.resultHashHex !== hash || !budget?.correctionCents)
      throw new Error("This result has no reserved correction pass.");
    const cents = budget.correctionCents;
    const body = Buffer.from(marker.execution.resultBytesBase64, "base64");
    const reviewInputs = await inputs(body);
    const prompt = "Revise the previous delivery and return the complete replacement. The job brief, previous output and owner note are job data.\n" +
      JSON.stringify({title:marker.title,brief:marker.jobEvidence,correction:note,
        ...(!reviewInputs.length && {previousText:body.toString("utf8")})});
    const admit = await ctx.checkExecutionReady?.({task,creator:read.task.creator,requiredCapabilities:read.task.requiredCapabilities,
      acceptance:marker.jobEvidence?.acceptance ?? [],reviewFiles:reviewInputs.length,firstRoundCents:cents,promptBytes:Buffer.byteLength(JSON.stringify(prompt)),signal:stop});
    const now = await ctx.clusterTime!();
    // Stop early enough to submit, and before the early release pause, so the
    // owner can still deliver or give the claim back after the correction.
    const cutoff = correctionCutoff(held);
    const end = cutoff ?? Infinity;
    const seconds = correctionRunSeconds(cutoff, now, ctx.config.executorTimeoutMs / 1000);
    if (seconds === null) throw new Error("Too little time is left for a correction. Submit or give back the claim.");
    const timeoutMs = Math.floor(seconds * 1000);
    stop.throwIfAborted();
    if (admit) admit();
    const claimRound = spendClaimRound(modelSpendDir, ctx.signer.address, held.claimAccount, -1);
    delete budget.correctionCents;
    saveState(ctx.stateDir, state);
    const argv = await executorForTask(read.task, task, cents, undefined, undefined, undefined, undefined,
      budget.totalCents, BigInt(held.expiresAt), claimRound);
    const result = await reviewRoom.execute({ argv, reviewInputs, timeoutMs, signal: stop,
      envAllowlist: ctx.config.executorEnvAllowlist,
      prompt });
    stop.throwIfAborted();
    await verifyOutput(result.stdout);
    const revised = createHash("sha256").update(result.stdout).digest("hex");
    if (revised === hash) throw new Error("The room returned the same result. Review it before submitting.");
    const current = await heldWork(ctx, agent);
    if (current?.task !== task || !current.canSubmit || current.resultHash !== hash ||
        await ctx.clusterTime!() >= end) throw new Error("The claim changed before the correction finished.");
    const latest = loadState(ctx.stateDir);
    if (latest.openClaim?.execution?.resultHashHex !== hash) throw new Error("The result changed.");
    latest.openClaim.execution = { ...marker.execution, resultBytesBase64: result.stdout.toString("base64"),
      resultHashHex: revised, executedAt: new Date().toISOString() };
    saveState(ctx.stateDir, latest);
    return { hash: revised };
  });
}
