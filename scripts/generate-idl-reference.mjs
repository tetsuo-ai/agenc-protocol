#!/usr/bin/env node
// IDL-derived protocol reference generator.
//
// Reads the canonical committed Anchor IDL
// (`artifacts/anchor/idl/agenc_coordination.json`) and emits:
//
//   docs/reference/INSTRUCTIONS.md — one section per instruction: doc-strings,
//     accounts table (writable/signer/optional flags, PDA seeds or fixed
//     address, has_one relations), args with rendered Rust-ish types.
//   docs/reference/ERRORS.md — every error code: number, name, message.
//
// Output is deterministic (instructions sorted by name, errors by code, no
// timestamps) so diffs are meaningful and `scripts/check-idl-reference.mjs`
// can enforce docs↔IDL freshness in the validate chain.
//
// Usage:
//   node scripts/generate-idl-reference.mjs [--out <dir>] [--idl <path>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_IDL_PATH = "artifacts/anchor/idl/agenc_coordination.json";
export const DEFAULT_OUT_DIR = "docs/reference";
export const GENERATED_FILES = ["INSTRUCTIONS.md", "ERRORS.md"];

// --- rendering helpers -------------------------------------------------------

function escapeCell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function renderType(type) {
  if (typeof type === "string") return type;
  if (type === null || typeof type !== "object") return JSON.stringify(type);
  if ("option" in type) return `Option<${renderType(type.option)}>`;
  if ("coption" in type) return `COption<${renderType(type.coption)}>`;
  if ("vec" in type) return `Vec<${renderType(type.vec)}>`;
  if ("array" in type) {
    const [inner, len] = type.array;
    return `[${renderType(inner)}; ${len}]`;
  }
  if ("defined" in type) {
    return typeof type.defined === "string" ? type.defined : type.defined.name;
  }
  return JSON.stringify(type);
}

function renderConstSeed(bytes) {
  const printable = bytes.every((b) => b >= 0x20 && b <= 0x7e);
  if (printable && bytes.length > 0) {
    return `"${String.fromCharCode(...bytes)}"`;
  }
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function renderSeed(seed) {
  switch (seed.kind) {
    case "const":
      return renderConstSeed(seed.value);
    case "account":
      return seed.account ? `account:${seed.path} (${seed.account})` : `account:${seed.path}`;
    case "arg":
      return `arg:${seed.path}`;
    default:
      return JSON.stringify(seed);
  }
}

function renderAccountLocation(account) {
  if (account.pda) {
    const seeds = account.pda.seeds.map(renderSeed).join(", ");
    const program = account.pda.program
      ? `, program=${renderSeed(account.pda.program)}`
      : "";
    return `PDA [${seeds}]${program}`;
  }
  if (account.address) return `address \`${account.address}\``;
  return "";
}

function flag(value) {
  return value ? "yes" : "";
}

function renderAccountNotes(account) {
  const parts = [];
  if (Array.isArray(account.docs) && account.docs.length > 0) {
    parts.push(account.docs.join(" "));
  }
  if (Array.isArray(account.relations) && account.relations.length > 0) {
    parts.push(`has_one → ${account.relations.join(", ")}`);
  }
  return parts.join(" — ");
}

// --- document builders -------------------------------------------------------

function generatedBanner(idlPath) {
  return [
    "> **GENERATED FILE — do not edit by hand.**",
    `> Source of truth: \`${idlPath}\`.`,
    "> Regenerate with `npm run docs:idl-reference`;",
    "> `npm run check:idl-reference` (part of `npm run validate` and CI) fails when this file drifts from the IDL.",
  ].join("\n");
}

export function buildInstructionsDoc(idl, idlPath = DEFAULT_IDL_PATH) {
  const instructions = [...idl.instructions].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  const lines = [];
  lines.push("# Instruction Reference");
  lines.push("");
  lines.push(generatedBanner(idlPath));
  lines.push("");
  lines.push(
    `Program: \`${idl.address}\` (\`${idl.metadata?.name ?? "unknown"}\` v${idl.metadata?.version ?? "?"}).`,
  );
  lines.push("");
  lines.push(
    `**${instructions.length} instructions**, sorted alphabetically. Accounts are listed in wire order; PDA seeds use \`"literal"\`, \`account:<path>\`, and \`arg:<path>\` notation.`,
  );
  lines.push("");
  lines.push("## Index");
  lines.push("");
  for (const ix of instructions) {
    lines.push(`- [\`${ix.name}\`](#${ix.name})`);
  }
  lines.push("");

  for (const ix of instructions) {
    lines.push(`## ${ix.name}`);
    lines.push("");
    if (Array.isArray(ix.docs) && ix.docs.length > 0) {
      lines.push(ix.docs.join("\n"));
      lines.push("");
    }

    lines.push(`### Accounts (${ix.accounts.length})`);
    lines.push("");
    if (ix.accounts.length === 0) {
      lines.push("_None._");
    } else {
      lines.push("| # | Account | Writable | Signer | Optional | PDA / address | Notes |");
      lines.push("|---|---|---|---|---|---|---|");
      ix.accounts.forEach((account, index) => {
        lines.push(
          `| ${index + 1} | \`${account.name}\` | ${flag(account.writable)} | ${flag(account.signer)} | ${flag(account.optional)} | ${escapeCell(renderAccountLocation(account))} | ${escapeCell(renderAccountNotes(account))} |`,
        );
      });
    }
    lines.push("");

    const args = ix.args ?? [];
    lines.push(`### Args (${args.length})`);
    lines.push("");
    if (args.length === 0) {
      lines.push("_None._");
    } else {
      lines.push("| # | Arg | Type |");
      lines.push("|---|---|---|");
      args.forEach((arg, index) => {
        lines.push(`| ${index + 1} | \`${arg.name}\` | \`${escapeCell(renderType(arg.type))}\` |`);
      });
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildErrorsDoc(idl, idlPath = DEFAULT_IDL_PATH) {
  const errors = [...(idl.errors ?? [])].sort((a, b) => a.code - b.code);

  const lines = [];
  lines.push("# Error Catalog");
  lines.push("");
  lines.push(generatedBanner(idlPath));
  lines.push("");
  lines.push(
    `Program: \`${idl.address}\` (\`${idl.metadata?.name ?? "unknown"}\` v${idl.metadata?.version ?? "?"}).`,
  );
  lines.push("");
  lines.push(`**${errors.length} error codes**, sorted by code. Anchor custom errors start at 6000 (0x1770).`);
  lines.push("");
  lines.push("| Code | Hex | Name | Message |");
  lines.push("|---|---|---|---|");
  for (const error of errors) {
    lines.push(
      `| ${error.code} | 0x${error.code.toString(16)} | \`${error.name}\` | ${escapeCell(error.msg ?? "")} |`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function generateReferenceDocs(idl, idlPath = DEFAULT_IDL_PATH) {
  return {
    "INSTRUCTIONS.md": buildInstructionsDoc(idl, idlPath),
    "ERRORS.md": buildErrorsDoc(idl, idlPath),
  };
}

export function loadIdl(idlPath = DEFAULT_IDL_PATH) {
  return JSON.parse(readFileSync(idlPath, "utf8"));
}

export function writeReferenceDocs(outDir, docs) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    writeFileSync(join(outDir, name), content);
  }
}

// --- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const options = { idl: DEFAULT_IDL_PATH, out: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--idl") options.idl = argv[++i];
    else if (argv[i] === "--out") options.out = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const idl = loadIdl(options.idl);
  const docs = generateReferenceDocs(idl, options.idl);
  writeReferenceDocs(options.out, docs);
  console.log(
    `Generated ${GENERATED_FILES.map((f) => `${options.out}/${f}`).join(", ")} ` +
      `(${idl.instructions.length} instructions, ${(idl.errors ?? []).length} errors) from ${options.idl}.`,
  );
}
