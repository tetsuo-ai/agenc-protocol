import { createHash } from "node:crypto";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it } from "vitest";
import { readReviewEnvelope, readReviewInputs, ReviewArtifactUnavailable } from "../src/review-artifact.js";
import { claimBudget, budgetForRevision } from "../src/revision-budget.js";

const task = "11111111111111111111111111111111";
const sum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const envelope: taskThread.TaskThreadEnvelope = { v: 1, taskPda: task, parentHash: null, role: "buyer", ts: 3, body: "Revise the title.", attachments: [] };

describe("anchored reviews", () => {
  it("requires the exact content, task and role", async () => {
    const bytes = Buffer.from(taskThread.canonicalEnvelopeJson(envelope));
    const digest = sum(bytes);
    const read = async () => bytes;
    expect(await readReviewEnvelope(read, task, digest, "buyer")).toEqual(envelope);
    await expect(readReviewEnvelope(read, task, digest, "worker")).rejects.toThrow();
    await expect(readReviewEnvelope(read, "wrong", digest, "buyer")).rejects.toThrow();
    await expect(readReviewEnvelope(read, task, "0".repeat(64), "buyer")).rejects.toThrow();
    await expect(readReviewEnvelope(async () => null, task, digest, "buyer")).rejects.toThrow(ReviewArtifactUnavailable);
  });
  it("verifies named inputs and leaves ordinary web references as references", async () => {
    const bytes = Buffer.from("input");
    const hash = sum(bytes);
    const input = { hash, uri: "https://store.invalid/artifacts/" + hash + "#input.txt" };
    const ref = { hash, uri: "https://evidence.invalid/story#section" };
    const read = async (key: string) => key === hash ? bytes : null;
    expect(await readReviewInputs({ ...envelope, attachments: [input, ref] }, read)).toEqual([{ name: "input.txt", bytes }]);
    await expect(readReviewInputs({ ...envelope, attachments: [input, input] }, read)).rejects.toThrow();
    await expect(readReviewInputs({ ...envelope, attachments: [input] }, async () => Buffer.from("changed"))).rejects.toThrow();
    await expect(readReviewInputs({ ...envelope, attachments: [{ ...input, uri: input.uri.replace("input.txt", "../other") }] }, read)).rejects.toThrow();
  });
});

it("only releases reserved cents once for each confirmed round", () => {
  for (const total of [1, 2, 3, 4, 50, 101]) {
    const first = claimBudget(total, true);
    const second = budgetForRevision({ ...first, remainingCents: 0 }, 1)!;
    const third = budgetForRevision({ ...second, remainingCents: 0 }, 2)!;
    expect(first.remainingCents + second.remainingCents + third.remainingCents).toBe(total);
    for (const round of [0, 1, 2, 3]) expect(budgetForRevision({ ...third, remainingCents: 0 }, round)?.remainingCents).toBe(0);
  }
  expect(budgetForRevision({ totalCents: 50, remainingCents: 0 }, 1)?.remainingCents).toBe(0);
  expect(budgetForRevision(undefined, 1)).toBeUndefined();
});
