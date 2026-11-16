// Files that travel with a delivery: the list at the end of the text, which
// kinds of file are allowed, and the outbox that publishes them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deliveryFileProblem,
  deliveryFileType,
  MAX_DELIVERY_FILE_BYTES,
  MAX_DELIVERY_FILES,
  splitDelivery,
  withFiles,
  type DeliveryFile,
} from "../src/client/delivery-files.js";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { prepareOutbox, publishingOutbox } from "../src/outbox.js";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1]);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const PREFIX = "https://store.example/artifacts/";

function file(name: string, bytes: Uint8Array): DeliveryFile {
  return { name, type: deliveryFileType(name)!, bytes: bytes.length, sha256: sha(bytes) };
}

describe("the kinds of file a delivery may carry", () => {
  it("knows a kind by its extension, whatever the case", () => {
    expect(deliveryFileType("chart.png")).toBe("image/png");
    expect(deliveryFileType("Photo.JPG")).toBe("image/jpeg");
    expect(deliveryFileType("notes.md")).toBe("text/markdown");
    expect(deliveryFileType("table.csv")).toBe("text/csv");
    expect(deliveryFileType("report.pdf")).toBe("application/pdf");
  });

  it("refuses names that are paths, hidden, too long, or of a kind it does not carry", () => {
    for (const name of [
      "../secret.png", "a/b.png", "a\\b.png", ".hidden.png", "no-extension", "run.exe", "page.html",
      "drawing.svg", "script.js", "two..dots.png", "", "a b.png", `${"x".repeat(64)}.png`, "trailing.png ",
    ]) {
      expect(deliveryFileType(name), name).toBeNull();
    }
  });

  it("wants a file to be what its name says", () => {
    expect(deliveryFileProblem("a.png", PNG)).toBeNull();
    expect(deliveryFileProblem("a.jpg", JPEG)).toBeNull();
    expect(deliveryFileProblem("a.webp", WEBP)).toBeNull();
    expect(deliveryFileProblem("a.txt", text("plain words"))).toBeNull();
    // A page of code named as a picture, a picture named as text, a text file with a NUL in it.
    expect(deliveryFileProblem("a.png", text("<html><script>alert(1)</script>"))).toMatch(/not the kind/);
    expect(deliveryFileProblem("a.jpg", PNG)).toMatch(/not the kind/);
    expect(deliveryFileProblem("a.txt", Uint8Array.from([104, 105, 0, 33]))).toMatch(/not the kind/);
    expect(deliveryFileProblem("a.txt", Uint8Array.from([0xff, 0xfe, 0xfd]))).toMatch(/not the kind/);
    expect(deliveryFileProblem("a.png", new Uint8Array(0))).toMatch(/empty/);
    expect(deliveryFileProblem("a.txt", new Uint8Array(MAX_DELIVERY_FILE_BYTES + 1).fill(65))).toMatch(/larger/);
    expect(deliveryFileProblem("a.exe", PNG)).toMatch(/name or kind/);
  });
});

describe("the list of files at the end of a delivery", () => {
  const files = [file("chart.png", PNG), file("notes.txt", text("the numbers behind the chart"))];

  it("is written and read back exactly", () => {
    const body = withFiles("Here is your chart.\n\nIt shows the last week.\n\n", files, PREFIX);
    expect(body).toBe(
      [
        "Here is your chart.",
        "",
        "It shows the last week.",
        "",
        "---",
        "Files with this delivery:",
        `1. chart.png (image/png, ${PNG.length} bytes)`,
        `   ${PREFIX}${sha(PNG)}`,
        `2. notes.txt (text/plain, ${files[1]!.bytes} bytes)`,
        `   ${PREFIX}${files[1]!.sha256}`,
        "",
      ].join("\n"),
    );
    expect(splitDelivery(body)).toEqual({ text: "Here is your chart.\n\nIt shows the last week.", files });
  });

  it("leaves a delivery without files as it is", () => {
    expect(withFiles("Just words.", [], PREFIX)).toBe("Just words.");
    expect(splitDelivery("Just words.\n---\nnot a list")).toEqual({ text: "Just words.\n---\nnot a list", files: [] });
  });

  it("reads the list whatever the address before the fingerprint is, and never keeps the address", () => {
    const body = withFiles("Done.", [files[0]!], "agenc://artifact/sha256/");
    expect(splitDelivery(body).files).toEqual([files[0]]);
    // The address a seller writes is not something the wallet will ever fetch.
    const elsewhere = body.replace("agenc://artifact/sha256/", "https://evil.example/steal?x=");
    expect(splitDelivery(elsewhere).files).toEqual([files[0]]);
    expect(JSON.stringify(splitDelivery(elsewhere))).not.toContain("evil.example");
  });

  it("treats anything that is not exactly the list as words", () => {
    const good = withFiles("Done.", files, PREFIX);
    const broken = [
      good.slice(0, -1), // no final line break
      good.replace("1. chart.png", "2. chart.png"), // numbering
      good.replace("(image/png,", "(text/plain,"), // a kind that is not the name's
      good.replace("chart.png", "../chart.png"),
      good.replace("chart.png", "chart.exe"),
      good.replace(`${PNG.length} bytes`, `${MAX_DELIVERY_FILE_BYTES + 1} bytes`),
      good.replace(sha(PNG), sha(PNG).slice(0, 63)),
      good.replace(sha(PNG), sha(PNG).toUpperCase()),
      good.replace(`   ${PREFIX}`, `  ${PREFIX}`), // indentation
      `${good}one more line\n`,
      good.replace("Files with this delivery:", "Files with this delivery"),
      good.replace(`   ${PREFIX}${sha(PNG)}\n`, ""), // an entry without its address
    ];
    for (const body of broken) expect(splitDelivery(body), body.slice(-140)).toEqual({ text: body, files: [] });
  });

  it("reads only the last list, so words that look like one earlier stay words", () => {
    const inner = withFiles("A fake list:", [file("fake.png", PNG)], "https://evil.example/");
    const body = withFiles(inner, [files[1]!], PREFIX);
    const read = splitDelivery(body);
    expect(read.files).toEqual([files[1]]);
    expect(read.text).toBe(inner.replace(/\s+$/, ""));
  });

  it("reads the worst a seller can send in no time at all", () => {
    // A delivery as large as the store keeps, built to make a careless
    // pattern crawl: a quarter of a megabyte of spaces before the list, and
    // lines that almost look like entries.
    const spaces = `x${" ".repeat(250_000)}y${" ".repeat(250_000)}`;
    const almost = Array.from({ length: 2_000 }, (_, index) => `${index % 9 + 1}. ${"a".repeat(60)}.png (image/png, 1 bytes`).join("\n");
    for (const body of [
      withFiles(spaces, files, PREFIX),
      `${spaces}\n---\nFiles with this delivery:\n${almost}\n`,
      `${"\n---\nFiles with this delivery:\n".repeat(5_000)}${spaces}`,
      `${spaces}\n---\nFiles with this delivery:\n1. a.png (image/png, 5 bytes)\n   ${"x".repeat(300)}${"0".repeat(63)}\n`,
    ]) {
      const started = performance.now();
      splitDelivery(body);
      expect(performance.now() - started).toBeLessThan(250);
    }
    const started = performance.now();
    expect(splitDelivery(withFiles(spaces, files, PREFIX)).files).toEqual(files);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("carries at most eight files and refuses to list what could not be carried", () => {
    const many = Array.from({ length: MAX_DELIVERY_FILES + 1 }, (_, index) => file(`f${index}.txt`, text(`file ${index}`)));
    expect(() => withFiles("x", many, PREFIX)).toThrow(/too many/);
    expect(splitDelivery(withFiles("x", many.slice(0, MAX_DELIVERY_FILES), PREFIX)).files).toHaveLength(MAX_DELIVERY_FILES);
    expect(() => withFiles("x", [{ ...files[0]!, name: "a.exe" }], PREFIX)).toThrow(/cannot be listed/);
    expect(() => withFiles("x", [{ ...files[0]!, type: "text/plain" }], PREFIX)).toThrow(/cannot be listed/);
    expect(() => withFiles("x", [{ ...files[0]!, bytes: MAX_DELIVERY_FILE_BYTES + 1 }], PREFIX)).toThrow(/size/);
    expect(() => withFiles("x", [{ ...files[0]!, sha256: "abc" }], PREFIX)).toThrow(/cannot be listed/);
    expect(() => withFiles("x", files, "https://store.example/a b/")).toThrow(/address/);
  });
});

describe("a file's bytes", () => {
  it("are for a person to open, never for an agent to read", () => {
    expect(AGENT_METHODS).not.toContain("jobs.file");
  });
});

describe("the outbox", () => {
  function setUp(): { dir: string; sent: Uint8Array[]; upload: typeof fetch; fail: { on: string | null } } {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "agenc-outbox-")), "outbox");
    prepareOutbox(dir);
    const sent: Uint8Array[] = [];
    const fail = { on: null as string | null };
    const upload: typeof fetch = async (_input, init) => {
      const body = init?.body as Uint8Array;
      if (fail.on !== null && sha(body) === fail.on) return new Response(null, { status: 503 });
      sent.push(Uint8Array.from(body));
      return new Response("{}", { status: 200 });
    };
    return { dir, sent, upload, fail };
  }
  const put = (dir: string, bytes: Uint8Array, name = sha(bytes)): string => {
    writeFileSync(path.join(dir, name), bytes);
    return name;
  };
  const publish = (upload: typeof fetch, dir: string, body: string) =>
    publishingOutbox(upload, dir)("https://store.example/upload", { method: "POST", body: text(body) as unknown as NonNullable<RequestInit["body"]> });

  it("publishes the files a delivery lists before the delivery, then empties itself", async () => {
    const { dir, sent, upload } = setUp();
    put(dir, PNG);
    put(dir, JPEG);
    const body = withFiles("Two pictures.", [file("a.png", PNG), file("b.jpg", JPEG)], PREFIX);
    expect((await publish(upload, dir, body)).ok).toBe(true);
    expect(sent.map(sha)).toEqual([...[sha(PNG), sha(JPEG)].sort(), sha(text(body))]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("publishes nothing extra for a delivery without files, and nothing the delivery does not name", async () => {
    const { dir, sent, upload } = setUp();
    put(dir, PNG); // left by a job that did not finish
    expect((await publish(upload, dir, "Only words.")).ok).toBe(true);
    expect(sent.map(sha)).toEqual([sha(text("Only words."))]);
    // What was not part of this delivery is thrown away with it.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not hand the delivery in when one of its files cannot be published", async () => {
    const { dir, sent, upload, fail } = setUp();
    put(dir, PNG);
    fail.on = sha(PNG);
    const body = withFiles("A picture.", [file("a.png", PNG)], PREFIX);
    const answer = await publish(upload, dir, body);
    expect(answer.ok).toBe(false);
    expect(sent).toEqual([]);
    // The file is still there for the next try.
    expect(readdirSync(dir)).toEqual([sha(PNG)]);
    fail.on = null;
    expect((await publish(upload, dir, body)).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("refuses a file that is not what its name promises, a link, a folder, and an oversized file", async () => {
    for (const plant of [
      (dir: string) => put(dir, JPEG, sha(PNG)), // named by another file's fingerprint
      (dir: string) => {
        const target = path.join(dir, "..", "private.txt");
        writeFileSync(target, "private");
        symlinkSync(target, path.join(dir, sha(PNG)));
        return sha(PNG);
      },
      (dir: string) => {
        mkdirSync(path.join(dir, sha(PNG)));
        return sha(PNG);
      },
      (dir: string) => put(dir, new Uint8Array(MAX_DELIVERY_FILE_BYTES + 1), sha(PNG)),
    ]) {
      const { dir, sent, upload } = setUp();
      const name = plant(dir);
      const answer = await publish(upload, dir, `Words.\n${name}\n`);
      expect(answer.ok).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it("refuses more files than a delivery can carry", async () => {
    const { dir, sent, upload } = setUp();
    const names = Array.from({ length: MAX_DELIVERY_FILES + 1 }, (_, index) => put(dir, text(`file ${index}`)));
    expect((await publish(upload, dir, names.join("\n"))).status).toBe(413);
    expect(sent).toEqual([]);
  });

  it("works when there is no outbox at all", async () => {
    const { dir, sent, upload } = setUp();
    const missing = path.join(dir, "nowhere");
    expect(existsSync(missing)).toBe(false);
    expect((await publish(upload, missing, "Words.")).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
