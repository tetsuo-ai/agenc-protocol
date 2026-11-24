// Run again in the integrated checkout: B provides the signed private exchange.
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walletRoomWork } from "../src/room-work.js";
import { connectRoomExchange } from "../src/client/room-exchange.js";
import { readAgent, readHireableListing } from "../src/market.js";
import { openParentFixture } from "./child-hire-fixture.js";

it.skipIf(!("exchangeContext" in taskThread))(
  "gives a paid private hire's room its scoped exchange session and resumes the parked run once after the buyer answers",
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
    const packets: { signature: string }[] = [];
    const relay = {
      async put(_exchange: unknown, p: { signature: string }) {
        if (!packets.some((other) => other.signature === p.signature)) packets.push(p);
        return packets.length;
      },
      async next(_exchange: unknown, cursor: number) {
        return packets[cursor] && { cursor: cursor + 1, packet: packets[cursor] };
      },
      async output() {
        return null;
      },
    };
    const f = await openParentFixture({
      privateInputs: true,
      world: {
        // The seller's host room (C/D) admits the private parent; this test parks its turn.
        earn: {
          executor: { argv: [process.execPath, "-e", "", "{prompt}"], mode: "sandboxed", envAllowlist: [], timeoutMs: 60_000, isolatedJobRoom: true },
          pollIntervalMs: 150,
          serviceRefreshMs: 300,
          roomWork: () => ({ admit: async () => {}, open: async () => ({ state: "waiting" as const }) }),
        } as never,
        services: (services) => ({ ...services, exchangeRelay: relay as never }),
      },
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
    const stateDir = mkdtempSync(join(tmpdir(), "room-work-"));
    try {
      f.world.clock.now = Math.max(Date.now(), Number(await f.world.sandbox.chain.clusterTime()) * 1000);
      const wallet = f.world.wallet;
      const room = f.grant.roomId;
      const earnId = "earn_" + f.seller.id + "_" + f.job.task;
      const buyer = new JobExchangeSession(await Reflect.get(wallet, "jobExchange").call(wallet, f.job.id, room, f.buyer.id),
        relay, f.world.clock.now + 3600000, requirement!, () => f.world.clock.now);
      let runs = 0;
      let question = "";
      const work = walletRoomWork({
        stateDir,
        session: async () => wallet.jobExchangeSession(earnId, room, relay as never, f.seller.id),
        // Stands in for Desktop's job room program: it sees only the scope JSON the wallet extended.
        execute: async (input) => {
          runs++;
          const scope = JSON.parse(input.argv[1]!);
          expect(scope.task).toBe(f.job.task);
          const exchange = await connectRoomExchange(scope.exchange);
          try {
            const { requirement: req, room: granted, bundle } = await exchange.roomInputs();
            expect(granted).toBe(room);
            expect(bundle.files.map((x) => x.name)).toEqual(["source.csv"]);
            await exchange.importInputs(async (current) => ({ commitment: req.commitment, version: current.version, manifest: req.commitment, room: granted }));
            if (runs === 1) {
              question = "a".repeat(32);
              await exchange.send({ id: question, kind: "question", parent: null, body: "Which quarter?" });
              expect(await exchange.roomTurnState()).toBe("parked");
              throw new Error("job-room: no delivery: Waiting for the buyer.");
            }
            const out = Buffer.from("q3,42\n");
            const pointer = await exchange.returnRoomOutput("Done.", [{ name: "answer.csv", bytes: out.length,
              sha256: createHash("sha256").update(out).digest("hex"), base64: out.toString("base64") }]);
            return { stdout: Buffer.from(pointer), stderr: Buffer.alloc(0), exitCode: 0 } as never;
          } finally { exchange.close(); }
        },
      });
      const binding = { task: address(f.job.task!), seller: address(f.seller.address), deadline: 0n, listing: null, privateInputs: true,
        spec: { acceptance: [privateInputCriterion(requirement!)] } };
      const input = { argv: ["room", JSON.stringify({ task: f.job.task, receipt: null, pin: null }), "{prompt}"], prompt: "Prepare.", timeoutMs: 60000 };
      await work.admit(binding);
      // Before the buyer releases the files the run waits; the seller's room joined the exchange.
      expect((await work.open(binding)).state).toBe("waiting");
      await buyer.join();
      await buyer.refresh();
      const preview = (await buyer.grantPreview())!;
      await buyer.release(preview.parties, preview.keySignature);
      const ready = await work.open(binding);
      if (ready.state !== "ready") throw new Error("expected ready, got " + ready.state);
      expect(await ready.execute(input as never)).toEqual({ state: "parked" });
      // The buyer answers. The worker's question hook enqueues one durable continuation.
      await buyer.refresh();
      await buyer.send({ id: "b".repeat(32), kind: "reply", parent: question, body: "Q3." });
      const questions = (await work.questions!(binding))!;
      await questions.session.refresh();
      expect(await questions.session.conversation.resume(questions.enqueueOnce)).toBe(true);
      const resumed = await work.open(binding);
      if (resumed.state !== "resume") throw new Error("expected resume, got " + resumed.state);
      const delivered = await resumed.resume();
      expect(delivered.state).toBe("delivered");
      expect((delivered as { stdout: Buffer }).stdout.toString()).toMatch(/^agenc\.private-output\.v[12]:[a-f0-9]{64}$/);
      expect(runs).toBe(2);
      // The continuation is consumed: the next open is an ordinary ready run, never a second resume.
      expect((await work.open(binding)).state).toBe("ready");
      expect(JSON.stringify(await buyer.status())).not.toContain("private source material");
    } finally {
      await f.world.wallet.close();
      rmSync(f.room, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
  90000,
);
