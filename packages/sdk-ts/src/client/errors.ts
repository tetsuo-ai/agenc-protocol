// Error hydration for the transaction runtime. Converts the many shapes a failed
// Solana transaction can take (kit SolanaError chains, RPC status `err` objects,
// litesvm FailedTransactionMetadata strings, raw program logs) into a single
// stable `AgencError` carrying the on-chain custom error code and its
// AGENC_COORDINATION_ERROR__* name. The code -> name map is built at module load
// from the generated errors module, so `code` and `errorName` survive
// NODE_ENV=production message-stripping in the generated client.
import {
  isSolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
} from "@solana/kit";
import * as generatedErrors from "../generated/errors/agencCoordination.js";

const ERROR_CONSTANT_PREFIX = "AGENC_COORDINATION_ERROR__";

/** Sentinel returned by the generated message lookup in production bundles. */
const PRODUCTION_MESSAGE_SENTINEL =
  "Error message not available in production bundles.";

/**
 * Reverse map from on-chain custom error code to its generated
 * `AGENC_COORDINATION_ERROR__*` constant name. Built once at module load by
 * scanning the generated errors module namespace, so it works even when the
 * generated human-readable messages are stripped in production builds.
 */
const codeToErrorName: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(generatedErrors)) {
    if (
      key.startsWith(ERROR_CONSTANT_PREFIX) &&
      typeof value === "number" &&
      !map.has(value)
    ) {
      map.set(value, key);
    }
  }
  return map;
})();

/**
 * Look up the `AGENC_COORDINATION_ERROR__*` constant name for an on-chain
 * custom error code.
 *
 * @param code - The custom program error code (e.g. `0x1770` / `6000`).
 * @returns The full constant name (e.g.
 * `"AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED"`), or `null` when the
 * code is not an agenc-coordination error.
 */
export function getAgencErrorName(code: number): string | null {
  return codeToErrorName.get(code) ?? null;
}

/**
 * Stable error type thrown by the marketplace client when a transaction fails.
 *
 * `code` and `errorName` are derived structurally (never from human-readable
 * messages), so they remain populated in production builds where the generated
 * client strips error message tables.
 */
export class AgencError extends Error {
  /** On-chain custom program error code (e.g. `0x1770`), or `null` when the failure was not a custom program error. */
  readonly code: number | null;
  /** The matching `AGENC_COORDINATION_ERROR__*` constant name, or `null` for unknown/non-program errors. */
  readonly errorName: string | null;
  /** Program logs from the failed transaction, when the transport surfaced them. */
  readonly logs: readonly string[];
  /**
   * Base58 signature of the attempted transaction, or `null` when the failure
   * happened before any transaction was submitted (blockhash fetch, signing).
   *
   * A non-null signature on a timeout or network-failure error means the
   * outcome is UNKNOWN — the transaction may still land. Check this signature
   * on-chain before retrying; a naive retry of a money-path call (e.g.
   * `hireFromListing` with a fresh task id) can pay twice.
   */
  readonly signature: string | null;

  /**
   * @param message - Human-readable failure summary.
   * @param options - Structured failure details.
   * @param options.code - On-chain custom error code, if one was identified.
   * @param options.errorName - The matching generated constant name.
   * @param options.logs - Program logs from the failed transaction.
   * @param options.signature - Signature of the attempted transaction, if one was submitted.
   * @param options.cause - The underlying error that triggered this one.
   */
  constructor(
    message: string,
    options: {
      code?: number | null;
      errorName?: string | null;
      logs?: readonly string[];
      signature?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgencError";
    this.code = options.code ?? null;
    this.errorName = options.errorName ?? null;
    this.logs = options.logs ?? [];
    this.signature = options.signature ?? null;
  }
}

const MAX_CAUSE_DEPTH = 16;

/** Walk an error's `cause` chain (bounded), yielding each link. */
function* causeChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

const CUSTOM_PROGRAM_ERROR_RE = /custom program error:\s*(0x[0-9a-f]+|\d+)/i;

/** Parse a `custom program error: 0x1771`-style fragment out of a string. */
function codeFromMessage(text: string): number | null {
  const match = CUSTOM_PROGRAM_ERROR_RE.exec(text);
  if (!match || match[1] === undefined) return null;
  // The regex is case-insensitive, so the prefix test must be too ("0X1771"):
  // parseInt with radix 16 strips both "0x" and "0X" prefixes itself.
  const parsed = /^0x/i.test(match[1])
    ? Number.parseInt(match[1], 16)
    : Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Pull a custom code out of a raw RPC/JSON transaction-error shape, e.g.
 * `{ InstructionError: [0, { Custom: 6000 }] }` or a bare `{ Custom: 6000 }`.
 */
function codeFromTransactionErrorShape(value: unknown): number | null {
  if (value == null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["Custom"] === "number") return obj["Custom"] as number;
  if (typeof obj["Custom"] === "bigint") return Number(obj["Custom"]);
  const instructionError = obj["InstructionError"];
  if (Array.isArray(instructionError) && instructionError.length >= 2) {
    return codeFromTransactionErrorShape(instructionError[1]);
  }
  return null;
}

/**
 * Extract the on-chain custom program error code from any failure shape the
 * runtime can produce.
 *
 * Handles, in order of structure-first preference:
 * 1. kit `SolanaError` chains carrying `SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM`;
 * 2. raw `{ InstructionError: [i, { Custom: n }] }` objects (RPC
 *    `getSignatureStatuses().err`, attached as `transactionError`/`context`);
 * 3. `custom program error: 0x1771`-style message strings (litesvm
 *    `FailedTransactionMetadata` text and RPC server messages);
 * 4. the same pattern inside program `logs`.
 *
 * @param error - The thrown failure (any shape).
 * @param logs - Optional program logs to scan as a fallback.
 * @returns The custom error code, or `null` when none can be identified.
 */
export function extractCustomProgramErrorCode(
  error: unknown,
  logs: readonly string[] = [],
): number | null {
  for (const link of causeChain(error)) {
    if (isSolanaError(link, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      const code = (link.context as { code?: unknown }).code;
      if (typeof code === "number") return code;
      if (typeof code === "bigint") return Number(code);
    }
    const carrier = link as {
      transactionError?: unknown;
      context?: unknown;
    };
    const structural =
      codeFromTransactionErrorShape(link) ??
      codeFromTransactionErrorShape(carrier.transactionError) ??
      codeFromTransactionErrorShape(carrier.context);
    if (structural !== null) return structural;
    if (typeof link === "string") {
      const fromString = codeFromMessage(link);
      if (fromString !== null) return fromString;
    }
    const message = (link as { message?: unknown }).message;
    if (typeof message === "string") {
      const fromMessage = codeFromMessage(message);
      if (fromMessage !== null) return fromMessage;
    }
  }
  for (const line of logs) {
    const fromLog = codeFromMessage(line);
    if (fromLog !== null) return fromLog;
  }
  return null;
}

/** Pull program logs off an error chain (transports attach them as `.logs`, kit preflight errors as `context.logs`). */
function extractLogs(error: unknown): readonly string[] {
  for (const link of causeChain(error)) {
    const direct = (link as { logs?: unknown }).logs;
    if (Array.isArray(direct) && direct.every((l) => typeof l === "string")) {
      return direct as readonly string[];
    }
    const context = (link as { context?: { logs?: unknown } }).context;
    const fromContext = context?.logs;
    if (
      Array.isArray(fromContext) &&
      fromContext.every((l) => typeof l === "string")
    ) {
      return fromContext as readonly string[];
    }
  }
  return [];
}

/**
 * Pull the attempted transaction's signature off an error chain. Transports
 * attach `signature` to every error thrown after submission; kit errors may
 * carry one too.
 */
function extractSignature(error: unknown): string | null {
  for (const link of causeChain(error)) {
    const signature = (link as { signature?: unknown }).signature;
    if (typeof signature === "string" && signature.length > 0) {
      return signature;
    }
  }
  return null;
}

const BLOCKHASH_EXPIRED_RE =
  /blockhash\s*not\s*found|block\s*height\s*exceeded|blockhash[^\n]*expired/i;

/**
 * Classify whether a failure means the transaction's blockhash lifetime
 * expired (and the transaction is therefore safe to re-sign with a fresh
 * blockhash and resend).
 *
 * Recognizes kit `SolanaError` codes (`SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED`,
 * `SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND`), raw RPC
 * `"BlockhashNotFound"` status strings, and message text from litesvm and RPC
 * servers.
 *
 * @param error - The thrown failure (any shape).
 * @returns `true` when the failure is a blockhash-expiry class error.
 */
export function isBlockhashExpiredError(error: unknown): boolean {
  for (const link of causeChain(error)) {
    if (isSolanaError(link, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) return true;
    if (isSolanaError(link, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) {
      return true;
    }
    const carrier = link as { transactionError?: unknown };
    if (carrier.transactionError === "BlockhashNotFound") return true;
    if (typeof link === "string" && BLOCKHASH_EXPIRED_RE.test(link)) return true;
    const message = (link as { message?: unknown }).message;
    if (typeof message === "string" && BLOCKHASH_EXPIRED_RE.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * Look up the generated human-readable message for a code, returning `null`
 * when the generated table is unavailable (production builds strip it) or the
 * code is unknown. Never throws — the generated lookup touches `process.env`,
 * which may not exist in browsers.
 */
function lookupGeneratedMessage(code: number): string | null {
  if (!codeToErrorName.has(code)) return null;
  try {
    const message = generatedErrors.getAgencCoordinationErrorMessage(
      code as generatedErrors.AgencCoordinationError,
    );
    if (
      typeof message === "string" &&
      message.length > 0 &&
      message !== PRODUCTION_MESSAGE_SENTINEL
    ) {
      return message;
    }
  } catch {
    // process.env not available (browser) or table stripped — fall through.
  }
  return null;
}

/**
 * Hydrate any transaction failure into an {@link AgencError}.
 *
 * The custom program error code is parsed from both kit error shapes
 * (`SolanaError` chains with `InstructionError` `Custom` variants) and litesvm
 * `FailedTransactionMetadata` strings (`custom program error: 0x1771`). The
 * `errorName` comes from the module-load-time reverse map, so it stays useful
 * in production builds; the generated message table is used for `message` only
 * when it actually returns one.
 *
 * When the failure chain carries a `signature` (transports attach it to every
 * error thrown after submission), it is lifted into `AgencError.signature`. A
 * signature on a timeout/network error means the outcome is UNKNOWN — check
 * the signature on-chain before retrying.
 *
 * @param error - The thrown failure (any shape). An existing `AgencError` is
 * returned unchanged.
 * @param extraLogs - Optional logs to attach when the error itself carries none.
 * @returns A structured {@link AgencError} with `cause` set to the original error.
 *
 * @example
 * ```ts
 * try {
 *   await client.registerAgent(input);
 * } catch (e) {
 *   if (e instanceof AgencError && e.code === AGENC_COORDINATION_ERROR__AGENT_ALREADY_REGISTERED) {
 *     // already registered — safe to continue
 *   }
 * }
 * ```
 */
export function toAgencError(
  error: unknown,
  extraLogs?: readonly string[],
): AgencError {
  if (error instanceof AgencError) return error;
  const ownLogs = extractLogs(error);
  const logs = ownLogs.length > 0 ? ownLogs : (extraLogs ?? []);
  const code = extractCustomProgramErrorCode(error, logs);
  const errorName = code !== null ? getAgencErrorName(code) : null;
  const signature = extractSignature(error);

  let message: string;
  if (code !== null) {
    const generatedMessage = lookupGeneratedMessage(code);
    const label =
      errorName ?? `custom program error 0x${code.toString(16)} (${code})`;
    message = generatedMessage
      ? `${label}: ${generatedMessage}`
      : `AgenC program error ${code} (0x${code.toString(16)})${errorName ? `: ${errorName}` : ""}`;
  } else if (error instanceof Error && error.message) {
    message = `Transaction failed: ${error.message}`;
  } else {
    message = "Transaction failed";
  }

  return new AgencError(message, {
    code,
    errorName,
    logs,
    signature,
    cause: error,
  });
}
