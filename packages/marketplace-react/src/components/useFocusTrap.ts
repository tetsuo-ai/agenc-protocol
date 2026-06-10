/**
 * `useFocusTrap` — an accessible focus trap for the modal surface.
 *
 * `HireCheckoutModal` is a money-handling dialog published to third-party
 * sites, so accessibility is STRUCTURAL (PLAN_2 A3): when the modal is open
 * this hook
 * - moves focus into the dialog (the first focusable element, or the dialog
 *   container itself);
 * - cycles Tab / Shift+Tab within the dialog (a real trap, not just an
 *   initial focus);
 * - RECAPTURES focus that escapes the dialog via a document-level `focusin`
 *   listener (a Tab from browser autofill UI, a third-party widget, or
 *   programmatic focus pulls focus back in — a container-scoped keydown alone
 *   never sees it);
 * - invokes `onEscape` when Escape is pressed;
 * - restores focus to the element that was focused before the dialog opened on
 *   close/unmount.
 *
 * SSR-safe: every `document` access happens inside `useEffect`, which never
 * runs on the server. The hook is a no-op while `active` is false.
 *
 * @module components/useFocusTrap
 */
import { useEffect, type RefObject } from "react";

/** Selector matching the natively focusable, non-disabled elements. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Trap keyboard focus within `containerRef` while `active`.
 *
 * @param containerRef - Ref to the dialog container element.
 * @param active - Whether the trap is engaged (the modal is open).
 * @param onEscape - Called when Escape is pressed inside the trap.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Remember what had focus so we can restore it on close.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus into the dialog (first focusable, else the container).
    const initial = focusableWithin(container)[0] ?? container;
    initial.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(container!);
      if (focusable.length === 0) {
        // Nothing to tab to — keep focus on the container.
        event.preventDefault();
        container!.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;
      if (event.shiftKey) {
        if (activeEl === first || activeEl === container) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Document-level recapture: a container-scoped keydown listener never sees a
    // Tab pressed while focus is OUTSIDE the dialog (browser autofill UI, a
    // third-party widget on the embedder's page, programmatic focus, or tabbing
    // back into the page from the address bar). When focus lands on something
    // the dialog does not contain, pull it back to the first focusable element
    // (or the container) so a keyboard/AT user cannot fall out of a money modal.
    function onFocusIn(event: FocusEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (container!.contains(target)) return;
      // Focus escaped the dialog — recapture it.
      event.stopPropagation();
      const focusable = focusableWithin(container!);
      (focusable[0] ?? container!).focus();
    }

    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      // Restore focus to where it was before the dialog opened.
      previouslyFocused?.focus();
    };
  }, [containerRef, active, onEscape]);
}
