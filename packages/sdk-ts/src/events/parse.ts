// Log-message event parsing: Anchor's `emit!` writes events to the transaction
// log as `Program data: <base64(discriminator ++ borsh payload)>`. This module
// scans those lines and decodes them with the generated event codecs.
//
// EMITTING-PROGRAM ATTRIBUTION (the trust boundary): any program can call
// `sol_log_data` with a byte-perfect copy of an agenc event blob, so the
// 8-byte discriminator alone authenticates nothing. Like Anchor's own
// EventParser, this module tracks the runtime-generated program invoke stack
// (`Program <id> invoke [n]` / `Program <id> success|failed`) and decodes a
// `Program data:` line ONLY while the agenc-coordination program is the
// currently executing program. Those structural lines cannot be forged from
// inside a program (`sol_log` output is always prefixed with `Program log:`),
// so attribution is as trustworthy as the log source itself.
//
// FAIL CLOSED: data lines that cannot be attributed to the agenc-coordination
// program (empty stack, foreign program on top, frames lost to a malformed or
// truncated sequence) are skipped. Note that an RPC `Log truncated` marker
// means trailing events may have been DROPPED from the log — absence of an
// event in truncated logs is not proof it was not emitted.
import { AGENC_EVENT_DECODERS, type AgencEvent } from "../generated/events/index.js";
import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "../generated/programs/index.js";
import { base64ToBytes, bytesToHex } from "./internal.js";

/** Anchor's event log line prefix (`emit!` convention, via `sol_log_data`). */
const PROGRAM_DATA_PREFIX = "Program data: ";

/** Program-emitted text lines (`sol_log`/`msg!`) — never structural. */
const PROGRAM_LOG_PREFIX = "Program log: ";

/** Return-data lines (`sol_set_return_data`) — never structural. */
const PROGRAM_RETURN_PREFIX = "Program return: ";

/** Length of the Anchor event discriminator that prefixes every event blob. */
const DISCRIMINATOR_LENGTH = 8;

/** Runtime-generated `Program <id> invoke [<depth>]` (depth is 1-based). */
const INVOKE_LINE = /^Program (\S+) invoke \[(\d+)\]$/;

/** Runtime-generated `Program <id> success`. */
const SUCCESS_LINE = /^Program (\S+) success$/;

/** Runtime-generated `Program <id> failed: <error>`. */
const FAILED_LINE = /^Program (\S+) failed/;

/**
 * Attempts to decode a base64 event blob as an agenc-coordination event.
 * Returns `null` for malformed base64, blobs shorter than the 8-byte
 * discriminator, unknown discriminators, and corrupt payloads.
 */
function decodeEventBlob(base64: string): AgencEvent | null {
  const bytes = base64ToBytes(base64);
  if (bytes === null || bytes.length < DISCRIMINATOR_LENGTH) return null;
  const entry = AGENC_EVENT_DECODERS[bytesToHex(bytes, 0, DISCRIMINATOR_LENGTH)];
  if (entry === undefined) return null;
  try {
    return entry.decode(bytes.subarray(DISCRIMINATOR_LENGTH));
  } catch {
    // Known discriminator but undecodable payload (truncated/corrupt) — skip.
    return null;
  }
}

/**
 * Scans log messages with invoke-stack tracking and yields every event that
 * is BOTH well-formed AND attributable to the agenc-coordination program.
 *
 * Defensive (fail-closed) handling of malformed sequences:
 * - a data line with an empty stack or a foreign/unknown program on top is
 *   skipped;
 * - an `invoke [n]` at an unexpected depth resyncs the stack to depth `n`,
 *   padding any missing intermediate frames as UNKNOWN (never decoded under);
 * - a `success`/`failed` terminator pops through missed inner terminators to
 *   its own frame, and a stray terminator for a program not on the stack is
 *   ignored.
 * Attribution errors can therefore only NARROW what is decoded, never widen it.
 */
function* decodeAttributedEvents(
  logMessages: readonly string[],
): Generator<AgencEvent, void, void> {
  // Execution stack of program ids; `null` marks an unknown (resynced) frame.
  const stack: Array<string | null> = [];
  for (const line of logMessages) {
    // Program-emitted text first: a program can log arbitrary strings (e.g.
    // `msg!("success")` -> `Program log: success`), so these lines must never
    // be interpreted as structural invoke/terminator markers.
    if (line.startsWith(PROGRAM_LOG_PREFIX)) continue;
    if (line.startsWith(PROGRAM_RETURN_PREFIX)) continue;

    if (line.startsWith(PROGRAM_DATA_PREFIX)) {
      if (stack.length === 0) continue; // unattributable — fail closed
      if (stack[stack.length - 1] !== AGENC_COORDINATION_PROGRAM_ADDRESS) {
        continue; // emitted by a foreign/unknown program — fail closed
      }
      const event = decodeEventBlob(line.slice(PROGRAM_DATA_PREFIX.length));
      if (event !== null) yield event;
      continue;
    }

    const invoke = INVOKE_LINE.exec(line);
    if (invoke !== null) {
      const depth = Number.parseInt(invoke[2]!, 10);
      if (Number.isSafeInteger(depth) && depth >= 1) {
        // Resync: an invoke at depth n means exactly n-1 callers are active.
        if (stack.length > depth - 1) stack.length = depth - 1;
        while (stack.length < depth - 1) stack.push(null);
        stack.push(invoke[1]!);
      }
      continue;
    }

    const terminator = SUCCESS_LINE.exec(line) ?? FAILED_LINE.exec(line);
    if (terminator !== null) {
      const programId = terminator[1]!;
      if (stack.length > 0 && stack[stack.length - 1] === programId) {
        stack.pop();
      } else {
        const index = stack.lastIndexOf(programId);
        if (index !== -1) stack.length = index; // pop through missed terminators
        // Not on the stack at all: stray terminator — ignore.
      }
      continue;
    }
    // Everything else (`Program <id> consumed ...`, `Log truncated`, vote
    // markers, ...) neither moves the stack nor carries event data.
  }
}

/**
 * Decodes the FIRST agenc-coordination event found in a transaction's log
 * messages, or `null` if none decodes.
 *
 * Scans for Anchor's `Program data: <base64>` lines, matches the leading
 * 8-byte discriminator against the generated event table, and decodes the
 * payload. Non-event lines, malformed base64, unknown discriminators, and
 * corrupt payloads are skipped silently.
 *
 * EMITTING-PROGRAM ATTRIBUTION: the scan tracks the program invoke stack
 * (`Program <id> invoke [n]` / `Program <id> success|failed`) and decodes a
 * `Program data:` line ONLY while the agenc-coordination program is the
 * executing program — a byte-perfect event blob logged by any other program
 * is ignored, as is any data line that cannot be attributed at all (fail
 * closed). Events emitted by the program inside a CPI (inner invoke) ARE
 * decoded. Caveat: if the log was truncated by the RPC (`Log truncated`),
 * trailing real events may be missing from the input.
 *
 * @param logMessages - The transaction's log messages (e.g. `meta.logMessages`).
 * @returns The first decoded {@link AgencEvent}, or `null`.
 *
 * @example
 * ```ts
 * const event = decodeAgencEvent(tx.meta.logMessages ?? []);
 * if (event?.eventName === "TaskCreated") {
 *   console.log(event.data.rewardAmount); // bigint
 * }
 * ```
 */
export function decodeAgencEvent(logMessages: readonly string[]): AgencEvent | null {
  for (const event of decodeAttributedEvents(logMessages)) return event;
  return null;
}

/**
 * Decodes ALL agenc-coordination events found in a transaction's log
 * messages, in log order.
 *
 * Same scanning rules as {@link decodeAgencEvent}: only `Program data:`
 * lines emitted while the agenc-coordination program is the executing
 * program (per invoke-stack attribution) are considered, and anything that
 * is not a well-formed, known, attributable event blob is skipped silently.
 *
 * @param logMessages - The transaction's log messages (e.g. `meta.logMessages`).
 * @returns Every decoded {@link AgencEvent}, in the order it was logged.
 *
 * @example
 * ```ts
 * const events = parseAgencCoordinationEvents(tx.meta.logMessages ?? []);
 * const hired = events.find((e) => e.eventName === "ServiceListingHired");
 * ```
 */
export function parseAgencCoordinationEvents(
  logMessages: readonly string[],
): AgencEvent[] {
  return [...decodeAttributedEvents(logMessages)];
}
