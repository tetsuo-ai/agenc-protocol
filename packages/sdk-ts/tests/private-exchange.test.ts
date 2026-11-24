import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createExchangeKey, newExchangeId, openPacket, sealPacket, signPacket, verifyPacket } from "../src/task-thread/private-exchange.js";

async function fixture() {
  const [buyer, worker, task, claim] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const parties = { task: task.address, claim: claim.address, generation: "1", claimedAt: "123", worker: worker.address,
    buyer: buyer.address, authority: worker.address, room: "f".repeat(64) };
  const key = await createExchangeKey();
  const announcement = await signPacket({ ...parties, sender: worker.address, id: newExchangeId(), purpose: "key" }, key.publicKey, worker);
  const data = new TextEncoder().encode("private-name.csv\nprivate bytes");
  const packet = await sealPacket({ ...parties, sender: buyer.address, id: newExchangeId(), purpose: "inputs" }, data, announcement, buyer);
  return { buyer, worker, parties, key, announcement, packet, data };
}

describe("private task thread", () => {
  it("only the named recipient can open signed content", async () => {
    const { buyer, parties, key, packet, data } = await fixture();
    expect(JSON.stringify(packet)).not.toContain("private-name");
    expect(await openPacket(packet, parties, buyer.address, "inputs", key.privateKey)).toEqual(data);
    await expect(openPacket(packet, parties, buyer.address, "inputs", (await createExchangeKey()).privateKey)).rejects.toThrow();
  });
  it("rejects a key substituted after its announcement and a substituted ciphertext", async () => {
    const { buyer, parties, announcement, packet, key, data } = await fixture();
    await expect(sealPacket(packet.header, data, { ...announcement, payload: (await createExchangeKey()).publicKey }, buyer)).rejects.toThrow();
    await expect(openPacket({ ...packet, payload: packet.payload + " " }, parties, buyer.address, "inputs", key.privateKey)).rejects.toThrow();
  });
  it("rejects replay into another claim, room, sender or message type", async () => {
    const { buyer, worker, parties, packet } = await fixture();
    for (const override of [{ generation: "2" }, { claimedAt: "124" }, { claim: buyer.address }, { room: "e".repeat(64) }]) {
      await expect(verifyPacket(packet, { ...parties, ...override }, buyer.address, "inputs")).rejects.toThrow();
    }
    await expect(verifyPacket(packet, parties, worker.address, "inputs")).rejects.toThrow();
    await expect(verifyPacket(packet, parties, buyer.address, "output")).rejects.toThrow();
  });
});
