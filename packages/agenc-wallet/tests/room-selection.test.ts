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
    acpPrices:{grok:{baseTicks:60_000_000_000, inputTicksPerByte:0}, business:{baseTicks:1000,inputTicksPerByte:1,needsExpiry:true}}};
  const select = liveRoomSelection(room);
  try {
    writeFileSync(path("base"), "");
    writeFileSync(path("choice"), JSON.stringify({agent:"grok"}));
    expect(select().ready).toBe(false);
    writeFileSync(path("acp"), "stand-in");
    expect(select()).toMatchObject({agent:"acp", ready:true, firstCall:room.acpPrices.grok});
    const initial = select().generation;
    writeFileSync(path("acp"), "changed");
    expect(select().generation).not.toBe(initial);
    writeFileSync(path("choice"), JSON.stringify({agent:"business",validUntil:Date.now() - 1}));
    expect(select().ready).toBe(false);
    writeFileSync(path("choice"), JSON.stringify({agent:"business",validUntil:Date.now() + 60000}));
    expect(select().ready).toBe(true);
    writeFileSync(path("choice"), JSON.stringify({agent:"unsupported"}));
    expect(select().ready).toBe(false);
    writeFileSync(path("choice"), JSON.stringify({agent:"claude-code"}));
    expect(select().ready).toBe(false);
    writeFileSync(path("claude"), "stand-in");
    expect(select()).toMatchObject({agent:"claude-code", ready:true});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
