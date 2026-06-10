/**
 * `<HireCheckoutModal>` — the embeddable money path (PLAN_2 A3).
 *
 * The accessible, themable checkout dialog: it shows the price, the moderation
 * attestation badge, the escrow-funding explanation, the referrer disclosure
 * (P6.2-gated), and walks the buyer through idle → confirming → funded /
 * error confirmation states.
 *
 * ## Accessibility (STRUCTURAL — this is published to third parties)
 *
 * Built on the accessible {@link Modal}: focus trap, Escape/overlay close
 * (auto-disabled while a hire is in flight so the buyer can't dismiss a pending
 * transaction), ARIA dialog roles, and live-region status announcements for
 * the confirming/funded/error transitions.
 *
 * ## The P6.2 referrer gate
 *
 * The disclosure renders when a `referrer` is configured, with the pending-
 * support copy until `referrerLive` is true (always false today). The modal
 * NEVER computes or claims a fee was charged — it discloses configured intent
 * only. Injection/earnings stay in the hooks, blocked on P6.2.
 *
 * ## Wiring
 *
 * Presentational by design: a host maps `useHire()` onto the props
 * (`status`/`error`/`taskPda`/`onConfirm`). The connected
 * {@link HireButton} shows the canonical wiring.
 *
 * @module components/HireCheckoutModal
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Address,
  IndexerListing,
  ServiceListing,
  ValidatedReferrerConfig,
} from "../types.js";
import type { HireStatus } from "../hooks/useHire.js";
import { formatPriceSol, tc } from "./format.js";
import { ModerationBadge } from "./badges.js";
import { Modal } from "./Modal.js";
import { ReferrerDisclosure } from "./ReferrerDisclosure.js";
import { Button } from "./primitives.js";

/** The listing being hired (decoded account + address). */
export interface HireCheckoutListing {
  /** The listing PDA. */
  address: Address;
  /** The decoded on-chain account (for price + name). */
  account: ServiceListing;
}

/** Props for {@link HireCheckoutModal}. */
export interface HireCheckoutModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Close request handler. */
  onClose: () => void;
  /** The listing under checkout. */
  listing: HireCheckoutListing;
  /**
   * Confirm handler — runs the actual hire (e.g. `() => hire({...})`). Resolves
   * when the hire settles; rejects with the typed `AgencError` to surface.
   */
  onConfirm: () => void | Promise<void>;
  /** Current hire status (map from `useHire().status`). Default "idle". */
  status?: HireStatus;
  /** The hire error to surface (map from `useHire().error`). */
  error?: Error | null;
  /** The minted Task PDA on success (map from `useHire().taskPda`). */
  taskPda?: Address | null;
  /** Optional handler when the buyer clicks "View task" after success. */
  onViewTask?: (taskPda: Address) => void;
  /** Indexer projection for the moderation badge. */
  moderation?: IndexerListing | null;
  /**
   * Configured referrer (from provider context). When present the disclosure
   * renders. Pass `null`/omit when no referrer is configured.
   */
  referrer?: ValidatedReferrerConfig | null;
  /**
   * Whether referral settlement is live (P6.2). Always false today. Drives the
   * disclosure copy only; never implies a fee was charged.
   */
  referrerLive?: boolean;
  /** Whether a signer/wallet is connected (gates the confirm button). */
  connected?: boolean;
  /** White-label mode. */
  unstyled?: boolean;
  /** Extra root class. */
  className?: string;
}

/**
 * The hire checkout dialog.
 */
export function HireCheckoutModal({
  open,
  onClose,
  listing,
  onConfirm,
  status = "idle",
  error = null,
  taskPda = null,
  onViewTask,
  moderation,
  referrer,
  referrerLive = false,
  connected = true,
  unstyled,
  className,
}: HireCheckoutModalProps): ReactNode {
  const pending = status === "pending";
  const success = status === "success";
  const price = formatPriceSol(listing.account.price);

  // SYNCHRONOUS double-submit guard. The parent-controlled `status` prop does
  // NOT flip to "pending" within the same tick as the click, so two fast
  // clicks would otherwise fire `onConfirm` (a funded hire) twice. We latch
  // locally the instant the button is clicked — before awaiting — and clear it
  // only when the hire settles (resolve/reject), the modal closes, or the
  // parent reaches a terminal status. This is independent of `status` so the
  // first click immediately disables the button.
  const [submitting, setSubmitting] = useState(false);
  // A ref mirror so the click handler reads/sets the latch synchronously
  // (state updates are async; a second click in the same tick must see it set).
  const submittingRef = useRef(false);

  // Clear the latch when the modal closes so a re-open starts clean, and when
  // the parent settles to a terminal status (success/error/idle, i.e. not
  // pending) so a retry after an error is allowed. The local latch (set
  // synchronously on click) only needs to outlive the gap before the parent's
  // `status` flips to pending; once it has settled the parent drives the gate.
  useEffect(() => {
    if (!open || !pending) {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [open, pending]);

  const handleConfirm = useCallback(() => {
    // Already in flight (sync ref check) — drop the duplicate click.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    let result: void | Promise<void>;
    try {
      result = onConfirm();
    } catch {
      // Synchronous throw: release the latch so the buyer can retry.
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
    }
    // For a synchronous (void) onConfirm the parent drives `status`; the effect
    // above clears the latch when it reaches a terminal/closed state.
  }, [onConfirm]);

  // The button is disabled the instant a submit is in flight (local latch) OR
  // the parent reports pending — whichever fires first.
  const confirmDisabled = !connected || pending || submitting;

  // While a hire is in flight, lock the dialog so the buyer cannot dismiss a
  // pending on-chain transaction by mistake.
  const lockClose = pending || submitting;

  const footer = success ? (
    <>
      {taskPda && onViewTask ? (
        <Button
          unstyled={unstyled}
          variant="primary"
          onClick={() => onViewTask(taskPda)}
        >
          {tc("components.hire.viewTask")}
        </Button>
      ) : null}
      <Button unstyled={unstyled} variant="secondary" onClick={onClose}>
        {tc("components.common.close")}
      </Button>
    </>
  ) : (
    <>
      <Button
        unstyled={unstyled}
        variant="secondary"
        onClick={onClose}
        disabled={pending || submitting}
      >
        {tc("components.hire.cancel")}
      </Button>
      <Button
        unstyled={unstyled}
        variant="primary"
        loading={pending || submitting}
        disabled={confirmDisabled}
        onClick={handleConfirm}
      >
        {pending || submitting
          ? tc("components.hire.pending")
          : tc("components.hire.confirm")}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tc("components.hire.checkoutTitle")}
      footer={footer}
      disableEscapeClose={lockClose}
      disableOverlayClose={lockClose}
      hideCloseButton={lockClose}
      unstyled={unstyled}
      className={className}
    >
      <div className={unstyled ? undefined : "agenc-checkout"}>
        <div className={unstyled ? undefined : "agenc-checkout__row"}>
          <span className={unstyled ? undefined : "agenc-checkout__price-label"}>
            {tc("components.hire.priceLabel")}
          </span>
          <span className={unstyled ? undefined : "agenc-checkout__price"}>
            {price}
          </span>
        </div>

        <div className={unstyled ? undefined : "agenc-checkout__moderation"}>
          <ModerationBadge moderation={moderation} unstyled={unstyled} />
        </div>

        <p className={unstyled ? undefined : "agenc-checkout__escrow-note"}>
          {tc("components.hire.escrowNote")}
        </p>

        {referrer ? (
          <ReferrerDisclosure
            referrer={referrer}
            live={referrerLive}
            unstyled={unstyled}
          />
        ) : null}

        {/* Live-region status: announces confirming / funded / error. */}
        <div
          className={unstyled ? undefined : "agenc-checkout__status"}
          role="status"
          aria-live="polite"
        >
          {pending ? tc("components.hire.pending") : null}
          {success ? (
            <>
              <strong>{tc("components.hire.success")}</strong>{" "}
              {tc("components.hire.successDetail")}
            </>
          ) : null}
        </div>

        {error ? (
          <div
            className={unstyled ? undefined : "agenc-checkout__error"}
            role="alert"
            aria-live="assertive"
          >
            <strong>{tc("components.hire.errorTitle")}</strong>
            <span>{error.message}</span>
          </div>
        ) : null}

        {!connected && !success ? (
          <p className={unstyled ? undefined : "agenc-checkout__hint"}>
            {tc("components.hire.notConnected")}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
