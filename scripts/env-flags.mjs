/**
 * Parse one fail-closed binary environment flag.
 *
 * Unset means false. Explicit `0`/`1` are the only accepted strings; empty,
 * boolean words, whitespace, and every other value are operator errors.
 */
export function parseBinaryEnvFlag(env, name) {
  const raw = env[name];
  if (raw === undefined) return false;
  if (raw === "0") return false;
  if (raw === "1") return true;
  throw new TypeError(`${name} must be unset, "0", or "1"; received ${JSON.stringify(raw)}`);
}
