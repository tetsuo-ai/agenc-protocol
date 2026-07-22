// Facade: ergonomic, named entry points over the generated client for the
// Batch-4 GOODS market (docs/design/batch-4-goods.md). Thin by design — the
// generated client resolves PDAs (the `good` PDA from seller+goodId, the
// per-unit `saleReceipt` PDA from good+expectedSerial) and encodes data; the
// facade adds friendly signatures, the string-form metadata/tags encoders, the
// no-operator defaults, and an optional capability guard.
//
// Domain: create / purchase / update a rivalrous goods listing.
//   - create + update are SELLER-signed (the seller's agent authority).
//   - purchase is BUYER-signed (a bare wallet — no agent registration).
// The protocol takes `protocol_fee_bps` to the treasury on every sale; an
// optional operator (store/embedder) leg rides the settlement combined-fee cap.
import { address, type Address } from "@solana/kit";
import {
  getCreateGoodsListingInstructionAsync,
  getPurchaseGoodInstructionAsync,
  getUpdateGoodsListingInstructionAsync,
  findGoodPda,
  findSaleReceiptPda,
  findModerationBlockPda,
  type CreateGoodsListingAsyncInput,
  type PurchaseGoodAsyncInput,
  type UpdateGoodsListingAsyncInput,
} from "../generated/index.js";
import { canonicalizeFacadeInputSignerFields } from "../client/signer-identity.js";
import { encodeListingName, encodeListingTags } from "../values/index.js";
import {
  snapshotFixedBytes,
  snapshotOptionalFixedBytes,
} from "../values/fixed-bytes.js";
import {
  snapshotOptionOrNullable,
  snapshotOptionalAddress,
} from "../values/options.js";
import { snapshotDenseStructuredArray } from "../values/structured-clone.js";
import { assertCapability, type CapabilitySet } from "./surface.js";

export { findGoodPda, findSaleReceiptPda };

/** The all-zero address: a `GoodsListing` with `operator === NO_OPERATOR` has
 * no operator fee leg. Mirrors the on-chain `Pubkey::default()` sentinel. */
export const NO_OPERATOR = address("11111111111111111111111111111111");

/**
 * Approximate lamports a buyer pays to rent-exempt a `SaleReceipt` account, ON
 * TOP of the price + fees (the receipt is buyer-funded and permanent in v1).
 * Surface this in a purchase preview so cheap goods aren't silently
 * rent-dominated. (Exact rent = `getMinimumBalanceForRentExemption(account
 * size)` from the RPC; this is the current mainnet value for the struct size.)
 */
export const SALE_RECEIPT_RENT_LAMPORTS = 1_559_040n;

/** Every SOL fee-leg payee (seller wallet, treasury, operator) must already be
 * rent-exempt or the system transfer fails — the WP-B2 lesson. A client should
 * preflight the payees against this before prompting the wallet. */
export const MIN_RENT_EXEMPT_PAYEE_LAMPORTS = 890_880n;

/**
 * Friendly input for {@link createGoodsListing}. Identical to the generated
 * `CreateGoodsListingAsyncInput`, except `name`/`tags` accept EITHER the raw
 * on-chain byte form OR the string form (validated + encoded), and `operator`/
 * `operatorFeeBps` default to no-operator when omitted.
 */
export type CreateGoodsListingInput = Omit<
  CreateGoodsListingAsyncInput,
  "name" | "tags" | "operator" | "operatorFeeBps"
> & {
  name: CreateGoodsListingAsyncInput["name"] | string;
  tags: CreateGoodsListingAsyncInput["tags"] | readonly string[];
  /** Operator (store/embedder) payee. Omit for no operator leg. */
  operator?: Address;
  /** Operator fee in basis points. Omit (or 0) for no operator leg. */
  operatorFeeBps?: number;
};

const encName = (v: CreateGoodsListingInput["name"]) =>
  typeof v === "string"
    ? encodeListingName(v)
    : snapshotFixedBytes(v, 32, "createGoodsListing: name");
const encTags = (v: CreateGoodsListingInput["tags"]) =>
  Array.isArray(v)
    ? encodeListingTags(
        snapshotDenseStructuredArray(
          v as readonly string[],
          "createGoodsListing: tags",
          32,
        ),
      )
    : snapshotFixedBytes(v, 64, "createGoodsListing: tags");

/**
 * Build a `create_goods_listing` instruction (SELLER-signed). The `good` PDA
 * is auto-resolved from the seller and good ID. The required `moderationBlock`
 * must be the canonical BLOCK-floor PDA for `metadataHash`; the program verifies
 * that binding. Pass `surface` to fail fast if the cluster hasn't stamped the
 * batch-4 goods surface.
 */
export async function createGoodsListing(
  input: CreateGoodsListingInput,
  opts: { surface?: CapabilitySet } = {},
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const operator = stableInput.operator ?? NO_OPERATOR;
  const operatorFeeBps = stableInput.operatorFeeBps ?? 0;
  const generatedInput = {
    ...stableInput,
    goodId: snapshotFixedBytes(
      stableInput.goodId,
      32,
      "createGoodsListing: goodId",
    ),
    name: encName(stableInput.name),
    metadataHash: snapshotFixedBytes(
      stableInput.metadataHash,
      32,
      "createGoodsListing: metadataHash",
    ),
    priceMint: snapshotOptionalAddress(
      stableInput.priceMint,
      "createGoodsListing: priceMint",
    ),
    tags: encTags(stableInput.tags),
    operator,
    operatorFeeBps,
  } as CreateGoodsListingAsyncInput;
  if (opts.surface) assertCapability(opts.surface, "goods");
  return getCreateGoodsListingInstructionAsync(generatedInput);
}

/**
 * Build a `purchase_good` instruction (BUYER-signed, a bare wallet). The
 * `saleReceipt` PDA is auto-resolved from `good` + `expectedSerial`.
 *
 * IMPORTANT runtime contract for the caller (a purchase is one atomic sale):
 *  - `expectedSerial` MUST equal the listing's current `sold_count`; if a
 *    concurrent sale lands first the tx fails (`GoodsSerialStale` or a receipt
 *    init-collision) — re-read `sold_count`, rebuild the instruction, and retry
 *    with the new serial. Transport-level blockhash retries cannot repair a
 *    stale program argument.
 *  - `expectedPrice` is the slippage ceiling.
 *  - `expectedMetadataHash` pins the exact off-chain good description the buyer
 *    reviewed; a concurrent metadata swap fails before payment.
 *  - when the listing carries an operator leg you MUST pass `operatorWallet`
 *    (and, on the SPL rail, `operatorTokenAccount`) or the tx fails
 *    `MissingOperatorAccount`.
 *  - every SOL payee must be rent-exempt ({@link MIN_RENT_EXEMPT_PAYEE_LAMPORTS}).
 */
export type PurchaseGoodInput = PurchaseGoodAsyncInput;

export async function purchaseGood(
  input: PurchaseGoodInput,
  opts: { surface?: CapabilitySet } = {},
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const generatedInput = {
    ...stableInput,
    expectedMetadataHash: snapshotFixedBytes(
      stableInput.expectedMetadataHash,
      32,
      "purchaseGood: expectedMetadataHash",
    ),
  };
  if (opts.surface) assertCapability(opts.surface, "goods");
  return getPurchaseGoodInstructionAsync(generatedInput);
}

/**
 * Build a `update_goods_listing` instruction (SELLER-signed). Every field is
 * optional — omit to leave unchanged. Restock is `additionalSupply` (an
 * ADDITIVE delta; there is no absolute supply setter by design). `metadataHash`
 * + `metadataUri` must be updated together.
 */
export async function updateGoodsListing(
  input: UpdateGoodsListingAsyncInput,
  opts: { surface?: CapabilitySet } = {},
) {
  const stableInput = canonicalizeFacadeInputSignerFields(input, ["authority"]);
  const generatedInput = {
    ...stableInput,
    price: snapshotOptionOrNullable(
      stableInput.price,
      "updateGoodsListing: price",
    ),
    isActive: snapshotOptionOrNullable(
      stableInput.isActive,
      "updateGoodsListing: isActive",
    ),
    metadataHash: snapshotOptionalFixedBytes(
      stableInput.metadataHash,
      32,
      "updateGoodsListing: metadataHash",
    ),
    metadataUri: snapshotOptionOrNullable(
      stableInput.metadataUri,
      "updateGoodsListing: metadataUri",
    ),
    tags: snapshotOptionalFixedBytes(
      stableInput.tags,
      64,
      "updateGoodsListing: tags",
    ),
    additionalSupply: snapshotOptionOrNullable(
      stableInput.additionalSupply,
      "updateGoodsListing: additionalSupply",
    ),
    operator: snapshotOptionalAddress(
      stableInput.operator,
      "updateGoodsListing: operator",
    ),
    operatorFeeBps: snapshotOptionOrNullable(
      stableInput.operatorFeeBps,
      "updateGoodsListing: operatorFeeBps",
    ),
  };
  if (opts.surface) assertCapability(opts.surface, "goods");
  return getUpdateGoodsListingInstructionAsync(generatedInput);
}

/** The BLOCK-floor account a create/purchase must pass for a metadata hash. */
export async function goodsModerationBlockPda(metadataHash: Uint8Array) {
  return findModerationBlockPda({
    contentHash: snapshotFixedBytes(
      metadataHash,
      32,
      "goodsModerationBlockPda: metadataHash",
    ),
  });
}
