// GoodPurchased watcher — the interface the game follow-on (or any indexer)
// consumes to fulfill an off-chain goods sale.
//
// Batch 4 (docs/design/batch-4-goods.md): a goods purchase is a SINGLE atomic
// transaction that emits a `GoodPurchased` Anchor event carrying everything an
// off-chain fulfiller needs — the listing, the buyer wallet, the unit serial,
// the SNAPSHOTTED metadata_hash (which pins the off-chain good, e.g. a game
// item-ledger row), the exact fee split (protocol_fee / operator_fee for revenue
// attribution), and the remaining supply. There is NO task/hire/settlement
// lifecycle to poll — the fulfiller watches for this one event and delivers.
//
// This module is transport-agnostic: `decodeGoodPurchased(logs, coder)` takes
// the tx log lines + an Anchor BorshCoder (the IDL event coder) and returns the
// decoded event, or null if the tx carried none. The kit-native path is the same
// idea using the SDK's `AGENC_EVENT_DECODERS` (see @tetsuo-ai/marketplace-sdk).

const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Decode the first `GoodPurchased` event out of a transaction's program logs.
 *
 * @param {string[]} logs - the tx log lines (e.g. litesvm `meta.logs()` or an
 *   RPC's `meta.logMessages`).
 * @param {import("@coral-xyz/anchor").BorshCoder} coder - an Anchor coder built
 *   from the agenc_coordination IDL (`new BorshCoder(IDL)`).
 * @returns {object|null} the decoded event `data`, or null if none present.
 */
export function decodeGoodPurchased(logs, coder) {
  for (const line of logs ?? []) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    let decoded;
    try {
      decoded = coder.events.decode(b64);
    } catch {
      continue; // not an Anchor event line (or a different program's data)
    }
    if (decoded && decoded.name === "GoodPurchased") return decoded.data;
  }
  return null;
}

/**
 * Reduce a decoded `GoodPurchased` into the off-chain fulfillment record a game
 * server / storefront would act on: deliver the good named by `metadataHash` to
 * `buyer`, and attribute `protocolFee` (+ `operatorFee`) as revenue.
 */
export function toFulfillment(event) {
  if (!event) return null;
  const hex = (b) => Buffer.from(b).toString("hex");
  return {
    listing: event.listing.toBase58(),
    buyer: event.buyer.toBase58(),
    seller: event.seller.toBase58(),
    serial: Number(event.serial),
    metadataHash: hex(event.metadata_hash),
    pricePaid: Number(event.price_paid),
    protocolFee: Number(event.protocol_fee),
    operatorFee: Number(event.operator_fee),
    remainingSupply: Number(event.remaining_supply),
    timestamp: Number(event.timestamp),
  };
}
