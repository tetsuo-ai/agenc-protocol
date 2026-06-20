/**
 * Structural/behavioral tests for the prebuilt components + their pure helpers.
 *
 * Covers: the format helpers (lamport→SOL, address truncation, listing decode),
 * the moderation/verified badge state mapping, the canonical loading/empty/
 * error states, the referrer disclosure copy (the money-safety surface never
 * claims a live fee while not live), the checkout confirmation states,
 * the focus-trap behavior of the modal, and the timeline stage logic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { address } from "@solana/kit";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import type { ValidatedReferrerConfig } from "../../src/types.js";
import {
  DisputeBanner,
  HireCheckoutModal,
  ListingCard,
  ListingGrid,
  ProviderCard,
  ReferrerDisclosure,
  ReviewPanel,
  TaskTimeline,
  decodeListingName,
  formatPriceSol,
  formatRate,
  formatSol,
  moderationStateOf,
  truncateAddress,
} from "../../src/components/index.js";
import {
  FIXTURE_AGENT,
  FIXTURE_LISTING,
  FIXTURE_REFERRER,
  makeIndexerListing,
  makeListing,
  makeListingRows,
  makeTrackRecord,
} from "../../src/components/__fixtures__/index.js";

afterEach(cleanup);

const referrer: ValidatedReferrerConfig = {
  wallet: address(FIXTURE_REFERRER),
  feeBps: 250,
};
const listing = { address: FIXTURE_LISTING, account: makeListing() };

// ---------------------------------------------------------------------------
// Pure format helpers
// ---------------------------------------------------------------------------
describe("format helpers", () => {
  it("formatSol renders lamports as trimmed SOL", () => {
    expect(formatSol(1_500_000_000n)).toBe("1.5");
    expect(formatSol(1_000_000n)).toBe("0.001");
    expect(formatSol(0n)).toBe("0");
    expect(formatSol(1_000_000_000n)).toBe("1");
  });

  it("formatPriceSol appends the unit", () => {
    expect(formatPriceSol(250_000_000n)).toBe("0.25 SOL");
  });

  it("truncateAddress shortens long base58", () => {
    expect(truncateAddress("So11111111111111111111111111111111111111112")).toBe(
      "So11…1112",
    );
    expect(truncateAddress("short")).toBe("short");
    expect(truncateAddress(null)).toBe("");
  });

  it("decodeListingName round-trips the encoded fixture name", () => {
    expect(decodeListingName(makeListing())).toBe("Translation service");
  });

  it("formatRate renders percent or the null fallback", () => {
    expect(formatRate(0.8)).toBe("80%");
    expect(formatRate(null)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Moderation badge state mapping (the P6.8-safe state-only surface)
// ---------------------------------------------------------------------------
describe("moderationStateOf", () => {
  it("maps null projection to pending (never asserts attested)", () => {
    expect(moderationStateOf(null)).toBe("pending");
    expect(moderationStateOf(undefined)).toBe("pending");
  });
  it("maps metadataValid to attested / issues", () => {
    expect(moderationStateOf(makeIndexerListing({ metadataValid: true }))).toBe(
      "attested",
    );
    expect(
      moderationStateOf(makeIndexerListing({ metadataValid: false })),
    ).toBe("issues");
  });
});

// ---------------------------------------------------------------------------
// ListingCard / ListingGrid
// ---------------------------------------------------------------------------
describe("ListingCard", () => {
  it("renders the decoded name, price, and fires onHire", () => {
    const onHire = vi.fn();
    render(
      <ListingCard listing={listing} moderation={makeIndexerListing()} onHire={onHire} />,
    );
    expect(screen.getByText("Translation service")).toBeTruthy();
    expect(screen.getByText("0.25 SOL")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hire/i }));
    expect(onHire).toHaveBeenCalledWith(listing);
  });

  it("falls back to an untitled label for an empty name", () => {
    const blank = {
      address: FIXTURE_LISTING,
      account: makeListing({ name: new Uint8Array(32) }),
    };
    render(<ListingCard listing={blank} />);
    expect(screen.getByText(/untitled/i)).toBeTruthy();
  });
});

describe("ListingGrid", () => {
  it("renders a card per listing", () => {
    render(<ListingGrid listings={makeListingRows(4)} onHire={() => {}} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });
  it("shows the empty state", () => {
    render(<ListingGrid listings={[]} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
  it("shows the error state with retry", () => {
    const onRetry = vi.fn();
    render(<ListingGrid listings={[]} error={new Error("x")} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("load-more reveals via onLoadMore", () => {
    const onLoadMore = vi.fn();
    render(
      <ListingGrid listings={makeListingRows(2)} hasMore onLoadMore={onLoadMore} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REFERRER DISCLOSURE — copy is the money-safety surface
// ---------------------------------------------------------------------------
describe("ReferrerDisclosure", () => {
  it("shows neutral copy while not live (never claims a charged fee)", () => {
    render(<ReferrerDisclosure referrer={referrer} live={false} />);
    expect(screen.getByText(/not active/i)).toBeTruthy();
    // It must NOT show the unqualified "earns a referral fee." present-tense
    // assertion as a standalone (the live copy) while not live.
    expect(screen.queryByText("This site earns a referral fee.")).toBeNull();
    expect(screen.getByText(/250 bps/)).toBeTruthy();
  });

  it("shows the live copy only when live is true", () => {
    render(<ReferrerDisclosure referrer={referrer} live />);
    expect(screen.getByText("This site earns a referral fee.")).toBeTruthy();
    expect(screen.queryByText(/not active/i)).toBeNull();
  });

  it("defaults to not live", () => {
    render(<ReferrerDisclosure referrer={referrer} />);
    expect(screen.getByText(/not active/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HireCheckoutModal — dialog wiring + confirmation states
// ---------------------------------------------------------------------------
describe("HireCheckoutModal", () => {
  it("renders a labelled dialog with price, escrow note, and moderation badge", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
        moderation={makeIndexerListing()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("0.25 SOL")).toBeTruthy();
    expect(screen.getByText(/held in protocol escrow/i)).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <HireCheckoutModal
        open={false}
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("confirm fires onConfirm; pending disables + relabels it", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /confirm and fund/i }));
    expect(onConfirm).toHaveBeenCalled();
    rerender(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={onConfirm}
        status="pending"
      />,
    );
    expect(screen.getByRole("button", { name: /confirming/i })).toBeTruthy();
    // Mid-transaction: the close (X) button is hidden so the buyer can't
    // dismiss a pending on-chain tx.
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
  });

  it("surfaces a hire error in an alert region", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
        status="error"
        error={new Error("0x1771: price changed")}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("price changed");
  });

  it("moves focus into the dialog when opened (focus trap)", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    // Focus is inside the dialog (on a focusable child or the dialog itself).
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("disables confirm and shows a hint when not connected", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
        connected={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: /confirm and fund/i }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText(/connect a wallet/i)).toBeTruthy();
  });

  it("shows the referrer disclosure when a referrer is configured but inactive", () => {
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
        referrer={referrer}
        referrerLive={false}
      />,
    );
    expect(screen.getByText(/not active/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TaskTimeline / ReviewPanel / DisputeBanner / ProviderCard
// ---------------------------------------------------------------------------
describe("TaskTimeline", () => {
  it("marks the current happy-path stage with aria-current", () => {
    render(<TaskTimeline status={TaskStatus.InProgress} />);
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toMatch(/in progress/i);
  });
  it("renders the off-path terminal for a disputed task", () => {
    render(<TaskTimeline status={TaskStatus.Disputed} />);
    expect(screen.getByText(/disputed/i)).toBeTruthy();
  });
  it("shows the empty state for a null status", () => {
    render(<TaskTimeline status={null} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("ReviewPanel", () => {
  it("fires accept/reject/requestChanges when a submission exists", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onRequestChanges = vi.fn();
    render(
      <ReviewPanel
        hasSubmission
        onAccept={onAccept}
        onReject={onReject}
        onRequestChanges={onRequestChanges}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    fireEvent.click(screen.getByRole("button", { name: /request changes/i }));
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(onAccept).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
    expect(onRequestChanges).toHaveBeenCalled();
  });
  it("hides actions and shows the awaiting copy without a submission", () => {
    render(<ReviewPanel hasSubmission={false} />);
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getByText(/awaiting/i)).toBeTruthy();
  });
});

describe("DisputeBanner", () => {
  it("renders the open-dispute alert", () => {
    render(<DisputeBanner disputeOpen />);
    expect(screen.getByRole("alert").textContent).toMatch(/in dispute/i);
  });
  it("offers initiate when no dispute and a handler is given", () => {
    const onInitiate = vi.fn();
    render(<DisputeBanner disputeOpen={false} onInitiate={onInitiate} />);
    fireEvent.click(screen.getByRole("button", { name: /open a dispute/i }));
    expect(onInitiate).toHaveBeenCalled();
  });
});

describe("ProviderCard", () => {
  it("shows verified badge + provisional rates", () => {
    render(
      <ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} verified />,
    );
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getAllByText(/provisional/i).length).toBeGreaterThan(0);
  });
  it("renders a null rate as the dash fallback, never a fabricated 0%", () => {
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord({ completionRate: null, disputeRate: null })}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
  it("shows the unavailable copy on a transport error", () => {
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={null}
        error={new Error("unsupported")}
      />,
    );
    expect(screen.getByText(/unavailable on this read transport/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// unstyled white-label invariant: no agenc-* classes emitted
// ---------------------------------------------------------------------------
describe("unstyled white-label", () => {
  it("ListingCard emits no agenc-* classes when unstyled", () => {
    const { container } = render(
      <ListingCard listing={listing} onHire={() => {}} unstyled />,
    );
    expect(container.querySelector('[class*="agenc-"]')).toBeNull();
  });
  it("HireCheckoutModal emits no agenc-* classes when unstyled", () => {
    const { baseElement } = render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={() => {}}
        unstyled
      />,
    );
    expect(baseElement.querySelector('[class*="agenc-"]')).toBeNull();
  });
});
