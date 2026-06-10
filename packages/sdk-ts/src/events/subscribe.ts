// Live + polling event subscriptions over the agenc-coordination program.
//
// Both entry points are typed against MINIMAL STRUCTURAL slices of the
// @solana/kit RPC interfaces (just the methods/fields they actually touch),
// so they accept a real kit `Rpc`/`RpcSubscriptions` client as well as any
// structurally-compatible test double — and stay browser-compatible.
import type { Address, Commitment } from "@solana/kit";
import type { AgencEvent, AgencEventName } from "../generated/events/index.js";
import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "../generated/programs/index.js";
import { sleep } from "./internal.js";
import { parseAgencCoordinationEvents } from "./parse.js";

/** Cap on the remembered-signature dedupe window (multi-address watches). */
const MAX_TRACKED_SIGNATURES = 1000;

/**
 * Default bound on `getSignaturesForAddress` pages fetched per watched
 * address per polling round (see
 * {@link SubscribeMarketplaceEventsViaPollingOptions.maxPagesPerRound}).
 */
const DEFAULT_MAX_PAGES_PER_ROUND = 10;

/** One `logsNotifications` notification (minimal structural slice). */
export type LogsNotification = {
  readonly value: {
    /** Transaction error, or `null`/`undefined` when the transaction succeeded. */
    readonly err: unknown;
    /** The transaction's log messages (may be `null` on some RPC providers). */
    readonly logs: readonly string[] | null;
    /** The transaction signature (used to dedupe multi-address watches). */
    readonly signature: string;
  };
};

/**
 * Minimal structural slice of a kit `RpcSubscriptions` client: just the
 * `logsNotifications(...).subscribe(...)` plan used by
 * {@link subscribeMarketplaceEvents}.
 */
export type MarketplaceEventsRpcSubscriptions = {
  logsNotifications(
    filter: { readonly mentions: readonly [Address] },
    config?: { readonly commitment?: Commitment },
  ): {
    subscribe(options: {
      readonly abortSignal: AbortSignal;
    }): Promise<AsyncIterable<LogsNotification>>;
  };
};

/** Options shared by both subscription entry points. */
export type SubscribeMarketplaceEventsOptions = {
  /** Only yield events with these names; omit to yield every decoded event. */
  events?: readonly AgencEventName[];
  /**
   * Accounts to watch (each becomes its own `mentions` log filter). Defaults
   * to the agenc-coordination program address, i.e. every program event.
   */
  addresses?: readonly Address[];
  /** Abort to end the iteration. */
  abortSignal?: AbortSignal;
  /** Commitment for the underlying RPC calls (default `"confirmed"`). */
  commitment?: Commitment;
  /**
   * Optional plain HTTP `Rpc` handle that arms the AUTOMATIC polling fallback
   * in {@link subscribeMarketplaceEvents}: when `rpcSubscriptions` is
   * `null`/`undefined`, or the WebSocket subscription setup fails, the
   * generator transparently delegates to
   * {@link subscribeMarketplaceEventsViaPolling} with this handle (forwarding
   * `pollIntervalMs`/`maxPagesPerRound` when provided).
   *
   * Ignored by {@link subscribeMarketplaceEventsViaPolling} itself — there
   * the rpc is the first positional argument.
   */
  rpc?: MarketplaceEventsPollingRpc;
};

/**
 * Subscribes to agenc-coordination events over a WebSocket
 * `logsNotifications` subscription and yields each decoded event.
 *
 * Opens one log subscription per watched address (`options.addresses`, or
 * the program address when omitted), decodes every Anchor `Program data:`
 * line via the generated event codecs, and yields events in arrival order.
 * Failed transactions and unknown/undecodable event blobs are skipped, and
 * transactions seen via multiple address filters are deduped by signature.
 *
 * AUTOMATIC POLLING FALLBACK: when `options.rpc` is provided, the generator
 * transparently delegates to {@link subscribeMarketplaceEventsViaPolling}
 * if `rpcSubscriptions` is `null`/`undefined` (HTTP-only environment) or if
 * the WebSocket subscription SETUP fails (e.g. the provider rejects the
 * subscription). Failures after a successful setup are NOT retried through
 * the fallback — they reject the iteration as before. Without `options.rpc`
 * a missing `rpcSubscriptions` throws, and setup failures are rethrown.
 *
 * @param rpcSubscriptions - A kit `RpcSubscriptions` client (or any object
 * with a structurally-compatible `logsNotifications` method); may be
 * `null`/`undefined` when `options.rpc` is provided (polling fallback).
 * @param options - Event-name filter, watched addresses, abort signal,
 * commitment, and the optional polling-fallback handle/knobs (`rpc`,
 * `pollIntervalMs`, `maxPagesPerRound` — the latter two apply only when the
 * fallback engages).
 * @returns An async iterable of decoded {@link AgencEvent}s; iteration ends
 * when the abort signal fires or every underlying subscription completes.
 *
 * @example
 * ```ts
 * const abortController = new AbortController();
 * for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
 *   events: ["TaskCreated", "ServiceListingHired"],
 *   abortSignal: abortController.signal,
 *   rpc, // optional: automatic polling fallback for HTTP-only environments
 * })) {
 *   console.log(event.eventName, event.data);
 * }
 * ```
 */
export async function* subscribeMarketplaceEvents(
  rpcSubscriptions: MarketplaceEventsRpcSubscriptions | null | undefined,
  options: SubscribeMarketplaceEventsViaPollingOptions = {},
): AsyncGenerator<AgencEvent, void, void> {
  const { events, addresses, abortSignal, commitment = "confirmed", rpc } = options;
  if (abortSignal?.aborted) return;

  // AUTOMATIC POLLING FALLBACK (1/2): no subscriptions client at all.
  if (rpcSubscriptions == null) {
    if (rpc === undefined) {
      throw new Error(
        "subscribeMarketplaceEvents: rpcSubscriptions is null/undefined and no " +
          "options.rpc was provided for the polling fallback",
      );
    }
    yield* subscribeMarketplaceEventsViaPolling(rpc, options);
    return;
  }

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const watched: readonly Address[] =
    addresses !== undefined && addresses.length > 0
      ? addresses
      : [AGENC_COORDINATION_PROGRAM_ADDRESS];
  const wanted = events === undefined ? null : new Set<AgencEventName>(events);

  // Set up EVERY subscription before consuming any: setup failures are the
  // fallback trigger (or rethrown), iteration failures after that are not.
  // The async IIFE also converts a synchronous `logsNotifications` throw
  // into a rejection.
  const setupPromises = watched.map((watchedAddress) =>
    (async () =>
      rpcSubscriptions
        .logsNotifications({ mentions: [watchedAddress] }, { commitment })
        .subscribe({ abortSignal: controller.signal }))(),
  );
  // Cancel sibling setups as soon as one fails so allSettled cannot hang.
  for (const setup of setupPromises) {
    setup.catch(() => controller.abort());
  }
  const settled = await Promise.allSettled(setupPromises);
  const rejected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected",
  );
  if (rejected !== undefined) {
    controller.abort();
    abortSignal?.removeEventListener("abort", onOuterAbort);
    if (abortSignal?.aborted) return;
    // AUTOMATIC POLLING FALLBACK (2/2): subscription setup failed.
    if (rpc !== undefined) {
      yield* subscribeMarketplaceEventsViaPolling(rpc, options);
      return;
    }
    throw rejected.reason;
  }
  const streams = settled.map(
    (entry) =>
      (entry as PromiseFulfilledResult<AsyncIterable<LogsNotification>>).value,
  );

  // Fan-in: each subscription pumps decoded events into a shared queue the
  // generator drains; `wake` parks the generator while the queue is empty.
  const queue: AgencEvent[] = [];
  let wake: (() => void) | null = null;
  let finishedPumps = 0;
  // Box (not a plain `let`) so TS control-flow analysis does not narrow the
  // closure-assigned failure away inside the drain loop below.
  const firstFailure: { current: { error: unknown } | null } = { current: null };
  const seenSignatures = new Set<string>();
  const seenSignatureOrder: string[] = [];

  const wakeLoop = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const pump = async (
    notifications: AsyncIterable<LogsNotification>,
  ): Promise<void> => {
    for await (const notification of notifications) {
      const { err, logs, signature } = notification.value;
      if (err != null || logs == null) continue;
      if (watched.length > 1) {
        // A transaction mentioning several watched addresses arrives once per
        // subscription — dedupe by signature (bounded memory).
        if (seenSignatures.has(signature)) continue;
        seenSignatures.add(signature);
        seenSignatureOrder.push(signature);
        if (seenSignatureOrder.length > MAX_TRACKED_SIGNATURES) {
          seenSignatures.delete(seenSignatureOrder.shift()!);
        }
      }
      for (const event of parseAgencCoordinationEvents(logs)) {
        if (wanted !== null && !wanted.has(event.eventName)) continue;
        queue.push(event);
      }
      if (queue.length > 0) wakeLoop();
    }
  };

  const pumps = streams.map((stream) =>
    pump(stream)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) firstFailure.current ??= { error };
      })
      .finally(() => {
        finishedPumps += 1;
        wakeLoop();
      }),
  );

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      const failure = firstFailure.current;
      if (failure !== null) throw failure.error;
      if (finishedPumps === watched.length || controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    controller.abort();
    abortSignal?.removeEventListener("abort", onOuterAbort);
    await Promise.all(pumps);
  }
}

/** One `getSignaturesForAddress` entry (minimal structural slice). */
export type SignatureInfo = {
  readonly signature: string;
  /** Transaction error, or `null`/`undefined` when the transaction succeeded. */
  readonly err: unknown;
};

/**
 * Minimal structural slice of a kit `Rpc` client used by
 * {@link subscribeMarketplaceEventsViaPolling}: `getSignaturesForAddress`
 * (newest-first signature pages) + `getTransaction` (for `meta.logMessages`).
 */
export type MarketplaceEventsPollingRpc = {
  getSignaturesForAddress(
    address: Address,
    config?: {
      readonly commitment?: Commitment;
      readonly until?: string;
      /** Pagination cursor: return only signatures OLDER than this one. */
      readonly before?: string;
    },
  ): {
    send(options?: {
      readonly abortSignal?: AbortSignal;
    }): Promise<readonly SignatureInfo[]>;
  };
  getTransaction(
    signature: string,
    config?: {
      readonly commitment?: Commitment;
      readonly maxSupportedTransactionVersion?: number;
    },
  ): {
    send(options?: { readonly abortSignal?: AbortSignal }): Promise<{
      readonly meta: { readonly logMessages: readonly string[] | null } | null;
    } | null>;
  };
};

/** Options for {@link subscribeMarketplaceEventsViaPolling}. */
export type SubscribeMarketplaceEventsViaPollingOptions =
  SubscribeMarketplaceEventsOptions & {
    /** Delay between poll rounds in milliseconds (default `2000`). */
    pollIntervalMs?: number;
    /**
     * Bound on the number of `getSignaturesForAddress` pages fetched per
     * watched address per round (default `10`). The RPC caps each page at
     * 1,000 signatures, so a round can drain a burst of up to
     * `maxPagesPerRound × 1,000` transactions per address.
     *
     * OVERFLOW BEHAVIOR: if a burst exceeds that bound within one poll
     * interval, the high-water mark still advances to the newest fetched
     * signature, so any signatures older than the last fetched page (but
     * newer than the previous watermark) are SKIPPED — their events are
     * permanently dropped for this subscription, never delivered late. Raise
     * `maxPagesPerRound` (or lower `pollIntervalMs`) if you expect sustained
     * bursts beyond the bound.
     */
    maxPagesPerRound?: number;
  };

/**
 * Polling fallback for {@link subscribeMarketplaceEvents} for environments
 * without WebSocket subscriptions (HTTP-only RPC providers, some edge/server
 * runtimes, flaky proxies). It stays exported as an explicit entry point, and
 * {@link subscribeMarketplaceEvents} also delegates to it automatically when
 * `options.rpc` is set and WebSocket subscriptions are unavailable.
 *
 * Each round it pages `getSignaturesForAddress` for every watched address
 * with a `before` cursor (newest-first) until it reaches the `until`
 * high-water mark, an empty page, or the
 * {@link SubscribeMarketplaceEventsViaPollingOptions.maxPagesPerRound} bound
 * (default `10` pages — see that option's TypeDoc for the overflow-drop
 * semantics). It then fetches each NEW successful transaction with
 * `getTransaction`, decodes the events from `meta.logMessages`, and yields
 * them oldest-first. The FIRST round only records the high-water mark —
 * pre-existing history is not replayed, so the semantics match the WebSocket
 * variant ("events from now on"). Transactions appearing under several
 * watched addresses are deduped by signature.
 *
 * @param rpc - A kit `Rpc` client (or any object with structurally-compatible
 * `getSignaturesForAddress` / `getTransaction` methods).
 * @param options - Same options as {@link subscribeMarketplaceEvents}, plus
 * `pollIntervalMs` (default `2000`) and `maxPagesPerRound` (default `10`).
 * (`options.rpc` is ignored here — the rpc is the first argument.)
 * @returns An async iterable of decoded {@link AgencEvent}s; iteration ends
 * when the abort signal fires.
 *
 * @example
 * ```ts
 * for await (const event of subscribeMarketplaceEventsViaPolling(rpc, {
 *   events: ["TaskCompleted"],
 *   pollIntervalMs: 5_000,
 *   abortSignal: abortController.signal,
 * })) {
 *   console.log("settled:", event.data);
 * }
 * ```
 */
export async function* subscribeMarketplaceEventsViaPolling(
  rpc: MarketplaceEventsPollingRpc,
  options: SubscribeMarketplaceEventsViaPollingOptions = {},
): AsyncGenerator<AgencEvent, void, void> {
  const {
    events,
    addresses,
    abortSignal,
    commitment = "confirmed",
    pollIntervalMs = 2000,
    maxPagesPerRound = DEFAULT_MAX_PAGES_PER_ROUND,
  } = options;

  const watched: readonly Address[] =
    addresses !== undefined && addresses.length > 0
      ? addresses
      : [AGENC_COORDINATION_PROGRAM_ADDRESS];
  const wanted = events === undefined ? null : new Set<AgencEventName>(events);

  const watermarks = new Map<Address, string>();
  const baselined = new Set<Address>();
  const seenSignatures = new Set<string>();
  const seenSignatureOrder: string[] = [];

  while (!(abortSignal?.aborted ?? false)) {
    for (const watchedAddress of watched) {
      if (abortSignal?.aborted) return;

      if (!baselined.has(watchedAddress)) {
        // First round: ONE page just to record the high-water mark — no
        // history replay, so no pagination needed.
        let infos: readonly SignatureInfo[];
        try {
          infos = await rpc
            .getSignaturesForAddress(watchedAddress, {
              commitment,
              until: watermarks.get(watchedAddress),
            })
            .send({ abortSignal });
        } catch (error) {
          if (abortSignal?.aborted) return;
          throw error;
        }
        // Newest-first: index 0 is the high-water mark for the next round.
        if (infos.length > 0) watermarks.set(watchedAddress, infos[0]!.signature);
        baselined.add(watchedAddress);
        continue;
      }

      // Page newest-first with a `before` cursor until the `until` watermark
      // is reached (empty page) or the per-round page bound is hit. Anything
      // beyond the bound is dropped when the watermark advances — see
      // `maxPagesPerRound` for the documented overflow behavior.
      const until = watermarks.get(watchedAddress);
      const pages: Array<readonly SignatureInfo[]> = [];
      let before: string | undefined;
      for (let page = 0; page < maxPagesPerRound; page += 1) {
        if (abortSignal?.aborted) return;
        let infos: readonly SignatureInfo[];
        try {
          infos = await rpc
            .getSignaturesForAddress(watchedAddress, { commitment, until, before })
            .send({ abortSignal });
        } catch (error) {
          if (abortSignal?.aborted) return;
          throw error;
        }
        if (infos.length === 0) break;
        pages.push(infos);
        before = infos[infos.length - 1]!.signature;
      }
      if (pages.length === 0) continue;

      // Newest-first within and across pages: pages[0][0] is the new
      // high-water mark for the next round.
      watermarks.set(watchedAddress, pages[0]![0]!.signature);

      // Yield oldest-first: walk the pages (and each page) backwards.
      for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
        const infos = pages[pageIndex]!;
        for (let i = infos.length - 1; i >= 0; i -= 1) {
          if (abortSignal?.aborted) return;
          const info = infos[i]!;
          if (info.err != null) continue;
          if (seenSignatures.has(info.signature)) continue;
          seenSignatures.add(info.signature);
          seenSignatureOrder.push(info.signature);
          if (seenSignatureOrder.length > MAX_TRACKED_SIGNATURES) {
            seenSignatures.delete(seenSignatureOrder.shift()!);
          }

          let transaction: Awaited<
            ReturnType<
              ReturnType<MarketplaceEventsPollingRpc["getTransaction"]>["send"]
            >
          >;
          try {
            transaction = await rpc
              .getTransaction(info.signature, {
                commitment,
                maxSupportedTransactionVersion: 0,
              })
              .send({ abortSignal });
          } catch (error) {
            if (abortSignal?.aborted) return;
            throw error;
          }

          const logs = transaction?.meta?.logMessages;
          if (logs == null) continue;
          for (const event of parseAgencCoordinationEvents(logs)) {
            if (wanted !== null && !wanted.has(event.eventName)) continue;
            yield event;
          }
        }
      }
    }
    await sleep(pollIntervalMs, abortSignal);
  }
}
