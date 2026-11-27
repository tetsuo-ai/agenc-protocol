import { expect, it } from "vitest";
import { correctionInputs } from "../src/work-inspection.js";
it("keeps verified text-only corrections free of synthetic attachments", async () => {
  expect(await correctionInputs(Buffer.from("A sentence to correct."),async()=>null)).toEqual([]);
});

it("suppresses legacy ACP file correction in both inspection and execution", async () => {
  const {createHash}=await import("node:crypto");
  const {inspectWorkChunk}=await import("../src/work-inspection.js");
  const file=Buffer.from("hello"), hash=createHash("sha256").update(file).digest("hex");
  const body=Buffer.from("Ready.\n\n---\nFiles with this delivery:\n1. note.txt (text/plain, 5 bytes)\n   https://artifacts.example/artifacts/"+hash+"\n");
  const id=createHash("sha256").update(body).digest("hex");
  let reads=0;
  const fetch=async()=>{reads++;return file;};
  const inspect=await inspectWorkChunk(body,id,"text",0,900,fetch,false);
  expect(inspect.correctionCents).toBe(0);
  await expect(correctionInputs(body,fetch,false)).rejects.toThrow(/cannot correct/);
  expect(reads).toBe(0);
  expect((await correctionInputs(body,fetch)).length).toBe(2);
});
