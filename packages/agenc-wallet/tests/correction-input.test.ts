import { expect, it } from "vitest";
import { correctionInputs } from "../src/work-inspection.js";
it("keeps verified text-only corrections free of synthetic attachments", async () => {
  expect(await correctionInputs(Buffer.from("A sentence to correct."),async()=>null)).toEqual([]);
});
