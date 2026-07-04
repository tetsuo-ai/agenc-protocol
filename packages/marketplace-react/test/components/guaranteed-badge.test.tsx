/**
 * GuaranteedBadge (WP-H3 Guaranteed Hire) render contract.
 *
 * The badge only ever ASSERTS a live guarantee: it renders NOTHING for
 * unguaranteed / unknown / loading states, and when guaranteed it shows the
 * catalog copy with the full phase-1-honest detail sentence on title/aria.
 *
 * REVERT-SENSITIVE: against a variant that renders the badge unconditionally
 * (or keys off ANY live bond instead of the worker bond) the "renders nothing"
 * cases go red; against copy drift toward the phase-2 claim ("you get the
 * bond") the exact-copy assertion goes red — the phase-1 program pays a
 * forfeited bond to the treasury, not the buyer, so that wording must not
 * ship until phase 2.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { address, type Address } from "@solana/kit";
import type { TaskGuarantee } from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  AgencProvider,
  GuaranteedBadge,
  type ReadTransport,
} from "../../src/index.js";

afterEach(cleanup);

const TASK_PDA = address("So11111111111111111111111111111111111111112");
const BOND_PDA = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

const BADGE_TEXT = "Guaranteed — worker has 25% at stake";
const DETAIL_TEXT =
  "Worker has 25% at stake — if the result fails review you're refunded and the worker forfeits the bond.";

function mockReadTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: vi.fn(async () => []),
    getListing: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listingHires: vi.fn(async () => []),
    agentTrackRecord: vi.fn(async () => {
      throw new Error("not implemented");
    }),
  } as unknown as ReadTransport;
}

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <AgencProvider
      config={{ queryTransport: mockReadTransport() }}
      queryClient={queryClient}
    >
      {children}
    </AgencProvider>
  );
}

function guaranteed(): TaskGuarantee {
  return {
    guaranteed: true,
    workerBond: {
      address: BOND_PDA,
      account: {
        task: TASK_PDA,
        party: "11111111111111111111111111111111" as Address,
        role: 1,
        amount: 1_000_000n,
      },
    } as unknown as NonNullable<TaskGuarantee["workerBond"]>,
    creatorBond: null,
  };
}

describe("GuaranteedBadge", () => {
  it("renders NOTHING for a known-unguaranteed task (guarantee: null)", () => {
    const { container } = render(
      <Providers>
        <GuaranteedBadge task={TASK_PDA} guarantee={null} />
      </Providers>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders NOTHING when the guarantee resolved but the worker bond is absent", () => {
    const { container } = render(
      <Providers>
        <GuaranteedBadge
          task={TASK_PDA}
          guarantee={{ guaranteed: false, workerBond: null, creatorBond: null }}
        />
      </Providers>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders NOTHING while an unresolved read is in flight (never asserts early)", () => {
    // A reader that never resolves — the badge must not render optimistically.
    const pending = new Promise<TaskGuarantee>(() => {});
    const { container } = render(
      <Providers>
        <GuaranteedBadge task={TASK_PDA} guaranteeReader={() => pending} />
      </Providers>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the guarantee copy (success tone) when the worker bond is live", () => {
    render(
      <Providers>
        <GuaranteedBadge task={TASK_PDA} guarantee={guaranteed()} />
      </Providers>,
    );
    const badge = screen.getByText(BADGE_TEXT);
    expect(badge).toBeTruthy();
    expect(badge.className).toContain("agenc-badge--success");
    // The full plain-English (phase-1-honest) sentence rides on title/aria.
    expect(badge.getAttribute("title")).toBe(DETAIL_TEXT);
    expect(badge.getAttribute("aria-label")).toBe(DETAIL_TEXT);
  });

  it("resolves through the reader seam when only a task is given", async () => {
    const reader = vi.fn(async () => guaranteed());
    render(
      <Providers>
        <GuaranteedBadge task={TASK_PDA} guaranteeReader={reader} />
      </Providers>,
    );
    expect(await screen.findByText(BADGE_TEXT)).toBeTruthy();
    expect(reader).toHaveBeenCalledWith(TASK_PDA);
  });

  it("honors the unstyled white-label contract", () => {
    render(
      <Providers>
        <GuaranteedBadge
          task={TASK_PDA}
          guarantee={guaranteed()}
          unstyled
          className="host-badge"
        />
      </Providers>,
    );
    const badge = screen.getByText(BADGE_TEXT);
    expect(badge.className).not.toContain("agenc-badge");
    expect(badge.className).toContain("host-badge");
  });
});
