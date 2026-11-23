import { setEarnWithApproval } from "./harness.js";
// Files with a delivery, end to end against the real program: a provider
// leaves a picture in its outbox, the delivery lists it, and the buyer's
// wallet reads the list, fetches the file by its fingerprint and checks it.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitDelivery } from "../src/client/delivery-files.js";
import { PRACTICE_SERVICES } from "../src/sandbox.js";
import type { MarketServices } from "../src/services.js";
import { CENT, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const POSTCARD = PRACTICE_SERVICES.find((service) => service.picture === true)!;

async function hirePostcard(started: World): Promise<string> {
  const { wallet, sandbox } = started;
  const listing = await sandbox.addService(POSTCARD);
  const agent = await wallet.createAgent("My assistant");
  await wallet.setPolicy(agent.id, {
    askAboveCents: 500,
    refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
  });
  await wallet.fundAgent(agent.id, { usdCents: 400 });
  const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A postcard for my desk." });
  // The house provider does the job: the picture and the delivery that lists it.
  expect(await sandbox.workOnce()).toBe(1);
  expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
  return job.id;
}

describe("a delivery with a picture", () => {
  it("shows the words, lists the picture, and hands the picture over checked", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    const jobId = await hirePostcard(world);
    const job = await wallet.getJob(jobId, true);

    // The words, without the list of files that ended them.
    expect(job.result?.verified).toBe(true);
    expect(job.result?.text).toContain("Here is your postcard.");
    expect(job.result?.text).toContain("You asked: A postcard for my desk.");
    expect(job.result?.text).not.toContain("Files with this delivery");
    expect(job.result?.files).toHaveLength(1);
    const listed = job.result!.files[0]!;
    expect(listed).toMatchObject({ name: "postcard.png", type: "image/png" });
    expect(listed.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The delivery that was recorded with the job is the words and the list
    // together, so the job's fingerprint covers the picture too.
    const recorded = new TextDecoder().decode(sandbox.deliveries.get(job.result!.hash!)!);
    expect(splitDelivery(recorded).files).toEqual(job.result!.files);

    const file = await wallet.jobFile(jobId, listed.sha256);
    const bytes = Buffer.from(file.base64, "base64");
    expect(bytes.length).toBe(listed.bytes);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect({ name: file.name, type: file.type, sha256: file.sha256 }).toEqual({
      name: "postcard.png",
      type: "image/png",
      sha256: listed.sha256,
    });

    // Only a file this delivery lists can be asked for.
    await expect(wallet.jobFile(jobId, "0".repeat(64))).rejects.toThrow(/not part of this delivery/);
    await expect(wallet.jobFile("job_nope", listed.sha256)).rejects.toThrow();

    // Paying for it works as for any delivery.
    const paid = await wallet.approveJob(jobId, 5, true);
    expect(paid.status).toBe("paid");
  }, 120_000);

  it("does not open a file the store hands back changed, or one it cannot get", async () => {
    let swap: "changed" | "missing" | null = null;
    world = await startWorld({
      services: (services): MarketServices => ({
        ...services,
        fetchFile: async (sha256Hex) => {
          const bytes = await services.fetchFile(sha256Hex);
          if (swap === "missing") return null;
          // A dishonest store: the right size, a picture, but not the one that was listed.
          if (swap === "changed" && bytes !== null) return Uint8Array.from(bytes, (byte, index) => (index === bytes.length - 20 ? byte ^ 1 : byte));
          return bytes;
        },
      }),
    });
    const jobId = await hirePostcard(world);
    const listed = (await world.wallet.getJob(jobId, true)).result!.files[0]!;
    swap = "missing";
    await expect(world.wallet.jobFile(jobId, listed.sha256)).rejects.toThrow(/could not be fetched/);
    swap = "changed";
    await expect(world.wallet.jobFile(jobId, listed.sha256)).rejects.toThrow(/not what the delivery says/);
    swap = null;
    expect((await world.wallet.jobFile(jobId, listed.sha256)).name).toBe("postcard.png");
  }, 120_000);
});

describe("an agent that delivers files", () => {
  it("is told where to leave them, what a file's address starts with and what the job pays", async () => {
    const seen = path.join(mkdtempSync(path.join(tmpdir(), "agenc-wallet-argv-")), "argv.json");
    // The job program: note what it was started with, leave one file in the
    // outbox named by its fingerprint, and list it at the end of the delivery.
    const program = [
      "const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');",
      "const [seenFile, outbox, prefix, pay, agent] = process.argv.slice(1);",
      "fs.writeFileSync(seenFile, JSON.stringify({ outbox, prefix, pay, agent }));",
      "const bytes = Buffer.from('city,temp\\nOslo,4\\n');",
      "const sha = crypto.createHash('sha256').update(bytes).digest('hex');",
      "fs.writeFileSync(path.join(outbox, sha), bytes);",
      "fs.writeFileSync(path.join(outbox, 'f'.repeat(64)), 'left by a job that did not finish');",
      "process.stdout.write('The table you asked for.\\n\\n---\\nFiles with this delivery:\\n1. table.csv (text/csv, ' + bytes.length + ' bytes)\\n   ' + prefix + sha + '\\n');",
    ].join("\n");
    world = await startWorld({
      earn: {
        executor: {
          argv: [process.execPath, "-e", program, seen, "{outbox}", "{files}", "{pay}", "{agent}", "{prompt}"],
          mode: "sandboxed",
          envAllowlist: [],
          timeoutMs: 30_000,
        },
        pollIntervalMs: 150,
      },
    });
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    await sandbox.postOpenJob({ title: "A table", instructions: "Send a small table.", rewardLamports: 50n * CENT });
    // The file and the delivery that lists it are both in the store.
    await eventually(async () => sandbox.deliveries.size === 2, 30_000);

    const started = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;
    expect(started.agent).toBe(agent.id);
    expect(path.basename(started.outbox!)).toBe("outbox");
    expect(started.outbox).toContain(world.dataDir);
    expect(started.prefix).toBe("agenc://artifact/sha256/");
    // This job pays fifty cents, even though the minimum is ten.
    expect(started.pay).toBe("50");

    const bodies = [...sandbox.deliveries.values()].map((bytes) => new TextDecoder().decode(bytes));
    const delivery = bodies.find((body) => body.startsWith("The table you asked for."))!;
    const { text, files } = splitDelivery(delivery);
    expect(text).toBe("The table you asked for.");
    expect(files).toHaveLength(1);
    expect(new TextDecoder().decode(sandbox.deliveries.get(files[0]!.sha256)!)).toBe("city,temp\nOslo,4\n");
    // What the delivery did not name was never published, and the outbox is empty again.
    expect(bodies.some((body) => body.includes("did not finish"))).toBe(false);
    await eventually(async () => {
      const { readdirSync } = await import("node:fs");
      return readdirSync(started.outbox!).length === 0;
    }, 10_000);
  }, 120_000);
});
