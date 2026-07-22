import { isAddress } from "@solana/kit";

const MAX_TITLE_CHARS = 160;
const MAX_ITEM_CHARS = 280;
const MAX_ITEMS = 12;
const MAX_NOTES_CHARS = 2_000;

export interface StarterJobSpec {
  readonly title: string;
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly notes?: string;
}

export interface StarterJobSpecPayload extends StarterJobSpec {
  readonly schema: "agenc.marketplace.starter.jobSpec.v1";
  readonly taskPda: string;
}

function stringField(
  source: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`spec.${key} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`spec.${key} is required.`);
  if (trimmed.length > maxChars) {
    throw new Error(`spec.${key} must be ${maxChars} characters or less.`);
  }
  return trimmed;
}

function stringArrayField(
  source: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new Error(`spec.${key} must be an array of strings.`);
  }
  const strings = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  if (strings.length === 0) {
    throw new Error(`spec.${key} needs at least one item.`);
  }
  if (strings.length > MAX_ITEMS) {
    throw new Error(`spec.${key} supports at most ${MAX_ITEMS} items.`);
  }
  const tooLong = strings.find((item) => item.length > MAX_ITEM_CHARS);
  if (tooLong) {
    throw new Error(
      `spec.${key} items must be ${MAX_ITEM_CHARS} characters or less.`,
    );
  }
  return Object.freeze(strings);
}

/**
 * Detach a normalized specification from caller-owned state and make its full
 * object graph immutable before any funded hire or asynchronous backend seam.
 */
export function freezeStarterJobSpec(spec: StarterJobSpec): StarterJobSpec {
  return Object.freeze({
    title: spec.title,
    deliverables: Object.freeze([...spec.deliverables]),
    acceptanceCriteria: Object.freeze([...spec.acceptanceCriteria]),
    ...(spec.notes === undefined ? {} : { notes: spec.notes }),
  });
}

/** Give a backend its own mutable copy without exposing the committed snapshot. */
export function cloneStarterJobSpec(spec: StarterJobSpec): StarterJobSpec {
  return {
    title: spec.title,
    deliverables: [...spec.deliverables],
    acceptanceCriteria: [...spec.acceptanceCriteria],
    ...(spec.notes === undefined ? {} : { notes: spec.notes }),
  };
}

/**
 * Builds the exact canonical payload hashed before hire and again by the
 * hosting backend. Keeping this normalization shared prevents the funded hire
 * commitment from drifting from the later hosted content.
 */
export function normalizeStarterJobSpec(
  taskPda: string,
  spec: unknown,
): StarterJobSpecPayload {
  const normalizedTaskPda = taskPda.trim();
  if (!isAddress(normalizedTaskPda)) {
    throw new Error("taskPda must be an exact 32-byte Solana address.");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("spec must be an object.");
  }
  const source = spec as Record<string, unknown>;
  const title = stringField(source, "title", MAX_TITLE_CHARS);
  const deliverables = stringArrayField(source, "deliverables");
  const acceptanceCriteria = stringArrayField(source, "acceptanceCriteria");
  let notes: string | undefined;
  if (typeof source.notes === "string" && source.notes.trim()) {
    notes = source.notes.trim();
    if (notes.length > MAX_NOTES_CHARS) {
      throw new Error(
        `spec.notes must be ${MAX_NOTES_CHARS} characters or less.`,
      );
    }
  }
  const payload: StarterJobSpecPayload = {
    schema: "agenc.marketplace.starter.jobSpec.v1",
    taskPda: normalizedTaskPda,
    title,
    deliverables,
    acceptanceCriteria,
    ...(notes === undefined ? {} : { notes }),
  };
  return Object.freeze(payload);
}
