// Amounts are in fortieths of a microdollar. Keep integer rates on both sides of admission.
export const CODEX_PRICE = { cent: 400_000, input: 30, cached: 3, output: 180 };
export const CODEX_CAP = { tokens: 1_000_000, calls: 64, input: 272_000, output: 128_000 };
export const CODEX_ENVELOPE_BYTES = 4096;
export const CODEX_MIN_OUTPUT = 16;

export function codexInputBound(bytes: number): number {
  return Math.min(CODEX_CAP.input, Math.ceil(bytes * 1.1) + 64);
}

export function codexMinimum(plan: boolean, promptBytes: number, file: boolean) {
  const calls = file ? 2 : 1;
  const firstBytes = promptBytes + CODEX_ENVELOPE_BYTES;
  const input = plan ? calls * CODEX_CAP.input :
    codexInputBound(firstBytes) + (file ? codexInputBound(firstBytes + CODEX_ENVELOPE_BYTES) : 0);
  const output = calls * (plan ? CODEX_CAP.output : CODEX_MIN_OUTPUT);
  return { calls, tokens: input + output, units: input * CODEX_PRICE.input + output * CODEX_PRICE.output };
}
