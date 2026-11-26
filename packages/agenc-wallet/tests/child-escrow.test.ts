import { createHash } from "node:crypto";
import { getAddressEncoder, generateKeyPairSigner } from "@solana/kit";
import { AGENC_COORDINATION_PROGRAM_ADDRESS as program } from "@tetsuo-ai/marketplace-sdk";
import { expect, it } from "vitest";
import { escrowStatus } from "../src/child-hire.js";
import type { Chain } from "../src/chain.js";
import type { ChildEscrow } from "../src/client/child-hire.js";

it("does not turn a signature alone into a payout when the escrow has closed", async () => {
  const { address: task } = await generateKeyPairSigner();
  const cached = {
    task,
    status: "working",
    signature: "funding",
    jobId: "child",
    deadline: null,
    reviewEndsAt: null,
    action: null,
  } satisfies ChildEscrow;
  const chain = {
    readRawAccount: async () => null,
    findSettlementSignature: async () => "ruling",
  } as unknown as Chain;
  expect(await escrowStatus(chain, cached, task, true)).toMatchObject({ status: "unknown", signature: null });
});

it("decodes a ruling for each escrow and ignores another program's event", async () => {
  const { escrowEvent } = await import("../src/child-escrow.js");
  const { address: parent } = await generateKeyPairSigner(),
    { address: child } = await generateKeyPairSigner();
  const event = (task: typeof parent, outcome: number) =>
    "Program data: " +
    Buffer.concat([
      createHash("sha256").update("event:RejectFrozenResolved").digest().subarray(0, 8),
      Uint8Array.from(getAddressEncoder().encode(task)),
      Buffer.from([outcome]),
      Buffer.alloc(8),
    ]).toString("base64");
  const logs = [
    `Program ${parent} invoke [1]`,
    event(child, 1),
    `Program ${parent} success`,
    `Program ${program} invoke [1]`,
    event(parent, 1),
    event(child, 0),
    `Program ${program} success`,
  ];
  expect(await escrowEvent(logs, parent)).toBe("paid");
  expect(await escrowEvent(logs, child)).toBe("refunded");
});
