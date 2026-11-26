import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  acquireStateLock,
  emptyState,
  loadState,
  readJobEvidence,
  MAX_WORKER_STATE_BYTES,
  pruneFailedJobs,
  pruneSettledSubmissions,
  saveState,
  SETTLED_SUBMISSION_RETENTION,
  WorkerStateError,
} from "../src/state.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const HASH = "ab".repeat(32);

function pendingSubmission() {
  return {
    task: TASK,
    submissionSignature: "submission-signature",
    resultUri: "agenc://result/sha256/test",
    resultHashHex: HASH,
    rewardAmount: "1",
    submittedAt: "2026-07-18T00:00:00.000Z",
    settled: false,
  };
}

function writeRaw(stateDir: string, value: unknown): void {
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(value), {
    mode: 0o600,
  });
}

describe("versioned fail-closed worker state", () => {
  it("writes a private, fsynced atomic state with no shared temp filename", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-state-"));
    const state = emptyState();
    state.agentIdHex = "ab".repeat(32);
    saveState(stateDir, state);

    expect(loadState(stateDir)).toEqual(state);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(stateDir, "state.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(
      readdirSync(stateDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rejects unsupported versions, malformed addresses/timestamps/phases, and unknown legacy fields", () => {
    const cases: unknown[] = [
      { ...emptyState(), version: 2 },
      {
        ...emptyState(),
        openClaim: {
          task: "not-an-address",
          claimedAt: "2026-07-18T00:00:00.000Z",
          phase: "claimed",
        },
      },
      {
        ...emptyState(),
        openClaim: {
          task: TASK,
          claimedAt: "yesterday",
          phase: "claimed",
        },
      },
      {
        ...emptyState(),
        openClaim: {
          task: TASK,
          claimedAt: "2026-07-18T00:00:00.000Z",
          phase: "submitting",
        },
      },
      {
        ...emptyState(),
        submissions: [
          { ...pendingSubmission(), outcome: "accepted", settledAt: undefined },
        ],
      },
      {
        ...emptyState(),
        openClaim: {
          task: TASK,
          claimedAt: "2026-07-18T00:00:00.000Z",
          phase: "claimed",
        },
        submissions: [pendingSubmission()],
      },
      {
        agentIdHex: null,
        openClaim: null,
        totalEarnedBaseline: "0",
        submissions: [],
        unexpected: true,
      },
    ];
    for (const value of cases) {
      const stateDir = mkdtempSync(
        path.join(tmpdir(), "agenc-worker-invalid-"),
      );
      writeRaw(stateDir, value);
      expect(() => loadState(stateDir)).toThrow(WorkerStateError);
    }
  });

  it("migrates only the exact legacy claim shape", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-legacy-"));
    writeRaw(stateDir, {
      agentIdHex: null,
      openClaim: {
        task: TASK,
        claimedAt: "2026-07-18T00:00:00.000Z",
      },
      totalEarnedBaseline: "0",
      submissions: [],
    });
    expect(loadState(stateDir).openClaim?.phase).toBe("claimed");

    writeRaw(stateDir, {
      agentIdHex: null,
      openClaim: {
        task: TASK,
        claimedAt: "2026-07-18T00:00:00.000Z",
        phase: "claimed",
      },
      totalEarnedBaseline: "0",
      submissions: [],
    });
    expect(() => loadState(stateDir)).toThrow(/legacy root\.openClaim\.phase/);
  });

  it("bounds the hot ledger while preserving every unsettled submission", () => {
    const state = emptyState();
    const settled = Array.from(
      { length: SETTLED_SUBMISSION_RETENTION + 5 },
      (_, index) => ({
        ...pendingSubmission(),
        task: `${index}`,
        settled: true as const,
        outcome: "accepted" as const,
        earnedLamports: "1",
        settlementSignature: `settlement-${index}`,
        settledAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
    const unsettled = [
      { ...pendingSubmission(), task: "pending-a" },
      { ...pendingSubmission(), task: "pending-b" },
    ];
    state.submissions = [...settled, ...unsettled];

    expect(pruneSettledSubmissions(state)).toBe(5);
    expect(state.submissions.filter(({ settled: done }) => done)).toHaveLength(
      SETTLED_SUBMISSION_RETENTION,
    );
    expect(
      state.submissions
        .filter(({ settled: done }) => !done)
        .map(({ task }) => task),
    ).toEqual(["pending-a", "pending-b"]);
    expect(state.submissions[0]?.task).toBe("5");
  });

  it("never prunes an unacknowledged settlement event", () => {
    const state = emptyState();
    state.submissions = [{
      ...pendingSubmission(), settled: true, outcome: "accepted", earnedLamports: "1",
      settlementSignature: null, settledAt: "2026-07-18T00:00:00.000Z", settlementEventPending: true,
    }];
    expect(pruneSettledSubmissions(state, 0)).toBe(0);
    state.submissions[0]!.settlementEventPending = false;
    expect(pruneSettledSubmissions(state, 0)).toBe(1);
  });

  it("rejects an oversized state file before reading or parsing it", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-large-"));
    const statePath = path.join(stateDir, "state.json");
    writeFileSync(statePath, "{}", { mode: 0o600 });
    chmodSync(statePath, 0o600);
    truncateSync(statePath, MAX_WORKER_STATE_BYTES + 1);
    expect(() => loadState(stateDir)).toThrow(/exceeds .* bytes/);
  });

  it("refuses symlinked state directories and state files", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agenc-worker-links-"));
    const realDir = path.join(parent, "real");
    mkdirSync(realDir, { mode: 0o700 });
    writeRaw(realDir, emptyState());

    const linkedDir = path.join(parent, "linked-dir");
    symlinkSync(realDir, linkedDir, "dir");
    expect(() => loadState(linkedDir)).toThrow(/not a symbolic link/u);
    expect(() => saveState(linkedDir, emptyState())).toThrow(
      /not a symbolic link/u,
    );

    const outside = path.join(parent, "outside.json");
    writeFileSync(outside, JSON.stringify(emptyState()), { mode: 0o600 });
    const stateDir = path.join(parent, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    symlinkSync(outside, path.join(stateDir, "state.json"));
    expect(() => loadState(stateDir)).toThrow(/not a symbolic link/u);
  });

  it("refuses group/world-accessible or foreign-owned state paths", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-mode-"));
    writeRaw(stateDir, emptyState());
    chmodSync(path.join(stateDir, "state.json"), 0o644);
    expect(() => loadState(stateDir)).toThrow(/chmod 600/u);

    chmodSync(path.join(stateDir, "state.json"), 0o600);
    chmodSync(stateDir, 0o755);
    expect(() => loadState(stateDir)).toThrow(/chmod 700/u);
    expect(() => saveState(stateDir, emptyState())).toThrow(/chmod 700/u);

    chmodSync(stateDir, 0o700);
    const actualUid = statSync(stateDir).uid;
    const uid = vi
      .spyOn(process, "getuid")
      .mockReturnValue(actualUid === 0 ? 1 : actualUid - 1);
    try {
      expect(() => loadState(stateDir)).toThrow(/owned by the current user/u);
    } finally {
      uid.mockRestore();
    }
  });
});

describe("exclusive state directory lock", () => {
  it("rejects a concurrent owner, releases cleanly, and reclaims a stale lock", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-lock-"));
    const release = acquireStateLock(stateDir);
    expect(() => acquireStateLock(stateDir)).toThrow(/already active/);
    release();
    const releaseAgain = acquireStateLock(stateDir);
    releaseAgain();

    writeFileSync(
      path.join(stateDir, ".active.lock"),
      JSON.stringify({
        pid: 99_999_999,
        nonce: "ab".repeat(16),
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const releaseStale = acquireStateLock(stateDir);
    releaseStale();
    expect(readdirSync(stateDir)).not.toContain(".active.lock");
  });

  it("fails closed on an unreadable published lock instead of unlinking it", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-lock-bad-"));
    writeFileSync(path.join(stateDir, ".active.lock"), "{");

    expect(() => acquireStateLock(stateDir)).toThrow(/unreadable/);
    expect(readdirSync(stateDir)).toContain(".active.lock");
  });

  it("reclaims a live reused PID when its recorded process identity mismatches", () => {
    if (process.platform !== "linux") return;
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-reused-pid-"),
    );
    writeFileSync(
      path.join(stateDir, ".active.lock"),
      JSON.stringify({
        pid: process.pid,
        nonce: "ad".repeat(16),
        acquiredAt: "2000-01-01T00:00:00.000Z",
        bootId: "00000000-0000-0000-0000-000000000000",
        processStartTime: "1",
      }),
    );
    const release = acquireStateLock(stateDir);
    release();
    expect(readdirSync(stateDir)).not.toContain(".active.lock");
  });

  it("fails closed when only half of a process identity is present", () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-incomplete-identity-"),
    );
    writeFileSync(
      path.join(stateDir, ".active.lock"),
      JSON.stringify({
        pid: 99_999_999,
        nonce: "ae".repeat(16),
        acquiredAt: "2000-01-01T00:00:00.000Z",
        bootId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(() => acquireStateLock(stateDir)).toThrow(
      /incomplete process identity/,
    );
    expect(readdirSync(stateDir)).toContain(".active.lock");
  });

  it("recovers when a dead process left its stale-lock reaper marker behind", () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-dead-reaper-"),
    );
    const targetNonce = "cd".repeat(16);
    const lockPath = path.join(stateDir, ".active.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99_999_999,
        nonce: targetNonce,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      `${lockPath}.reap.${targetNonce}`,
      JSON.stringify({
        pid: 99_999_998,
        nonce: "ef".repeat(16),
        targetNonce,
        acquiredAt: "2000-01-01T00:00:01.000Z",
      }),
    );

    const release = acquireStateLock(stateDir);
    release();
    expect(
      readdirSync(stateDir).filter((name) => name.startsWith(".active.lock")),
    ).toEqual([]);
  });

  it("recovers a complete legacy hard-link reaper marker", () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-legacy-reaper-"),
    );
    const targetNonce = "ac".repeat(16);
    const lockPath = path.join(stateDir, ".active.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99_999_999,
        nonce: targetNonce,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    linkSync(lockPath, `${lockPath}.reap.${targetNonce}`);

    const release = acquireStateLock(stateDir);
    release();
    expect(
      readdirSync(stateDir).filter((name) => name.startsWith(".active.lock")),
    ).toEqual([]);
  });

  it("allows exactly one real process to win a stale-lock recovery race", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-two-reapers-"),
    );
    const lockPath = path.join(stateDir, ".active.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99_999_999,
        nonce: "bc".repeat(16),
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const script = `const {acquireStateLock,WorkerStateError}=await import("./src/state.ts");
      try { const release=acquireStateLock(process.argv[1]); console.log("ACQUIRED"); setTimeout(()=>release(),250); }
      catch (error) {
        const expectedContention = error instanceof WorkerStateError &&
          (error.message.includes("already active") ||
            error.message.includes("being reclaimed by another process"));
        if (!expectedContention) { console.error(error); process.exitCode=2; }
        else { console.log("BLOCKED"); }
      }`;
    const contenders = [0, 1].map(() =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, stateDir],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const results = await Promise.all(
      contenders.map(async (child) => {
        let output = "";
        let errorOutput = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          errorOutput += chunk;
        });
        // `exit` may precede the final stdout read. `close` is emitted only
        // after the child and all stdio handles have closed.
        const [code, signal] = await once(child, "close");
        return { code, signal, output: output.trim(), errorOutput };
      }),
    );

    expect(
      results.every(({ code, signal }) => code === 0 && signal === null),
      JSON.stringify(results),
    ).toBe(true);
    const outputs = results.map(({ output }) => output);
    expect(outputs.sort()).toEqual(["ACQUIRED", "BLOCKED"]);
    expect(
      readdirSync(stateDir).filter((name) => name.startsWith(".active.lock")),
    ).toEqual([]);
  });

  it("publishes only complete lock JSON under real child-process observation", async () => {
    const stateDir = mkdtempSync(
      path.join(tmpdir(), "agenc-worker-lock-observed-"),
    );
    const observer = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("node:fs"),p=require("node:path").join(process.argv[1],".active.lock");
         console.log("READY");
         setInterval(()=>{let raw;try{raw=fs.readFileSync(p,"utf8")}catch(e){if(e.code==="ENOENT")return;throw e}
         try{const v=JSON.parse(raw);if(!Number.isInteger(v.pid)||typeof v.nonce!=="string"||typeof v.acquiredAt!=="string")throw new Error("shape")}
         catch(e){console.log("MALFORMED:"+raw.length);process.exit(3)}},0);`,
        stateDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    observer.stdout.setEncoding("utf8");
    observer.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    const exited = once(observer, "exit");
    while (!output.includes("READY") && observer.exitCode === null) {
      await once(observer.stdout, "data");
    }

    for (let index = 0; index < 100 && observer.exitCode === null; index += 1) {
      const release = acquireStateLock(stateDir);
      release();
    }
    if (observer.exitCode === null) observer.kill("SIGTERM");
    await exited;
    expect(output).not.toContain("MALFORMED");
    expect(
      readdirSync(stateDir).filter((name) => name.startsWith(".active.lock")),
    ).toEqual([]);
  });
});

describe("given-up jobs in the state file", () => {
  const failed = {
    task: TASK,
    claimedAt: "2026-11-19T00:00:00.000Z",
    failedAt: "2026-11-19T00:10:00.000Z",
    chosen: false,
    cause: "attempts" as const,
    reason: "executor exited with code 3",
    attempts: 3,
    claimReleased: false,
  };

  it("writes the earlier format until a job is given up", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-failed-"));
    saveState(stateDir, emptyState());
    const plain = JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8"));
    expect(Object.keys(plain).sort()).toEqual(
      ["agentIdHex", "openClaim", "submissions", "totalEarnedBaseline", "version"],
    );

    const state = emptyState();
    state.failedJobs.push(failed);
    state.consecutiveFailures = 1;
    state.pause = { since: failed.failedAt, reason: failed.reason };
    saveState(stateDir, state);
    expect(loadState(stateDir)).toEqual(state);
  });

  it("refuses a given-up job it does not understand", () => {
    for (const job of [
      { ...failed, cause: "bored" },
      { ...failed, reason: "two\nlines" },
      { ...failed, attempts: -1 },
      { ...failed, claimReleased: "no" },
      { ...failed, extra: true },
    ]) {
      const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-failed-bad-"));
      writeRaw(stateDir, { ...emptyState(), failedJobs: [job] });
      expect(() => loadState(stateDir)).toThrow(WorkerStateError);
    }
  });

  it("keeps every job whose claim is still out and only the newest others", () => {
    const state = emptyState();
    for (let index = 0; index < 250; index += 1) {
      state.failedJobs.push({
        ...failed,
        claimReleased: index % 50 !== 0,
        failedAt: new Date(Date.UTC(2026, 10, 19, 0, 0, index)).toISOString(),
      });
    }
    pruneFailedJobs(state);
    expect(state.failedJobs.filter((job) => !job.claimReleased)).toHaveLength(5);
    expect(state.failedJobs.filter((job) => job.claimReleased)).toHaveLength(200);
    expect(state.failedJobs.at(-1)?.failedAt).toBe("2026-11-19T00:04:09.000Z");
  });
});

describe("archived job evidence", () => {
  it("keeps 300 large requests through submission, settlement, outbox replay and restart", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "worker-large-history-"));
    const state = emptyState();
    const evidence = { request: "é".repeat(30000), acceptance: ['"\\\n'.repeat(2000)] };
    for (let i = 0; i < 300; i++) {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(i + 1);
      state.submissions.push({ ...pendingSubmission(), task: getAddressDecoder().decode(bytes), jobEvidence: { ...evidence, request: `${i}${evidence.request}` } });
    }
    state.openClaim = { task: TASK, phase: "claimed", claimedAt: "2026-07-18T00:00:00.000Z", jobEvidence: evidence };
    saveState(stateDir, state);
    let reopened = loadState(stateDir);
    expect(statSync(path.join(stateDir, "state.json")).size).toBeLessThan(MAX_WORKER_STATE_BYTES);
    expect(reopened.submissions).toHaveLength(300);
    expect(reopened.submissions[0]?.jobEvidence).toBeUndefined();
    expect(readJobEvidence(stateDir, reopened.openClaim!)).toEqual(evidence);
    for (const record of reopened.submissions.slice(0, 299)) {
      Object.assign(record, { settled: true, outcome: "accepted", earnedLamports: "1", settlementSignature: null, settledAt: "2026-07-19T00:00:00.000Z", settlementEventPending: true });
    }
    saveState(stateDir, reopened);
    reopened = loadState(stateDir);
    expect(reopened.submissions.filter((record) => record.settlementEventPending)).toHaveLength(299);
    expect(pruneSettledSubmissions(reopened, 0)).toBe(0);
    for (let i = 0; i < 300; i++) {
      expect(readJobEvidence(stateDir, reopened.submissions[i]!)).toEqual({ ...evidence, request: `${i}${evidence.request}` });
    }
    const pendingRef = reopened.submissions[0]!.jobEvidenceRef;
    for (const record of reopened.submissions.slice(1, 299)) record.settlementEventPending = false;
    expect(pruneSettledSubmissions(reopened, 0)).toBe(298);
    saveState(stateDir, reopened);
    reopened = loadState(stateDir);
    expect(reopened.submissions).toHaveLength(2);
    expect(reopened.submissions[0]?.jobEvidenceRef).toBe(pendingRef);
    expect(reopened.submissions[1]?.settled).toBe(false);
    expect(readJobEvidence(stateDir, reopened.submissions[0]!)).toEqual({ ...evidence, request: `0${evidence.request}` });
    expect(statSync(path.join(stateDir, "state.json")).size).toBeLessThan(MAX_WORKER_STATE_BYTES);
  });

  it("rejects changed evidence and malformed references", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "worker-evidence-integrity-"));
    const state = emptyState();
    state.submissions = [{ ...pendingSubmission(), jobEvidence: { request: "Original", acceptance: [] } }];
    saveState(stateDir, state);
    const entry = loadState(stateDir).submissions[0]!;
    const file = path.join(stateDir, `evidence-${entry.jobEvidenceRef}.json`);
    writeFileSync(file, JSON.stringify({ request: "Changed", acceptance: [] }));
    expect(() => readJobEvidence(stateDir, entry)).toThrow("hash mismatch");
    expect(() => readJobEvidence(stateDir, { jobEvidenceRef: "../../outside" })).toThrow();
  });
});
