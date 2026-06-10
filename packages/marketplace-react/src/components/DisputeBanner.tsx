/**
 * `<DisputeBanner>` — surfaces a task's dispute state + the entry point to open
 * one.
 *
 * Two modes, driven by `disputeOpen`:
 * - OPEN: a prominent `role="alert"` banner explaining funds stay in escrow
 *   until a protocol resolver decides (matches the assignable single-resolver
 *   model — no voting copy);
 * - NONE: an optional "Open a dispute" affordance (rendered only when
 *   `onInitiate` is provided), with pending/opened/error states.
 *
 * Presentational: it takes `disputeOpen` + the initiate handler/status/error
 * (map from `useDispute()`), so it renders under SSR and in Ladle.
 *
 * @module components/DisputeBanner
 */
import type { ReactNode } from "react";
import type { DisputeStatus } from "../hooks/useDispute.js";
import { tc } from "./format.js";
import { Button, cx, rootClass, type ThemableProps } from "./primitives.js";

/** Props for {@link DisputeBanner}. */
export interface DisputeBannerProps extends ThemableProps {
  /** Whether a dispute is currently open on the task. */
  disputeOpen?: boolean;
  /**
   * Open-a-dispute handler (`useDispute().initiate`-bound by the host). When
   * omitted, the no-dispute state renders informationally with no action.
   */
  onInitiate?: () => void;
  /** Initiate-mutation status (from `useDispute().status`). */
  status?: DisputeStatus;
  /** The initiate error to surface. */
  error?: Error | null;
}

/**
 * The dispute banner / entry point.
 */
export function DisputeBanner({
  disputeOpen = false,
  onInitiate,
  status = "idle",
  error = null,
  unstyled,
  className,
}: DisputeBannerProps): ReactNode {
  const bannerClass = rootClass(
    cx(
      "agenc-dispute",
      disputeOpen ? "agenc-dispute--open" : "agenc-dispute--none",
    ),
    unstyled,
    className,
  );
  const pending = status === "pending";
  const opened = status === "success";

  if (disputeOpen) {
    return (
      <div className={bannerClass} role="alert">
        <strong className={unstyled ? undefined : "agenc-dispute__title"}>
          {tc("components.dispute.title")}
        </strong>
        <p className={unstyled ? undefined : "agenc-dispute__body"}>
          {tc("components.dispute.body")}
        </p>
      </div>
    );
  }

  // No open dispute. Render the action only when a handler is provided.
  return (
    <div className={bannerClass} role="region" aria-label={tc("components.dispute.none")}>
      <p className={unstyled ? undefined : "agenc-dispute__none"}>
        {tc("components.dispute.none")}
      </p>
      {onInitiate ? (
        <Button
          unstyled={unstyled}
          variant="secondary"
          loading={pending}
          disabled={pending}
          onClick={onInitiate}
        >
          {pending
            ? tc("components.dispute.pending")
            : tc("components.dispute.initiate")}
        </Button>
      ) : null}
      <div
        className={unstyled ? undefined : "agenc-dispute__status"}
        role="status"
        aria-live="polite"
      >
        {opened ? tc("components.dispute.opened") : null}
      </div>
      {error ? (
        <div
          className={unstyled ? undefined : "agenc-dispute__error"}
          role="alert"
          aria-live="assertive"
        >
          <strong>{tc("components.dispute.errorTitle")}</strong>
          <span>{error.message}</span>
        </div>
      ) : null}
    </div>
  );
}
