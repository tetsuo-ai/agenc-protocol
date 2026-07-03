/**
 * Minimal English string catalog + a `t(id, vars?)` resolver.
 *
 * Every user-facing string in this package and its downstream hooks/components
 * routes through this module so a future `{ locale }` can resolve translations
 * **without an API break** (PLAN_2 Part A design constraint). v1 ships English
 * only; the resolver signature is already locale-shaped.
 *
 * ## Why a catalog and not inline literals
 *
 * Components published to third parties cannot assume the host's language. By
 * keying every literal here:
 * - adding a locale is a data change (a new {@link StringCatalog}), not a code
 *   change to every component;
 * - the message ids are a stable contract the components agent binds to;
 * - `{var}` interpolation is centralized and SSR-safe (pure string ops, no
 *   `Intl` global assumptions at module scope).
 *
 * @module strings
 */

/**
 * The catalog shape: every message id maps to an English template. `{name}`
 * placeholders are filled by {@link t} from the `vars` argument.
 */
export interface StringCatalog {
  readonly [id: string]: string;
}

/**
 * Default English catalog. Keep ids namespaced by surface
 * (`provider.*`, `referrer.*`, `transport.*`, `hire.*`, ...) so the components
 * agent can extend it without collisions.
 */
export const EN_STRINGS = {
  // Provider / context wiring errors (developer-facing, but routed for parity).
  "provider.missingContext":
    "useAgencContext must be used within <AgencProvider>.",
  "provider.missingWriteClient":
    "No write client is configured. Pass config.client, or config.rpcUrl + config.signer, to <AgencProvider> before using a mutating hook.",
  "provider.missingSigner":
    "No signer is configured on <AgencProvider>. Connect a wallet or pass config.signer.",

  // Referrer config validation / capability surface.
  "referrer.invalidWallet":
    "Referrer wallet is not a valid base58 Solana address: {wallet}.",
  "referrer.invalidFeeBps":
    "Referrer feeBps must be an integer between {min} and {max} (basis points); got {feeBps}.",
  "referrer.notLive":
    "Referral fee is not active for this hire.",
  "referrer.notLiveReason":
    "No referrer is configured for this provider.",
  "referrer.earningsNotLiveReason":
    "Referral settlement is live, but no earnings endpoint is available on this network (configure indexer.baseUrl).",
  "referrer.earningsFetchFailed":
    "The referrer earnings endpoint could not be read.",

  // Read transport.
  "transport.noReadSource":
    "No read source is configured. Pass an indexer baseUrl, an rpc/queryTransport, to <AgencProvider> or createReadTransport().",

  // Generic loading / empty / error states (components extend these).
  "state.loading": "Loading…",
  "state.empty": "Nothing to show yet.",
  "state.error": "Something went wrong.",

  // Hire flow shells (components fill out the rest).
  "hire.cta": "Hire",
  "hire.pending": "Confirming…",
  "hire.funded": "Escrow funded.",
} as const satisfies StringCatalog;

/** A message id present in the default English catalog. */
export type StringId = keyof typeof EN_STRINGS;

/** Interpolation variables for {@link t}: `{name}` → `vars.name`. */
export type StringVars = Record<string, string | number | bigint>;

/**
 * Options for {@link t}. `locale` is accepted today (English-only) so adding
 * real locales later does not break the call signature; `catalog` lets a host
 * inject an override/extension catalog.
 */
export interface TranslateOptions {
  /** BCP-47 locale tag. v1 resolves everything to English regardless. */
  locale?: string;
  /** Override catalog (e.g. a future locale, or host-supplied copy). */
  catalog?: StringCatalog;
}

/**
 * Resolve a message id to its localized string with `{var}` interpolation.
 *
 * Unknown ids and unmatched placeholders are returned verbatim (the id itself,
 * or the `{placeholder}` left intact) rather than throwing — a missing string
 * must never crash a money-handling UI.
 *
 * @param id - The message id (a {@link StringId}, or any string for host
 *   catalogs).
 * @param vars - Values for `{name}` placeholders in the template.
 * @param options - Optional `locale` (forward-compatible) and `catalog`
 *   override.
 * @returns The interpolated string.
 *
 * @example
 * ```ts
 * t("referrer.invalidFeeBps", { min: 0, max: 10000, feeBps: 99999 });
 * // -> "Referrer feeBps must be an integer between 0 and 10000 ...; got 99999."
 * ```
 */
export function t(
  id: StringId | (string & {}),
  vars?: StringVars,
  options?: TranslateOptions,
): string {
  const catalog: StringCatalog = options?.catalog ?? EN_STRINGS;
  const template = catalog[id] ?? id;
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}
