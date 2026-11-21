// Plain Solana keypair files for the signing rails.
//
// Review finding S-19: a JSON.parse error quotes its input. On Node 24 and later
// the message carries the unexpected character and up to about ten characters of
// the text around it, so a key stored as base58 text, or a JSON array with one
// stray character, would print part of a secret. Every failure here names the
// path only, never the content. The parse error is dropped, never attached as a
// cause, because printing the new error would print the cause with it.
import { readFileSync } from "node:fs";

export const PLAIN_KEYPAIR_SHAPE =
  "must be a plain 64-byte JSON array; encrypted vault/object inputs are refused";

// A configured value that is not plainly a file path may be key material passed
// by mistake (an inline JSON array, a base58 string, or one comma-split piece of
// either). A failed read then names no path at all.
function isPathLike(value) {
  return (
    typeof value === "string" &&
    (/[\\/]/.test(value) || /\.json$/i.test(value)) &&
    !/^\s*[[{]/.test(value)
  );
}

// The 64 secret-key bytes of a keypair file's text, read from `filePath`.
export function parsePlainKeypairJson(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`keypair ${filePath} is not valid JSON (content not shown)`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`keypair ${filePath} ${PLAIN_KEYPAIR_SHAPE}.`);
  }
  return Uint8Array.from(parsed);
}

// Read a plain keypair file and return its 64 secret-key bytes. `configured` is
// the value the operator set, before any home or root expansion.
export function readPlainKeypairFile(filePath, configured = filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("keypair must be an explicitly configured file path");
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code =
      typeof error?.code === "string" && /^E[A-Z]+$/.test(error.code)
        ? ` (${error.code})`
        : "";
    const shown = isPathLike(configured) ? filePath : "<value not shown>";
    throw new Error(`cannot read keypair ${shown}${code}`);
  }
  return parsePlainKeypairJson(raw, filePath);
}
