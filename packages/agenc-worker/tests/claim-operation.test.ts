import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, getSignatureFromTransaction } from "@solana/kit";
import { AgencError } from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it, vi } from "vitest";
import { sendClaimOperation } from "../src/claim-operation.js";
import type { WorkerContext } from "../src/runtime.js";

const TASK = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const WORKER = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

function fakeTx(seed: number) {
  return {
    messageBytes: new Uint8Array(12).fill(seed),
    signatures: { [WORKER]: new Uint8Array(64).fill(seed) },
    lifetimeConstraint: { blockhash: "blockhash-" + seed, lastValidBlockHeight: 100n },
  };
}

type Behavior = "withheld" | "rejected" | "landed";

function setup(options: { valid?: boolean; neverLanded?: boolean; status?: unknown } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "claim-operation-"));
  const resent: Uint8Array[] = [];
  const sendAndConfirm = vi.fn(async (tx: { messageBytes: Uint8Array }) => { resent.push(tx.messageBytes); return { signature: "resent" }; });
  const ctx = {
    stateDir: dir, modelSpendDir: dir, signer: { address: WORKER },
    client: { transport: { getSignatureStatus: vi.fn(async () => options.status ?? null), sendAndConfirm, confirmationCommitment: "confirmed" } },
    operationLifetime: {
      blockhashValid: vi.fn(async () => options.valid ?? false),
      neverLanded: vi.fn(async () => options.neverLanded ?? false),
    },
  } as unknown as WorkerContext;
  let seed = 0;
  // Stands in for the client: sign, then pass the send guard (or be withheld), then the transport.
  const send = vi.fn(async (opts: Parameters<Parameters<typeof sendClaimOperation>[5]>[0], behavior: Behavior = "landed") => {
    const tx = fakeTx(++seed);
    opts.assertAuthorized?.("sign");
    opts.onSigned?.(tx as never);
    if (behavior === "withheld") throw new AgencError("The signed transaction was withheld.", { signature: "withheld" });
    opts.assertAuthorized?.("send", "sig");
    if (behavior === "rejected") throw new AgencError("Preflight rejected the transaction.", { signature: "rejected" });
    return { signature: "landed-" + seed };
  });
  const run = (behavior: Behavior, extra: { check?: () => void; previous?: string } = {}) =>
    sendClaimOperation(ctx, WORKER, TASK, "submit-1", "intent", options2 => send(options2, behavior), extra.check, extra.previous);
  return { ctx, send, run, sendAndConfirm, resent };
}

describe("signed claim operations do not stick", () => {
  it("signs again once after the transaction was withheld before dispatch", async () => {
    const t = setup();
    await expect(t.run("withheld")).rejects.toThrow("withheld");
    expect(await t.run("landed")).toBe("landed-2");
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.sendAndConfirm).not.toHaveBeenCalled();
  });

  it("resends the saved bytes while their blockhash is valid, under the same check", async () => {
    const t = setup({ valid: true });
    await expect(t.run("rejected")).rejects.toThrow("Preflight");
    const check = vi.fn();
    expect(await t.run("landed", { check })).toBe("resent");
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.resent).toHaveLength(1);
    expect([...t.resent[0]!]).toEqual([...new Uint8Array(12).fill(1)]);
    expect(check).toHaveBeenCalled();
    // A refusing check blocks the resend.
    await expect(t.run("landed", { check: () => { throw new Error("The admission changed."); } })).rejects.toThrow("admission changed");
    expect(t.sendAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("signs again after the blockhash expired only when it is proven never to have landed", async () => {
    const proven = setup({ valid: false, neverLanded: true });
    await expect(proven.run("rejected")).rejects.toThrow("Preflight");
    expect(await proven.run("landed")).toBe("landed-2");
    expect(proven.send).toHaveBeenCalledTimes(2);

    const unproven = setup({ valid: false, neverLanded: false });
    await expect(unproven.run("rejected")).rejects.toThrow("Preflight");
    await expect(unproven.run("landed")).rejects.toThrow("requires chain confirmation");
    expect(unproven.send).toHaveBeenCalledTimes(1);
  });

  it("returns a confirmed saved signature without sending anything", async () => {
    const t = setup({ status: { err: null, confirmationStatus: "finalized" } });
    await expect(t.run("rejected")).rejects.toThrow("Preflight");
    expect(await t.run("landed")).toBe(getSignatureFromTransaction(fakeTx(1) as never));
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("re-signs a 0.1.16 submission whose signature is absent from the chain, once", async () => {
    const t = setup({ status: null });
    expect(await t.run("landed", { previous: "old-signature" })).toBe("landed-1");
    const confirmed = setup({ status: { err: null, confirmationStatus: "confirmed" } });
    expect(await confirmed.run("landed", { previous: "old-signature" })).toBe("old-signature");
    expect(confirmed.send).not.toHaveBeenCalled();
  });
});
