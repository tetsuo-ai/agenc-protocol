/**
 * `<ReviewPanel>` — buyer-side settlement actions (accept / reject / request
 * changes) for a submitted task.
 *
 * Presentational: it takes the three action handlers and a status/error (map
 * from `useSubmissionReview()`), plus a `hasSubmission` flag that gates the
 * actions until the worker has submitted. Each action is a real, keyboard-
 * accessible button; the panel announces the settled outcome in a live region.
 *
 * The destructive verbs (reject, request changes) are visually distinguished
 * but never hidden behind a confirm of their own — the host decides whether to
 * wrap them; the panel keeps them clearly labelled and reversible-where-the-
 * protocol-allows (request changes returns the task to the worker).
 *
 * @module components/ReviewPanel
 */
import type { ReactNode } from "react";
import type { ReviewStatus } from "../hooks/useSubmissionReview.js";
import { tc } from "./format.js";
import {
  Button,
  StateMessage,
  rootClass,
  type ThemableProps,
} from "./primitives.js";

/** Props for {@link ReviewPanel}. */
export interface ReviewPanelProps extends ThemableProps {
  /** Whether the worker has submitted a result to review. */
  hasSubmission?: boolean;
  /** Accept handler (`useSubmissionReview().accept`-bound by the host). */
  onAccept?: () => void;
  /** Reject handler. */
  onReject?: () => void;
  /** Request-changes handler. */
  onRequestChanges?: () => void;
  /** Current action status (from `useSubmissionReview().status`). */
  status?: ReviewStatus;
  /** The action error to surface. */
  error?: Error | null;
  /**
   * Which verb most recently settled, for the success copy. Optional; when
   * given and `status === "success"` the matching message renders.
   */
  settledAction?: "accept" | "reject" | "requestChanges";
}

const SUCCESS_STRING: Record<
  NonNullable<ReviewPanelProps["settledAction"]>,
  string
> = {
  accept: "components.review.accepted",
  reject: "components.review.rejected",
  requestChanges: "components.review.changesRequested",
};

/**
 * The accept / reject / request-changes review panel.
 */
export function ReviewPanel({
  hasSubmission = false,
  onAccept,
  onReject,
  onRequestChanges,
  status = "idle",
  error = null,
  settledAction,
  unstyled,
  className,
}: ReviewPanelProps): ReactNode {
  const panelClass = rootClass("agenc-review", unstyled, className);
  const pending = status === "pending";
  const success = status === "success";

  return (
    <section
      className={panelClass}
      aria-label={tc("components.review.title")}
    >
      <h3 className={unstyled ? undefined : "agenc-review__title"}>
        {tc("components.review.title")}
      </h3>

      {!hasSubmission ? (
        <StateMessage
          kind="empty"
          message={tc("components.review.noSubmission")}
          unstyled={unstyled}
        />
      ) : (
        <div className={unstyled ? undefined : "agenc-review__actions"}>
          <Button
            unstyled={unstyled}
            variant="primary"
            loading={pending}
            disabled={pending || !onAccept}
            onClick={onAccept}
          >
            {tc("components.review.accept")}
          </Button>
          <Button
            unstyled={unstyled}
            variant="secondary"
            disabled={pending || !onRequestChanges}
            onClick={onRequestChanges}
          >
            {tc("components.review.requestChanges")}
          </Button>
          <Button
            unstyled={unstyled}
            variant="danger"
            disabled={pending || !onReject}
            onClick={onReject}
          >
            {tc("components.review.reject")}
          </Button>
        </div>
      )}

      <div
        className={unstyled ? undefined : "agenc-review__status"}
        role="status"
        aria-live="polite"
      >
        {pending ? tc("components.review.pending") : null}
        {success && settledAction ? tc(SUCCESS_STRING[settledAction]) : null}
      </div>

      {error ? (
        <div
          className={unstyled ? undefined : "agenc-review__error"}
          role="alert"
          aria-live="assertive"
        >
          <strong>{tc("components.review.errorTitle")}</strong>
          <span>{error.message}</span>
        </div>
      ) : null}
    </section>
  );
}
