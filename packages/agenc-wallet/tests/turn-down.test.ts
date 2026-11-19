// What a turn-down writes on the chain: a reason that anyone can work out
// again from the job itself, not a fingerprint of the wallet's own clock.
import { address } from "@solana/kit";
import { values } from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it } from "vitest";
import { TURN_DOWN_REASON, turnDownReason } from "../src/market.js";

const TASK = address("7Z9CYgQ4ytmGHW9a8qr998CiS6DJn7wdeWcCNQFBAGid");
const DELIVERY = "ab".repeat(32);
const REQUEST = "cd".repeat(32);

describe("the reason a turn-down records", () => {
  it("is the hash of a document built only from what the job records publicly", async () => {
    const reason = await turnDownReason({ task: TASK, deliveryHashHex: DELIVERY, requestHashHex: REQUEST });
    expect(reason.document).toEqual({
      kind: "agenc.marketplace.turnDown",
      v: 1,
      task: TASK,
      delivery: DELIVERY,
      request: REQUEST,
      reason: TURN_DOWN_REASON,
    });
    // A reviewer rebuilds it with nothing but the job and the SDK.
    const rebuilt = await values.canonicalJobSpecHash({
      reason: "The delivery does not do what was asked.",
      request: REQUEST,
      delivery: DELIVERY,
      task: TASK,
      v: 1,
      kind: "agenc.marketplace.turnDown",
    });
    expect(reason.hex).toBe(rebuilt.hex);
    expect(Array.from(reason.hash)).toEqual(Array.from(rebuilt.bytes));
    // Pinned (sha-256 of the sorted JSON, worked out separately), so the shape
    // cannot drift without this test saying so.
    expect(reason.hex).toBe("cc5373bee64efd13c27e5fe9f0d74729286379f0c1928fb3dfe7f494f244a3e7");
  });

  it("names the job, the delivery and the request it answered", async () => {
    const base = await turnDownReason({ task: TASK, deliveryHashHex: DELIVERY, requestHashHex: REQUEST });
    const otherDelivery = await turnDownReason({ task: TASK, deliveryHashHex: "ef".repeat(32), requestHashHex: REQUEST });
    const otherRequest = await turnDownReason({ task: TASK, deliveryHashHex: DELIVERY, requestHashHex: "01".repeat(32) });
    const otherTask = await turnDownReason({
      task: address("AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE"),
      deliveryHashHex: DELIVERY,
      requestHashHex: REQUEST,
    });
    const hashes = new Set([base.hex, otherDelivery.hex, otherRequest.hex, otherTask.hex]);
    expect(hashes.size).toBe(4);
  });

  it("is the same whoever works it out and whenever, and never the old clock fingerprint", async () => {
    const first = await turnDownReason({ task: TASK, deliveryHashHex: DELIVERY, requestHashHex: REQUEST });
    const again = await turnDownReason({ task: TASK, deliveryHashHex: DELIVERY, requestHashHex: REQUEST });
    expect(again.hex).toBe(first.hex);
    // What the wallet used to send: the wallet's own job id and clock, which
    // nobody else can know, so the hash said nothing about the delivery.
    const old = values.bytesToHex(await values.sha256(`declined:job_x:${Date.now()}`));
    expect(first.hex).not.toBe(old);
    expect(first.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash.some((byte) => byte !== 0)).toBe(true);
  });
});
