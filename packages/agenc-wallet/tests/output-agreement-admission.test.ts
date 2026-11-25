// What a job's agreed outputs may name, and when each end finds out.
// The buyer's wallet refuses a name no delivery can carry before any quote. A seller's wallet reads the agreement
// when it admits a job, BEFORE the claim (agenc-worker runtime: "The room cannot fulfil the verified job terms."),
// so a job it could never deliver is not taken and no claim deposit moves.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AGREED_OUTPUT_KINDS, agreedOutputProblem, deliveryFileProblem, deliveryFileType } from "../src/client/delivery-files.js";
import { OutputAgreementError, checkOutputAgreement, outputAgreementCriterion, outputAgreementFromSpec } from "../src/client/job-exchange.js";
import { walletRoomWork } from "../src/room-work.js";

const work = () => walletRoomWork({ session: async () => null, stateDir: mkdtempSync(path.join(tmpdir(), "admit-")) });
const binding = (acceptance: unknown, privateInputs = false) => ({ task: "11111111111111111111111111111111", seller: "11111111111111111111111111111111",
  deadline: 0n, spec: { acceptance }, privateInputs, listingMetadata: null, listing: null }) as never;
const line = (names: string) => `Agreed outputs v1: at least one file; required files: ${names}`;

it("names the kinds a delivery carries, from the delivery check's own list", () => {
  for (const kind of AGREED_OUTPUT_KINDS.split(", ")) {
    expect(agreedOutputProblem("out" + kind), kind).toBeNull();
    expect(deliveryFileType("out" + kind), kind).not.toBeNull();
  }
  // Every kind a delivery carries is either allowed or a picture kind the room never hands out under that name.
  for (const kind of ["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "txt", "md", "csv", "json"]) {
    expect(deliveryFileType("a." + kind)).not.toBeNull();
    expect(agreedOutputProblem("a." + kind) === null, kind).toBe(AGREED_OUTPUT_KINDS.split(", ").includes("." + kind));
  }
  // A name that passes is one the delivery check accepts with the right bytes.
  expect(deliveryFileProblem("report.csv", Buffer.from("a,b\n"))).toBeNull();
});

it("refuses a required file no delivery can carry, in plain words that name the kinds", () => {
  for (const name of ["tool.exe", "report.xlsx", "Makefile", "notes.docx", "page.html", "run.sh"]) {
    expect(agreedOutputProblem(name), name).toBe("a delivery cannot carry that kind of file");
    let message = "";
    try { checkOutputAgreement({ requiredFiles: ["ok.csv", name], allowTextOnly: false }); } catch (error) {
      expect(error).toBeInstanceOf(OutputAgreementError);
      message = (error as Error).message;
    }
    expect(message, name).toBe(`"${name}" cannot be a required file: a delivery cannot carry that kind of file. A delivery carries these kinds of file: .png, .webp, .pdf, .zip, .txt, .md, .csv, .json.`);
    expect(() => outputAgreementCriterion({ requiredFiles: [name], allowTextOnly: false })).toThrow(OutputAgreementError);
  }
  // A job room saves every picture again as PNG or WebP with a lower-case kind: these names never come out.
  for (const name of ["photo.jpg", "photo.jpeg", "anim.gif", "Chart.PNG", "shot.WebP"]) {
    expect(agreedOutputProblem(name), name).toBe("a picture is delivered as .png or .webp");
    expect(() => checkOutputAgreement({ requiredFiles: [name], allowTextOnly: false }), name).toThrow(/a picture is delivered as \.png or \.webp/);
  }
});

it("still refuses more than eight names, a repeated name, a path and a wrong shape", () => {
  const many = Array.from({ length: 9 }, (_, index) => `f${index}.csv`);
  for (const requiredFiles of [many, ["a.csv", "A.csv"], ["../a.csv"], ["a/b.csv"], ["/etc/passwd"], [".hidden.csv"], ["a..csv"], [""], [7 as never]])
    expect(() => checkOutputAgreement({ requiredFiles, allowTextOnly: false }), String(requiredFiles)).toThrow(OutputAgreementError);
  expect(() => checkOutputAgreement({ requiredFiles: ["a.csv"], allowTextOnly: "yes" as never })).toThrow(OutputAgreementError);
  expect(() => checkOutputAgreement(null as never)).toThrow(OutputAgreementError);
});

it("accepts what a delivery can carry and writes it as before", () => {
  const good = { requiredFiles: ["report.csv", "chart.png", "cover.webp", "paper.pdf", "all.zip", "notes.txt", "README.md", "data.json"], allowTextOnly: false };
  expect(checkOutputAgreement(good)).toEqual(good);
  expect(outputAgreementCriterion({ requiredFiles: ["report.csv"], allowTextOnly: false })).toBe(line("report.csv"));
  expect(outputAgreementFromSpec({ acceptance: [line("report.csv, chart.png")] })).toEqual({ requiredFiles: ["report.csv", "chart.png"], allowTextOnly: false });
  expect(outputAgreementFromSpec({ acceptance: ["Agreed outputs v1: text-only delivery allowed; no required files"] })).toEqual({ requiredFiles: [], allowTextOnly: true });
  expect(outputAgreementFromSpec({ acceptance: ["Be kind."] })).toBeUndefined();
});

it("a seller does not admit, before the claim, a job whose agreed outputs it could never deliver", async () => {
  for (const name of ["tool.exe", "report.xlsx", "Makefile", "photo.jpg", "Chart.PNG"])
    await expect(work().admit(binding([line(name)])), name).rejects.toThrow(/cannot be a required file/);
  await expect(work().admit(binding(["Check the totals.", line("report.csv, tool.exe")]))).rejects.toThrow(/tool\.exe/);
});

it("a seller does not admit a malformed, repeated, duplicate, path or oversized agreement", async () => {
  const nine = Array.from({ length: 9 }, (_, index) => `f${index}.csv`).join(", ");
  const bad: unknown[] = [
    ["Agreed outputs v1: anything goes"],
    ["Agreed outputs v1: "],
    ["Agreed outputs v1: at least one file"],
    ["Agreed outputs v1: at least one file; required files: "],
    [line("report.csv") + " "],
    [line("report.csv,chart.png")],
    [line("report.csv"), line("report.csv")],
    [line("report.csv"), "Agreed outputs v1: text-only delivery allowed; no required files"],
    [line("report.csv, report.csv")],
    [line("report.csv, REPORT.csv")],
    [line("../report.csv")],
    [line("a/report.csv")],
    [line("/etc/passwd")],
    [line(nine)],
    "Agreed outputs v1: at least one file; required files: report.csv",
    { 0: line("report.csv") },
  ];
  for (const acceptance of bad) await expect(work().admit(binding(acceptance)), JSON.stringify(acceptance)).rejects.toThrow();
});

it("a seller admits a good agreement, a text-only one and a job from before agreements", async () => {
  for (const acceptance of [[line("report.csv")], [line("report.csv, chart.png, cover.webp")], ["Check the totals.", line("data.json")],
    ["Agreed outputs v1: text-only delivery allowed; no required files"], ["Agreed outputs v1: at least one file; no required files"],
    ["Be kind."], []])
    await expect(work().admit(binding(acceptance)), JSON.stringify(acceptance)).resolves.toBeUndefined();
  // No acceptance at all (an older job).
  await expect(work().admit({ task: "11111111111111111111111111111111", seller: "11111111111111111111111111111111", deadline: 0n, spec: {},
    privateInputs: false, listingMetadata: null, listing: null } as never)).resolves.toBeUndefined();
});
