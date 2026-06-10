/**
 * `<PoweredByAgenC>` — an optional attribution badge linking a trust page.
 *
 * A small, themable "Powered by AgenC" mark embedders can drop into a
 * storefront footer / checkout to link buyers to an explanation of the escrow +
 * moderation trust stack. Optional and fully white-labelable.
 *
 * SSR-safe; the link is a plain anchor (`rel="noopener noreferrer"` for safety
 * when it opens in a new tab). The `href` is scheme-validated (http/https/
 * mailto only; `javascript:`/`data:` fall back to the default trust href) so an
 * embedder wiring untrusted data into the prop cannot create a click-to-execute
 * XSS on a money surface.
 *
 * @module components/PoweredByAgenC
 */
import type { ReactNode } from "react";
import { tc } from "./format.js";
import { rootClass, type ThemableProps } from "./primitives.js";

/** The default trust page the badge links to. */
export const DEFAULT_TRUST_HREF = "https://agenc.tech/trust";

/** Schemes a trust link may safely use. Anything else (e.g. `javascript:`,
 * `data:`) is rejected and falls back to {@link DEFAULT_TRUST_HREF}. */
const SAFE_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Validate an embedder-supplied href. React does NOT block `javascript:` (or
 * `data:`) in an anchor href, so an embedder wiring untrusted data here would
 * create a click-to-execute XSS. Allow only http/https/mailto; fall back to the
 * safe default trust href otherwise. Scheme-relative (`//host`) and
 * path/relative URLs resolve against a dummy base and keep their (http/https)
 * scheme; anything that fails to parse falls back too.
 */
function safeHref(href: string): string {
  try {
    // Resolve against a base so relative/scheme-relative hrefs parse and adopt
    // a concrete (https) scheme rather than being rejected.
    const url = new URL(href, DEFAULT_TRUST_HREF);
    return SAFE_HREF_SCHEMES.has(url.protocol) ? href : DEFAULT_TRUST_HREF;
  } catch {
    return DEFAULT_TRUST_HREF;
  }
}

/** Props for {@link PoweredByAgenC}. */
export interface PoweredByAgenCProps extends ThemableProps {
  /** Trust-page URL. Defaults to {@link DEFAULT_TRUST_HREF}. */
  href?: string;
  /** Open the link in a new tab. Default true. */
  newTab?: boolean;
  /** Override the visible label. */
  label?: string;
}

/**
 * The "Powered by AgenC" attribution mark.
 */
export function PoweredByAgenC({
  href = DEFAULT_TRUST_HREF,
  newTab = true,
  label,
  unstyled,
  className,
}: PoweredByAgenCProps): ReactNode {
  const linkClass = rootClass("agenc-powered-by", unstyled, className);
  return (
    <a
      className={linkClass}
      href={safeHref(href)}
      target={newTab ? "_blank" : undefined}
      // noopener + noreferrer for new-tab links (defense-in-depth against
      // reverse-tabnabbing; noreferrer implies noopener in modern browsers).
      rel={newTab ? "noopener noreferrer" : undefined}
      // The link's accessible name combines the brand + the trust-link copy.
      aria-label={`${label ?? tc("components.poweredBy.label")} — ${tc(
        "components.poweredBy.trustLink",
      )}`}
    >
      <span className={unstyled ? undefined : "agenc-powered-by__label"}>
        {label ?? tc("components.poweredBy.label")}
      </span>
    </a>
  );
}
