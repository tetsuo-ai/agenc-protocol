/**
 * `<HireButton>` — the connected, drop-in hire entry point.
 *
 * This is the one component that binds the hooks directly: it renders a price-
 * aware CTA that opens {@link HireCheckoutModal}, drives the hire through
 * `useHire()`, resolves the signer via `useWalletSigner()`, and threads the
 * provider's configured referrer + capability into the modal's disclosure.
 *
 * ## Why the caller supplies the hire input
 *
 * A hire needs caller-specific fields the listing alone can't provide
 * (`creatorAgent` — the BUYER's registered agent PDA, or the humanless flag —
 * and a fresh `taskId`). So `HireButton` takes a `buildHireInput(listing)`
 * factory rather than guessing them. The compare-and-swap guards
 * (`expectedPrice`/`expectedVersion`/`listingSpecHash`) are derived from the
 * decoded listing by default and can be overridden in the returned input.
 *
 * @module components/HireButton
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useAgencContext } from "../provider/context.js";
import { useHire, type AnyHireInput } from "../hooks/useHire.js";
import { useWalletSigner } from "../hooks/useWalletSigner.js";
import type { Address } from "../types.js";
import { formatPriceSol, tc } from "./format.js";
import {
  HireCheckoutModal,
  type HireCheckoutListing,
} from "./HireCheckoutModal.js";
import { Button, type ThemableProps } from "./primitives.js";

/** Props for {@link HireButton}. */
export interface HireButtonProps extends ThemableProps {
  /** The listing to hire (decoded account + address). */
  listing: HireCheckoutListing;
  /**
   * Build the per-hire input from the listing. Must return at least
   * `creatorAgent` (standard hire) or `{ humanless: true }` plus a fresh
   * `taskId` and the compare-and-swap guards. `listing` and the signer default
   * to context. See `useHire` for the full input shape.
   */
  buildHireInput: (listing: HireCheckoutListing) => AnyHireInput;
  /** Called after a successful hire with the minted Task PDA. */
  onHired?: (taskPda: Address) => void;
  /** Called when the buyer clicks "View task" on the success screen. */
  onViewTask?: (taskPda: Address) => void;
  /** Show the price in the button label (`Hire — 1.5 SOL`). Default true. */
  showPriceInLabel?: boolean;
  /** Override the button label. */
  label?: string;
}

/**
 * A connected hire button + checkout modal.
 *
 * @example
 * ```tsx
 * <HireButton
 *   listing={row}
 *   buildHireInput={(l) => ({
 *     listing: l.address,
 *     creatorAgent: myAgentPda,
 *     taskId: randomId32(),
 *     expectedPrice: l.account.price,
 *     expectedVersion: l.account.version,
 *   })}
 *   onHired={(task) => router.push(`/tasks/${task}`)}
 * />
 * ```
 */
export function HireButton({
  listing,
  buildHireInput,
  onHired,
  onViewTask,
  showPriceInLabel = true,
  label,
  unstyled,
  className,
}: HireButtonProps): ReactNode {
  const ctx = useAgencContext();
  const { hire, status, error, taskPda, reset } = useHire();
  const { connected } = useWalletSigner();
  const [open, setOpen] = useState(false);
  // SYNCHRONOUS in-flight latch (defense-in-depth alongside the modal's own
  // latch): the `useHire` mutation's `status` does NOT flip to "pending" within
  // the same tick, and `mutateAsync` does NOT dedupe concurrent calls — so a
  // fast double-invoke of `confirm` would fire two funded hires with fresh
  // taskIds (two escrows / double charge). The ref guards against re-entrancy
  // before the first `hire(...)` promise settles.
  const inFlightRef = useRef(false);

  const capability = ctx.resolveReferrerCapability();

  const close = useCallback(() => {
    setOpen(false);
    inFlightRef.current = false;
    // Reset the mutation so re-opening starts clean (idle), not stuck on a
    // prior success/error.
    reset();
  }, [reset]);

  const confirm = useCallback(async () => {
    // Drop a duplicate confirm while the first hire is still in flight.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const input = buildHireInput(listing);
      const result = await hire(input);
      onHired?.(result.taskPda);
    } finally {
      inFlightRef.current = false;
    }
  }, [buildHireInput, hire, listing, onHired]);

  const buttonLabel =
    label ??
    (showPriceInLabel
      ? tc("components.hire.ctaPrice", {
          price: formatPriceSol(listing.account.price),
        })
      : tc("components.hire.cta"));

  return (
    <>
      <Button
        unstyled={unstyled}
        className={className}
        variant="primary"
        onClick={() => setOpen(true)}
      >
        {buttonLabel}
      </Button>
      <HireCheckoutModal
        open={open}
        onClose={close}
        listing={listing}
        onConfirm={confirm}
        status={status}
        error={error}
        taskPda={taskPda}
        onViewTask={onViewTask}
        referrer={ctx.referrer}
        referrerLive={capability.live}
        connected={connected}
        unstyled={unstyled}
      />
    </>
  );
}
