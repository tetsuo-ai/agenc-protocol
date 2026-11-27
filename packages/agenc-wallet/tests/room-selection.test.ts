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
