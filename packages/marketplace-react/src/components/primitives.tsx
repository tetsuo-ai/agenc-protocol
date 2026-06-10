/**
 * Shared presentational primitives for the prebuilt components.
 *
 * These are the small, themable building blocks every higher-level component
 * (ListingCard, HireCheckoutModal, ...) composes: a class-name joiner, a
 * loading spinner, the canonical loading/empty/error state block, a status
 * badge, and a button. They emit ONLY `--agenc-*`-driven class names (no
 * CSS-in-JS), honor the `unstyled` white-label contract, and route every
 * literal through {@link tc}.
 *
 * SSR-safe: pure render functions, no `window`/`document` at module scope.
 *
 * @module components/primitives
 */
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import { AGENC_THEME_CLASS } from "../theme/index.js";
import { tc } from "./format.js";

/** Join truthy class names with a single space. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}

/**
 * Resolve the className a styled element should carry: when `unstyled`, only
 * the caller's `extra` survives (white-label); otherwise the base `agenc-*`
 * class plus `extra`.
 */
export function elementClass(
  base: string,
  unstyled: boolean | undefined,
  extra?: string,
): string | undefined {
  if (unstyled) return extra && extra.trim() !== "" ? extra : undefined;
  return cx(base, extra) || undefined;
}

/**
 * Resolve a COMPONENT ROOT className. Like {@link elementClass} but, when
 * styled, ALSO prepends the {@link AGENC_THEME_CLASS} scope (`"agenc"`) so the
 * `--agenc-*` tokens resolve even when the token sheet is scoped rather than
 * global. When `unstyled`, ONLY the caller's `extra` survives — neither the
 * scope class nor the component base class is emitted (true white-label).
 *
 * Use this for the outermost element of every prebuilt component; use
 * {@link elementClass} for inner elements (which inherit the scope from the
 * root and so don't repeat it).
 */
export function rootClass(
  base: string,
  unstyled: boolean | undefined,
  extra?: string,
): string | undefined {
  if (unstyled) return extra && extra.trim() !== "" ? extra : undefined;
  return cx(AGENC_THEME_CLASS, base, extra) || undefined;
}

/** Common props every prebuilt component accepts. */
export interface ThemableProps {
  /** White-label mode: emit semantic markup + ARIA but no default theme class. */
  unstyled?: boolean;
  /** Extra class name appended to the component root. */
  className?: string;
}

/** Variants the loading/empty/error block renders. */
export type StateKind = "loading" | "empty" | "error";

/** Props for {@link StateMessage}. */
export interface StateMessageProps extends ThemableProps {
  /** Which state to render. */
  kind: StateKind;
  /** Override message (defaults to the catalog string for `kind`). */
  message?: string;
  /** Optional retry handler (renders a Retry button for `error`/`empty`). */
  onRetry?: () => void;
  /** Accessible role override. Defaults: `status` (loading) / `alert` (error). */
  role?: HTMLAttributes<HTMLDivElement>["role"];
}

const STATE_STRING: Record<StateKind, string> = {
  loading: "components.common.loading",
  empty: "components.common.empty",
  error: "components.common.error",
};

/**
 * The canonical loading / empty / error block. Every read component renders
 * this for its non-data states so screen readers get a consistent, polite
 * announcement (`role="status"` for loading, `role="alert"` for error).
 */
export function StateMessage({
  kind,
  message,
  onRetry,
  role,
  unstyled,
  className,
}: StateMessageProps): ReactNode {
  const text = message ?? tc(STATE_STRING[kind]);
  const resolvedRole = role ?? (kind === "error" ? "alert" : "status");
  return (
    <div
      className={elementClass(`agenc-state agenc-state--${kind}`, unstyled, className)}
      role={resolvedRole}
      aria-live={kind === "error" ? "assertive" : "polite"}
      aria-busy={kind === "loading" ? true : undefined}
    >
      {kind === "loading" ? <Spinner unstyled={unstyled} /> : null}
      <span className={unstyled ? undefined : "agenc-state__text"}>{text}</span>
      {onRetry && kind !== "loading" ? (
        <Button unstyled={unstyled} variant="ghost" onClick={onRetry}>
          {tc("components.common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

/** Props for {@link Spinner}. */
export interface SpinnerProps extends ThemableProps {
  /** Accessible label (default "Loading…"). */
  label?: string;
}

/**
 * An accessible, CSS-animated spinner. `role="status"` + visually-hidden label
 * so a screen reader announces the loading state with no visible text.
 */
export function Spinner({ label, unstyled, className }: SpinnerProps): ReactNode {
  return (
    <span
      className={elementClass("agenc-spinner", unstyled, className)}
      role="status"
      aria-live="polite"
    >
      <span className={unstyled ? undefined : "agenc-visually-hidden"}>
        {label ?? tc("components.common.loading")}
      </span>
    </span>
  );
}

/** Visual intent of a {@link Badge}. */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Props for {@link Badge}. */
export interface BadgeProps extends ThemableProps {
  /** Color intent. */
  tone?: BadgeTone;
  /** Badge content. */
  children: ReactNode;
  /**
   * Optional `title`/`aria-label` for an icon-only or abbreviated badge so it
   * carries an accessible name.
   */
  label?: string;
}

/**
 * A small status pill (verified / moderation / state). Themable via
 * `--agenc-*`; tone maps to a semantic color token.
 */
export function Badge({
  tone = "neutral",
  children,
  label,
  unstyled,
  className,
}: BadgeProps): ReactNode {
  return (
    <span
      className={elementClass(
        `agenc-badge agenc-badge--${tone}`,
        unstyled,
        className,
      )}
      title={label}
      aria-label={label}
    >
      {children}
    </span>
  );
}

/** Visual variant of a {@link Button}. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Props for {@link Button}. */
export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    ThemableProps {
  /** Visual variant. */
  variant?: ButtonVariant;
  /** Show a spinner + disable while a related action is in flight. */
  loading?: boolean;
}

/**
 * A themable, accessible button. Always a real `<button type="button">` (the
 * default) so keyboard + screen-reader semantics are correct; `loading`
 * disables it and shows an inline spinner with an accessible busy state.
 */
export function Button({
  variant = "primary",
  loading = false,
  unstyled,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type ?? "button"}
      className={elementClass(
        `agenc-button agenc-button--${variant}`,
        unstyled,
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner unstyled={unstyled} /> : null}
      <span className={unstyled ? undefined : "agenc-button__label"}>
        {children}
      </span>
    </button>
  );
}
