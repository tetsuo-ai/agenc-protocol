// Run again in the integrated checkout: B provides the signed private exchange.
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { expect, it } from "vitest";
import { stageChildShare } from "../src/child-share.js";
import { readAgent, readHireableListing } from "../src/market.js";
import { openParentFixture } from "./child-hire-fixture.js";
import { privateRoomDouble } from "./harness.js";

it.skipIf(!("exchangeContext" in taskThread))(
  "restages only the authenticated private parent bundle for the specifically authorized supplier",
  async () => {
    // B is a separate release input. Keep the fixtures importable on G's recorded base.
    const source = "../src/private-inputs.js";
    const { privateInputCriterion } = await import(source);
    const sessionSource = "../src/job-exchange-session.js";
    const { JobExchangeSession } = await import(sessionSource);
    const file = Buffer.from("private source material");
    const files = [
      {
        name: "source.csv",
        bytes: file.length,
        sha256: createHash("sha256").update(file).digest("hex"),
        base64: file.toString("base64"),
      },
    ];
    let requirement: { commitment: string; required: true; version: 1 };
    let supplier = "";
    const f = await openParentFixture({
      privateInputs: true,
      // A private hire needs the seller's verified isolated room.
      world: { earn: { executor: { argv: [process.execPath, "-e", "setTimeout(()=>{},60000)", "{prompt}"], mode: "sandboxed",
        envAllowlist: [], timeoutMs: 60_000, isolatedJobRoom: true }, roomWork: privateRoomDouble(), pollIntervalMs: 150, serviceRefreshMs: 300 } },
      async prepareCriteria(world, request, seller, listing) {
        const registration = (await readHireableListing(world.sandbox.chain, address(listing))).providerAgent;
        supplier = (await readAgent(world.sandbox.chain, registration))!.authority;
        requirement = await Reflect.get(world.wallet, "stageJobInputs").call(
          world.wallet,
          files,
          seller,
          "Use the figures in the approved report.",
        );
        return [privateInputCriterion(requirement)];
      },
    });
    try {
      const wallet = f.world.wallet;
      const open = Reflect.get(wallet, "jobExchange").bind(wallet);
      const client = await open(f.job.id, f.grant.roomId, f.buyer.id);
      const studio = await open("earn_" + f.seller.id + "_" + f.job.task, f.grant.roomId, f.seller.id);
      const packets: { signature: string }[] = [];
      const relay = {
        async put(_exchange: unknown, p: { signature: string }) {
          if (!packets.some((other) => other.signature === p.signature)) packets.push(p);
        },
        async next(_exchange: unknown, cursor: number) {
          return packets[cursor] && { cursor: cursor + 1, packet: packets[cursor] };
        },
      };
      const sessions = [client, studio].map(
        (exchange) => new JobExchangeSession(exchange, relay, Date.now() + 60000, requirement),
      );
      const [buyer, seller] = sessions;
      await buyer.join();
      await seller.join();
      await buyer.refresh();
      await seller.refresh();
      const preview = await buyer.grantPreview();
      await buyer.release(preview.parties, preview.keySignature);
      await seller.refresh();
      const request = { ...f.request, privateCommitment: requirement!.commitment };
      const proof = await wallet.childHires.authorizeShare(f.job.id, {
        parentTask: f.grant.parentTask,
        supplier,
        request,
      });
      await expect(stageChildShare(wallet as object, f.grant, request, supplier, proof)).rejects.toThrow();
      await seller.importInputs(async (bundle: { version: number }) => ({
        room: f.grant.roomId,
        commitment: requirement.commitment,
        manifest: requirement.commitment,
        version: bundle.version,
      }));
      const derived = await stageChildShare(wallet as object, f.grant, request, supplier, proof);
      expect(derived).not.toEqual(requirement!.commitment);
      expect(await stageChildShare(wallet as object, f.grant, request, supplier, proof, derived)).toEqual(
        derived,
      );
      await expect(
        stageChildShare(wallet as object, { ...f.grant, roomId: "b".repeat(64) }, request, supplier, proof),
      ).rejects.toThrow();
      await expect(
        wallet.childHires.request(f.grant, { ...request, brief: "Publish all figures" }),
      ).rejects.toThrow(/original buyer/);
      if (typeof Reflect.get(wallet, "postListingMessage") === "function") {
        const q = await wallet.childHires.request(f.grant, request, proof);
        expect(JSON.stringify(q.quote.terms)).not.toContain("source.csv");
        const funded = await wallet.childHires.decide(f.grant.parentTask, q.quote.id, true);
        expect(funded.child.task).toBeTruthy();
        expect(funded.child.task).not.toBe(funded.parent.task);
      }
      expect(JSON.stringify(await buyer.status())).not.toContain(file.toString());
    } finally {
      await f.world.wallet.close();
      rmSync(f.room, { recursive: true, force: true });
    }
  },
  90000,
);
