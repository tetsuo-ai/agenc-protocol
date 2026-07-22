/**
 * Revert-sensitive double-submit guard tests for the money path (finding #1).
 *
 * The confirm button must disable SYNCHRONOUSLY on the first click — the
 * parent-controlled `status` prop does not flip to "pending" within the same
 * tick, so without a local in-flight latch two fast clicks fire `onConfirm`
 * (a funded hire with a fresh taskId) TWICE -> two escrows / double charge.
 *
 * These render the REAL components:
 * - the bare `HireCheckoutModal` (a synchronous double-click fires the
 *   underlying confirm exactly once); and
 * - the REAL connected `HireButton` inside `AgencProvider` with a write client
 *   whose `hireFromListing` never resolves (so the in-flight window stays open)
 *   — a synchronous double-click invokes the SDK money path exactly once.
 *
 * REVERT-SENSITIVITY: against the pre-fix code (confirm guarded only by the
 * async `status`/`pending` prop) both assertions go red with "expected 2".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { AgencProvider } from "../../src/provider/index.js";
import { HireButton, HireCheckoutModal } from "../../src/components/index.js";
import type {
  AgencProviderConfig,
  MarketplaceClient,
  ReadTransport,
} from "../../src/types.js";
import {
  FIXTURE_AGENT,
  FIXTURE_LISTING,
  makeListing,
} from "../../src/components/__fixtures__/index.js";

afterEach(cleanup);

const listing = { address: FIXTURE_LISTING, account: makeListing() };

function noopReadTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: async () => [],
    getListing: async () => {
      throw new Error("not wired");
    },
    listingHires: async () => [],
    agentTrackRecord: async () => {
      throw new Error("not wired");
    },
  };
}

/** A write client whose hire never resolves (keeps the in-flight window open). */
function neverResolvingClient(
  hireFromListing: MarketplaceClient["hireFromListing"],
): MarketplaceClient {
  return {
    signer: { address: FIXTURE_AGENT } as MarketplaceClient["signer"],
    transport: {} as MarketplaceClient["transport"],
    send: async () => ({ signature: "sig", logs: [] }),
    hireFromListing,
  } as unknown as MarketplaceClient;
}

function ConnectedHarness({
  client,
}: {
  client: MarketplaceClient;
}): ReactNode {
  const config: AgencProviderConfig = {
    network: "localnet",
    queryTransport: noopReadTransport(),
    client,
    signer: { address: FIXTURE_AGENT } as AgencProviderConfig["signer"],
  };
  return (
    <AgencProvider config={config}>
      <HireButton
        listing={listing}
        buildHireInput={(l) => ({
          listing: l.address,
          providerAgent: l.account.providerAgent,
          creatorAgent: FIXTURE_AGENT,
          taskId: new Uint8Array(32).fill(7),
          expectedPrice: l.account.price,
          expectedVersion: 3n,
          taskJobSpecHash: l.account.specHash,
          moderator: FIXTURE_AGENT,
        })}
      />
    </AgencProvider>
  );
}

describe("double-submit guard (finding #1)", () => {
  it("bare modal: a synchronous double-click fires onConfirm exactly once", () => {
    // onConfirm returns a never-resolving promise: the parent has not yet
    // re-rendered with status="pending" when the second click lands.
    const onConfirm = vi.fn(() => new Promise<void>(() => {}));
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={onConfirm}
      />,
    );
    const button = screen.getByRole("button", { name: /confirm and fund/i });
    fireEvent.click(button);
    fireEvent.click(button);
    // Pre-fix: fired twice (no synchronous local latch).
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("connected HireButton: a synchronous double-click invokes the SDK hire once", async () => {
    // The write client's hire never resolves, so useHire's status stays pending
    // and the only thing that can stop the second click is a synchronous latch.
    const hireFromListing = vi.fn(
      () => new Promise<never>(() => {}),
    ) as unknown as MarketplaceClient["hireFromListing"];
    render(<ConnectedHarness client={neverResolvingClient(hireFromListing)} />);

    // Open the modal via the CTA, then double-click the real confirm button.
    fireEvent.click(screen.getByRole("button", { name: /hire/i }));
    const confirm = screen.getByRole("button", { name: /confirm and fund/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    // PDA derivation now runs from the synchronously captured identity before
    // the funded client call, so wait for that async boundary without assuming
    // a particular microtask count. The click-handler latch still blocks the
    // second click before either enqueue can happen.
    await waitFor(() => expect(hireFromListing).toHaveBeenCalledTimes(1));
  });

  it("releases the latch after rejection without an unhandled rejection", async () => {
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("hire rejected"))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    render(
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={listing}
        onConfirm={onConfirm}
      />,
    );
    const button = screen.getByRole("button", { name: /confirm and fund/i });
    fireEvent.click(button);

    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
