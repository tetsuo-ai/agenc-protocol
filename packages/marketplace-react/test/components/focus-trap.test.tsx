/**
 * Focus-trap behavior tests for the money modal (finding #2).
 *
 * `HireCheckoutModal` is a money-handling dialog published to third parties, so
 * the trap must be a REAL trap: Tab/Shift+Tab wrap inside, focus restores to
 * the pre-open element on close, and — the load-bearing case — focus that
 * ESCAPES the dialog (browser autofill, a third-party widget, programmatic
 * focus, address-bar -> page Tab) is RECAPTURED. A container-scoped keydown
 * listener never sees a Tab pressed outside the dialog; only a document-level
 * `focusin` recapture pulls it back.
 *
 * REVERT-SENSITIVITY: the escape-recapture test fails against the pre-fix code
 * (container-only keydown listener, no document-level focusin) — focus stays
 * on the outside element and `dialog.contains(document.activeElement)` is false.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HireCheckoutModal } from "../../src/components/index.js";
import { FIXTURE_LISTING, makeListing } from "../../src/components/__fixtures__/index.js";

afterEach(cleanup);

const listing = { address: FIXTURE_LISTING, account: makeListing() };

function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * jsdom has no layout, so every element reports `offsetParent === null` and the
 * hook's visibility filter (`offsetParent !== null`) collapses the focusable
 * set to just the active element — which would defeat a Tab-cycle test. Force
 * the dialog's focusables to report a non-null offsetParent so the REAL hook
 * computes a real first/last and its wrap logic is genuinely exercised.
 */
function makeVisible(elements: HTMLElement[]): void {
  for (const el of elements) {
    Object.defineProperty(el, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
  }
}

describe("focus trap (finding #2)", () => {
  it("Shift+Tab from the first element wraps to the last", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = focusablesIn(dialog);
    makeVisible(focusables);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(first).not.toBe(last);

    first.focus();
    expect(document.activeElement).toBe(first);
    // Shift+Tab at the first element must wrap focus to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Tab from the last element wraps to the first", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = focusablesIn(dialog);
    makeVisible(focusables);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("restores focus to the pre-open element on close", () => {
    // A focusable element OUTSIDE the modal that holds focus before opening.
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    // Focus moved into the dialog.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    // Close: focus restores to the opener.
    rerender(
      <HireCheckoutModal
        open={false}
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("recaptures focus that escapes the dialog (the escape path)", () => {
    // A real interactive element on the embedder's page, OUTSIDE the dialog.
    const outside = document.createElement("button");
    outside.textContent = "embedder widget";
    document.body.appendChild(outside);

    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");

    // Focus escapes the dialog (e.g. autofill / third-party widget / programmatic).
    outside.focus();

    // Pre-fix: focus stays on the outside element (container keydown never sees
    // it). With the document-level focusin recapture, focus is pulled back in.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(outside);
    outside.remove();
  });
});
