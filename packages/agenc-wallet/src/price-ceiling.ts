/** An exact integer ratio of the decimal value on the JSON wire. */
function decimal(value: number): [bigint, bigint] {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const places = fraction.length - Number(exponent);
  const digits = BigInt(whole! + fraction);
  return places >= 0 ? [digits, 10n ** BigInt(places)] : [digits * 10n ** BigInt(-places), 1n];
}

/** A buyer's price ceiling always rounds down, including fractions of a cent. */
export function priceCeiling(cents: number, usdPerSol: number): bigint {
  if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(usdPerSol) || usdPerSol <= 0) return 0n;
  const [amount, scale] = decimal(cents);
  const [rate, rateScale] = decimal(usdPerSol);
  return amount * 10_000_000n * rateScale / (scale * rate);
}
