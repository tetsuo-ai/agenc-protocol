import { describe, expect, it } from "vitest";
import {
  centsToLamports,
  decodePythPrice,
  lamportsToCents,
  PYTH_SOL_USD_FEED_ID,
} from "../src/pricing.js";

// The SOL/USD price account, read from mainnet on 2026-11-14 (publish time
// 1794684239, price 71.64297517).
const ACCOUNT = Buffer.from(
  "IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bS2BBqsBAAAAYaU9AAAAAAD4////T7X4agAAAABOtfhqAAAAAJBN1a8BAAAAp4YeAAAAAADRJPsbAAAAAAA=",
  "base64",
);
const PUBLISHED = 1_794_684_239;

describe("the on-chain price", () => {
  it("decodes a real price account", () => {
    const price = decodePythPrice(ACCOUNT, {
      feedIdHex: PYTH_SOL_USD_FEED_ID,
      nowSecs: PUBLISHED + 30,
    });
    expect(price).toBeCloseTo(71.64297517, 6);
  });

  it("refuses a stale price", () => {
    expect(
      decodePythPrice(ACCOUNT, { feedIdHex: PYTH_SOL_USD_FEED_ID, nowSecs: PUBLISHED + 16 * 60 }),
    ).toBeNull();
  });

  it("refuses another feed, another account type and truncated data", () => {
    expect(
      decodePythPrice(ACCOUNT, { feedIdHex: "00".repeat(32), nowSecs: PUBLISHED }),
    ).toBeNull();
    const wrongType = Buffer.from(ACCOUNT);
    wrongType[0] = wrongType[0]! ^ 0xff;
    expect(
      decodePythPrice(wrongType, { feedIdHex: PYTH_SOL_USD_FEED_ID, nowSecs: PUBLISHED }),
    ).toBeNull();
    expect(
      decodePythPrice(ACCOUNT.subarray(0, 60), { feedIdHex: PYTH_SOL_USD_FEED_ID, nowSecs: PUBLISHED }),
    ).toBeNull();
  });

  it("converts both ways and rounds a cap up", () => {
    expect(lamportsToCents(1_000_000_000n, 100)).toBe(10_000);
    expect(lamportsToCents(1_000_000_000n, null)).toBeNull();
    expect(centsToLamports(20, 100)).toBe(2_000_000n);
    expect(centsToLamports(1, 71.64297517)).toBe(139_582n);
    expect(centsToLamports(-5, 100)).toBe(0n);
  });
});
