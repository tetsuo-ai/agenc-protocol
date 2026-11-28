import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commandGeneration, liveRoomSelection } from "../src/room-selection.js";
import { earnOptions } from "../src/earn-bootstrap.js";
import { checkBusinessRoom } from "../src/business-room.js";

it("selects the installed Codex room live and refuses a plan without registration", () => {
  const dir = mkdtempSync(join(tmpdir(),"codex-selection-"));
  const path = (name:string) => join(dir,name);
  const room = {setting:path("choice"), keyStore:path("empty"),coreCandidates:[],
    baseFiles:[path("base")],agentFiles:[path("claude")],codexFiles:[path("codex")]};
  try {
    writeFileSync(path("base"),"fixture");
    writeFileSync(room.setting,JSON.stringify({agent:"codex-api"}));
    const read = liveRoomSelection(room);
    expect(read()).toMatchObject({agent:"codex-api",ready:false});
    writeFileSync(path("codex"),"fixture");
    const api = read();
    expect(api).toMatchObject({agent:"codex-api",ready:true});
    writeFileSync(room.setting,JSON.stringify({agent:"codex-plan"}));
    expect(read()).toMatchObject({agent:"codex-plan",ready:false});
    const plan = liveRoomSelection({...room,codexPlanMinimumCents:78})();
    expect(plan).toMatchObject({agent:"codex-plan",ready:true,minimumModelCents:78});
    expect(plan.generation).not.toBe(api.generation);
    writeFileSync(room.setting,"unreadable selection");
    expect(read().ready).toBe(false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("retains the money restrictions and chosen switch with only a named executor", () => {
  const config = earnOptions({
    ownerToken: "fake",
    unlockSecret: "fake",
    earn: {
      executor: null,
      ownJobsOnly: true,
      maxRewardLamports: "10000000",
      chosenRoomSetting: "/fake/preferences",
      agentExecutors: {},
    },
  });
  expect(config).toMatchObject({
    executor: null,
    ownJobsOnly: true,
    maxRewardLamports: 10_000_000n,
  });
  expect(config.chosenRoomEnabled).toBeTypeOf("function");
});

it("invalidates admission for key changes and executable changes without restarting", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-room-"));
  const file = (n: string) => join(dir, n);
  try {
    const liveRoom = {
      setting: file("choice"),
      keyStore: file("fake-key-store"),
      coreCandidates: [file("core")],
      baseFiles: [file("base")],
      agentFiles: [file("claude")],
    };
    for (const n of ["choice", "base", "claude", "fake-key-store"])
      writeFileSync(file(n), "test");
    const config = earnOptions({
      ownerToken: "fake",
      unlockSecret: "fake",
      earn: {
        executor: {
          mode: "sandboxed",
          isolatedJobRoom: true,
          argv: [process.execPath, "{prompt}"],
          readiness: { argv: [process.execPath] },
        },
        defaultRoomSetting: liveRoom.setting,
        liveRoom,
      },
    });
    expect(config.defaultExecutorEnabled?.()).toBe(true);
    rmSync(file("choice"));
    expect(config.defaultExecutorEnabled?.()).toBe(false);
    writeFileSync(file("core"), "stand-in", { mode: 0o700 });
    expect(config.defaultExecutorEnabled?.()).toBe(true);
    expect(config.liveRoomState?.().coreCommand).toBe(file("core"));
    const generation = config.defaultExecutorGeneration!();
    writeFileSync(liveRoom.keyStore + ".epoch", "changing");
    expect(config.defaultExecutorEnabled?.()).toBe(false);
    rmSync(liveRoom.keyStore + ".epoch");
    rmSync(file("fake-key-store"));
    expect(config.defaultExecutorGeneration!()).not.toBe(generation);
    const before = config.defaultExecutorGeneration!();
    chmodSync(file("core"), 0o600);
    expect(config.defaultExecutorGeneration!()).not.toBe(before);
    expect(config.defaultExecutorEnabled?.()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("funds and restores the named seller using its own room probe", async () => {
  const room = {
    mode: "sandboxed" as const,
    timeoutMs: 1000,
    envAllowlist: [],
    argv: [process.execPath, "{prompt}"],
    readiness: { argv: [process.execPath, "-e", "process.exit(0)"] },
  };
  await expect(
    checkBusinessRoom(
      {
        executor: null,
        agentExecutors: { named: room },
        chosenRoomEnabled: () => true,
      },
      "named",
      () => room,
    ),
  ).resolves.toBeTypeOf("function");
});

it("invalidates a named peer admission if its pairing is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "named-pair-"));
  try {
    const profile = join(dir, "stand-in-pair");
    writeFileSync(profile, "first stand-in");
    const generation = () => commandGeneration([process.execPath], [process.execPath, "/room", "peer-ready", profile]);
    const before = generation();
    writeFileSync(profile, "new stand-in pairing");
    expect(generation()).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("tracks the selected ACP image and rejects a missing or unknown profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-room-"));
  const path = (n: string) => join(dir, n);
  const room = {setting:path("choice"), keyStore:path("keystore"), baseFiles:[path("base")],
    agentFiles:[path("claude")], coreCandidates:[], acpFiles:[path("acp")],
    acpPrices:{grok:{baseTicks:60_000_000_000, inputTicksPerByte:0,tokenHold:500000}, business:{baseTicks:1000,inputTicksPerByte:1,needsExpiry:true,tokenHold:32000}}};
  const select = liveRoomSelection(room);
  try {
    writeFileSync(path("base"), "");
    writeFileSync(path("choice"), JSON.stringify({agent:"grok",version:"1".repeat(64)}));
    expect(select().ready).toBe(false);
    writeFileSync(path("acp"), "stand-in");
    expect(select()).toMatchObject({agent:"acp", ready:true,identity:"acp:grok:"+"1".repeat(64), firstCall:room.acpPrices.grok});
    const initial = select().generation;
    writeFileSync(path("acp"), "changed");
    expect(select().generation).not.toBe(initial);
    writeFileSync(path("choice"), JSON.stringify({agent:"business",version:"2".repeat(64),validUntil:Date.now() - 1}));
    expect(select().ready).toBe(false);
    writeFileSync(path("choice"), JSON.stringify({agent:"business",version:"2".repeat(64),validUntil:Date.now() + 60000}));
    expect(select().ready).toBe(true);
    writeFileSync(path("choice"), JSON.stringify({agent:"unsupported"}));
    expect(select().ready).toBe(false);
    writeFileSync(path("choice"), JSON.stringify({agent:"claude-code"}));
    expect(select().ready).toBe(false);
    writeFileSync(path("claude"), "stand-in");
    expect(select()).toMatchObject({agent:"claude-code", ready:true});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("invalidates a ready room when machine settings arrive",async()=>{
  const {liveRoomSelection}=await import("../src/room-selection.js");
  const {mkdirSync}=await import("node:fs");
  const dir=mkdtempSync(join(tmpdir(),"managed-room-"));
  try {
    const path=join(dir,"core");
    writeFileSync(path,"fixture",{mode:0o700});
    const select=liveRoomSelection({setting:join(dir,"choice"),keyStore:join(dir,"store"),agentFiles:[path],baseFiles:[path],coreCandidates:[path],managedSettingsRoot:dir});
    const before=select();
    expect(before.ready).toBe(true);
    const config=join(dir,"config.toml");
    writeFileSync(config,"fixture");
    expect(select().ready).toBe(false);
    expect(select().generation).not.toBe(before.generation);
    rmSync(config);
    mkdirSync(join(dir,"config.d"));
    expect(select().ready).toBe(true);
    writeFileSync(join(dir,"config.d","rule.toml"),"test");
    expect(select().ready).toBe(false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it("keeps the seller selection stable when the same plan rotates its token", () => {
  const dir = mkdtempSync(join(tmpdir(),"codex-rotation-"));
  const setting = join(dir,"choice"), image = join(dir,"image");
  try {
    writeFileSync(image,"test image");
    const read = liveRoomSelection({setting,keyStore:join(dir,"keys"),coreCandidates:[],
      agentFiles:[image],baseFiles:[image],codexFiles:[image],codexPlanMinimumCents:78});
    const write = (version:string, tag:string) => writeFileSync(setting,JSON.stringify({
      agent:"codex-plan",version,tag,sealed:"fixture-"+tag}));
    write("a".repeat(64),"b".repeat(64));
    const selected = read();
    write("a".repeat(64),"c".repeat(64));
    expect(read()).toEqual(selected);
    const marker = join(dir,"0.refused");
    writeFileSync(join(dir,".paid-agent-claim."+"c".repeat(64)+"."+"e".repeat(64)),marker);
    writeFileSync(marker,"b".repeat(64));
    expect(read()).toEqual(selected);
    writeFileSync(marker,"c".repeat(64));
    expect(read().generation).not.toBe(selected.generation);
    write("d".repeat(64),"c".repeat(64));
    expect(read().generation).not.toBe(selected.generation);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("parks a known entitlement failure only for its profile, login version and refresh interval", () => {
  const root=mkdtempSync(join(tmpdir(),"model-access-"));
  const f=(n:string)=>join(root,n), version="a".repeat(64);
  try {
    writeFileSync(f("selection"),JSON.stringify({agent:"grok",version}));
    writeFileSync(f("image"),"fixture");
    const current=liveRoomSelection({setting:f("selection"),keyStore:f("keys"),baseFiles:[f("image")],agentFiles:[f("image")],
      acpFiles:[f("image")],coreCandidates:[],acpPrices:{grok:{baseTicks:60000000000,inputTicksPerByte:0,tokenHold:500000}}});
    const mark=f(".paid-agent-entitlement.grok."+version);
    const old=current();
    writeFileSync(mark,String(Date.now()+300000));
    expect(current().ready).toBe(false);
    expect(current().generation).not.toBe(old.generation);
    writeFileSync(mark,String(Date.now()-1));
    expect(current().ready).toBe(true);
    writeFileSync(mark,String(Date.now()+300000));
    writeFileSync(f("selection"),JSON.stringify({agent:"grok",version:"b".repeat(64)}));
    expect(current().ready).toBe(true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

it("parks an ACP image from a Desktop that supplied no pre-call token ceiling", () => {
  const root=mkdtempSync(join(tmpdir(),"old-acp-room-")), f=(name:string)=>join(root,name);
  try {
    writeFileSync(f("image"),"fixture");
    writeFileSync(f("selection"),JSON.stringify({agent:"grok",version:"a".repeat(64)}));
    const select=liveRoomSelection({setting:f("selection"),keyStore:f("keys"),baseFiles:[f("image")],agentFiles:[f("image")],
      acpFiles:[f("image")],coreCandidates:[],acpPrices:{grok:{baseTicks:60000000000,inputTicksPerByte:0}}});
    expect(select().ready).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

it("resolves shell scripts after errexit and node scripts after a warning code", async()=>{
  const {checkNamedProgram}=await import("../src/room-selection.js");
  expect(()=>checkNamedProgram([process.execPath,"--disable-warning","DEP0018","/missing/worker.js"])).toThrow();
  expect(()=>checkNamedProgram([process.execPath,"-c","/missing/worker.js"])).toThrow();
  if (process.platform !== "win32") {
    expect(()=>checkNamedProgram(["/bin/sh","-e","/missing/worker.sh"])).toThrow();
    expect(()=>checkNamedProgram(["/bin/sh","-c","true"])).not.toThrow();
  }
});

it("offers an Antigravity room whose first call holds the capped 965,536 tokens and refuses the old 1,114,112", () => {
  const root=mkdtempSync(join(tmpdir(),"agy-hold-")), f=(name:string)=>join(root,name);
  try {
    writeFileSync(f("image"),"fixture");
    writeFileSync(f("selection"),JSON.stringify({agent:"antigravity",version:"a".repeat(64)}));
    const ready=(tokenHold:number)=>liveRoomSelection({setting:f("selection"),keyStore:f("keys"),baseFiles:[f("image")],agentFiles:[f("image")],
      acpFiles:[f("image")],coreCandidates:[],acpPrices:{antigravity:{baseTicks:1000,inputTicksPerByte:0,tokenHold}}})().ready;
    expect(ready(900000+65536)).toBe(true);
    expect(ready(1048576+65536)).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
