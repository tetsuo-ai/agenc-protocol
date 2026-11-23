import { discoveryPriceCents } from "./discovery.js";

export class ToolInputError extends Error {}

export function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolInputError(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolInputError(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw new ToolInputError(`${field} is required.`);
    return undefined;
  }
  if (trimmed.length > max) {
    throw new ToolInputError(`${field} is too long (at most ${max} characters).`);
  }
  return trimmed;
}

export function dollarsToCents(value: unknown, field: string, fractionalCents = false): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new ToolInputError(`${field} must be a dollar amount above zero.`);
  }
  if (!fractionalCents) return Math.round(value * 100);
  const cap = discoveryPriceCents(String(value));
  if (cap === null) throw new ToolInputError(`${field} has more precision than the wallet can accept.`);
  return cap;
}
