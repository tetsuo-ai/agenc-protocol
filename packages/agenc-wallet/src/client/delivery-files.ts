/**
 * Files that travel with a delivery.
 *
 * A delivery is one piece of text whose fingerprint is recorded with the job.
 * A file that goes with it is kept in the same delivery store under its own
 * fingerprint, and the text ends with a short list naming each file and that
 * fingerprint. So the job's recorded fingerprint covers the files too: change
 * a file and its fingerprint no longer matches the list, change the list and
 * the delivery no longer matches the job.
 *
 * The list is plain text on purpose. A buyer on any other software still
 * reads the delivery and sees the links; this wallet reads the list back,
 * fetches each file from the delivery store by fingerprint, and never from
 * an address the text names.
 *
 * Both ends use this file: the program that does a job writes the list
 * (`withFiles`), and the buyer's wallet reads it (`splitDelivery`).
 */

/** A delivery carries at most this many files. */
export const MAX_DELIVERY_FILES = 8;
/** The marketplace's delivery store keeps nothing larger than this. */
export const MAX_DELIVERY_FILE_BYTES = 256 * 1024;

export interface DeliveryFile {
  /** A plain file name: letters, digits, dots, dashes and underscores. */
  name: string;
  /** The media type its extension stands for. */
  type: string;
  bytes: number;
  /** sha-256 of the file, lowercase hex. */
  sha256: string;
}

const startsWith = (bytes: Uint8Array, ...codes: number[]): boolean =>
  bytes.length >= codes.length && codes.every((code, index) => bytes[index] === code);

/** Text kinds: valid UTF-8 with no NUL byte. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

interface FileKind {
  readonly type: string;
  /** True when the bytes are what the extension says they are. */
  readonly matches: (bytes: Uint8Array) => boolean;
}

/**
 * The kinds of file a delivery may carry, by extension. A file must also be
 * what its name says: a picture has to start the way that kind of picture
 * starts, and a text file has to be text.
 */
const FILE_KINDS: Readonly<Record<string, FileKind>> = {
  png: { type: "image/png", matches: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  jpg: { type: "image/jpeg", matches: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  jpeg: { type: "image/jpeg", matches: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  gif: { type: "image/gif", matches: (b) => startsWith(b, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  webp: {
    type: "image/webp",
    matches: (b) => startsWith(b, 0x52, 0x49, 0x46, 0x46) && b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  pdf: { type: "application/pdf", matches: (b) => startsWith(b, 0x25, 0x50, 0x44, 0x46, 0x2d) },
  zip: { type: "application/zip", matches: (b) => startsWith(b, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0x50, 0x4b, 0x05, 0x06) },
  txt: { type: "text/plain", matches: isText },
  md: { type: "text/markdown", matches: isText },
  csv: { type: "text/csv", matches: isText },
  json: { type: "application/json", matches: isText },
};

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The media type a file name's extension stands for, or null when the name or kind is not allowed. */
export function deliveryFileType(name: string): string | null {
  if (!FILE_NAME.test(name) || name.includes("..")) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return FILE_KINDS[name.slice(dot + 1).toLowerCase()]?.type ?? null;
}

/** True for a picture kind this wallet will show. */
export function isPictureType(type: string): boolean {
  return type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp";
}

/**
 * Why a file may not go with a delivery, or null when it may: an allowed name
 * and kind, not empty, not over the store's limit, and really that kind.
 */
export function deliveryFileProblem(name: string, bytes: Uint8Array): string | null {
  const type = deliveryFileType(name);
  if (type === null) return "its name or kind is not one a delivery can carry";
  if (bytes.length === 0) return "it is empty";
  if (bytes.length > MAX_DELIVERY_FILE_BYTES) return "it is larger than 256 KB";
  const dot = name.lastIndexOf(".");
  const kind = FILE_KINDS[name.slice(dot + 1).toLowerCase()]!;
  if (!kind.matches(bytes)) return "it is not the kind of file its name says";
  return null;
}

const RULE = "---";
const HEADING = "Files with this delivery:";

/**
 * The delivery text with its files listed at the end. `linkPrefix` is what a
 * file's fingerprint is added to, to make its address in the delivery store.
 */
export function withFiles(text: string, files: readonly DeliveryFile[], linkPrefix: string): string {
  if (files.length === 0) return text;
  if (files.length > MAX_DELIVERY_FILES) throw new RangeError("too many files for one delivery");
  if (/\s/.test(linkPrefix) || linkPrefix.length > 300) throw new RangeError("the file address is not usable");
  // `trimEnd`, not a pattern: a pattern that strips trailing spaces can be
  // made to take minutes by a text that is mostly spaces.
  const lines = [text.trimEnd(), "", RULE, HEADING];
  files.forEach((file, index) => {
    if (deliveryFileType(file.name) !== file.type || !SHA256_HEX.test(file.sha256)) {
      throw new RangeError(`"${file.name}" cannot be listed`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_DELIVERY_FILE_BYTES) {
      throw new RangeError(`"${file.name}" is not a size a delivery can carry`);
    }
    lines.push(`${index + 1}. ${file.name} (${file.type}, ${file.bytes} bytes)`, `   ${linkPrefix}${file.sha256}`);
  });
  return `${lines.join("\n")}\n`;
}

const ENTRY = /^([1-9])\. ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) \(([a-z]+\/[a-z0-9.+-]{1,40}), ([1-9][0-9]{0,6}) bytes\)$/;
const ADDRESS = /^ {3}[^\s]{0,300}?([0-9a-f]{64})$/;

/**
 * A delivery's text and the files listed at its end.
 *
 * The list is read only when it is exactly the shape `withFiles` writes, from
 * its rule line to the end of the text. Anything else is left as text and
 * carries no files: a seller's words can never half-form a list.
 */
export function splitDelivery(body: string): { text: string; files: DeliveryFile[] } {
  const whole = { text: body, files: [] as DeliveryFile[] };
  const marker = `\n${RULE}\n${HEADING}\n`;
  const at = body.lastIndexOf(marker);
  if (at < 0) return whole;
  const tail = body.slice(at + marker.length);
  if (!tail.endsWith("\n")) return whole;
  const lines = tail.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length % 2 !== 0 || lines.length / 2 > MAX_DELIVERY_FILES) return whole;
  const files: DeliveryFile[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const entry = ENTRY.exec(lines[index]!);
    const address = ADDRESS.exec(lines[index + 1]!);
    if (entry === null || address === null) return whole;
    const [, number, name, type, size] = entry;
    const bytes = Number(size);
    if (Number(number) !== index / 2 + 1) return whole;
    if (deliveryFileType(name!) !== type || bytes > MAX_DELIVERY_FILE_BYTES) return whole;
    files.push({ name: name!, type: type!, bytes, sha256: address[1]! });
  }
  return { text: body.slice(0, at).trimEnd(), files };
}
