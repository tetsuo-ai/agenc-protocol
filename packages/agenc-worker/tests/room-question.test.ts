import { expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { waitForRoomAnswer } from "../src/room-work.js";

it("reuses the signed answer's run ID after losing the queue acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-answers-"));
  const task = "task" as Address;
  const id = "a".repeat(64);
  let waiting = true;
  const session = {
    refresh: async () => ({ waiting }),
    conversation: { resume: async (enqueue: (id: string, answer: string, deadline: number) => Promise<void>) => {
      await enqueue(id, "Signed answer", 123456);
      waiting = false;
      return true;
    } },
  };
  const enqueueOnce = vi.fn(async () => {}).mockRejectedValueOnce(new Error("lost acknowledgement"));
  const host = { session, enqueueOnce };
  await expect(waitForRoomAnswer(root, task, host)).rejects.toThrow();
  expect(await waitForRoomAnswer(root, task, host)).toBe(true);
  expect(await waitForRoomAnswer(root, task, host)).toBe(false);
  expect(enqueueOnce.mock.calls).toEqual([[id, "Signed answer", 123456], [id, "Signed answer", 123456]]);
  expect(readdirSync(join(root, "room-answers", task))).toEqual([id]);
});
