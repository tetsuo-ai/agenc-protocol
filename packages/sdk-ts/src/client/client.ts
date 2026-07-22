// The marketplace client: one signer + one transport + one pipeline.
//
// Every transaction follows the same path regardless of venue (kit RPC or
// litesvm): prepend compute-budget instructions per config -> fetch blockhash
// -> assemble v0 message -> sign with the embedded signer -> submit via the
// Transport -> on a proven pre-broadcast blockhash expiry re-fetch/RE-SIGN/
// resend (bounded by maxRetries) -> on an ambiguous post-broadcast expiry
// reconcile the first signature or fail closed -> hydrate a structured
// AgencError on failure.
//
// Named convenience methods are THIN: the facade builds the instruction, the
// client sends it. They accept exactly the same input as the facade function.
import {
  appendTransactionMessageInstructions,
  assertIsTransactionMessageWithinSizeLimit,
  assertIsTransactionWithinSizeLimit,
  address,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type AddressesByLookupTableAddress,
  type Commitment,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as facade from "../facade/index.js";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "./compute-budget.js";
import { AgencError, isBlockhashExpiredError, toAgencError } from "./errors.js";
import {
  canonicalizeFacadeInputSigners,
  canonicalizeInstructionSigners,
  stabilizeTransactionSigner,
} from "./signer-identity.js";
import {
  createRpcTransport,
  isRetrySafePreBroadcastFailure,
  type RpcTransportRpc,
  type RpcTransportSubscriptions,
  type SignedTransaction,
  type Transport,
  type TransportSendResult,
  type TransportSignatureStatus,
} from "./transport.js";
import { snapshotDenseStructuredArray } from "../values/structured-clone.js";

/**
 * Default compute-unit limit prepended to every transaction.
 *
 * FEE WARNING: Solana charges the prioritization fee on the REQUESTED limit,
 * not on consumed units — `fee = computeUnitPrice x computeUnitLimit`. Typical
 * single facade instructions consume only ~15-35k CU, so leaving this 600k
 * default in place while setting a `computeUnitPrice` overpays the priority
 * fee by roughly 18-42x on every transaction. When you set a price, also set
 * an explicit `computeUnitLimit` (client-wide or per call via
 * {@link SendOptions}) sized to your instruction's actual consumption.
 */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 600_000;
/** Default number of blockhash-expiry retries. */
export const DEFAULT_MAX_RETRIES = 3;
/** Default commitment used when the client builds its own transport. */
export const DEFAULT_COMMITMENT: Commitment = "confirmed";

const MAX_ADDRESS_LOOKUP_TABLES_PER_SEND = 16;
const MAX_ADDRESSES_PER_LOOKUP_TABLE = 256;

function snapshotLookupTableAddresses(
  value: readonly Address[],
  label: string,
): readonly Address[] {
  const entries = snapshotDenseStructuredArray(
    value,
    label,
    MAX_ADDRESS_LOOKUP_TABLES_PER_SEND,
  );
  const seen = new Set<Address>();
  const snapshot: Address[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    let lookupTableAddress: Address;
    try {
      lookupTableAddress = address(entries[index]!);
    } catch (cause) {
      throw new TypeError(`${label}[${index}] must be a valid address`, {
        cause,
      });
    }
    if (seen.has(lookupTableAddress)) {
      throw new Error(`${label}: duplicate lookup table ${lookupTableAddress}`);
    }
    seen.add(lookupTableAddress);
    snapshot.push(lookupTableAddress);
  }
  return Object.freeze(snapshot);
}

function snapshotResolvedLookupTables(
  requested: readonly Address[],
  value: AddressesByLookupTableAddress,
): AddressesByLookupTableAddress {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("resolved address lookup tables must be an object");
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (cause) {
    throw new TypeError(
      "resolved address lookup tables must be safely inspectable",
      { cause },
    );
  }
  if (keys.length !== requested.length) {
    throw new Error(
      "resolved address lookup tables must exactly match the requested table set",
    );
  }
  const requestedSet = new Set(requested);
  const resolved = Object.create(null) as AddressesByLookupTableAddress;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(
        "resolved address lookup tables must contain only address keys",
      );
    }
    const tableAddress = address(key);
    if (!requestedSet.delete(tableAddress)) {
      throw new Error(`unexpected resolved lookup table ${tableAddress}`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (cause) {
      throw new TypeError(
        "resolved address lookup tables must be safely inspectable",
        { cause },
      );
    }
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `resolved lookup table ${tableAddress} must be an enumerable own data property`,
      );
    }
    const rawAddresses = snapshotDenseStructuredArray(
      descriptor.value as readonly Address[],
      `resolved lookup table ${tableAddress}`,
      MAX_ADDRESSES_PER_LOOKUP_TABLE,
    );
    const addresses: Address[] = [];
    for (let index = 0; index < rawAddresses.length; index += 1) {
      try {
        addresses.push(address(rawAddresses[index]!));
      } catch (cause) {
        throw new TypeError(
          `resolved lookup table ${tableAddress}[${index}] must be a valid address`,
          { cause },
        );
      }
    }
    resolved[tableAddress] = Object.freeze(addresses) as Address[];
  }
  if (requestedSet.size !== 0) {
    throw new Error("one or more requested address lookup tables were not resolved");
  }
  return Object.freeze(resolved);
}

/** Result of a confirmed client send. */
export type SendResult = TransportSendResult;

/** Per-call overrides for {@link MarketplaceClient.send}. */
export interface SendOptions {
  /** Set to `false` to omit ALL compute-budget instructions for this call. */
  computeBudget?: false;
  /**
   * Override the client's compute-unit limit for this call.
   *
   * The prioritization fee is charged on this REQUESTED limit, not on
   * consumed units (`fee = computeUnitPrice x computeUnitLimit`) — see
   * {@link DEFAULT_COMPUTE_UNIT_LIMIT}. Set this explicitly whenever a
   * `computeUnitPrice` is in effect.
   */
  computeUnitLimit?: number;
  /**
   * Override the client's compute-unit price (micro-lamports) for this call.
   *
   * Setting a price without also setting an explicit `computeUnitLimit`
   * charges the fee against the 600k default limit — typically 18-42x the
   * units a single facade instruction actually consumes.
   */
  computeUnitPrice?: bigint | number;
  /** Override the client's proven-pre-broadcast blockhash-expiry retry bound. */
  maxRetries?: number;
  /**
   * Canonical on-chain address lookup tables used to compress this v0 message.
   * The client asks the transport to fetch their actual ordered contents; it
   * never trusts caller-supplied address indexes. Per-call values replace the
   * client default. Custom transports must implement
   * `resolveAddressLookupTables` when this option is non-empty.
   */
  addressLookupTableAddresses?: readonly Address[];
}

/** Connection part of the client config: bring a transport, a kit RPC, or URLs. */
export type MarketplaceClientConnectionConfig =
  | {
      /** A pre-built transport (litesvm, sandbox, or custom). */
      transport: Transport;
    }
  | {
      /** A kit RPC client (from `createSolanaRpc`). */
      rpc: RpcTransportRpc;
      /** Optional kit RPC subscriptions for notification-based confirmation. */
      rpcSubscriptions?: RpcTransportSubscriptions;
    }
  | {
      /** HTTP RPC endpoint; the client builds the kit RPC itself. */
      rpcUrl: string;
      /** Optional WebSocket endpoint for notification-based confirmation. */
      rpcSubscriptionsUrl?: string;
    };

/** Full configuration for {@link createMarketplaceClient}. */
export type MarketplaceClientConfig = MarketplaceClientConnectionConfig & {
  /** The signer used as fee payer and embedded transaction signer. */
  signer: TransactionSigner;
  /**
   * Commitment used when the client builds its own RPC transport. Ignored when
   * a pre-built `transport` is supplied (the transport owns confirmation).
   * Defaults to `"confirmed"`.
   */
  commitment?: Commitment;
  /**
   * Compute-unit limit prepended to every transaction. Defaults to 600_000.
   *
   * The prioritization fee is charged on this REQUESTED limit, not on consumed
   * units (`fee = computeUnitPrice x computeUnitLimit`) — see
   * {@link DEFAULT_COMPUTE_UNIT_LIMIT}. Set it explicitly (here or per call)
   * whenever you set a `computeUnitPrice`.
   */
  computeUnitLimit?: number;
  /**
   * Compute-unit price (micro-lamports) prepended to every transaction. Unset
   * by default.
   *
   * Setting a price without an explicit `computeUnitLimit` charges the
   * priority fee against the 600k default limit — typically 18-42x the units
   * a single facade instruction actually consumes.
   */
  computeUnitPrice?: bigint | number;
  /** Proven-pre-broadcast blockhash-expiry retry bound. Defaults to 3. */
  maxRetries?: number;
  /**
   * P6.2 demand-side referral default. When set, EVERY hire/create this client
   * builds (`hireFromListing`, `hireFromListingHumanless`, `createTask`,
   * `createTaskHumanless`) carries this referrer wallet + bps unless the per-call
   * input overrides `referrer`/`referrerFeeBps`. This is what an embedder sets once
   * at construction so the on-chain §4 4-way split credits them on every job their
   * site originates — the wiring behind the Phase 4 marketplace-react `useHire`.
   *
   * `referrerFeeBps` must satisfy the on-chain caps (referrer ≤ 2000 bps, and
   * protocol + operator + referrer ≤ 4000 bps) or the transaction is rejected
   * on-chain (`ReferrerFeeTooHigh` / `CombinedFeeAboveCap`).
   */
  referrer?: {
    /** The embedder's payee wallet (base58 `Address`). */
    address: Address;
    /** The referral fee in basis points (e.g. 500 = 5%). */
    feeBps: number;
  };
};

/** Input type of a facade instruction builder. */
type FacadeInput<TBuilder extends (input: never) => unknown> =
  Parameters<TBuilder>[0];

/**
 * The marketplace client returned by {@link createMarketplaceClient}.
 *
 * `send` is the generic path; the named methods build the matching facade
 * instruction and send it through the same pipeline.
 */
export interface MarketplaceClient {
  /** The signer this client signs and pays fees with. */
  readonly signer: TransactionSigner;
  /** The transport this client submits through. */
  readonly transport: Transport;
  /**
   * Client-level referral default applied by hire/create helpers. Exposed so
   * higher-level recovery flows can reconcile the exact economic intent that
   * the client submitted. Omitted when no default is configured.
   */
  readonly defaultReferrer?: Readonly<
    NonNullable<MarketplaceClientConfig["referrer"]>
  >;

  /**
   * Assemble, sign, submit, and confirm a transaction from instructions.
   *
   * Compute-budget instructions are prepended per the client config (override
   * or disable per call via `options`). On a proven pre-broadcast blockhash
   * expiry the client re-fetches the blockhash, RE-SIGNS, and resends, up to
   * `maxRetries` times. Any other failure — including blockhash fetch/signing
   * errors and outcome-ambiguous post-broadcast expiry — rejects with an
   * {@link AgencError} (the original error is preserved as `cause`).
   *
   * Expiry-vs-landed race: an expiry signal can be reported while the
   * previous attempt actually landed (the status view can lag the
   * block-height view). When the transport implements
   * `getSignatureStatus`, the client rechecks the previous attempt's
   * signature before every possible re-sign and short-circuits to success
   * with the FIRST signature (or throws that attempt's real on-chain error)
   * if it landed. Every unmarked rejection after entering a custom transport
   * is treated as potentially submitted and bound to the local wire signature;
   * if its status is absent or unavailable, the client fails closed with that
   * `AgencError.signature`. Only an SDK-branded first-party
   * BlockhashNotFound preflight can authorize a re-sign. Successful transport
   * results are also checked for an exact signature match and valid log shape.
   *
   * @param instructions - The program instructions to execute, in order.
   * @param options - Per-call compute-budget / retry overrides.
   * @returns The confirmed signature and (when the transport provides them) logs.
   *
   * @example
   * ```ts
   * const ix = await facade.createTask({ ... });
   * const { signature } = await client.send([ix]);
   * ```
   */
  send(
    instructions: readonly Instruction[],
    options?: SendOptions,
  ): Promise<SendResult>;

  /** Build (facade.registerAgent) and send a register_agent transaction. */
  registerAgent(
    input: FacadeInput<typeof facade.registerAgent>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.createServiceListing) and send a create_service_listing transaction. */
  createServiceListing(
    input: FacadeInput<typeof facade.createServiceListing>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.registerStore) and send a register_store transaction. */
  registerStore(
    input: FacadeInput<typeof facade.registerStore>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.updateStore) and send an update_store transaction. */
  updateStore(
    input: FacadeInput<typeof facade.updateStore>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.closeStore) and send a close_store transaction. */
  closeStore(
    input: FacadeInput<typeof facade.closeStore>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.hireFromListing) and send a hire_from_listing transaction. */
  hireFromListing(
    input: FacadeInput<typeof facade.hireFromListing>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.hireFromListingHumanless) and send a hire_from_listing_humanless transaction. */
  hireFromListingHumanless(
    input: FacadeInput<typeof facade.hireFromListingHumanless>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.setTaskJobSpec) and send a set_task_job_spec transaction. */
  setTaskJobSpec(
    input: FacadeInput<typeof facade.setTaskJobSpec>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /**
   * Build and send claim_task_with_job_spec. Pass the verified `jobSpecHash`
   * for the assignment-time moderation BLOCK check. Dependent tasks also pass
   * `parentTask` as canonical completion evidence.
   */
  claimTaskWithJobSpec(
    input: FacadeInput<typeof facade.claimTaskWithJobSpec>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.submitTaskResult) and send a submit_task_result transaction. */
  submitTaskResult(
    input: FacadeInput<typeof facade.submitTaskResult>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.acceptTaskResult) and send an accept_task_result transaction. */
  acceptTaskResult(
    input: FacadeInput<typeof facade.acceptTaskResult>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.rejectTaskResult) and send a reject_task_result transaction. */
  rejectTaskResult(
    input: FacadeInput<typeof facade.rejectTaskResult>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.autoAcceptTaskResult) and send an auto_accept_task_result transaction. */
  autoAcceptTaskResult(
    input: FacadeInput<typeof facade.autoAcceptTaskResult>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.validateTaskResult) and send a validate_task_result transaction. */
  validateTaskResult(
    input: FacadeInput<typeof facade.validateTaskResult>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.cancelTask) and send a cancel_task transaction. */
  cancelTask(
    input: FacadeInput<typeof facade.cancelTask>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.closeTask) and send a close_task transaction. */
  closeTask(
    input: FacadeInput<typeof facade.closeTask>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.rateHire) and send a rate_hire transaction. */
  rateHire(
    input: FacadeInput<typeof facade.rateHire>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.postCompletionBond) and send a post_completion_bond transaction. */
  postCompletionBond(
    input: FacadeInput<typeof facade.postCompletionBond>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.reclaimCompletionBond) and send a reclaim_completion_bond transaction. */
  reclaimCompletionBond(
    input: FacadeInput<typeof facade.reclaimCompletionBond>,
    options?: SendOptions,
  ): Promise<SendResult>;

  // --- dispute family (wraps every builder exported by facade/disputes.ts) ---

  /** Build (facade.initiateDispute) and send an initiate_dispute transaction. */
  initiateDispute(
    input: FacadeInput<typeof facade.initiateDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
  // P6.3: `voteDispute` removed — the per-case arbiter vote/quorum model is retired;
  // a threshold-approved authority or threshold-seated assigned resolver decides.
  /** Build (facade.resolveDispute) and send a resolve_dispute transaction. */
  resolveDispute(
    input: FacadeInput<typeof facade.resolveDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.expireDispute) and send an expire_dispute transaction. */
  expireDispute(
    input: FacadeInput<typeof facade.expireDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.cancelDispute) and send a cancel_dispute transaction. */
  cancelDispute(
    input: FacadeInput<typeof facade.cancelDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.applyDisputeSlash) and send an apply_dispute_slash transaction. */
  applyDisputeSlash(
    input: FacadeInput<typeof facade.applyDisputeSlash>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.applyInitiatorSlash) and send an apply_initiator_slash transaction. */
  applyInitiatorSlash(
    input: FacadeInput<typeof facade.applyInitiatorSlash>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.resolveRejectFrozen) and send a resolve_reject_frozen transaction. */
  resolveRejectFrozen(
    input: FacadeInput<typeof facade.resolveRejectFrozen>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.expireRejectFrozen) and send an expire_reject_frozen transaction. */
  expireRejectFrozen(
    input: FacadeInput<typeof facade.expireRejectFrozen>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.assignDisputeResolver) and send an assign_dispute_resolver transaction. */
  assignDisputeResolver(
    input: FacadeInput<typeof facade.assignDisputeResolver>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.revokeDisputeResolver) and send a revoke_dispute_resolver transaction. */
  revokeDisputeResolver(
    input: FacadeInput<typeof facade.revokeDisputeResolver>,
    options?: SendOptions,
  ): Promise<SendResult>;
}

/**
 * Merge a client-level `referrer` default (P6.2) into a hire/create facade input.
 *
 * The default is applied ONLY when the caller did not pass an explicit `referrer`
 * (the property is absent or `undefined`); any explicit value — including an
 * explicit `referrer: null` to opt out — wins. Returns the input unchanged when no
 * default is configured. Pure + exported for unit testing.
 */
export function withReferrerDefault<TInput>(
  input: TInput,
  defaultReferrer: MarketplaceClientConfig["referrer"],
): TInput {
  if (!defaultReferrer) return input;
  const record = input as Record<string, unknown>;
  if (record.referrer !== undefined) return input;
  return {
    ...record,
    referrer: defaultReferrer.address,
    referrerFeeBps: defaultReferrer.feeBps,
  } as TInput;
}

function resolveTransport(config: MarketplaceClientConfig): Transport {
  if ("transport" in config && config.transport) {
    return config.transport;
  }
  const commitment = config.commitment ?? DEFAULT_COMMITMENT;
  if ("rpc" in config && config.rpc) {
    return createRpcTransport({
      rpc: config.rpc,
      rpcSubscriptions: config.rpcSubscriptions,
      commitment,
    });
  }
  if ("rpcUrl" in config && config.rpcUrl) {
    return createRpcTransport({
      rpc: createSolanaRpc(config.rpcUrl),
      rpcSubscriptions: config.rpcSubscriptionsUrl
        ? createSolanaRpcSubscriptions(config.rpcSubscriptionsUrl)
        : undefined,
      commitment,
    });
  }
  throw new Error(
    "createMarketplaceClient: provide one of { transport }, { rpc }, or { rpcUrl }",
  );
}

/**
 * Create a {@link MarketplaceClient} binding a signer to a transport.
 *
 * The connection can be a pre-built {@link Transport} (litesvm/sandbox), a kit
 * RPC client, or plain URLs (the client builds the kit RPC itself). Defaults:
 * commitment `"confirmed"`, computeUnitLimit `600_000`, computeUnitPrice
 * unset, maxRetries `3`.
 *
 * @param config - Connection + signer + pipeline defaults.
 * @returns A client whose every method runs the same
 * assemble/sign/confirm/error pipeline.
 *
 * @example
 * ```ts
 * const client = createMarketplaceClient({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   signer: await generateKeyPairSigner(),
 * });
 * const { signature } = await client.registerAgent({
 *   authority: client.signer,
 *   agentId,
 *   capabilities: 1n,
 *   endpoint: "https://agent.example",
 *   metadataUri: null,
 *   stakeAmount: 0n,
 * });
 * ```
 */
export function createMarketplaceClient(
  config: MarketplaceClientConfig,
): MarketplaceClient {
  const transport = resolveTransport(config);
  const signer = stabilizeTransactionSigner(config.signer);
  const defaultComputeUnitLimit =
    config.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const defaultComputeUnitPrice = config.computeUnitPrice;
  const defaultMaxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultReferrer =
    config.referrer === undefined
      ? undefined
      : Object.freeze({
          address: config.referrer.address,
          feeBps: config.referrer.feeBps,
        });

  function computeBudgetInstructions(options?: SendOptions): Instruction[] {
    if (options?.computeBudget === false) return [];
    const instructions: Instruction[] = [];
    const limit = options?.computeUnitLimit ?? defaultComputeUnitLimit;
    instructions.push(getSetComputeUnitLimitInstruction(limit));
    const price = options?.computeUnitPrice ?? defaultComputeUnitPrice;
    if (price !== undefined) {
      instructions.push(getSetComputeUnitPriceInstruction(price));
    }
    return instructions;
  }

  /**
   * Once `sendAndConfirm` has been invoked, an unmarked failure from a custom
   * transport is outcome-ambiguous even when that transport omitted a
   * signature. Bind it to the signature of the exact signed wire transaction
   * the SDK handed across the boundary. This also prevents a faulty transport
   * from substituting an unrelated signature in the surfaced error.
   */
  function hydrateAmbiguousTransportFailure(
    signedTransaction: SignedTransaction,
    error: unknown,
  ): AgencError {
    const localSignature = getSignatureFromTransaction(signedTransaction);
    const hydrated = toAgencError(error);
    if (hydrated.signature === localSignature) return hydrated;

    const ambiguity =
      hydrated.signature === null
        ? `the transport supplied no SDK retry-safe pre-broadcast proof; the submission outcome for local wire signature ${localSignature} is unknown`
        : `the transport reported signature ${hydrated.signature}, which does not match local wire signature ${localSignature}; the local transaction's submission outcome is unknown`;
    return new AgencError(`${hydrated.message}; ${ambiguity}`, {
      code: hydrated.code,
      errorName: hydrated.errorName,
      logs: hydrated.logs,
      signature: localSignature,
      cause: error,
    });
  }

  /** Reject a custom transport's false/malformed success at the same seam. */
  function validateTransportSendResult(
    signedTransaction: SignedTransaction,
    result: unknown,
  ): TransportSendResult {
    const localSignature = getSignatureFromTransaction(signedTransaction);
    const carrier =
      result !== null && typeof result === "object"
        ? (result as { signature?: unknown; logs?: unknown })
        : null;
    let defect: string | null = null;
    if (!carrier) {
      defect = "the transport returned a malformed success result";
    } else if (
      typeof carrier.signature !== "string" ||
      carrier.signature.length === 0
    ) {
      defect =
        "the transport returned an empty or non-string success signature";
    } else if (carrier.signature !== localSignature) {
      defect =
        `the transport reported success for signature ${carrier.signature}, ` +
        `which does not match local wire signature ${localSignature}`;
    } else if (
      !Array.isArray(carrier.logs) ||
      !carrier.logs.every((line) => typeof line === "string")
    ) {
      defect = "the transport returned malformed success logs";
    }
    if (defect !== null) {
      throw new Error(
        `${defect}; the local transaction's outcome is unknown and it must not be re-submitted`,
      );
    }
    return result as TransportSendResult;
  }

  /**
   * Reconcile an outcome-ambiguous expiry without re-signing. The expiry
   * signal can race a landed transaction when the status view lags the
   * block-height view. Returns the success result
   * (with the FIRST signature) only after it reaches the transport's promised
   * commitment, throws the attempt's real on-chain error when it failed,
   * throws an in-flight signature error when it is visible below the promised
   * commitment, and returns `null` only for a proven pre-broadcast failure
   * whose signature is unseen (or cannot be checked). A post-broadcast failure
   * with an unavailable status always throws an unknown-outcome error.
   */
  async function resolveLandedAttempt(
    signedTransaction: SignedTransaction,
    submittedFailure: ReturnType<typeof toAgencError> | null,
  ): Promise<SendResult | null> {
    const signature = getSignatureFromTransaction(signedTransaction);
    const throwUnknownOutcome = (
      reason: string,
      reconciliationError?: unknown,
    ): never => {
      const originalFailure =
        submittedFailure?.cause ?? submittedFailure ?? undefined;
      const failure = new Error(
        `Transaction ${signature} expired after submission, but ${reason}; ` +
          "the outcome is unknown and the transaction was not re-submitted",
        originalFailure === undefined ? undefined : { cause: originalFailure },
      ) as Error & {
        signature: string;
        reconciliationError?: unknown;
      };
      failure.signature = signature;
      if (reconciliationError !== undefined) {
        failure.reconciliationError = reconciliationError;
      }
      throw toAgencError(failure);
    };

    if (
      submittedFailure?.signature !== null &&
      submittedFailure?.signature !== undefined &&
      submittedFailure.signature !== signature
    ) {
      throwUnknownOutcome(
        `the transport reported the different signature ${submittedFailure.signature}`,
      );
    }
    if (!transport.getSignatureStatus) {
      if (submittedFailure !== null) {
        throwUnknownOutcome("the transport cannot look up its status");
      }
      return null;
    }
    let status: TransportSignatureStatus | null;
    try {
      status = await transport.getSignatureStatus(signature);
    } catch (reconciliationError) {
      if (submittedFailure !== null) {
        throwUnknownOutcome("its status lookup failed", reconciliationError);
      }
      return null;
    }
    if (!status) {
      if (submittedFailure !== null) {
        throwUnknownOutcome("its cluster status is still unknown");
      }
      return null;
    }
    if (status.err != null) {
      let detail: string;
      try {
        detail = JSON.stringify(status.err) ?? String(status.err);
      } catch {
        detail = String(status.err);
      }
      const failure = new Error(
        `Transaction ${signature} failed: ${detail}`,
      ) as Error & { transactionError: unknown; signature: string };
      failure.transactionError = status.err;
      failure.signature = signature;
      throw toAgencError(failure);
    }
    const targetCommitment =
      transport.confirmationCommitment ?? DEFAULT_COMMITMENT;
    const statusRank =
      status.confirmationStatus === "finalized"
        ? 2
        : status.confirmationStatus === "confirmed"
          ? 1
          : status.confirmationStatus === "processed"
            ? 0
            : -1;
    const targetRank =
      targetCommitment === "finalized"
        ? 2
        : targetCommitment === "processed"
          ? 0
          : 1;
    if (statusRank < targetRank) {
      // The first signature exists but has not reached this transport's
      // promised commitment. Re-signing could duplicate an instruction if it
      // later lands; reporting success could bless a fork that is dropped.
      // Surface the signature as an explicitly in-flight/unknown outcome.
      const pending = new Error(
        `Transaction ${signature} has only reached ${status.confirmationStatus ?? "an unknown commitment"}; waiting for ${targetCommitment}`,
      ) as Error & { signature: string };
      pending.signature = signature;
      throw toAgencError(pending);
    }
    return { signature, logs: [] };
  }

  async function send(
    instructions: readonly Instruction[],
    options?: SendOptions,
  ): Promise<SendResult> {
    let allInstructions: readonly Instruction[];
    try {
      allInstructions = canonicalizeInstructionSigners(
        [...computeBudgetInstructions(options), ...instructions],
        signer,
      );
    } catch (error) {
      throw toAgencError(error);
    }
    const maxRetries = options?.maxRetries ?? defaultMaxRetries;
    const lookupTableAddresses = snapshotLookupTableAddresses(
      options?.addressLookupTableAddresses ?? [],
      "MarketplaceClient.send: addressLookupTableAddresses",
    );
    let lookupTables: AddressesByLookupTableAddress | undefined;
    if (lookupTableAddresses.length > 0) {
      if (transport.resolveAddressLookupTables === undefined) {
        throw toAgencError(
          new Error(
            "MarketplaceClient.send: transport cannot resolve address lookup tables",
          ),
        );
      }
      try {
        lookupTables = snapshotResolvedLookupTables(
          lookupTableAddresses,
          await transport.resolveAddressLookupTables(lookupTableAddresses),
        );
      } catch (error) {
        throw toAgencError(error);
      }
    }
    let attempt = 0;
    for (;;) {
      // Pre-submission steps (blockhash fetch, assembly, signing) are wrapped
      // too: EVERY failure out of send() is an AgencError, with the original
      // error preserved as `cause`. No transaction is in flight here, so
      // these hydrate with `signature: null`.
      let signedTransaction: SignedTransaction;
      try {
        const latestBlockhash = await transport.getLatestBlockhash();
        const uncompressedMessage = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(signer, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
          (m) => appendTransactionMessageInstructions(allInstructions, m),
        );
        const message =
          lookupTables === undefined
            ? uncompressedMessage
            : compressTransactionMessageUsingAddressLookupTables(
                uncompressedMessage,
                lookupTables,
              );
        // Reject an impossible wire before invoking any wallet capability. The
        // v0 compiler accounts for signatures, compact lengths, and lookup-table
        // references exactly; legacy/v0 transactions are capped at 1,232 bytes.
        assertIsTransactionMessageWithinSizeLimit(message);
        // RE-SIGNED on every attempt: the message embeds the freshly fetched
        // blockhash, so a retry is a new signature over a new lifetime.
        signedTransaction = (await signTransactionMessageWithSigners(
          message,
        )) as SignedTransaction;
        // Defense in depth at the transport seam. Signing must not be able to
        // turn a size-checked message into an oversized wire transaction.
        assertIsTransactionWithinSizeLimit(signedTransaction);
      } catch (error) {
        throw toAgencError(error);
      }
      try {
        const result = await transport.sendAndConfirm(signedTransaction);
        return validateTransportSendResult(signedTransaction, result);
      } catch (error) {
        const expired = isBlockhashExpiredError(error);
        const localSignature = getSignatureFromTransaction(signedTransaction);
        if (isRetrySafePreBroadcastFailure(error, localSignature)) {
          if (expired && attempt < maxRetries) {
            // Only the SDK's private preflight capability proves that no wire
            // transaction was broadcast. Re-fetch and RE-SIGN in that one
            // machine-enforced case.
            attempt += 1;
            continue;
          }
          throw toAgencError(error);
        }

        // A custom transport may have broadcast before throwing any error,
        // including an unsigned one. Bind every unmarked transport failure to
        // the locally derived wire signature and never auto-submit another.
        const submittedFailure = hydrateAmbiguousTransportFailure(
          signedTransaction,
          error,
        );
        if (expired) {
          // A status lookup may prove the first transaction reached the
          // promised commitment. Otherwise resolveLandedAttempt fails closed
          // with the same local signature; it never authorizes a retry.
          const landed = await resolveLandedAttempt(
            signedTransaction,
            submittedFailure,
          );
          if (landed) return landed;
        }
        throw submittedFailure;
      }
    }
  }

  /** Wrap a facade builder: build the instruction, send it. Thin by design. */
  function viaFacade<TInput>(
    build: (input: TInput) => Promise<Instruction>,
  ): (input: TInput, options?: SendOptions) => Promise<SendResult> {
    return async (input, options) => {
      const stableInput = canonicalizeFacadeInputSigners(input, signer);
      return send([await build(stableInput)], options);
    };
  }

  /**
   * Like {@link viaFacade} but injects the client's configured `referrer` default
   * (P6.2) into the hire/create input when the caller did not pass an explicit
   * `referrer`. The on-chain handler validates the caps, so this only sets the
   * default; an explicit per-call `referrer: null` (or any value) wins.
   */
  function viaFacadeWithReferral<TInput>(
    build: (input: TInput) => Promise<Instruction>,
  ): (input: TInput, options?: SendOptions) => Promise<SendResult> {
    return async (input, options) => {
      const merged = withReferrerDefault(input, defaultReferrer);
      const stableInput = canonicalizeFacadeInputSigners(merged, signer);
      return send([await build(stableInput)], options);
    };
  }

  return {
    signer,
    transport,
    ...(defaultReferrer === undefined ? {} : { defaultReferrer }),
    send,
    registerAgent: viaFacade(facade.registerAgent),
    createServiceListing: viaFacade(facade.createServiceListing),
    // Batch-2 on-chain store identity (P5.2): permissionless register (rent +
    // the 0.05 SOL bond), in-place update, and the full-refund close.
    registerStore: viaFacade(facade.registerStore),
    updateStore: viaFacade(facade.updateStore),
    closeStore: viaFacade(facade.closeStore),
    // P6.2: hires carry the client's configured `referrer` default unless the
    // per-call input overrides it (the embedder's wallet+bps on every job).
    hireFromListing: viaFacadeWithReferral(facade.hireFromListing),
    hireFromListingHumanless: viaFacadeWithReferral(
      facade.hireFromListingHumanless,
    ),
    setTaskJobSpec: viaFacade(facade.setTaskJobSpec),
    claimTaskWithJobSpec: viaFacade(facade.claimTaskWithJobSpec),
    submitTaskResult: viaFacade(facade.submitTaskResult),
    acceptTaskResult: viaFacade(facade.acceptTaskResult),
    rejectTaskResult: viaFacade(facade.rejectTaskResult),
    autoAcceptTaskResult: viaFacade(facade.autoAcceptTaskResult),
    validateTaskResult: viaFacade(facade.validateTaskResult),
    cancelTask: viaFacade(facade.cancelTask),
    closeTask: viaFacade(facade.closeTask),
    rateHire: viaFacade(facade.rateHire),
    postCompletionBond: viaFacade(facade.postCompletionBond),
    reclaimCompletionBond: viaFacade(facade.reclaimCompletionBond),
    initiateDispute: viaFacade(facade.initiateDispute),
    // P6.3: `voteDispute` removed (vote/quorum model retired).
    resolveDispute: viaFacade(facade.resolveDispute),
    expireDispute: viaFacade(facade.expireDispute),
    cancelDispute: viaFacade(facade.cancelDispute),
    applyDisputeSlash: viaFacade(facade.applyDisputeSlash),
    applyInitiatorSlash: viaFacade(facade.applyInitiatorSlash),
    resolveRejectFrozen: viaFacade(facade.resolveRejectFrozen),
    expireRejectFrozen: viaFacade(facade.expireRejectFrozen),
    assignDisputeResolver: viaFacade(facade.assignDisputeResolver),
    revokeDisputeResolver: viaFacade(facade.revokeDisputeResolver),
  };
}
