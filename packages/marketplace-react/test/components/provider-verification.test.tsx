/**
 * P7.3(3) verified-surfacing tests for `ProviderCard` + `useAgentVerification`.
 *
 * The load-bearing invariant: an agent is shown VERIFIED only when a genuine,
 * live on-chain `AgentVerification` is read back (exists && !revoked &&
 * not-expired). A merely-CLAIMED `operatorDomain` — and a revoked / expired /
 * absent record — must NEVER render as verified. These assertions are
 * revert-sensitive: if `ProviderCard` ever conflated claimed with verified, or
 * if `evaluateAgentVerification` stopped honoring revoked/expiry, they go red.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  AgencProvider,
  ProviderCard,
  evaluateAgentVerification,
  useAgentVerification,
  type AgencProviderConfig,
  type AgentVerificationReader,
  type AgentVerificationResult,
  type ReadTransport,
} from "../../src/index.js";
import {
  FIXTURE_AGENT,
  FIXTURE_VERIFIED_DOMAIN,
  makeTrackRecord,
  makeUnverified,
  makeVerified,
} from "../../src/components/__fixtures__/index.js";
import type { AgentVerification } from "@tetsuo-ai/marketplace-sdk";

afterEach(cleanup);

/** A decoded AgentVerification account fixture. */
function account(
  overrides: Partial<AgentVerification> = {},
): AgentVerification {
  return {
    discriminator: new Uint8Array(8),
    agent: FIXTURE_AGENT,
    verifiedDomain: FIXTURE_VERIFIED_DOMAIN,
    method: 0,
    verifiedBy: FIXTURE_AGENT,
    verifiedAt: 1_700_000_000n,
    expiresAt: 0n,
    revoked: false,
    bump: 255,
    reserved: new Uint8Array(32),
    ...overrides,
  } as unknown as AgentVerification;
}

const NOW = 1_700_000_500n;

// ---------------------------------------------------------------------------
// evaluateAgentVerification — the revoked / expired / absent boundaries
// ---------------------------------------------------------------------------
describe("evaluateAgentVerification", () => {
  it("a live, non-revoked, non-expiring account is verified with its domain", () => {
    const res = evaluateAgentVerification(account(), NOW);
    expect(res.verified).toBe(true);
    if (res.verified) {
      expect(res.domain).toBe(FIXTURE_VERIFIED_DOMAIN);
      expect(res.method).toBe(0);
      expect(res.revoked).toBe(false);
    }
  });

  it("an absent account (null/undefined) is NOT verified", () => {
    expect(evaluateAgentVerification(null, NOW).verified).toBe(false);
    expect(evaluateAgentVerification(undefined, NOW).verified).toBe(false);
  });

  it("a REVOKED account is NOT verified", () => {
    expect(evaluateAgentVerification(account({ revoked: true }), NOW).verified).toBe(
      false,
    );
  });

  it("an EXPIRED account (now >= expiresAt) is NOT verified", () => {
    // expiresAt strictly in the past relative to NOW.
    expect(
      evaluateAgentVerification(account({ expiresAt: NOW - 1n }), NOW).verified,
    ).toBe(false);
    // Exactly at expiry is also not live (>= boundary).
    expect(
      evaluateAgentVerification(account({ expiresAt: NOW }), NOW).verified,
    ).toBe(false);
  });

  it("a future expiry is still verified; expiresAt === 0 means no expiry", () => {
    expect(
      evaluateAgentVerification(account({ expiresAt: NOW + 1n }), NOW).verified,
    ).toBe(true);
    expect(
      evaluateAgentVerification(account({ expiresAt: 0n }), NOW).verified,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// useAgentVerification — reader seam, inert-without-reader, error fail-safe
// ---------------------------------------------------------------------------
function mockReadTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: vi.fn(async () => []),
    getListing: vi.fn(async () => {
      throw new Error("not implemented in mock");
    }),
    listingHires: vi.fn(async () => []),
    agentTrackRecord: vi.fn(async () => {
      throw new Error("not implemented in mock");
    }),
  };
}

function wrapper(config?: Partial<AgencProviderConfig>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const full: AgencProviderConfig = {
    network: "localnet",
    queryTransport: mockReadTransport(),
    ...config,
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider config={full} queryClient={queryClient}>
        {children}
      </AgencProvider>
    );
  };
}

describe("useAgentVerification", () => {
  it("resolves a verified result through the injected reader", async () => {
    const reader: AgentVerificationReader = vi.fn(async () => makeVerified());
    const { result } = renderHook(
      () => useAgentVerification(FIXTURE_AGENT, { reader }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.verified).toBe(true));
    expect(reader).toHaveBeenCalledWith(FIXTURE_AGENT);
    expect(result.current.verification.verified).toBe(true);
  });

  it("is inert (never verified, never queries) when no reader is given", async () => {
    const { result } = renderHook(() => useAgentVerification(FIXTURE_AGENT), {
      wrapper: wrapper(),
    });
    expect(result.current.verified).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("is inert when agentPda is falsy", () => {
    const reader: AgentVerificationReader = vi.fn(async () => makeVerified());
    const { result } = renderHook(() => useAgentVerification(null, { reader }), {
      wrapper: wrapper(),
    });
    expect(result.current.verified).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it("treats a reader error as NOT verified (fail-safe)", async () => {
    const reader: AgentVerificationReader = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const { result } = renderHook(
      () => useAgentVerification(FIXTURE_AGENT, { reader }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.verified).toBe(false);
  });

  it("surfaces an unverified reader result as not verified", async () => {
    const reader: AgentVerificationReader = vi.fn(async () => makeUnverified());
    const { result } = renderHook(
      () => useAgentVerification(FIXTURE_AGENT, { reader }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.verified).toBe(false);
  });

  it("fails CLOSED across an errored refetch — a stale verified=true is dropped", async () => {
    // First read succeeds (verified=true); a later refetch throws. react-query
    // retains the last successful `query.data` across a failed refetch, so the
    // hook would otherwise keep reporting verified=true alongside a non-null
    // error. The module promises "A failed read is NEVER treated as verified";
    // this asserts the fail-closed behavior across the refetch boundary.
    const reader: AgentVerificationReader = vi
      .fn<AgentVerificationReader>()
      .mockResolvedValueOnce(makeVerified())
      .mockRejectedValue(new Error("rpc down on refetch"));
    const { result } = renderHook(
      () => useAgentVerification(FIXTURE_AGENT, { reader }),
      { wrapper: wrapper() },
    );
    // First load surfaces verified=true with no error.
    await waitFor(() => expect(result.current.verified).toBe(true));
    expect(result.current.error).toBeNull();

    // Refetch fails; the previously-verified state must NOT survive the error.
    result.current.refetch();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.verified).toBe(false);
    expect(result.current.verification.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProviderCard — claimed vs verified rendering (the trust distinction)
// ---------------------------------------------------------------------------
/** Find a node by accessible name (badges carry an aria-label). */
function badgeByLabel(re: RegExp): HTMLElement | null {
  return screen.queryByLabelText(re);
}

describe("ProviderCard verified-domain surfacing", () => {
  it("renders the on-chain VERIFIED domain badge only when verified", () => {
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord()}
        verification={makeVerified()}
        operatorDomain={FIXTURE_VERIFIED_DOMAIN}
      />,
    );
    // "Verified: <domain>" text + the verified Verified pill.
    expect(
      screen.getByText(new RegExp(`Verified:\\s*${FIXTURE_VERIFIED_DOMAIN}`)),
    ).toBeTruthy();
    expect(badgeByLabel(/Verified domain/i)).toBeTruthy();
    // The generic verified badge is present (Verified, not Unverified).
    expect(screen.getByText(/^Verified$/)).toBeTruthy();
    expect(screen.queryByText(/^Unverified$/)).toBeNull();
    // It must NOT render the claimed pill copy for a verified provider.
    expect(screen.queryByText(/^Claims:/)).toBeNull();
  });

  it("a CLAIMED-only domain renders the distinct claims pill, never verified", () => {
    const claimed = "totally-real-agents.example";
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord()}
        verification={makeUnverified()}
        operatorDomain={claimed}
      />,
    );
    // The claimed pill shows "Claims: <domain>" and is labelled not-verified.
    expect(screen.getByText(new RegExp(`Claims:\\s*${claimed}`))).toBeTruthy();
    expect(badgeByLabel(/not verified on-chain/i)).toBeTruthy();
    // No verified-domain badge, and the status pill reads Unverified.
    expect(badgeByLabel(/^Verified domain/i)).toBeNull();
    expect(screen.queryByText(/Verified:/)).toBeNull();
    expect(screen.getByText(/^Unverified$/)).toBeTruthy();
  });

  it("a REVOKED record (resolved to unverified) never shows the verified domain", () => {
    // Even when the claimed string equals a real domain, an unverified result
    // must render as merely claimed, not verified.
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord()}
        verification={makeUnverified()}
        operatorDomain={FIXTURE_VERIFIED_DOMAIN}
      />,
    );
    expect(screen.queryByText(/Verified:/)).toBeNull();
    expect(badgeByLabel(/^Verified domain/i)).toBeNull();
    expect(
      screen.getByText(new RegExp(`Claims:\\s*${FIXTURE_VERIFIED_DOMAIN}`)),
    ).toBeTruthy();
    expect(screen.getByText(/^Unverified$/)).toBeTruthy();
  });

  it.each([
    ["REVOKED", account({ revoked: true })],
    ["EXPIRED", account({ expiresAt: NOW - 1n })],
  ])(
    "a %s verification (resolved via evaluateAgentVerification) with a present operatorDomain renders CLAIMED, never VERIFIED",
    (_label, acct) => {
      // Drive the card off the REAL resolution path: a revoked/expired on-chain
      // account resolves to { verified: false }, and the present operatorDomain
      // must then render as a claimed-only pill — never as a verified domain.
      const verification = evaluateAgentVerification(acct, NOW);
      expect(verification.verified).toBe(false);
      render(
        <ProviderCard
          agent={FIXTURE_AGENT}
          trackRecord={makeTrackRecord()}
          verification={verification}
          operatorDomain={FIXTURE_VERIFIED_DOMAIN}
        />,
      );
      // CLAIMED pill (distinct copy + not-verified label), no verified domain.
      expect(
        screen.getByText(new RegExp(`Claims:\\s*${FIXTURE_VERIFIED_DOMAIN}`)),
      ).toBeTruthy();
      expect(badgeByLabel(/not verified on-chain/i)).toBeTruthy();
      expect(screen.queryByText(/Verified:/)).toBeNull();
      expect(badgeByLabel(/^Verified domain/i)).toBeNull();
      expect(screen.getByText(/^Unverified$/)).toBeTruthy();
    },
  );

  it("absent verification (default prop) renders unverified with no domain pill", () => {
    render(<ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} />);
    expect(screen.queryByText(/Verified:/)).toBeNull();
    expect(screen.queryByText(/^Claims:/)).toBeNull();
    expect(screen.getByText(/^Unverified$/)).toBeTruthy();
  });

  it("uses the ON-CHAIN domain even if the claimed metadata domain differs", () => {
    render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord()}
        verification={makeVerified({ domain: "proven.example" })}
        operatorDomain="self-claimed-different.example"
      />,
    );
    // The proven on-chain domain is what shows; the divergent claim is not shown
    // as verified (and the claimed pill is suppressed when a verified domain wins).
    expect(screen.getByText(/Verified:\s*proven\.example/)).toBeTruthy();
    expect(screen.queryByText(/self-claimed-different\.example/)).toBeNull();
  });

  it("emits no agenc-* classes when unstyled (white-label invariant)", () => {
    const { container } = render(
      <ProviderCard
        agent={FIXTURE_AGENT}
        trackRecord={makeTrackRecord()}
        verification={makeVerified()}
        operatorDomain={FIXTURE_VERIFIED_DOMAIN}
        unstyled
      />,
    );
    expect(container.querySelector('[class*="agenc-"]')).toBeNull();
    // Still surfaces the verified domain text in white-label mode.
    expect(screen.getByText(/Verified:/)).toBeTruthy();
  });

  it("honors the legacy `verified` boolean only as a fallback (no domain)", () => {
    render(
      <ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} verified />,
    );
    expect(screen.getByText(/^Verified$/)).toBeTruthy();
    // A bare boolean carries no domain, so no verified-domain pill renders.
    expect(screen.queryByText(/Verified:/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Result-shape contract: AgentVerificationResult discriminates on `verified`.
// ---------------------------------------------------------------------------
describe("AgentVerificationResult shape", () => {
  it("narrows the verified union to expose the full attestation fields", () => {
    const res: AgentVerificationResult = makeVerified();
    if (res.verified) {
      // All pinned fields present on the verified branch.
      expect(typeof res.domain).toBe("string");
      expect(typeof res.method).toBe("number");
      expect(typeof res.verifiedAt).toBe("bigint");
      expect(typeof res.expiresAt).toBe("bigint");
      expect(res.revoked).toBe(false);
    } else {
      throw new Error("fixture should be verified");
    }
  });
});
