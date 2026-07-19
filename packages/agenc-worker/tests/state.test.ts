import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  linkSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  acquireStateLock,
  emptyState,
  loadState,
  saveState,
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
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(value));
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
    const script = `const {acquireStateLock}=await import("./src/state.ts");
      try { const release=acquireStateLock(process.argv[1]); console.log("ACQUIRED"); setTimeout(()=>release(),250); }
      catch { console.log("BLOCKED"); }`;
    const contenders = [0, 1].map(() =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, stateDir],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const outputs = await Promise.all(
      contenders.map(async (child) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
        });
        await once(child, "exit");
        return output.trim();
      }),
    );

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
