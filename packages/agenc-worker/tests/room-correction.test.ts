import { expect, it, vi } from "vitest";
import { correctChosenWork } from "../src/chosen-correction.js";
import type { WorkerContext } from "../src/runtime.js";
const s = vi.hoisted(() => ({marker:{} as any, spend:vi.fn(()=>"/fake/round")}));
vi.mock("../src/state.js",()=>({loadState:()=>({openClaim:s.marker}),saveState:vi.fn()}));
vi.mock("../src/revision-budget.js",()=>({spendClaimRound:s.spend}));
vi.mock("../src/upkeep.js",()=>({readTaskAccount:async()=>({kind:"task",task:{creator:"buyer",requiredCapabilities:1n}})}));
vi.mock("../src/chosen.js",()=>({heldWork:async()=>({task:"task",canSubmit:true,resultHash:"first",expiresAt:6000,deadline:6000,releaseWindow:null,claimAccount:"claim"})}));
it("admits the correction before charging it and passes a text result inline", async () => {
  const previous="First complete delivery.";
  s.marker={chosen:true,phase:"executed",execution:{resultHashHex:"first",resultBytesBase64:Buffer.from(previous).toString("base64")},modelBudget:{correctionCents:5,totalCents:20}};
  const signal=new AbortController().signal;
  const execute=vi.fn(async()=>({stdout:Buffer.from("Corrected delivery.")}));
  const ctx={config:{executorMode:"sandboxed",executorTimeoutMs:60000},withChosenRoom:(f:any)=>f(signal),
    checkChosenRoom:async()=>{},checkExecutionReady:async (job:any)=>{if(job.reviewFiles) throw new Error("Unsupported files.");},
    reviewRoom:{execute},modelSpendDir:"/fake",signer:{address:"seller"},executorForTask:async()=>["room"],clusterTime:async()=>1000} as unknown as WorkerContext;
  const correct=(files:any[])=>correctChosenWork(ctx,{} as never,signal,"task" as never,"first","Correct one sentence.",async()=>files,async()=>{});
  await expect(correct([{name:"file.txt",bytes:Buffer.from("review")}])).rejects.toThrow("Unsupported files");
  expect(s.spend).not.toHaveBeenCalled();
  expect(s.marker.modelBudget.correctionCents).toBe(5);
  await correct([]);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({prompt:expect.stringContaining(previous)}));
  expect(s.spend).toHaveBeenCalledOnce();
});
