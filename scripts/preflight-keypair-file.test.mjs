import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  parsePlainKeypairJson,
  readPlainKeypairFile,
} from "./keypair-file.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { Keypair } = require("@solana/web3.js");

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Review S-19. Synthetic stand-ins for key material: none of them is a key.
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function syntheticBase58(length) {
  let state = 0x5eed;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    text += BASE58_ALPHABET[state % BASE58_ALPHABET.length];
  }
  return text;
}
const BASE58_TEXT = syntheticBase58(88);
const BYTES = Array.from({ length: 64 }, (_, index) => (index * 37 + 11) % 256);
const strayParts = BYTES.map(String);
strayParts[31] = `x${strayParts[31]}`;
const BAD_FILES = [
  ["base58 text", BASE58_TEXT],
  ["a byte array with one stray character", `[${strayParts.join(",")}]`],
  ["a byte array with a trailing comma", `[${BYTES.join(",")},]`],
  ["a byte array with trailing text", `[${BYTES.join(",")}]${BASE58_TEXT.slice(0, 12)}`],
  ["quoted base58 text", JSON.stringify(BASE58_TEXT)],
  ["a vault object", JSON.stringify({ kind: "vault", ciphertext: BASE58_TEXT })],
  ["a short byte array", `[${BYTES.slice(0, 32).join(",")}]`],
  ["an empty file", ""],
];

// Every 6-character piece of `text`.
function pieces(text, size = 6) {
  const out = [];
  for (let index = 0; index + size <= text.length; index += 1) {
    out.push(text.slice(index, index + size));
  }
  return out;
}

function assertQuotesNone(output, content, label) {
  for (const piece of pieces(content)) {
    assert.ok(!output.includes(piece), `${label}: output quotes ${JSON.stringify(piece)}`);
  }
}

function withDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "agenc-s19-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("S-19 precondition: a plain JSON.parse quotes the synthetic file content", () => {
  for (const label of [
    "base58 text",
    "a byte array with one stray character",
    "a byte array with a trailing comma",
  ]) {
    const content = new Map(BAD_FILES).get(label);
    assert.throws(
      () => JSON.parse(content),
      (error) => pieces(content).some((piece) => error.message.includes(piece)),
      label,
    );
  }
});

test("S-19: a bad keypair file's error names the path and quotes none of its content", () => {
  withDirectory((directory) => {
    BAD_FILES.forEach(([label, content], index) => {
      const filePath = path.join(directory, `bad-${index}.json`);
      writeFileSync(filePath, content, { mode: 0o600 });
      assertQuotesNone(filePath, content, `${label} (the path itself)`);
      let caught;
      assert.throws(
        () => readPlainKeypairFile(filePath),
        (error) => {
          caught = error;
          return true;
        },
        label,
      );
      assert.ok(
        caught.message === `keypair ${filePath} is not valid JSON (content not shown)` ||
          caught.message ===
            `keypair ${filePath} must be a plain 64-byte JSON array; encrypted vault/object inputs are refused.`,
        `${label}: ${caught.message}`,
      );
      assert.equal(caught.cause, undefined, label);
      for (const output of [caught.message, String(caught.stack), inspect(caught)]) {
        assertQuotesNone(output, content, label);
      }
      assert.throws(
        () => parsePlainKeypairJson(content, filePath),
        (error) => {
          assert.equal(error.message, caught.message, label);
          return true;
        },
      );
    });
  });
});

test("S-19: a failed read names a path-like value and never echoes another value", () => {
  withDirectory((directory) => {
    const missing = path.join(directory, "missing.json");
    assert.throws(() => readPlainKeypairFile(missing), {
      message: `cannot read keypair ${missing} (ENOENT)`,
    });
    assert.throws(() => readPlainKeypairFile(directory), {
      message: `cannot read keypair ${directory} (EISDIR)`,
    });
    // Key material set where a path belongs, whole or as one comma-split piece.
    for (const value of [
      `[${BYTES.join(",")}]`,
      `[${strayParts.join(",")}]`,
      BASE58_TEXT,
      String(BYTES[5]),
      JSON.stringify({ ciphertext: BASE58_TEXT }),
    ]) {
      const notShown = { message: "cannot read keypair <value not shown> (ENOENT)" };
      assert.throws(() => readPlainKeypairFile(value), notShown);
      // A caller that resolves the value first passes what was configured.
      assert.throws(
        () => readPlainKeypairFile(path.join(directory, value), value),
        notShown,
      );
    }
    for (const value of ["", "   ", undefined, null, 42]) {
      assert.throws(() => readPlainKeypairFile(value), {
        message: "keypair must be an explicitly configured file path",
      });
    }
  });
});

test("S-19: a plain 64-byte keypair file still loads", () => {
  withDirectory((directory) => {
    const keypair = Keypair.generate();
    const filePath = path.join(directory, "throwaway.json");
    for (const text of [
      JSON.stringify(Array.from(keypair.secretKey)),
      `${JSON.stringify(Array.from(keypair.secretKey))}\n`,
    ]) {
      writeFileSync(filePath, text, { mode: 0o600 });
      const bytes = readPlainKeypairFile(filePath);
      assert.ok(bytes instanceof Uint8Array);
      assert.deepEqual(Buffer.from(bytes), Buffer.from(keypair.secretKey));
      assert.ok(Keypair.fromSecretKey(bytes).publicKey.equals(keypair.publicKey));
    }
  });
});

// A top-level function, from its signature to its closing brace at column 0.
function topLevelFunction(source, signature) {
  const match = signature.exec(source);
  assert.ok(match, String(signature));
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}

test("S-19: every signing rail reads its keypair files through the guarded reader", () => {
  for (const name of [
    "mainnet-init-and-stamp.mjs",
    "mainnet-migrate-sweep.mjs",
    "mainnet-fee-change.mjs",
    "mainnet-repair-dispute-counter.mjs",
    "validation-initialize.mjs",
  ]) {
    const source = readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
    assert.match(
      source,
      /^import \{ readPlainKeypairFile \} from "\.\/keypair-file\.mjs";$/m,
      name,
    );
    const body = topLevelFunction(source, /^(?:async )?function loadKeypair\(/m);
    assert.match(body, /readPlainKeypairFile\(/, name);
    assert.doesNotMatch(body, /JSON\.parse|readFileSync|readFile\(|loadJson/, name);
  }
  // No script keeps a loadKeypair that parses key text itself.
  for (const name of readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    const source = readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
    for (const match of source.matchAll(/^(?:export )?(?:async )?function loadKeypair\(/gm)) {
      const body = source.slice(match.index, source.indexOf("\n}", match.index) + 2);
      assert.doesNotMatch(body, /JSON\.parse/, name);
    }
  }
});
