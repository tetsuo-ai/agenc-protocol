import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { earnOptions } from "../src/earn-bootstrap.js";
import { checkBusinessRoom } from "../src/business-room.js";

it("retains the money restrictions and chosen switch with only a named executor", () => {
  const config = earnOptions({ownerToken:"fake",unlockSecret:"fake",earn:{ executor:null, ownJobsOnly:true,
    maxRewardLamports:"10000000", chosenRoomSetting:"/fake/preferences", agentExecutors:{} }});
  expect(config).toMatchObject({ executor:null, ownJobsOnly:true, maxRewardLamports:10_000_000n });
  expect(config.chosenRoomEnabled).toBeTypeOf("function");
});

it("invalidates admission for key changes and executable changes without restarting", () => {
  const dir = mkdtempSync(join(tmpdir(),"live-room-"));
  const file = (n:string) => join(dir,n);
  try {
    const liveRoom = {setting:file("choice"), keyStore:file("fake-key-store"), coreCandidates:[file("core")],
      baseFiles:[file("base")], agentFiles:[file("claude")]};
    for (const n of ["choice","base","claude","fake-key-store"]) writeFileSync(file(n),"test");
    const config = earnOptions({ownerToken:"fake",unlockSecret:"fake",earn:{executor:{mode:"sandboxed",isolatedJobRoom:true,
      argv:[process.execPath,"{prompt}"],readiness:{argv:[process.execPath]}}, defaultRoomSetting:liveRoom.setting, liveRoom}});
    expect(config.defaultExecutorEnabled?.()).toBe(true);
    rmSync(file("choice"));
    expect(config.defaultExecutorEnabled?.()).toBe(false);
    writeFileSync(file("core"),"stand-in", {mode:0o700});
    expect(config.defaultExecutorEnabled?.()).toBe(true);
    expect(config.liveRoomState?.().coreCommand).toBe(file("core"));
    const generation = config.defaultExecutorGeneration!();
    rmSync(file("fake-key-store"));
    expect(config.defaultExecutorGeneration!()).not.toBe(generation);
    const before = config.defaultExecutorGeneration!();
    chmodSync(file("core"),0o600);
    expect(config.defaultExecutorGeneration!()).not.toBe(before);
    expect(config.defaultExecutorEnabled?.()).toBe(false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("funds and restores the named seller using its own room probe", async () => {
  const room = {mode:"sandboxed" as const,timeoutMs:1000,envAllowlist:[],argv:[process.execPath,"{prompt}"],
    readiness:{argv:[process.execPath,"-e","process.exit(0)"]}};
  await expect(checkBusinessRoom({executor:null,agentExecutors:{named:room},chosenRoomEnabled:()=>true},
    "named", () => room)).resolves.toBeUndefined();
});
