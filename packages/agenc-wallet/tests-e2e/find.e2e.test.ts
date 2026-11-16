// Finding a service, against the real program: a search reads what a provider
// wrote, the list comes a page at a time, and every row says what the buyer
// is asked to send and what comes back.
import { afterEach, describe, expect, it } from "vitest";
import { CENT, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const NAMES = {
  name: "Northlight",
  category: "marketing",
  summary: "Ten name ideas for a product, pet or project.",
  inputs: ["What needs a name"],
  outputs: ["Ten ideas"],
  priceLamports: 80n * CENT,
  replyPrefix: "Ten ideas.",
};
const NOTES = {
  name: "Clear Notes",
  category: "writing",
  summary: "A short, plain summary of the text you send.",
  inputs: ["The text to sum up", "How long it should be"],
  outputs: ["A summary in plain words"],
  priceLamports: 50n * CENT,
  replyPrefix: "Summary.",
};

describe("finding a service", () => {
  it("searches what the provider wrote, not only the name", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    await sandbox.addService(NAMES);
    await sandbox.addService(NOTES);
    const names = async (query: string): Promise<string[]> =>
      (await wallet.find({ query, limit: 20 })).services.map((service) => service.name);

    // A word that is only in the description.
    expect(await names("poem")).toEqual(["Haiku Writer"]);
    // The plural a person types finds the singular a provider wrote.
    expect(await names("summaries")).toEqual(["Clear Notes"]);
    expect(await names("poems")).toEqual(["Haiku Writer"]);
    // The category, and what the service hands back.
    expect(await names("marketing")).toEqual(["Northlight"]);
    expect(await names("ideas")).toEqual(["Northlight"]);
    // What it asks for.
    expect(await names("sum up")).toEqual(["Clear Notes"]);
    // A word in the name counts for more than a word further down.
    expect(await names("notes poem")).toEqual(["Clear Notes", "Haiku Writer"]);
    expect(await wallet.find({ query: "zebra" })).toEqual({ services: [], total: 0 });

    // Of several words, the services that match the most of them are the answer:
    // one stray word does not make a match.
    expect(await names("plain summary poem")).toEqual(["Clear Notes"]);
    expect(await names("name ideas for a product")).toEqual(["Northlight"]);
    // A whole sentence works, from a person or an agent: the filler is left out.
    expect(await names("find someone to write me a poem about my garden")).toEqual(["Haiku Writer"]);
    expect(await names("I need a short summary of some text, please")).toEqual(["Clear Notes"]);
    // A short word has to stand alone: "ai" is inside "haiku", and is not a match for it.
    await sandbox.addService({
      name: "AI Painter",
      category: "design",
      summary: "Paints what you describe.",
      priceLamports: 90n * CENT,
      replyPrefix: "Painted.",
    });
    expect(await names("ai")).toEqual(["AI Painter"]);
    expect(await names("ai painter")).toEqual(["AI Painter"]);
    // Filler alone is still a search, of a kind: it is all there is to go on.
    expect((await wallet.find({ query: "the" })).total).toBeGreaterThan(0);

    const [notes] = (await wallet.find({ query: "notes" })).services;
    expect(notes).toMatchObject({
      name: "Clear Notes",
      details: "ready",
      category: "writing",
      summary: "A short, plain summary of the text you send.",
      description: "A short, plain summary of the text you send.",
      inputs: ["The text to sum up", "How long it should be"],
      outputs: ["A summary in plain words"],
      tags: [],
      terms: [],
    });
  });

  it("hands the list out a page at a time and says how many there are", async () => {
    world = await startWorld();
    const { wallet, sandbox } = world;
    for (let index = 0; index < 4; index += 1) {
      await sandbox.addService({ ...NAMES, name: `Namer ${index}`, priceLamports: BigInt(index + 30) * CENT });
    }
    const all = await wallet.find({ limit: 50 });
    expect(all.total).toBe(5);
    expect(all.services).toHaveLength(5);

    const first = await wallet.find({ limit: 2 });
    const second = await wallet.find({ limit: 2, offset: 2 });
    const third = await wallet.find({ limit: 2, offset: 4 });
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([first.services.length, second.services.length, third.services.length]).toEqual([2, 2, 1]);
    // The pages are the same list cut up: nothing twice, nothing missing.
    expect([...first.services, ...second.services, ...third.services].map((service) => service.listing)).toEqual(
      all.services.map((service) => service.listing),
    );
    expect(await wallet.find({ limit: 2, offset: 9 })).toEqual({ services: [], total: 5 });
    // A search has its own count.
    expect((await wallet.find({ query: "namer", limit: 1 })).total).toBe(4);
    // Nonsense for a page is read as the first page.
    expect((await wallet.find({ limit: 2, offset: -3 })).services.map((service) => service.listing)).toEqual(
      first.services.map((service) => service.listing),
    );
  });
});
