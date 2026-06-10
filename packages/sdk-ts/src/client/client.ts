// The marketplace client: one signer + one transport + one pipeline.
//
// Every transaction follows the same path regardless of venue (kit RPC or
// litesvm): prepend compute-budget instructions per config -> fetch blockhash
// -> assemble v0 message -> sign with the embedded signer -> submit via the
// Transport -> on blockhash expiry re-fetch/RE-SIGN/resend (bounded by
// maxRetries) -> on failure hydrate a structured AgencError.
//
// Named convenience methods are THIN: the facade builds the instruction, the
// client sends it. They accept exactly the same input as the facade function.
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Commitment,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as facade from "../facade/index.js";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "./compute-budget.js";
import { isBlockhashExpiredError, toAgencError } from "./errors.js";
import {
  createRpcTransport,
  type RpcTransportRpc,
  type RpcTransportSubscriptions,
  type SignedTransaction,
  type Transport,
  type TransportSendResult,
  type TransportSignatureStatus,
} from "./transport.js";

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
  /** Override the client's blockhash-expiry retry bound for this call. */
  maxRetries?: number;
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
  /** Blockhash-expiry retry bound. Defaults to 3. */
  maxRetries?: number;
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
   * Assemble, sign, submit, and confirm a transaction from instructions.
   *
   * Compute-budget instructions are prepended per the client config (override
   * or disable per call via `options`). On a blockhash-expiry failure the
   * client re-fetches the blockhash, RE-SIGNS, and resends, up to
   * `maxRetries` times; any other failure — including pre-submission failures
   * such as a blockhash fetch or signing error — rejects with an
   * {@link AgencError} (the original error is preserved as `cause`).
   *
   * Expiry-vs-landed race: an expiry signal can be reported while the
   * previous attempt actually landed (the status view can lag the
   * block-height view). When the transport implements
   * `getSignatureStatus`, the client rechecks the previous attempt's
   * signature before every re-sign and short-circuits to success with the
   * FIRST signature (or throws that attempt's real on-chain error) if it
   * landed. A residual window remains: if the status view still lags at
   * recheck time — or the transport cannot check — a landed transaction can
   * be re-submitted. Duplicate marketplace instructions fail on-chain on PDA
   * init; for non-idempotent instructions (e.g. bare transfers), reconcile
   * via `AgencError.signature` before application-level retries.
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
  /** Build (facade.hireFromListing) and send a hire_from_listing transaction. */
  hireFromListing(
    input: FacadeInput<typeof facade.hireFromListing>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.claimTaskWithJobSpec) and send a claim_task_with_job_spec transaction. */
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
  /** Build (facade.postCompletionBond) and send a post_completion_bond transaction. */
  postCompletionBond(
    input: FacadeInput<typeof facade.postCompletionBond>,
    options?: SendOptions,
  ): Promise<SendResult>;

  // --- dispute family (wraps every builder exported by facade/disputes.ts) ---

  /** Build (facade.initiateDispute) and send an initiate_dispute transaction. */
  initiateDispute(
    input: FacadeInput<typeof facade.initiateDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
  /** Build (facade.voteDispute) and send a vote_dispute transaction (advisory-only). */
  voteDispute(
    input: FacadeInput<typeof facade.voteDispute>,
    options?: SendOptions,
  ): Promise<SendResult>;
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
  const { signer } = config;
  const defaultComputeUnitLimit =
    config.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const defaultComputeUnitPrice = config.computeUnitPrice;
  const defaultMaxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

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
   * Before an expiry-triggered re-sign, check whether the previous attempt
   * actually landed — the expiry signal can race a landed transaction when
   * the status view lags the block-height view. Returns the success result
   * (with the FIRST signature) to short-circuit with, throws the attempt's
   * real on-chain error when it landed and failed, and returns `null` when
   * the attempt did not land (or the transport cannot check).
   */
  async function resolveLandedAttempt(
    signedTransaction: SignedTransaction,
  ): Promise<SendResult | null> {
    if (!transport.getSignatureStatus) return null;
    const signature = getSignatureFromTransaction(signedTransaction);
    let status: TransportSignatureStatus | null;
    try {
      status = await transport.getSignatureStatus(signature);
    } catch {
      // Status view unavailable — fall back to the documented re-sign path.
      return null;
    }
    if (!status) return null;
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
    return { signature, logs: [] };
  }

  async function send(
    instructions: readonly Instruction[],
    options?: SendOptions,
  ): Promise<SendResult> {
    const allInstructions = [
      ...computeBudgetInstructions(options),
      ...instructions,
    ];
    const maxRetries = options?.maxRetries ?? defaultMaxRetries;
    let attempt = 0;
    for (;;) {
      // Pre-submission steps (blockhash fetch, assembly, signing) are wrapped
      // too: EVERY failure out of send() is an AgencError, with the original
      // error preserved as `cause`. No transaction is in flight here, so
      // these hydrate with `signature: null`.
      let signedTransaction: SignedTransaction;
      try {
        const latestBlockhash = await transport.getLatestBlockhash();
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(signer, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
          (m) => appendTransactionMessageInstructions(allInstructions, m),
        );
        // RE-SIGNED on every attempt: the message embeds the freshly fetched
        // blockhash, so a retry is a new signature over a new lifetime.
        signedTransaction = (await signTransactionMessageWithSigners(
          message,
        )) as SignedTransaction;
      } catch (error) {
        throw toAgencError(error);
      }
      try {
        return await transport.sendAndConfirm(signedTransaction);
      } catch (error) {
        if (attempt < maxRetries && isBlockhashExpiredError(error)) {
          // The expiry signal can race a landed transaction: short-circuit
          // to the first signature instead of submitting a duplicate.
          const landed = await resolveLandedAttempt(signedTransaction);
          if (landed) return landed;
          attempt += 1;
          continue;
        }
        throw toAgencError(error);
      }
    }
  }

  /** Wrap a facade builder: build the instruction, send it. Thin by design. */
  function viaFacade<TInput>(
    build: (input: TInput) => Promise<Instruction>,
  ): (input: TInput, options?: SendOptions) => Promise<SendResult> {
    return async (input, options) => send([await build(input)], options);
  }

  return {
    signer,
    transport,
    send,
    registerAgent: viaFacade(facade.registerAgent),
    createServiceListing: viaFacade(facade.createServiceListing),
    hireFromListing: viaFacade(facade.hireFromListing),
    claimTaskWithJobSpec: viaFacade(facade.claimTaskWithJobSpec),
    submitTaskResult: viaFacade(facade.submitTaskResult),
    acceptTaskResult: viaFacade(facade.acceptTaskResult),
    postCompletionBond: viaFacade(facade.postCompletionBond),
    initiateDispute: viaFacade(facade.initiateDispute),
    voteDispute: viaFacade(facade.voteDispute),
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
