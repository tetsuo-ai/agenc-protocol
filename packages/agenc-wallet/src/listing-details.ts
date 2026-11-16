// What a provider published about a service: checked against the hash the
// listing committed to, and reduced to the few plain fields a buyer reads.
//
// A listing carries a name, a price and two commitments: where its
// description lives (`spec_uri`) and what that description hashes to
// (`spec_hash`). The marketplace's list of services does not carry the words
// themselves. This module proves a fetched document is the one the listing
// committed to (docs/LISTING_METADATA.md, "Verification") and tidies it.
//
// Everything in here is the provider's own text. It is shown to a person or
// handed to an agent as information, never as instructions, and nothing in
// it changes what the wallet signs.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { values } from "@tetsuo-ai/marketplace-sdk";

/** What a provider says about a service, ready to show. */
export interface ListingDetails {
  /** The provider's description, as plain text with line breaks kept. */
  description: string | null;
  /** One of the marketplace's category words, such as "writing". */
  category: string | null;
  tags: string[];
  /** What the provider asks a buyer to send. */
  inputs: string[];
  /** What the provider says a buyer gets. */
  outputs: string[];
  /** The provider's own terms, one plain line each. */
  terms: string[];
}

/** A service whose provider published nothing beyond the name and price. */
export const NO_DETAILS: ListingDetails = Object.freeze({
  description: null,
  category: null,
  tags: [],
  inputs: [],
  outputs: [],
  terms: [],
}) as ListingDetails;

/** The largest description document that is read at all. */
export const MAX_LISTING_SPEC_BYTES = 128 * 1024;

const MAX_DESCRIPTION = 2_000;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM = 160;
const MAX_TERM = 280;
const MAX_TAGS = 8;
const HEX64 = /^[0-9a-f]{64}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The payload of a description document, only when it is the one the listing
 * committed to. The document is an envelope: `integrity` names how the payload
 * was hashed and what it hashed to, and `payload` holds the words. The payload
 * is hashed again here and has to equal both the hash in the envelope and the
 * hash the listing recorded. Anything else gives null: text that cannot be
 * tied to the listing is not shown as the provider's.
 */
export async function verifiedListingPayload(
  bytes: Uint8Array,
  specHashHex: string,
): Promise<Record<string, unknown> | null> {
  if (!HEX64.test(specHashHex) || bytes.length === 0 || bytes.length > MAX_LISTING_SPEC_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const envelope = record(parsed);
  const integrity = record(envelope?.integrity);
  const payload = record(envelope?.payload);
  if (
    integrity === null ||
    payload === null ||
    integrity.algorithm !== "sha256" ||
    integrity.canonicalization !== "json-stable-v1" ||
    integrity.payloadHash !== specHashHex
  ) {
    return null;
  }
  let derived: string;
  try {
    derived = (await values.canonicalJobSpecHash(payload)).hex;
  } catch {
    return null;
  }
  return derived === specHashHex ? payload : null;
}

/** Control characters other than a line break and a tab, as one class. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;

/**
 * How much of a stranger's text is looked at, as a multiple of how much of it
 * is kept. A description can be any length and can be written to make
 * tidying it slow. Everything below works on a bounded piece of it, and no
 * pattern below repeats without a bound, so the work is bounded whatever the
 * text says.
 */
const LOOKED_AT = 4;
/** No list a provider publishes is read past this many entries. */
const MAX_ENTRIES_READ = 64;

function bounded(text: string, kept: number): string {
  return text.length > kept * LOOKED_AT ? text.slice(0, kept * LOOKED_AT) : text;
}

/** Take the marks of Markdown off a line: the words stay, the syntax goes. */
function unmark(line: string): string {
  return line
    .replace(/!\[([^\]\n]{0,300})\]\([^)\n]{0,600}\)/g, "$1")
    .replace(/\[([^\]\n]{1,300})\]\([^)\n]{0,600}\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]{1,300}?)(?<=\S)\1/g, "$2")
    .replace(/`{1,3}([^`\n]{1,300})`{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,8}[*+]\s+/, "- ");
}

/** A rule (---, ***, ___) is layout, not words. */
function isRule(entry: string): boolean {
  if (entry.length === 0 || entry.length > 120) return false;
  let marks = 0;
  for (const character of entry) {
    if (character === "-" || character === "*" || character === "_") marks += 1;
    else if (character !== " ") return false;
  }
  return marks >= 3;
}

/** One tidy line of untrusted text, or null when nothing is left. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = unmark(bounded(value, max).replace(CONTROL, " ").replace(/\s+/g, " ").trim()).trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** A word that can be a label, or part of one: "Input", "Important Notes". */
const LABEL_WORD = /^[A-Z][A-Za-z']*$/;

/**
 * Give a flattened description its lines back. Many descriptions reach the
 * marketplace with their line breaks lost, so a Markdown list reads
 * "Input: - Topic - Tone Output: - Image" and a heading sits in the middle of
 * a line as "## Delivery". Each heading, each item and each label that
 * introduces a list goes back on a line of its own. Only line breaks are
 * added and heading marks dropped; no word changes. A text that still has its
 * own line breaks, or that does not look flattened, is returned as it is.
 */
function unflatten(text: string): string {
  if (text.includes("\n")) return text;
  const sections = text.split(/ #{2,6} (?=\S)/);
  const headed = sections.length > 1;
  if (!headed && !text.includes(": - ")) return text;
  const lines: string[] = [];
  sections.forEach((section, at) => {
    const parts = section.split(" - ");
    // Under a heading two items make a list; in running text it takes a label and three.
    if (parts.length < (headed && at > 0 ? 3 : 4)) {
      lines.push(section.trim());
      return;
    }
    parts.forEach((part, index) => {
      let body = part.trim();
      let label: string | null = null;
      if (index < parts.length - 1 && body.endsWith(":")) {
        const words = body.split(" ");
        let first = words.length - 1;
        if (LABEL_WORD.test((words[first] as string).slice(0, -1))) {
          // The label is the run of capitalised words before the colon, three at most...
          while (first > 0 && first > words.length - 3 && LABEL_WORD.test(words[first - 1] as string)) {
            first -= 1;
          }
          // ...unless every word is capitalised, as an item of a list often is: then only the last one.
          if (first === 0 && words.length > 1) first = words.length - 1;
          label = words.slice(first).join(" ");
          body = words.slice(0, first).join(" ");
        }
      }
      if (body.length > 0) lines.push(index === 0 ? body : `- ${body}`);
      if (label !== null) lines.push(label);
    });
  });
  return lines.filter((entry) => entry.length > 0).join("\n");
}

/** Untrusted text as plain paragraphs: line breaks kept, Markdown marks removed. */
function paragraphs(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const lines = unflatten(
    bounded(value, max).replace(/\r\n?/g, "\n").replace(CONTROL, " ").replace(/[ \t]+/g, " ").trim(),
  )
    .split("\n")
    .map((entry) => unmark(entry).trim());
  const kept: string[] = [];
  for (const entry of lines) {
    // A rule (---) or a fence (```) is layout, not words.
    if (isRule(entry) || entry.startsWith("```")) continue;
    if (entry.length === 0 && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(entry);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const text = kept.join("\n");
  if (text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function shortList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value.slice(0, MAX_ENTRIES_READ)) {
    const text = line(entry, maxLength);
    if (text === null) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(text);
    if (list.length === maxItems) break;
  }
  return list;
}

/** How fast a provider says it answers, as a plain line. */
function answersWithin(hours: number): string {
  if (hours < 1) return "Answers within the hour";
  if (hours <= 72) {
    const whole = Math.round(hours);
    return `Answers within ${whole} ${whole === 1 ? "hour" : "hours"}`;
  }
  return `Answers within ${Math.round(hours / 24)} days`;
}

/** The provider's service terms as plain lines. They are promises, not rules the marketplace enforces. */
function termLines(metadata: Record<string, unknown>): string[] {
  const terms: string[] = [];
  const sla = metadata.sla;
  const stated = record(sla);
  if (stated !== null) {
    const hours = stated.responseHours;
    if (typeof hours === "number" && Number.isFinite(hours) && hours >= 0 && hours <= 24 * 365) {
      terms.push(answersWithin(hours));
    }
    const rounds = stated.revisions;
    if (typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0 && rounds <= 99) {
      terms.push(
        rounds === 0
          ? "No rounds of changes included"
          : `${rounds} ${rounds === 1 ? "round" : "rounds"} of changes included`,
      );
    }
    const refund = line(stated.refundPolicy, MAX_TERM - 9);
    if (refund !== null) {
      terms.push(`Refunds: ${KEBAB.test(refund) ? refund.replace(/-/g, " ") : refund}`);
    }
  } else {
    const plain = line(sla, MAX_TERM);
    // A bare number is how some providers write "hours".
    if (plain !== null) terms.push(/^[0-9]{1,4}$/.test(plain) ? answersWithin(Number(plain)) : plain);
  }
  const pricing = line(metadata.pricingNotes, MAX_TERM - 7);
  if (pricing !== null) terms.push(`Price: ${pricing}`);
  return terms;
}

/**
 * Reduce a checked description payload to what a buyer reads. Unknown fields
 * are ignored, every text is clipped, and a field of the wrong shape counts
 * as absent: a provider controls this document entirely.
 */
export function listingDetails(payload: Record<string, unknown>): ListingDetails {
  const metadata = record(record(payload.custom)?.listingMetadata) ?? {};
  const category =
    typeof payload.category === "string" && payload.category.length <= 32 && KEBAB.test(payload.category)
      ? payload.category
      : null;
  const tags = Array.isArray(payload.tags)
    ? [
        ...new Set(
          payload.tags.slice(0, MAX_ENTRIES_READ).filter(
            (tag): tag is string => typeof tag === "string" && tag.length <= 32 && KEBAB.test(tag),
          ),
        ),
      ].slice(0, MAX_TAGS)
    : [];
  return {
    description: paragraphs(metadata.longDescription, MAX_DESCRIPTION),
    category,
    tags,
    inputs: shortList(metadata.buyerInputs, MAX_LIST_ITEMS, MAX_LIST_ITEM),
    outputs: shortList(metadata.deliverables, MAX_LIST_ITEMS, MAX_LIST_ITEM),
    terms: termLines(metadata),
  };
}

/**
 * Details read back from a file or handed in from elsewhere, forced into
 * shape. A cache file is as untrusted as the network it was filled from.
 */
export function tidyDetails(value: unknown): ListingDetails | null {
  const entry = record(value);
  if (entry === null) return null;
  const category =
    typeof entry.category === "string" && entry.category.length <= 32 && KEBAB.test(entry.category)
      ? entry.category
      : null;
  return {
    description: paragraphs(entry.description, MAX_DESCRIPTION),
    category,
    tags: Array.isArray(entry.tags)
      ? entry.tags
          .slice(0, MAX_ENTRIES_READ)
          .filter((tag): tag is string => typeof tag === "string" && tag.length <= 32 && KEBAB.test(tag))
          .slice(0, MAX_TAGS)
      : [],
    inputs: shortList(entry.inputs, MAX_LIST_ITEMS, MAX_LIST_ITEM),
    outputs: shortList(entry.outputs, MAX_LIST_ITEMS, MAX_LIST_ITEM),
    terms: shortList(entry.terms, 6, MAX_TERM),
  };
}

const SUMMARY_MAX = 180;
/** A summary this long says enough for a row; no further sentence is added. */
const SUMMARY_ENOUGH = 90;

/**
 * Many providers open their description with the service's name as a
 * heading. Wherever the name is already shown, that repeat is dropped: a name
 * on a line of its own, a name set off by a colon or a dash, or a name run
 * into the sentence after it ("Meme Forge Turn any idea into a meme"). A name
 * that is the subject of the first sentence ("Meme Forge turns any idea...")
 * is part of that sentence and stays.
 */
export function withoutLeadingName(name: string, text: string): string {
  const title = name.trim();
  if (title.length === 0 || !text.toLowerCase().startsWith(title.toLowerCase())) return text;
  const rest = text.slice(title.length);
  const heading =
    /^[ \t]*\n/.test(rest) ||
    /^\s*[:.|\-\u2013\u2014]\s/.test(rest) ||
    /^ +[A-Z0-9"'(]/.test(rest);
  if (!heading) return text;
  const stripped = rest.replace(/^[\s:.|\-\u2013\u2014]+/, "");
  return stripped.length >= 20 ? stripped : text;
}

function sentencesOf(text: string): string[] {
  const found: string[] = [];
  let from = 0;
  // The last mark of a run ("..." or "?!") is the one followed by a space.
  for (const match of text.matchAll(/[.!?](?=\s)/g)) {
    const end = (match.index ?? 0) + 1;
    found.push(text.slice(from, end).trim());
    from = end;
  }
  found.push(text.slice(from).trim());
  return found.filter((sentence) => sentence.length > 0);
}

/**
 * One or two sentences for a row in a list, taken from the start of a
 * description: what the service is, before the lists of what goes in and
 * what comes out (a row shows those on their own).
 */
export function summarize(name: string, description: string | null): string | null {
  if (description === null) return null;
  const text = withoutLeadingName(name, bounded(description, MAX_DESCRIPTION))
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  let summary = "";
  for (const sentence of sentencesOf(text)) {
    // "Input: ..." or "- a - b - c" starts the lists; the summary ends before them.
    const list =
      /^[A-Z][A-Za-z' ]{0,24}:/.test(sentence) || /^[-*]\s/.test(sentence) || sentence.split(" - ").length > 2;
    if (summary.length > 0 && (list || summary.length + 1 + sentence.length > SUMMARY_MAX)) break;
    summary = summary.length === 0 ? sentence : `${summary} ${sentence}`;
    if (summary.length >= SUMMARY_ENOUGH) break;
  }
  if (summary.length <= SUMMARY_MAX) return summary;
  const space = summary.lastIndexOf(" ", SUMMARY_MAX - 1);
  return `${summary.slice(0, space > SUMMARY_MAX / 2 ? space : SUMMARY_MAX - 1).trimEnd()}…`;
}

/** Remembers checked descriptions by the hash they were checked against. */
export interface DetailsCache {
  get(specHashHex: string): ListingDetails | undefined;
  set(specHashHex: string, details: ListingDetails): void;
  /** Write anything not yet saved. Resolves once it is on disk, or at once for a cache in memory. */
  flush(): Promise<void>;
}

const CACHE_VERSION = 1;
const CACHE_MAX_ENTRIES = 600;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_WRITE_DELAY_MS = 750;

/**
 * A cache of checked descriptions. A description is addressed by its hash, so
 * an entry never goes out of date: the same hash is always the same words.
 * With a `file`, entries outlive the process, the list fills at once the next
 * time, and a description stays readable while its host is down.
 *
 * The file is a convenience. It is read defensively, written whole to a
 * temporary file and renamed, and any failure to read or write it only means
 * the descriptions are fetched again.
 */
export function openDetailsCache(
  options: { file?: string | null; now?: () => number; log?: (line: string) => void } = {},
): DetailsCache {
  const file = options.file ?? null;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const entries = new Map<string, { details: ListingDetails; seenAt: number }>();
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;

  if (file !== null) {
    try {
      if (statSync(file).size <= CACHE_MAX_BYTES) {
        const parsed = record(JSON.parse(readFileSync(file, "utf8")));
        const stored = parsed?.version === CACHE_VERSION ? record(parsed.entries) : null;
        for (const [hash, value] of Object.entries(stored ?? {})) {
          if (!HEX64.test(hash)) continue;
          const row = record(value);
          const details = tidyDetails(row?.details);
          if (details === null) continue;
          const seenAt = typeof row?.seenAt === "number" && Number.isFinite(row.seenAt) ? row.seenAt : 0;
          entries.set(hash, { details, seenAt });
          if (entries.size >= CACHE_MAX_ENTRIES) break;
        }
      }
    } catch (error) {
      // A missing file is the normal first run; anything else is started over.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`descriptions cache could not be read (${(error as Error).message}); starting empty`);
      }
    }
  }

  function write(): void {
    if (file === null || !dirty) return;
    dirty = false;
    // The oldest go first when the cache is over its size.
    const kept = [...entries.entries()]
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, CACHE_MAX_ENTRIES);
    if (kept.length < entries.size) {
      entries.clear();
      for (const [hash, entry] of kept) entries.set(hash, entry);
    }
    const text = JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(kept) });
    const directory = path.dirname(file);
    const temporary = path.join(
      directory,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let fd: number | null = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = openSync(temporary, "wx", 0o600);
      writeSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, file);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Nothing more to do with a descriptor that will not close.
        }
      }
      try {
        rmSync(temporary, { force: true });
      } catch {
        // The temporary file was never made, or its folder is not a folder.
      }
      log(`descriptions cache could not be saved (${(error as Error).message})`);
    }
  }

  function schedule(): void {
    dirty = true;
    if (file === null || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      write();
    }, CACHE_WRITE_DELAY_MS);
    // A cache write never keeps the service alive.
    timer.unref();
  }

  return {
    get(specHashHex) {
      const entry = entries.get(specHashHex);
      if (entry === undefined) return undefined;
      // Remember it was wanted, at most once a day, so the oldest can be dropped first.
      const at = now();
      if (at - entry.seenAt > 24 * 60 * 60_000) {
        entry.seenAt = at;
        schedule();
      }
      return entry.details;
    },
    set(specHashHex, details) {
      if (!HEX64.test(specHashHex)) return;
      entries.set(specHashHex, { details, seenAt: now() });
      schedule();
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      write();
    },
  };
}
