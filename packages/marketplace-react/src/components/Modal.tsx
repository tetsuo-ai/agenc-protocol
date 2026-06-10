/**
 * `<Modal>` — the accessible dialog primitive the checkout flow is built on.
 *
 * Accessibility is STRUCTURAL here (PLAN_2 A3): this is the surface a
 * money-handling modal published to third parties renders into, so it ships
 * with:
 * - `role="dialog"` + `aria-modal="true"` + a labelled title
 *   (`aria-labelledby`) and optional description (`aria-describedby`);
 * - a focus trap (initial focus in, Tab cycling, focus restore on close) via
 *   {@link useFocusTrap};
 * - Escape-to-close and overlay-click-to-close (both opt-out-able);
 * - a real `<button>` close affordance with an accessible name.
 *
 * SSR-safe: renders nothing while closed; all `document` access is inside the
 * focus-trap effect. No portal is used (a portal needs `document.body`, which
 * SSR lacks) — the dialog renders inline in the React tree behind a fixed
 * overlay, which keeps it hydration-safe. Hosts that need a body portal can
 * wrap it themselves on the client.
 *
 * @module components/Modal
 */
import { useId, useRef, type ReactNode } from "react";
import { tc } from "./format.js";
import { rootClass, type ThemableProps } from "./primitives.js";
import { useFocusTrap } from "./useFocusTrap.js";

/** Props for {@link Modal}. */
export interface ModalProps extends ThemableProps {
  /** Whether the dialog is open. Renders nothing when false. */
  open: boolean;
  /** Called to request a close (Escape, overlay click, close button). */
  onClose: () => void;
  /** The dialog title (becomes the `aria-labelledby` target). */
  title: ReactNode;
  /** Dialog body. */
  children: ReactNode;
  /** Optional footer (actions). */
  footer?: ReactNode;
  /** Disable Escape-to-close (e.g. mid-transaction). Default false. */
  disableEscapeClose?: boolean;
  /** Disable overlay-click-to-close. Default false. */
  disableOverlayClose?: boolean;
  /** Hide the close (X) button (e.g. a forced confirmation step). Default false. */
  hideCloseButton?: boolean;
  /** Accessible label for the close button. */
  closeLabel?: string;
}

/**
 * An accessible modal dialog.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  disableEscapeClose = false,
  disableOverlayClose = false,
  hideCloseButton = false,
  closeLabel,
  unstyled,
  className,
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useFocusTrap(dialogRef, open, () => {
    if (!disableEscapeClose) onClose();
  });

  if (!open) return null;

  const overlayClass = rootClass("agenc-modal", unstyled, className);

  return (
    <div
      className={overlayClass}
      // The overlay. Clicking it (not the dialog) requests close.
      onMouseDown={(event) => {
        if (disableOverlayClose) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={unstyled ? undefined : "agenc-modal__dialog"}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <header className={unstyled ? undefined : "agenc-modal__header"}>
          <h2 id={titleId} className={unstyled ? undefined : "agenc-modal__title"}>
            {title}
          </h2>
          {hideCloseButton ? null : (
            <button
              type="button"
              className={unstyled ? undefined : "agenc-modal__close"}
              aria-label={closeLabel ?? tc("components.common.close")}
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </header>
        <div id={bodyId} className={unstyled ? undefined : "agenc-modal__body"}>
          {children}
        </div>
        {footer ? (
          <footer className={unstyled ? undefined : "agenc-modal__footer"}>
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
