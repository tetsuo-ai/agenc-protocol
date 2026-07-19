import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidatorProcessBinding,
  parseValidatorPidRecord,
  type ValidatorPidRecord,
} from "../src/localnet.js";

const STATE_DIR = path.resolve("/repo/.localnet");
const LEDGER = path.join(STATE_DIR, "ledger");
const PROGRAM_BINARY = path.resolve("/repo/program.so");
const PROGRAM_ID = "Program1111111111111111111111111111111111";
const ARGV = [
  "solana-test-validator",
  "--ledger",
  LEDGER,
  "--rpc-port",
  "8899",
  "--upgradeable-program",
  PROGRAM_ID,
  PROGRAM_BINARY,
];
const ARGV_SHA256 = createHash("sha256")
  .update(Buffer.from(`${ARGV.join("\0")}\0`))
  .digest("hex");
const RECORD: ValidatorPidRecord = {
  schemaVersion: 1,
  role: "validator",
  pid: 1234,
  uid: 1000,
  processStartTicks: "123456",
  executable: "/usr/bin/solana-test-validator",
  cwd: STATE_DIR,
  argvSha256: ARGV_SHA256,
  recordedAt: "2026-07-19T00:00:00.000Z",
  rpcPort: 8899,
  programSha256: "ab".repeat(32),
  programSize: 2_000_000,
};

describe("localnet purge identity", () => {
  it("rejects legacy numeric PID files and unknown metadata", () => {
    expect(() => parseValidatorPidRecord("1234")).toThrow(/JSON object/);
    expect(() =>
      parseValidatorPidRecord(JSON.stringify({ ...RECORD, surprise: true })),
    ).toThrow(/unsupported identity/);
  });

  it("accepts only an exact owner/start/executable/argv/ledger binding", () => {
    expect(() =>
      assertValidatorProcessBinding(
        RECORD,
        {
          uid: 1000,
          executable: "/usr/bin/solana-test-validator",
          argv: ARGV,
          cwd: STATE_DIR,
          processStartTicks: RECORD.processStartTicks,
          argvSha256: RECORD.argvSha256,
        },
        {
          uid: 1000,
          ledger: LEDGER,
          stateDir: STATE_DIR,
          programId: PROGRAM_ID,
          programBinary: PROGRAM_BINARY,
        },
      ),
    ).not.toThrow();
  });

  it.each([
    { uid: 2000 },
    { executable: "/usr/bin/node" },
    { cwd: "/other", argvSha256: ARGV_SHA256 },
    { argv: ["solana-test-validator", "--ledger", "/other", "--rpc-port", "8899"] },
    { processStartTicks: "123457" },
    { argvSha256: "00".repeat(32) },
  ])("refuses an ambiguous or reused PID %#", (override) => {
    expect(() =>
      assertValidatorProcessBinding(
        RECORD,
        {
          uid: 1000,
          executable: "/usr/bin/solana-test-validator",
          argv: ARGV,
          cwd: STATE_DIR,
          processStartTicks: RECORD.processStartTicks,
          argvSha256: RECORD.argvSha256,
          ...override,
        },
        {
          uid: 1000,
          ledger: LEDGER,
          stateDir: STATE_DIR,
          programId: PROGRAM_ID,
          programBinary: PROGRAM_BINARY,
        },
      ),
    ).toThrow(/purge refused/);
  });
});
