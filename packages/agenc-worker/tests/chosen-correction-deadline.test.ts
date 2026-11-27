import {expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {emptyState,saveState} from "../src/state.js";
import {correctChosenWork} from "../src/chosen-correction.js";
const clock=vi.hoisted(()=>({ms:1000}));
vi.mock("../src/boot-clock.js",()=>({monotonicMs:()=>clock.ms}));
const held=vi.hoisted(()=>vi.fn());
const read=vi.hoisted(()=>vi.fn());
vi.mock("../src/chosen.js",()=>({heldWork:held}));
vi.mock("../src/upkeep.js",()=>({readTaskAccount:read}));
it.each(["clock","launch","active"])("holds a correction that expires during %s",async delay=>{
  clock.ms=1000;
  const root=mkdtempSync(join(tmpdir(),"correction-time-"));
  const task="11111111111111111111111111111111",hash=createHash("sha256").update("first").digest("hex");
  const state=emptyState();
  state.openClaim={task,claimedAt:new Date().toISOString(),phase:"executed",chosen:true,modelBudget:{totalCents:10,remainingCents:0,correctionCents:2},
    execution:{resultBytesBase64:Buffer.from("first").toString("base64"),resultHashHex:hash,rewardAmount:"10",executedAt:new Date().toISOString()}};
  saveState(root,state);mkdirSync(join(root,"seller-claim"));
  held.mockResolvedValue({task,canSubmit:true,resultHash:hash,claimAccount:"claim",deadline:1400,expiresAt:9000,releaseWindow:null});
  read.mockResolvedValue({kind:"task",task:{creator:"buyer",requiredCapabilities:1n}});
  const execute=vi.fn(async (input:{signal:AbortSignal})=>{
    if (delay === "active") {
      clock.ms+=110000;
      await new Promise<void>(resolve=>{
        const fallback=setTimeout(resolve,700);
        input.signal.addEventListener("abort",()=>{clearTimeout(fallback);resolve();},{once:true});
      });
      input.signal.throwIfAborted();
    }
    return {stdout:Buffer.from("second")};
  });
  const launch=vi.fn(async(...args:unknown[])=>{
    expect(args[8]).toBe(1100n);
    if(delay==="launch") clock.ms+=110000;
    (args[10] as ()=>void)();
    return ["room"];
  });
  const ctx={stateDir:root,modelSpendDir:root,signer:{address:"seller"},
    config:{executorMode:"sandboxed",executorTimeoutMs:600000,executorEnvAllowlist:[]},
    withChosenRoom:(fn:(s:AbortSignal)=>unknown)=>fn(new AbortController().signal),checkChosenRoom:async()=>{},
    executorForTask:launch,reviewRoom:{execute},clusterTime:async()=>{if(delay==="clock")clock.ms+=110000;return 1000;}};
  try {
    await expect(correctChosenWork(ctx as never,{} as never,new AbortController().signal,task as never,hash,"One edit",async()=>[],async()=>{})).rejects.toThrow(/deadline|time|expired/i);
    expect(execute).toHaveBeenCalledTimes(delay === "active" ? 1 : 0);
    expect(existsSync(join(root,"seller-claim","-1"))).toBe(delay === "active");
  }finally{rmSync(root,{recursive:true,force:true});}
});
