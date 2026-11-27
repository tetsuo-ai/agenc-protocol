// Market charges both basis-point shares on the gross reward, rounding each down.
import { WalletError } from "./errors.js";

export interface ServiceEconomicsInput {
  priceLamports: bigint;
  marketFeeBps: number | null;
  operatorFeeBps: number;
  referrerFeeBps?: number;
  usdPerSol: number | null;
  minimumMarginCents?: number;
  modelCapCents?: number;
}

export function serviceEconomics(input: ServiceEconomicsInput) {
  const { usdPerSol, marketFeeBps, operatorFeeBps, priceLamports } = input;
  if (usdPerSol === null || !Number.isFinite(usdPerSol) || usdPerSol <= 0 || marketFeeBps === null)
    throw new WalletError("NETWORK", "A current dollar price and marketplace fee are needed before funding this service.");
  const referrer = input.referrerFeeBps ?? 0;
  const margin = input.minimumMarginCents ?? 0;
  const cap = input.modelCapCents ?? Number.MAX_SAFE_INTEGER;
  if (![margin, cap, marketFeeBps, operatorFeeBps, referrer].every(Number.isSafeInteger) ||
      margin < 0 || cap < 1 || margin >= Number.MAX_SAFE_INTEGER || priceLamports <= 0n ||
      marketFeeBps < 0 || operatorFeeBps < 0 || referrer < 0 || marketFeeBps + operatorFeeBps + referrer >= 10000)
    throw new WalletError("BAD_REQUEST", "Invalid service price, fees or model budget.");

  // Use the feed's decimal value without float arithmetic at a cent boundary.
  const [digits, exponent = "0"] = String(usdPerSol).split("e");
  const [whole, fraction = ""] = digits!.split(".");
  const places = fraction.length - Number(exponent);
  const rate = BigInt(whole + fraction) * 10n ** BigInt(Math.max(-places, 0));
  const divisor = 10_000_000n * 10n ** BigInt(Math.max(places, 0));
  const target = ((BigInt(margin) + 1n) * divisor + rate - 1n) / rate;
  const fees = BigInt(marketFeeBps + operatorFeeBps + referrer);
  const net = (price: bigint) => price - price * BigInt(marketFeeBps) / 10000n - price * BigInt(operatorFeeBps) / 10000n - price * BigInt(referrer) / 10000n;
  // The two independent rounding points can coincide and drop net by a lamport.
  // Find the first acceptable price near the exact continuous bound, then
  // always check the actual net of the price offered.
  let minimumPriceLamports = target > 3n ? (target - 3n) * 10000n / (10000n - fees) : 1n;
  while (net(minimumPriceLamports) < target) minimumPriceLamports++;
  const sellerNetLamports = net(priceLamports);
  if (sellerNetLamports < target)
    throw Object.assign(new WalletError("BAD_REQUEST", `This price leaves less than one cent for the job after fees and margin. The minimum is ${minimumPriceLamports} lamports at the current rate.`), { name: "ExecutorBudgetError" });
  const available = sellerNetLamports * rate / divisor - BigInt(margin);
  return { minimumPriceLamports, sellerNetLamports, modelBudgetCents: Number(available < BigInt(cap) ? available : BigInt(cap)) };
}

/** Accept the C3 quote as returned by the wallet. The existing quote guard
 * binds version and recipient. Here an inconsistent split cannot fund a job. */
export function admitQuotedService(quote: {
  listingVersion: string; operator: string | null; operatorFeeBps: number; marketplaceFeeBps: number;
  price: { lamports: string }; minimumSellerNet: { lamports: string }; operatorFee: { lamports: string };
}, usdPerSol: number | null, limits: { minimumMarginCents?: number; modelCapCents?: number } = {}) {
  const price = BigInt(quote.price.lamports);
  const result = serviceEconomics({ ...limits, usdPerSol, priceLamports: price,
    marketFeeBps: quote.marketplaceFeeBps, operatorFeeBps: quote.operatorFeeBps });
  if (!quote.listingVersion || (quote.operatorFeeBps > 0 && !quote.operator) ||
      BigInt(quote.operatorFee.lamports) !== price * BigInt(quote.operatorFeeBps) / 10000n ||
      BigInt(quote.minimumSellerNet.lamports) !== result.sellerNetLamports)
    throw new WalletError("PRICE_CHANGED", "The listing payout changed. Review a fresh quote.");
  return result;
}
