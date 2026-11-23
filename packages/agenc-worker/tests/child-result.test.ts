import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageChildResult, parkChildRun, enqueueChildResume, takeChildResume } from "../src/child-result.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const digest = (f: unknown) => hash(JSON.stringify(f));
const binding = {
  parentTask: "parent",
  claimedAt: "123",
  roomId: "room",
  childTask: "child",
  purchaseKey: "purchase",
};
const file = {
  name: "result.txt",
  sha256: hash("verified"),
  bytes: 8,
  base64: Buffer.from("verified").toString("base64"),
};
function delivery(f = file) {
  return {
    ...binding,
    round: 1,
    deliveryHash: hash("spec"),
    text: "ok",
    files: [f],
    receipt: digest([
      "parent",
      "123",
      "room",
      "child",
      1,
      hash("spec"),
      digest("ok"),
      [[f.name, f.bytes, f.sha256]],
    ]),
  };
}
async function spool() {
  const path = await mkdtemp(join(tmpdir(), "supplier-"));
  dirs.push(path);
  return path;
}
it("publishes a complete read-only import before enqueue and gives concurrent schedulers exactly one model start", async () => {
  const path = await spool(),
    result = delivery();
  await parkChildRun(path, binding, binding.purchaseKey);
  await expect(enqueueChildResume(path, binding, binding.purchaseKey, result.receipt)).rejects.toThrow();
  const [a, b] = await Promise.all([
    stageChildResult(path, binding, result),
    stageChildResult(path, binding, result),
  ]);
  expect(a).toEqual(b);
  expect(await readFile(join(a.folder, "files/result.txt"), "utf8")).toBe("verified");
  await Promise.all([
    enqueueChildResume(path, binding, binding.purchaseKey, result.receipt),
    enqueueChildResume(path, binding, binding.purchaseKey, result.receipt),
  ]);
  const starts = await Promise.all([
    takeChildResume(path, binding, result.receipt),
    takeChildResume(path, binding, result.receipt),
  ]);
  expect(starts.filter((s) => s.start)).toHaveLength(1);
  expect(await takeChildResume(path, binding, result.receipt)).toMatchObject({
    start: false,
    runId: result.receipt,
  });
});
it("refuses a corrupt file, a path, a different room or a delivery with substituted text", async () => {
  const path = await spool();
  for (const result of [
    delivery({ ...file, name: "../file" }),
    delivery({ ...file, base64: Buffer.from("tampered").toString("base64") }),
    { ...delivery(), roomId: "elsewhere" },
    { ...delivery(), text: "changed" },
  ])
    await expect(stageChildResult(path, binding, result)).rejects.toThrow();
});
