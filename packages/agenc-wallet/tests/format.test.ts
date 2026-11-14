import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatMoney,
  formatSol,
  formatUsd,
  formatWait,
} from "../src/client/format.js";
import { createLineReader } from "../src/client/socket-client.js";

describe("money and time in plain words", () => {
  it("writes dollars", () => {
    expect(formatUsd(142)).toBe("$1.42");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.4)).toBe("less than $0.01");
    expect(formatUsd(199.6)).toBe("$2.00");
    expect(formatUsd(123_456_789)).toBe("$1,234,567.89");
    expect(formatUsd(-250)).toBe("-$2.50");
  });

  it("writes SOL without trailing zeros", () => {
    expect(formatSol(5_000_000n)).toBe("0.005 SOL");
    expect(formatSol("1000000000")).toBe("1 SOL");
    expect(formatSol(1_234_567_891n)).toBe("1.234568 SOL");
    expect(formatSol(999_999_999n)).toBe("1 SOL");
    expect(formatSol("not a number")).toBe("0 SOL");
  });

  it("prefers dollars and falls back to SOL", () => {
    expect(formatMoney({ lamports: "2000000", usdCents: 20 })).toBe("$0.20");
    expect(formatMoney({ lamports: "2000000", usdCents: null })).toBe("0.002 SOL");
  });

  it("writes waits and durations", () => {
    expect(formatWait(10_000, 0)).toBe("any moment now");
    expect(formatWait(8 * 60_000, 0)).toBe("in 8 minutes");
    expect(formatWait(3 * 3_600_000, 0)).toBe("in 3 hours");
    expect(formatDuration(3_600)).toBe("an hour");
    expect(formatDuration(86_400)).toBe("24 hours");
    expect(formatDuration(3 * 86_400)).toBe("3 days");
  });
});

describe("the line reader", () => {
  it("joins lines split across chunks and keeps several in one chunk apart", () => {
    const lines: string[] = [];
    const read = createLineReader((line) => lines.push(line), () => lines.push("OVERFLOW"));
    read(Buffer.from('{"a":'));
    read(Buffer.from('1}\n{"b":2}\n{"c"'));
    read(Buffer.from(":3}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("refuses a frame that never ends", () => {
    let overflowed = false;
    const read = createLineReader(() => {}, () => {
      overflowed = true;
    });
    read(Buffer.alloc(1024 * 1024 + 1, 0x61));
    expect(overflowed).toBe(true);
  });
});
