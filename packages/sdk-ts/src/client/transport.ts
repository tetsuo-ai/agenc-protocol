// The transport seam of the transaction runtime. A Transport owns exactly two
// concerns — blockhash acquisition and (signed) transaction submission +
// confirmation — so the SAME assemble/sign/retry/error pipeline in client.ts
// runs unchanged against a real kit RPC, a litesvm in-process VM (see
// tests-e2e/litesvm-transport.ts), or the P2.1 sandbox.
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  SolanaError,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  type Blockhash,
  type Commitment,
  type GetEpochInfoApi,
  type GetLatestBlockhashApi,
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
} from "@solana/kit";

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
  /** Base58 transaction signature. */
  signature: string;
  /**
   * Program logs for the transaction. Transports that cannot cheaply provide
   * logs on success (e.g. the subscription-based RPC path) return `[]`.
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
 * `sendAndConfirm` MUST reject on failure; the rejection is hydrated into an
 * `AgencError` by the client. Attaching a `logs: string[]` property to the
 * thrown error lets the client surface program logs on failures, and attaching
 * a `signature: string` property to every error thrown after submission lets
 * the client expose which in-flight transaction the failure refers to
 * (`AgencError.signature`).
 */
export interface Transport {
  /**
   * Fetch a fresh blockhash for transaction lifetimes.
   * @returns The latest blockhash and its `lastValidBlockHeight`.
   */
  getLatestBlockhash(): Promise<LatestBlockhash>;
  /**
   * Submit a signed transaction and wait until it is confirmed.
   * @param signedTx - The fully signed, blockhash-lifetime transaction.
   * @returns The signature and (when available) the program logs.
   */
  sendAndConfirm(signedTx: SignedTransaction): Promise<TransportSendResult>;
  /**
   * OPTIONAL: look up the current status of a previously submitted signature.
   *
   * When implemented, the client uses this before every blockhash-expiry
   * triggered re-sign to detect the race where the expiry signal (block
   * height) outruns the status view while the original transaction actually
   * landed — short-circuiting to the FIRST signature instead of submitting a
   * duplicate. Transports that cannot check (e.g. fire-and-forget venues) may
   * omit it; the client then falls back to plain re-sign-and-resend.
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
 * Attach the submitted transaction's signature to an error thrown after
 * submission (without clobbering an existing one), so consumers — and the
 * client's `AgencError` hydration — can reconcile in-flight outcomes.
 */
function attachSignature(error: unknown, signature: string): void {
  if (error === null || typeof error !== "object") return;
  const carrier = error as { signature?: unknown };
  if (typeof carrier.signature === "string") return;
  try {
    carrier.signature = signature;
  } catch {
    // Frozen/sealed error object — nothing more we can do.
  }
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
 * before any re-sign.
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

  if (rpcSubscriptions) {
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });
    return {
      getLatestBlockhash,
      getSignatureStatus,
      async sendAndConfirm(signedTx) {
        const signature = getSignatureFromTransaction(signedTx);
        try {
          await sendAndConfirmTransaction(signedTx, { commitment });
        } catch (error) {
          attachSignature(error, signature);
          throw error;
        }
        return { signature, logs: [] };
      },
    };
  }

  return {
    getLatestBlockhash,
    getSignatureStatus,
    async sendAndConfirm(signedTx) {
      const signature = getSignatureFromTransaction(signedTx);
      const wireTransaction = getBase64EncodedWireTransaction(signedTx);
      await rpc
        .sendTransaction(wireTransaction, {
          encoding: "base64",
          preflightCommitment: commitment,
        })
        .send();

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
        attachSignature(error, signature);
        throw error;
      }
    },
  };
}
