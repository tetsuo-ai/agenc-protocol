/**
 * AgenC theme — the `--agenc-*` CSS custom-property contract.
 *
 * ## How theming works (no CSS-in-JS runtime)
 *
 * Every prebuilt component (shipped by the components agent) styles itself
 * **only** through CSS custom properties named `--agenc-*` (e.g.
 * `--agenc-violet`, `--agenc-surface`, `--agenc-radius`). They are declared in
 * the vendored {@link AGENC_TOKENS_CSS_PATH} stylesheet under `:root, .agenc`.
 * To restyle, override any of those variables on an ancestor element — no
 * recompile, no Tailwind, no JS.
 *
 * ## Three ways to load the tokens
 *
 * 1. **Side-effect CSS import** (recommended for bundler apps):
 *    ```ts
 *    import "@tetsuo-ai/marketplace-react/theme.css";
 *    ```
 *    Pulls in the full vendored token sheet as a side effect. This is the only
 *    CSS this package ships, and it is fully optional: headless hook usage
 *    needs no CSS at all.
 *
 * 2. **`<link>` / framework asset pipeline:** point at the resolved package
 *    path `@tetsuo-ai/marketplace-react/theme.css`.
 *
 * 3. **Inline injection** via {@link agencThemeStyleTag} — returns the token
 *    CSS as a string you can drop into a `<style>` tag (handy for the embed
 *    widget / iframe where a separate stylesheet request is undesirable).
 *    NOTE: this returns only the small base token set, not the full vendored
 *    sheet; prefer (1) or (2) for the canonical theme.
 *
 * ## The `unstyled` escape hatch (white-label)
 *
 * Per PLAN_2 A3, every prebuilt component accepts an `unstyled` prop. When set,
 * the component renders semantic markup and ARIA wiring but emits **none** of
 * the default `--agenc-*`-driven classes, so a host app can style it from
 * scratch. This module owns the convention so components stay consistent:
 * - the default class root is {@link AGENC_THEME_CLASS} (`"agenc"`), the scope
 *   under which `--agenc-*` tokens are defined;
 * - {@link resolveThemeClassName} returns `undefined` when `unstyled` is true,
 *   so a component can spread it onto its root without branching.
 *
 * @module theme
 */

/**
 * The root class scope under which the vendored sheet declares `--agenc-*`
 * tokens (`:root, .agenc`). Components default their outermost element to this
 * class so the tokens resolve even when the sheet is scoped rather than global.
 */
export const AGENC_THEME_CLASS = "agenc";

/**
 * Package-relative specifier for the vendored token stylesheet, exposed for
 * documentation/tooling. Import it for its side effect via the package's
 * `./theme.css` export: `import "@tetsuo-ai/marketplace-react/theme.css"`.
 */
export const AGENC_TOKENS_CSS_PATH = "@tetsuo-ai/marketplace-react/theme.css";

/**
 * Resolve the class name a themable component should put on its root element.
 *
 * @param unstyled - When true (white-label mode), returns `undefined` so the
 *   component emits no default theme class.
 * @param extra - An optional caller-supplied `className` to append.
 * @returns The composed class string, or `undefined` when there is nothing to
 *   apply.
 */
export function resolveThemeClassName(
  unstyled?: boolean,
  extra?: string,
): string | undefined {
  if (unstyled) {
    return extra && extra.trim() !== "" ? extra : undefined;
  }
  const composed = [AGENC_THEME_CLASS, extra]
    .filter((part): part is string => Boolean(part && part.trim() !== ""))
    .join(" ");
  return composed === "" ? undefined : composed;
}

/**
 * The minimal base `--agenc-*` token set as inline CSS text, for the embed /
 * iframe surface where a separate stylesheet request is undesirable. This is a
 * SUBSET of the full vendored sheet (the most load-bearing surface, brand,
 * text, semantic, and radius tokens) — for the canonical, complete theme
 * import `@tetsuo-ai/marketplace-react/theme.css` instead.
 *
 * SSR-safe: returns a string and never touches `document`. The caller decides
 * how to inject it (a `<style>` element, a `dangerouslySetInnerHTML`, etc.).
 */
export function agencThemeStyleTag(): string {
  return `:root,.${AGENC_THEME_CLASS}{--agenc-void:#0A0612;--agenc-surface:#16102A;--agenc-surface-2:#221638;--agenc-surface-3:#2E1A4A;--agenc-violet:#7B3FFF;--agenc-magenta:#FF2E93;--agenc-orange:#FF6B1A;--agenc-cyan:#48C8EF;--agenc-text:#F5F0FF;--agenc-text-muted:#B8A8D9;--agenc-text-dim:#6E5C8F;--agenc-success:#3FFFA0;--agenc-warning:#FFC53F;--agenc-danger:#FF3D3D;--agenc-border:#2E1A4A;--agenc-border-strong:#4A2E7A;--agenc-radius-sm:4px;--agenc-radius:8px;--agenc-radius-lg:12px;--agenc-radius-pill:9999px;}`;
}
