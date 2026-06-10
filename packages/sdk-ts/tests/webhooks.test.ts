// Tests for the webhooks module (PLAN.md P3.3): the delivery-signature
// verification helper, against known HMAC vectors (independently computed
// with node:crypto), the replay-tolerance window, and malformed-header /
// tampered-body rejection.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAgencWebhookSignature } from "../src/index.js";

// ---------------------------------------------------------------------------
// Known vectors (precomputed with node:crypto, hardcoded so a WebCrypto
// regression cannot silently re-derive a wrong expectation).
// ---------------------------------------------------------------------------

const SECRET = "whsec_3q9QGiHxBcDdXxJZBkPMV7Fy";
const T = 1_765_432_100_000;
const RAW_BODY =
  '{"id":"evt_8f14e45f-ceea-4673-aa6a-1b9b9d6b2a01","type":"listing.hired",' +
  '"createdAt":"2026-06-10T12:00:00.000Z","data":{"listing":' +
  '"So11111111111111111111111111111111111111112"}}';
const V1 = "22d44c341651d0b036c8935648a9eef6bfc1bc85da674b7e46e4fd2e409cb1a0";

/** Independent reference implementation for dynamically-built cases. */
function signedHeader(secret: string, t: number, rawBody: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

/** A clock pinned right at the signed timestamp. */
const atT = () => T;

describe("verifyAgencWebhookSignature", () => {
  it("accepts the hardcoded known vector", async () => {
    await expect(
      verifyAgencWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${V1}`,
        secret: SECRET,
        now: atT,
      }),
    ).resolves.toBe(true);
  });

  it("accepts the second known vector (secret s3cr3t, t=1000, body hello)", async () => {
    await expect(
      verifyAgencWebhookSignature({
        rawBody: "hello",
        signatureHeader:
          "t=1000,v1=4f14bfc5c8421050c604bb7c14e02f3129c9e67bb2b73c97a65c7288a167c280",
        secret: "s3cr3t",
        now: () => 1000,
      }),
    ).resolves.toBe(true);
  });

  it("matches an independently node:crypto-signed header end to end", async () => {
    const body = '{"id":"evt_x","type":"task.created","data":{}}';
    await expect(
      verifyAgencWebhookSignature({
        rawBody: body,
        signatureHeader: signedHeader("another-secret", 42_000, body),
        secret: "another-secret",
        now: () => 42_000,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body under a valid signature", async () => {
    const tampered = RAW_BODY.replace("listing.hired", "task.accepted");
    await expect(
      verifyAgencWebhookSignature({
        rawBody: tampered,
        signatureHeader: `t=${T},v1=${V1}`,
        secret: SECRET,
        now: atT,
      }),
    ).resolves.toBe(false);
  });

  it("rejects the wrong secret", async () => {
    await expect(
      verifyAgencWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${V1}`,
        secret: "whsec_wrong",
        now: atT,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a header whose t was shifted (t is signed with the body)", async () => {
    await expect(
      verifyAgencWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: `t=${T + 1},v1=${V1}`,
        secret: SECRET,
        now: atT,
      }),
    ).resolves.toBe(false);
  });

  describe("tolerance window (default 300000 ms)", () => {
    it("accepts exactly at the edge and rejects one ms beyond (stale)", async () => {
      const input = {
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${V1}`,
        secret: SECRET,
      };
      await expect(
        verifyAgencWebhookSignature({ ...input, now: () => T + 300_000 }),
      ).resolves.toBe(true);
      await expect(
        verifyAgencWebhookSignature({ ...input, now: () => T + 300_001 }),
      ).resolves.toBe(false);
    });

    it("rejects future-skewed timestamps beyond tolerance", async () => {
      await expect(
        verifyAgencWebhookSignature({
          rawBody: RAW_BODY,
          signatureHeader: `t=${T},v1=${V1}`,
          secret: SECRET,
          now: () => T - 300_001,
        }),
      ).resolves.toBe(false);
    });

    it("honours a custom toleranceMs", async () => {
      const input = {
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${V1}`,
        secret: SECRET,
        toleranceMs: 1_000,
      };
      await expect(
        verifyAgencWebhookSignature({ ...input, now: () => T + 999 }),
      ).resolves.toBe(true);
      await expect(
        verifyAgencWebhookSignature({ ...input, now: () => T + 1_001 }),
      ).resolves.toBe(false);
    });
  });

  describe("malformed headers (return false, never throw)", () => {
    const CASES: Array<[string, string]> = [
      ["empty string", ""],
      ["no key=value at all", "garbage"],
      ["missing v1", `t=${T}`],
      ["missing t", `v1=${V1}`],
      ["non-numeric t", `t=soon,v1=${V1}`],
      ["negative t", `t=-${T},v1=${V1}`],
      ["duplicate t", `t=${T},t=${T},v1=${V1}`],
      ["empty v1", `t=${T},v1=`],
      ["non-hex v1", `t=${T},v1=zz${V1.slice(2)}`],
      ["odd-length v1", `t=${T},v1=${V1.slice(0, 63)}`],
      ["swapped separators", `t:${T};v1:${V1}`],
    ];
    for (const [label, header] of CASES) {
      it(`rejects ${label}`, async () => {
        await expect(
          verifyAgencWebhookSignature({
            rawBody: RAW_BODY,
            signatureHeader: header,
            secret: SECRET,
            now: atT,
          }),
        ).resolves.toBe(false);
      });
    }
  });

  it("accepts any matching v1 among several (secret rotation)", async () => {
    const otherMac = createHmac("sha256", "old-secret")
      .update(`${T}.${RAW_BODY}`)
      .digest("hex");
    await expect(
      verifyAgencWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${otherMac},v1=${V1}`,
        secret: SECRET,
        now: atT,
      }),
    ).resolves.toBe(true);
  });

  it("ignores unknown header keys (forward compatibility)", async () => {
    await expect(
      verifyAgencWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: `t=${T},v1=${V1},v2=deadbeef`,
        secret: SECRET,
        now: atT,
      }),
    ).resolves.toBe(true);
  });
});
