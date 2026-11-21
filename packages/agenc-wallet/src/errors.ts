import type { WalletErrorCode, WalletErrorShape } from "./client/types.js";

/**
 * A refusal or failure with a sentence that is safe to show to a person.
 * Internal detail (addresses, program errors, stack traces) goes in `cause`
 * and stays in the service log.
 */
export class WalletError extends Error implements WalletErrorShape {
  readonly code: WalletErrorCode;
  /** Whether trying again later, with nothing changed, may work (see `WalletErrorShape`). */
  readonly retryable?: boolean;

  constructor(
    code: WalletErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WalletError";
    this.code = code;
    if (options?.retryable !== undefined) this.retryable = options.retryable;
  }
}

/** Turn anything thrown into the wire error shape without leaking detail. */
export function toWalletErrorShape(error: unknown): WalletErrorShape {
  if (error instanceof WalletError) {
    return error.retryable === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "INTERNAL",
    message: "Something went wrong inside the wallet. Nothing was changed by this request.",
  };
}

/** A short diagnostic string for the service log (never shown in a panel). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? ` <- ${error.cause.name}: ${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}
