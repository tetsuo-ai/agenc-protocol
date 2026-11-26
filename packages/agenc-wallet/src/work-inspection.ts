import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { MAX_DELIVERY_FILE_BYTES } from "./client/delivery-files.js";
import { createHash } from "node:crypto";
import {
  deliveryFileProblem,
  splitDelivery,
  type DeliveryFile,
} from "./client/delivery-files.js";
import { WalletError } from "./errors.js";
import type { WorkInspection } from "./client/business.js";

type FetchFile = (hash: string) => Promise<Uint8Array | null>;
const hashOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Pre-submission files have not been published. Read only content-addressed
 * regular files from the worker outbox, then verify against the held manifest. */
export function workFileSource(stateDir: string, hosted: FetchFile): FetchFile {
  return async (hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new WalletError("BAD_REQUEST", "Invalid file fingerprint.");
    const dir = path.join(stateDir, "outbox");
    try {
      if (!(await lstat(dir)).isDirectory())
        throw new WalletError("NOT_ALLOWED", "Invalid room outbox.");
      const fd = await open(
        path.join(dir, hash),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > MAX_DELIVERY_FILE_BYTES)
          throw new WalletError("NOT_ALLOWED", "Invalid room file.");
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length)
          throw new WalletError("NOT_AVAILABLE", "The room file changed.");
        return bytes;
      } finally {
        await fd.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return hosted(hash);
  };
}
export async function verifiedWorkFile(file: DeliveryFile, fetch: FetchFile) {
  const bytes = await fetch(file.sha256);
  if (
    !bytes ||
    bytes.length !== file.bytes ||
    hashOf(bytes) !== file.sha256 ||
    deliveryFileProblem(file.name, bytes)
  )
    throw new WalletError(
      "NOT_AVAILABLE",
      "This file could not be verified. Check the delivery before submitting.",
    );
  return Buffer.from(bytes);
}
function decode(body: Buffer) {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = splitDelivery(raw);
    if (
      !parsed.files.length &&
      raw.includes("\n---\nFiles with this delivery:\n")
    )
      throw new Error("Invalid file manifest.");
    if (
      new Set(parsed.files.map((file) => file.name.toLowerCase())).size !==
      parsed.files.length
    )
      throw new Error("Duplicate file.");
    return parsed;
  } catch {
    throw new WalletError(
      "NOT_AVAILABLE",
      "The room result is not readable text.",
    );
  }
}
export async function correctionInputs(body: Buffer, fetch: FetchFile) {
  const { text, files } = decode(body);
  let previous = "previous-result.txt";
  while (files.some((f) => f.name.toLowerCase() === previous))
    previous = "p-" + previous;
  return [
    { name: previous, bytes: Buffer.from(text) },
    ...(await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        bytes: await verifiedWorkFile(file, fetch),
      })),
    )),
  ];
}
export async function checkWorkFiles(body: Buffer, fetch: FetchFile) {
  const { files } = decode(body);
  await Promise.all(files.map((file) => verifiedWorkFile(file, fetch)));
}
export async function inspectWorkChunk(
  body: Buffer,
  hash: string,
  part: string,
  offset: number,
  correctionCents: number,
  fetch: FetchFile,
): Promise<WorkInspection> {
  if (hashOf(body) !== hash)
    throw new WalletError(
      "PRICE_CHANGED",
      "The room result changed. Open it again.",
    );
  const { text, files } = decode(body);
  const file = files.find((f) => f.sha256 === part);
  if (part !== "text" && !file)
    throw new WalletError(
      "NOT_FOUND",
      "That file is not in the selected result.",
    );
  const bytes = file ? await verifiedWorkFile(file, fetch) : Buffer.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
    throw new WalletError("BAD_REQUEST", "Choose a valid result offset.");
  const end = Math.min(bytes.length, offset + 48 * 1024);
  return {
    part,
    hash,
    totalBytes: bytes.length,
    base64: bytes.subarray(offset, end).toString("base64"),
    next: end < bytes.length ? end : null,
    files,
    correctionCents,
  };
}
