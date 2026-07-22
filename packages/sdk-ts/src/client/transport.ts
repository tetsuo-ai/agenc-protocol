// The transport seam of the transaction runtime. A Transport owns exactly two
// concerns — blockhash acquisition and (signed) transaction submission +
// confirmation — so the SAME assemble/sign/retry/error pipeline in client.ts
// runs unchanged against a real kit RPC, a litesvm in-process VM (see
// tests-e2e/litesvm-transport.ts), or the P2.1 sandbox.
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  sendAndConfirmTransactionFactory,
  SolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  type Blockhash,
  type Commitment,
  type GetEpochInfoApi,
  type GetLatestBlockhashApi,
  type GetMultipleAccountsApi,
  type GetSignatureStatusesApi,
  type Rpc,
  type RpcSubscriptions,
  type SendableTransaction,
  type SendTransactionApi,
  type Signature,
  type SignatureNotificationsApi,
  type SlotNotificationsApi,
  type Transaction,
  type TransactionWithBlockhashLifetime,
  type Address,
  type AddressesByLookupTableAddress,
} from "@solana/kit";
import {
  ADDRESS_LOOKUP_TABLE_DISCRIMINATOR,
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  fetchAllMaybeAddressLookupTable,
} from "@solana-program/address-lookup-table";

/**
 * A fully signed, blockhash-lifetime transaction — exactly what the client's
 * sign step produces and what a {@link Transport} submits.
 */
export type SignedTransaction = SendableTransaction &
  Transaction &
  TransactionWithBlockhashLifetime;

/** A blockhash + the last block height at which it is still valid. */
export interface LatestBlockhash {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

/** Result of a confirmed transaction submission. */
export interface TransportSendResult {
  /**
   * Base58 signature of the exact `signedTx` passed to `sendAndConfirm`.
   * The client validates this against the locally signed wire transaction.
   */
  signature: string;
  /**
   * Program logs for the transaction. Transports that cannot cheaply provide
   * logs on success (e.g. the subscription-based RPC path) return `[]`. This
   * must be an array of strings; the client rejects malformed success results.
   */
  logs: readonly string[];
}

/**
 * Snapshot of a transaction's cluster status, as returned by
 * {@link Transport.getSignatureStatus}.
 */
export interface TransportSignatureStatus {
  /**
   * The cluster confirmation status (`"processed"` / `"confirmed"` /
   * `"finalized"`), or `null` when the venue does not report one.
   */
  confirmationStatus: string | null;
  /**
   * The transaction-level error, or `null` when the transaction succeeded.
   * Shapes match RPC `getSignatureStatuses().value[n].err` (e.g.
   * `{ InstructionError: [i, { Custom: code }] }`).
   */
  err: unknown;
}

/**
 * Minimal seam between the client pipeline and a Solana execution venue.
 *
 * Implementations exist for kit RPC ({@link createRpcTransport}) and litesvm
 * (the e2e test transport); the P2.1 sandbox injects its own. A transport's
 * `sendAndConfirm` MUST reject on failure. Once a custom transport has been
 * invoked, every rejection is conservatively treated as outcome-ambiguous and
 * bound to the locally derived wire signature, even if the rejection omitted
 * one. A reported signature is trusted only when it exactly matches that local
 * signature. Attaching `logs: string[]` still lets the client surface failure
 * logs. Automatic re-signing is reserved for an internal, SDK-branded
 * first-party BlockhashNotFound preflight rejection; custom transports cannot
 * create that capability by returning a matching error shape.
 */
export interface Transport {
  /**
   * Commitment that `sendAndConfirm` promises to reach. Custom transports may
   * omit this; expiry reconciliation then conservatively requires
   * `"confirmed"`.
   */
  readonly confirmationCommitment?: Commitment;
  /**
   * Fetch a fresh blockhash for transaction lifetimes.
   * @returns The latest blockhash and its `lastValidBlockHeight`.
   */
  getLatestBlockhash(): Promise<LatestBlockhash>;
  /**
   * OPTIONAL: resolve the exact, ordered on-venue contents of lookup tables.
   * The client never accepts caller-asserted table contents because a wrong
   * index would make the signed v0 message authorize a different account.
   * Standard RPC transports implement this from `getMultipleAccounts`.
   */
  resolveAddressLookupTables?(
    lookupTableAddresses: readonly Address[],
  ): Promise<AddressesByLookupTableAddress>;
  /**
   * Submit a signed transaction and wait until it is confirmed.
   * @param signedTx - The fully signed, blockhash-lifetime transaction.
   * @returns The exact signature of `signedTx` and a string-array of logs.
   * A mismatched, empty, or malformed success result is rejected as an unknown
   * outcome carrying the local signature and must not be re-submitted.
   */
  sendAndConfirm(signedTx: SignedTransaction): Promise<TransportSendResult>;
  /**
   * OPTIONAL: look up the current status of a previously submitted signature.
   *
   * For an unmarked expiry rejection, the client uses this to detect the race
   * where the expiry signal outruns the status view while the original
   * transaction actually landed. A status at the promised commitment returns
   * the FIRST signature; an absent/unavailable status fails closed without a
   * re-sign. Transports that cannot check may omit it.
   *
   * @param signature - Base58 signature of the transaction to look up.
   * @returns The status snapshot, or `null` when the cluster has not seen the
   * signature.
   */
  getSignatureStatus?(
    signature: string,
  ): Promise<TransportSignatureStatus | null>;
}

/** The RPC methods {@link createRpcTransport} needs. */
export type RpcTransportRpc = Rpc<
  GetEpochInfoApi &
    GetLatestBlockhashApi &
    GetSignatureStatusesApi &
    SendTransactionApi
>;

/** The RPC subscription channels {@link createRpcTransport} can use. */
export type RpcTransportSubscriptions = RpcSubscriptions<
  SignatureNotificationsApi & SlotNotificationsApi
>;

/** Configuration for {@link createRpcTransport}. */
export interface RpcTransportConfig {
  /** A kit RPC client (from `createSolanaRpc`). */
  rpc: RpcTransportRpc;
  /**
   * Optional kit RPC subscriptions (from `createSolanaRpcSubscriptions`).
   * When present, confirmation uses kit's `sendAndConfirmTransactionFactory`;
   * when absent, the transport sends then polls `getSignatureStatuses`.
   */
  rpcSubscriptions?: RpcTransportSubscriptions;
  /** Commitment to confirm to. Defaults to `"confirmed"`. */
  commitment?: Commitment;
  /** Polling interval (ms) for the no-subscriptions path. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Maximum time (ms) to wait for confirmation on the polling path. Defaults to 60_000. */
  timeoutMs?: number;
}

const COMMITMENT_RANK: Record<string, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

function commitmentReached(
  status: string | null | undefined,
  target: Commitment,
): boolean {
  if (!status) return false;
  return (COMMITMENT_RANK[status] ?? -1) >= (COMMITMENT_RANK[target] ?? 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyTransactionError(err: unknown): string {
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Extra `getSignatureStatuses` polls performed AFTER block-height expiry is
 * detected, before concluding the transaction can never land. The status view
 * can lag the block-height view (separate RPC calls, possibly separate nodes
 * behind a load balancer), so "status null + height exceeded" does not yet
 * prove the transaction missed its lifetime.
 */
const EXPIRY_STATUS_RECHECKS = 2;

/**
 * Return an error carrying the submitted transaction's signature (without
 * clobbering an existing one), so consumers — and the client's `AgencError`
 * hydration — can reconcile in-flight outcomes. JavaScript permits rejecting
 * with primitives and frozen objects, so wrap when mutation is impossible.
 */
function withSignature(error: unknown, signature: string): unknown {
  if (error !== null && typeof error === "object") {
    const carrier = error as { signature?: unknown };
    try {
      if (
        typeof carrier.signature === "string" &&
        carrier.signature.length > 0
      ) {
        return error;
      }
      carrier.signature = signature;
      if (carrier.signature === signature) return error;
    } catch {
      // Frozen/sealed/proxied object: preserve it as the wrapper's cause below.
    }
  }

  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string" && error.length > 0
        ? error
        : `Transaction ${signature} failed after submission`;
  const wrapped = new Error(message, { cause: error }) as Error & {
    signature: string;
  };
  wrapped.signature = signature;
  return wrapped;
}

/** True only for a typed/-32002 RPC simulation rejection before broadcast. */
function isTypedSendTransactionPreflightFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 16 && current != null; depth += 1) {
    if (
      isSolanaError(
        current,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    ) {
      return true;
    }
    try {
      const carrier = current as {
        code?: unknown;
        context?: { __code?: unknown; err?: unknown };
      };
      if (
        carrier.code ===
          SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE ||
        carrier.context?.__code ===
          SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Polling adapters may preserve only raw `context.err` at the direct
 * `sendTransaction().send()` response seam. That seam is still before any
 * status/confirmation work, so this narrow compatibility fallback is safe
 * there. It must not be used around the subscription helper's combined
 * send-and-confirm boundary.
 */
function isDirectSendPreflightFailure(error: unknown): boolean {
  if (isTypedSendTransactionPreflightFailure(error)) return true;
  let current = error;
  for (let depth = 0; depth < 16 && current != null; depth += 1) {
    try {
      const carrier = current as {
        context?: { err?: unknown };
        cause?: unknown;
      };
      if (carrier.context?.err === "BlockhashNotFound") return true;
      current = carrier.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/** True only when a deterministic preflight rejection is BlockhashNotFound. */
function isBlockhashNotFoundPreflightFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 16 && current != null; depth += 1) {
    if (
      isSolanaError(
        current,
        SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
      )
    ) {
      return true;
    }
    try {
      const carrier = current as {
        transactionError?: unknown;
        context?: { err?: unknown };
        cause?: unknown;
      };
      if (
        carrier.transactionError === "BlockhashNotFound" ||
        carrier.context?.err === "BlockhashNotFound"
      ) {
        return true;
      }
      current = carrier.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Private capability set for errors the SDK itself proved happened before
 * broadcast and may therefore be retried with a fresh blockhash. A WeakMap is
 * deliberately used instead of a public structural property: custom
 * transports cannot accidentally (or by copying an error shape) opt into the
 * automatic re-sign path. Binding the capability to the exact wire signature
 * also prevents replaying a branded error for another transaction.
 */
const retrySafePreBroadcastFailures = new WeakMap<object, string>();

function markRetrySafePreBroadcastFailure(
  error: unknown,
  wireSignature: string,
): unknown {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    retrySafePreBroadcastFailures.set(error as object, wireSignature);
    return error;
  }
  // The current first-party preflight classifiers always produce objects, but
  // retain a safe fallback so a future adapter cannot lose the capability by
  // rejecting with a primitive.
  const wrapped = new Error("Retry-safe RPC preflight failure", {
    cause: error,
  });
  retrySafePreBroadcastFailures.set(wrapped, wireSignature);
  return wrapped;
}

/**
 * Internal predicate consumed by the sibling client module. This is not
 * re-exported from the package's public client barrel; only an object branded
 * by this module's private WeakMap for that exact wire signature can pass it.
 */
export function isRetrySafePreBroadcastFailure(
  error: unknown,
  wireSignature: string,
): boolean {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    retrySafePreBroadcastFailures.get(error as object) === wireSignature
  );
}

/** Internal sentinel for a failure before an RPC request object exists. */
class RpcRequestConstructionFailure extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("RPC sendTransaction request construction failed", { cause: original });
    this.name = "RpcRequestConstructionFailure";
    this.original = original;
  }
}

/**
 * Kit's subscription helper combines request construction, send, and confirm
 * in one promise. Guard only the synchronous construction call so its outer
 * catch can distinguish a proven pre-submission failure from an ambiguous
 * send/confirmation failure.
 */
function guardSendTransactionConstruction(
  rpc: RpcTransportRpc,
): RpcTransportRpc {
  const boundMethods = new Map<PropertyKey, unknown>();
  // Proxy a fresh target rather than `rpc` itself. A frozen custom RPC may
  // expose non-configurable methods, and ECMAScript forbids a Proxy from
  // returning wrappers for those properties when the original is its target.
  const proxyTarget = Object.create(null) as RpcTransportRpc;
  return new Proxy(proxyTarget, {
    get(_target, property) {
      if (property !== "sendTransaction") {
        const value = Reflect.get(rpc, property, rpc);
        if (typeof value !== "function") return value;
        if (!boundMethods.has(property)) {
          // Preserve class/private-field and other receiver-sensitive RPC
          // implementations; the guard proxy must be transparent to every
          // method except sendTransaction construction.
          boundMethods.set(property, value.bind(rpc));
        }
        return boundMethods.get(property);
      }
      return (...args: Parameters<RpcTransportRpc["sendTransaction"]>) => {
        try {
          return rpc.sendTransaction(...args);
        } catch (error) {
          throw new RpcRequestConstructionFailure(error);
        }
      };
    },
  });
}

/**
 * Create a {@link Transport} backed by a kit RPC client.
 *
 * With `rpcSubscriptions` the transport confirms via kit's
 * `sendAndConfirmTransactionFactory` (signature notifications). Without them
 * it sends the transaction, then polls `getSignatureStatuses` until the target
 * commitment is reached, the blockhash expires (detected via `getEpochInfo`
 * block height vs the transaction's `lastValidBlockHeight` — surfaced as a
 * kit `SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED` so the client retry path engages),
 * or the timeout elapses.
 *
 * Expiry-vs-landed race: before reporting `BLOCK_HEIGHT_EXCEEDED`, the polling
 * path re-polls the signature status a couple more times — the transaction may
 * have landed in a block `<= lastValidBlockHeight` while the status view
 * lagged the block-height view. If the recheck finds it, the transport returns
 * success (or throws the transaction's real on-chain error) instead of
 * signaling expiry. A residual window remains: a status view lagging longer
 * than the rechecks can still mis-report a landed transaction as expired, so
 * the client additionally rechecks via {@link Transport.getSignatureStatus}
 * before any possible re-sign. If that status remains unavailable, the
 * transport's attached signature makes the client fail closed.
 *
 * Every error thrown after submission carries a `signature` property (lifted
 * into `AgencError.signature`): on a timeout or mid-poll network failure the
 * outcome is UNKNOWN — check that signature before retrying.
 *
 * @param config - RPC client, optional subscriptions, and confirmation tuning.
 * @returns A transport running the standard pipeline against the RPC.
 *
 * @example
 * ```ts
 * const transport = createRpcTransport({
 *   rpc: createSolanaRpc("https://api.mainnet-beta.solana.com"),
 *   commitment: "confirmed",
 * });
 * ```
 */
export function createRpcTransport(config: RpcTransportConfig): Transport {
  const {
    rpc,
    rpcSubscriptions,
    commitment = "confirmed",
    pollIntervalMs = 1_000,
    timeoutMs = 60_000,
  } = config;

  async function getLatestBlockhash(): Promise<LatestBlockhash> {
    const { value } = await rpc.getLatestBlockhash({ commitment }).send();
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight,
    };
  }

  async function getSignatureStatus(
    signature: string,
  ): Promise<TransportSignatureStatus | null> {
    const { value } = await rpc
      .getSignatureStatuses([signature as Signature])
      .send();
    const status = value[0];
    if (!status) return null;
    return {
      confirmationStatus: status.confirmationStatus ?? null,
      err: status.err ?? null,
    };
  }

  async function resolveAddressLookupTables(
    lookupTableAddresses: readonly Address[],
  ): Promise<AddressesByLookupTableAddress> {
    // Standard Kit RPC clients expose the full Solana API dynamically. Keep the
    // transport's ordinary type surface minimal while using the account method
    // only when a caller explicitly requests v0 lookup-table compression.
    //
    // Table contents are decoded from the raw base64 account bytes with the
    // official lookup-table program codec — not taken from the RPC's
    // `jsonParsed` view — and each account's owner and state discriminator are
    // verified before its ordered addresses are trusted for compression.
    const accounts = await fetchAllMaybeAddressLookupTable(
      rpc as unknown as Rpc<GetMultipleAccountsApi>,
      [...lookupTableAddresses],
      { commitment },
    );
    const resolved = Object.create(null) as AddressesByLookupTableAddress;
    for (const account of accounts) {
      if (!account.exists) {
        throw new Error(
          `address lookup table ${account.address} does not exist at commitment "${commitment}"`,
        );
      }
      if (account.programAddress !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS) {
        throw new Error(
          `address lookup table ${account.address} is not owned by the address lookup table program (owner: ${account.programAddress})`,
        );
      }
      if (account.data.discriminator !== ADDRESS_LOOKUP_TABLE_DISCRIMINATOR) {
        throw new Error(
          `address lookup table ${account.address} is not an initialized lookup table (state discriminator: ${account.data.discriminator})`,
        );
      }
      resolved[account.address] = account.data.addresses;
    }
    return resolved;
  }

  if (rpcSubscriptions) {
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc: guardSendTransactionConstruction(rpc),
      rpcSubscriptions,
    });
    return {
      confirmationCommitment: commitment,
      getLatestBlockhash,
      getSignatureStatus,
      resolveAddressLookupTables,
      async sendAndConfirm(signedTx) {
        const signature = getSignatureFromTransaction(signedTx);
        try {
          await sendAndConfirmTransaction(signedTx, { commitment });
        } catch (error) {
          if (error instanceof RpcRequestConstructionFailure) {
            throw error.original;
          }
          // A simulation failure proves the RPC did not broadcast. Other
          // failures at this boundary may have happened after acceptance.
          if (isTypedSendTransactionPreflightFailure(error)) {
            if (isBlockhashNotFoundPreflightFailure(error)) {
              throw markRetrySafePreBroadcastFailure(error, signature);
            }
            throw error;
          }
          throw withSignature(error, signature);
        }
        return { signature, logs: [] };
      },
    };
  }

  return {
    confirmationCommitment: commitment,
    getLatestBlockhash,
    getSignatureStatus,
    resolveAddressLookupTables,
    async sendAndConfirm(signedTx) {
      const signature = getSignatureFromTransaction(signedTx);
      const wireTransaction = getBase64EncodedWireTransaction(signedTx);
      let sendRequest: ReturnType<RpcTransportRpc["sendTransaction"]>;
      try {
        sendRequest = rpc.sendTransaction(wireTransaction, {
          encoding: "base64",
          preflightCommitment: commitment,
        });
      } catch (error) {
        // Request construction failed synchronously, before the RPC transport
        // received wire bytes. This is a proven pre-submission failure.
        throw error;
      }
      try {
        await sendRequest.send();
      } catch (error) {
        // A standard -32002 simulation rejection is deterministic and was not
        // broadcast. In particular, BlockhashNotFound must remain eligible for
        // the client's fresh-blockhash retry without becoming "in flight".
        if (isTypedSendTransactionPreflightFailure(error)) {
          if (isBlockhashNotFoundPreflightFailure(error)) {
            throw markRetrySafePreBroadcastFailure(error, signature);
          }
          throw error;
        }
        // Some compatible adapters retain only raw context.err at this direct
        // send response seam. Preserve their historical unsigned error shape,
        // but do NOT brand it retry-safe: without the standard -32002
        // provenance the client treats it as ambiguous and will not re-sign.
        if (isDirectSendPreflightFailure(error)) throw error;
        // The RPC may accept and forward the transaction before its HTTP
        // response is lost. This boundary is therefore outcome-ambiguous even
        // though status polling has not started yet; retain the known wire
        // signature so callers can reconcile instead of treating it as a
        // proven pre-send failure.
        throw withSignature(error, signature);
      }

      const pollStatus = async () => {
        const { value: statuses } = await rpc
          .getSignatureStatuses([signature])
          .send();
        return statuses[0] ?? null;
      };

      const { lastValidBlockHeight } = signedTx.lifetimeConstraint;
      const deadline = Date.now() + timeoutMs;
      try {
        for (;;) {
          let status = await pollStatus();
          if (!status) {
            // Not seen by the cluster yet — check whether the blockhash
            // lifetime is over.
            const epochInfo = await rpc.getEpochInfo({ commitment }).send();
            if (epochInfo.blockHeight > lastValidBlockHeight) {
              // The height view says expired, but the status view may simply
              // lag it: the transaction can have landed in a block
              // <= lastValidBlockHeight between the (null) status poll and
              // the epoch-info read. Re-poll the status a couple more times
              // before concluding it can never land.
              for (let i = 0; i < EXPIRY_STATUS_RECHECKS && !status; i += 1) {
                await sleep(pollIntervalMs);
                status = await pollStatus();
              }
              if (!status) {
                throw new SolanaError(SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED, {
                  currentBlockHeight: epochInfo.blockHeight,
                  lastValidBlockHeight,
                });
              }
            }
          }
          if (status) {
            if (status.err) {
              const failure = new Error(
                `Transaction ${signature} failed: ${stringifyTransactionError(status.err)}`,
              ) as Error & { transactionError: unknown };
              failure.transactionError = status.err;
              throw failure;
            }
            if (commitmentReached(status.confirmationStatus, commitment)) {
              return { signature, logs: [] };
            }
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Transaction ${signature} was not confirmed to "${commitment}" within ${timeoutMs}ms`,
            );
          }
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        // Anything thrown after submission (real on-chain failure, expiry,
        // timeout, mid-poll network error) refers to an in-flight signature —
        // attach it so consumers can reconcile the outcome.
        throw withSignature(error, signature);
      }
    },
  };
}
