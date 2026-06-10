// @vitest-environment jsdom
/**
 * jsdom render proof for the A1 SSR Done-when's CLIENT half: the provider + the
 * `useListings` hook + the REAL `<ListingGrid>` component render a POPULATED
 * grid (the seeded listings) with NO React hydration/render error.
 *
 * This is the deterministic, browser-free companion to:
 *  - `test-apps/next-ssr/scripts/check-ssr.mjs` (server HTML SSR-shell proof), and
 *  - the Playwright `ssr-hydration` spec (real-browser, no console hydration
 *    warning) when browser binaries are available.
 *
 * It feeds the SAME REAL seeded `ServiceListing` bytes the Next.js fixture uses
 * (captured into `test-apps/next-ssr/app/listings-fixture.json`) through the
 * public `queryTransport` slot, so the assertion is over genuine on-chain
 * accounts — not synthetic data.
 */
import { address } from "@solana/kit";
import { getServiceListingDecoder } from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgencProvider,
  ReadTransportUnsupportedError,
  type AgencProviderConfig,
  type ReadTransport,
  type ServiceListing,
} from "../../src/index.js";
import { useListings } from "../../src/hooks/index.js";
import { ListingGrid as AgencListingGrid } from "../../src/components/index.js";
// The REAL seeded listing bytes the Next.js SSR fixture renders.
import fixture from "../../test-apps/next-ssr/app/listings-fixture.json";

interface CapturedListing {
  address: string;
  accountBase64: string;
}

const DECODER = getServiceListingDecoder();
const ROWS = (fixture.listings as CapturedListing[]).map((row) => ({
  address: address(row.address),
  account: DECODER.decode(
    Uint8Array.from(Buffer.from(row.accountBase64, "base64")),
  ) as ServiceListing,
}));

function fixtureTransport(): ReadTransport {
  return {
    kind: "gpa",
    listActiveListings: async () => ROWS.map((r) => ({ ...r })),
    getListing: async (pda) => {
      const hit = ROWS.find((r) => String(r.address) === String(pda));
      if (!hit) throw new Error(`fixture listing ${pda} not found`);
      return { address: hit.address, account: hit.account };
    },
    listingHires: async () => [],
    agentTrackRecord: async () => {
      throw new ReadTransportUnsupportedError("agentTrackRecord");
    },
  };
}

/** The same provider + hook + component composition the Next.js page uses. */
function Page() {
  const q = useListings();
  return (
    <AgencListingGrid
      listings={q.listings}
      isLoading={q.isLoading}
      error={q.error}
      hasMore={q.hasMore}
      onLoadMore={q.fetchMore}
      onRetry={q.refetch}
    />
  );
}

function wrap(children: ReactNode) {
  const config: AgencProviderConfig = {
    network: "localnet",
    queryTransport: fixtureTransport(),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <AgencProvider config={config} queryClient={queryClient}>
      {children}
    </AgencProvider>
  );
}

describe("A1 SSR fixture (jsdom): provider + useListings + real ListingGrid", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders a POPULATED grid of the real seeded listings", async () => {
    // Sanity: the captured fixture is non-empty (else the proof is hollow).
    expect(ROWS.length).toBeGreaterThan(0);

    render(wrap(<Page />));

    // The real ListingCard renders each listing as an <article> with an
    // aria-label of the decoded listing name. Wait for the populated grid.
    await waitFor(() => {
      expect(screen.getAllByRole("article").length).toBe(ROWS.length);
    });

    // The first seeded listing's name is a real decoded string (not empty).
    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(ROWS.length);

    // No React render/hydration error was logged.
    const reactErrors = errorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0] ?? "").match(/hydrat|did not match|Warning.*render/i),
    );
    expect(reactErrors).toHaveLength(0);
  });
});
