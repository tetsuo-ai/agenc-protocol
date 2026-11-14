import type { WalletErrorCode, WalletErrorShape } from "./client/types.js";

/**
 * A refusal or failure with a sentence that is safe to show to a person.
 * Internal detail (addresses, program errors, stack traces) goes in `cause`
 * and stays in the service log.
 */
export class WalletError extends Error implements WalletErrorShape {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WalletError";
    this.code = code;
  }
}

/** Turn anything thrown into the wire error shape without leaking detail. */
export function toWalletErrorShape(error: unknown): WalletErrorShape {
  if (error instanceof WalletError) {
    return { code: error.code, message: error.message };
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
