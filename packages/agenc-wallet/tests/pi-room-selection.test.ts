import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { liveRoomSelection } from "../src/room-selection.js";

it("requires the selected Pi image and includes its identity and price in admission", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-admit-"));
  const path = (name: string) => join(dir, name);
  const price = { baseTicks: 768_000_000, inputTicksPerByte: 0 };
  const room = {
    setting: path("choice"), keyStore: path("keys"), coreCandidates: [],
    baseFiles: [path("base")], agentFiles: [path("claude")],
    acpFiles: [path("acp")], acpPrices: { opencode: price },
    piFiles: [path("pi")], piPrices: { "pi-openai": price },
  };
  try {
    for (const name of ["base", "acp", "claude"]) writeFileSync(path(name), "fixture");
    writeFileSync(room.setting, JSON.stringify({agent: "pi-openai"}));
    const select = liveRoomSelection(room);
    expect(select().ready).toBe(false);
    writeFileSync(path("pi"), "pi image");
    const first = select();
    expect(first).toMatchObject({ agent: "pi", ready: true, firstCall: price });
    price.baseTicks += 1;
    expect(select().generation).not.toBe(first.generation);
    price.baseTicks -= 1;
    writeFileSync(path("pi"), "new image");
    expect(select().generation).not.toBe(first.generation);
    writeFileSync(room.setting, JSON.stringify({agent: "pi-other"}));
    expect(select().ready).toBe(false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
