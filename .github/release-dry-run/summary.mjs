// Temporary release dry run (scratch branch only, never for main).
// Collects every pack record into pins.json, checks the repeated SDK pack,
// and fails unless every job of the run succeeded.
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = process.env.DRY_RUN_ARTIFACTS;
const outDir = path.join(process.env.RUNNER_TEMP, "dry-run-pins");
const train = JSON.parse(
  await readFile(path.join(root, "release-train.json"), "utf8"),
);

const records = [];
for (const name of (await readdir(artifacts)).sort()) {
  if (!name.startsWith("dry-run-pack-")) continue;
  try {
    records.push(
      JSON.parse(
        await readFile(path.join(artifacts, name, "integrity.json"), "utf8"),
      ),
    );
  } catch (error) {
    console.log(`${name}: no integrity.json (${error.message})`);
  }
}

const problems = [];
const pins = {};
const lines = [
  "| Package | Version | Integrity | Files | Bytes |",
  "|---|---|---|---|---|",
];
for (const entry of train.packages) {
  if (entry.id === "moderation") {
    lines.push(
      `| ${entry.name} | ${entry.expectedVersion} | unchanged (not released) | | |`,
    );
    continue;
  }
  const tag = `${entry.tagPrefix}${entry.expectedVersion}`;
  const first = records.find((r) => r.tag === tag && r.attempt === "a");
  if (first === undefined) {
    problems.push(`${tag}: no packed tarball`);
    lines.push(`| ${entry.name} | ${entry.expectedVersion} | MISSING | | |`);
    continue;
  }
  if (first.name !== entry.name || first.version !== entry.expectedVersion) {
    problems.push(`${tag}: packed ${first.name}@${first.version}`);
  }
  for (const other of records.filter(
    (r) => r.tag === tag && r.attempt !== "a",
  )) {
    if (other.integrity !== first.integrity) {
      problems.push(
        `${tag}: attempt ${other.attempt} packed ${other.integrity}, attempt a ${first.integrity}`,
      );
    }
  }
  pins[entry.id] = {
    name: first.name,
    version: first.version,
    integrity: first.integrity,
    sha256: first.sha256,
    entryCount: first.entryCount,
    size: first.size,
    testingProgramSha256: first.testingProgramSha256,
    builtProgramSha256: first.builtProgramSha256,
  };
  lines.push(
    `| ${entry.name} | ${entry.expectedVersion} | \`${first.integrity}\` | ${first.entryCount} | ${first.size} |`,
  );
}

const jobs = {
  protocol_verifiable_build: process.env.RESULT_VERIFY,
  rust_supply_chain: process.env.RESULT_RUST,
  pack_protocol: process.env.RESULT_PACK_PROTOCOL,
  pack_clients: process.env.RESULT_PACK_CLIENTS,
  smoke_clients: process.env.RESULT_SMOKE,
};
lines.push("", "| Job | Result |", "|---|---|");
for (const [job, result] of Object.entries(jobs)) {
  lines.push(`| ${job} | ${result} |`);
  if (result !== "success") problems.push(`${job}: ${result}`);
}

await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "pins.json"),
  `${JSON.stringify(
    {
      sourceCommit: process.env.GITHUB_SHA,
      jobs,
      problems,
      pins,
      records,
    },
    null,
    2,
  )}\n`,
);
const report = `${lines.join("\n")}\n${
  problems.length > 0
    ? `\nProblems:\n${problems.map((p) => `- ${p}`).join("\n")}\n`
    : "\nNo problems.\n"
}`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
}
if (problems.length > 0) process.exitCode = 1;
