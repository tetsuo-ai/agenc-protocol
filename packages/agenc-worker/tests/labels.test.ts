// A job's name and listing travel with it from the claim to the ledger, so
// whoever shows the worker's jobs to a person can say which job is which.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { jobTitle } from "../src/runtime.js";
import {
  emptyState,
  loadState,
  MAX_JOB_TITLE_CHARS,
  saveState,
  WorkerStateError,
} from "../src/state.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const LISTING = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("a job's name", () => {
  it("comes from the job spec's title as one plain line", () => {
    expect(jobTitle(encode({ title: "Hire: Haiku Writer", instructions: "x" }))).toBe(
      "Hire: Haiku Writer",
    );
    expect(jobTitle(encode({ title: "  Two\n\tlines‮flipped\u0007 " }))).toBe(
      "Two lines flipped",
    );
    const long = jobTitle(encode({ title: "a".repeat(500) }))!;
    expect([...long]).toHaveLength(MAX_JOB_TITLE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is absent when the job spec has none worth showing", () => {
    expect(jobTitle(encode({ summary: "no title" }))).toBeUndefined();
    expect(jobTitle(encode({ title: 42 }))).toBeUndefined();
    expect(jobTitle(encode({ title: " \n " }))).toBeUndefined();
    expect(jobTitle(encode(["title"]))).toBeUndefined();
    expect(jobTitle(new TextEncoder().encode("not json"))).toBeUndefined();
  });
});

describe("the state file", () => {
  it("keeps a job's name and listing from claim to ledger", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-labels-"));
    const state = emptyState();
    state.openClaim = {
      task: TASK,
      claimedAt: "2026-11-19T00:00:00.000Z",
      phase: "claimed",
      title: "Haiku Writer",
      listing: LISTING,
    };
    saveState(stateDir, state);
    expect(loadState(stateDir).openClaim).toEqual(state.openClaim);

    state.openClaim = null;
    state.submissions.push({
      task: TASK,
      submissionSignature: null,
      resultUri: "agenc://result/sha256/test",
      resultHashHex: "ab".repeat(32),
      rewardAmount: "1",
      submittedAt: "2026-11-19T00:00:00.000Z",
      settled: false,
      title: "Haiku Writer",
      listing: LISTING,
    });
    saveState(stateDir, state);
    expect(loadState(stateDir).submissions[0]).toMatchObject({
      title: "Haiku Writer",
      listing: LISTING,
    });
  });

  it("refuses a name that is not one short line, and a listing that is not an address", () => {
    for (const labels of [
      { title: "" },
      { title: "line\nbreak" },
      { title: "x".repeat(MAX_JOB_TITLE_CHARS + 1) },
      { title: 7 },
      { listing: "not an address" },
    ]) {
      const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-labels-bad-"));
      writeFileSync(
        path.join(stateDir, "state.json"),
        JSON.stringify({
          ...emptyState(),
          openClaim: {
            task: TASK,
            claimedAt: "2026-11-19T00:00:00.000Z",
            phase: "claimed",
            ...labels,
          },
        }),
        { mode: 0o600 },
      );
      expect(() => loadState(stateDir)).toThrow(WorkerStateError);
    }
  });
});
