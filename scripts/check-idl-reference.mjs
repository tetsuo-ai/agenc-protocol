#!/usr/bin/env node
// Docs↔IDL drift gate.
//
// Regenerates the IDL-derived reference docs (INSTRUCTIONS.md, ERRORS.md) into
// a temp directory and diffs them line-by-line against the committed copies in
// `docs/reference/`. Any divergence — missing files included — exits non-zero
// with a readable summary, so an IDL change without regenerated docs fails
// `npm run validate` and CI.
//
// Fix drift with: npm run docs:idl-reference
//
// Usage:
//   node scripts/check-idl-reference.mjs [--idl <path>] [--docs <dir>]

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IDL_PATH,
  DEFAULT_OUT_DIR,
  generateReferenceDocs,
  loadIdl,
} from "./generate-idl-reference.mjs";

const MAX_SHOWN_DIFF_LINES = 8;

function parseArgs(argv) {
  const options = { idl: DEFAULT_IDL_PATH, docs: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--idl") options.idl = argv[++i];
    else if (argv[i] === "--docs") options.docs = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

function summarizeLineDrift(fileName, expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const drift = [];
  for (let i = 0; i < max && drift.length < MAX_SHOWN_DIFF_LINES; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      drift.push(
        `    line ${i + 1}:\n` +
          `      expected (from IDL): ${JSON.stringify(expectedLines[i] ?? "<missing>")}\n` +
          `      committed doc:       ${JSON.stringify(actualLines[i] ?? "<missing>")}`,
      );
    }
  }
  const total = countDifferingLines(expectedLines, actualLines);
  const header = `  ${fileName}: ${total} differing line(s)` +
    (expectedLines.length !== actualLines.length
      ? ` (expected ${expectedLines.length} lines, committed ${actualLines.length})`
      : "");
  const truncated = total > drift.length ? `    … ${total - drift.length} more differing line(s)` : null;
  return [header, ...drift, truncated].filter(Boolean).join("\n");
}

function countDifferingLines(expectedLines, actualLines) {
  const max = Math.max(expectedLines.length, actualLines.length);
  let count = 0;
  for (let i = 0; i < max; i += 1) {
    if (expectedLines[i] !== actualLines[i]) count += 1;
  }
  return count;
}

const options = parseArgs(process.argv.slice(2));

if (!existsSync(options.idl)) {
  console.error(`IDL not found: ${options.idl}`);
  process.exit(2);
}

const idl = loadIdl(options.idl);
const generated = generateReferenceDocs(idl, options.idl);

// Materialize the freshly generated docs in a temp dir so a failing run leaves
// an inspectable artifact.
const tempDir = mkdtempSync(join(tmpdir(), "agenc-idl-reference-"));
for (const [name, content] of Object.entries(generated)) {
  writeFileSync(join(tempDir, name), content);
}

const problems = [];
for (const [name, expected] of Object.entries(generated)) {
  const committedPath = join(options.docs, name);
  if (!existsSync(committedPath)) {
    problems.push(`  ${name}: missing at ${committedPath} (expected generated copy to be committed)`);
    continue;
  }
  const committed = readFileSync(committedPath, "utf8");
  if (committed !== expected) {
    problems.push(summarizeLineDrift(name, expected, committed));
  }
}

if (problems.length > 0) {
  console.error(`IDL reference drift detected (docs in ${options.docs} do not match ${options.idl}):`);
  console.error(problems.join("\n"));
  console.error("");
  console.error(`Freshly generated docs for comparison: ${tempDir}`);
  console.error("Fix: npm run docs:idl-reference  (then commit docs/reference)");
  process.exit(1);
}

console.log(
  `IDL reference docs are in sync: ${idl.instructions.length} instructions, ` +
    `${(idl.errors ?? []).length} errors (${options.docs} ↔ ${options.idl}).`,
);
