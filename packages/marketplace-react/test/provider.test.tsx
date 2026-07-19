/**
 * Structural tests for the foundation slice: provider render, referrer
 * validation + the referrer capability, the read-transport override slot, and
 * the write-client override slot.
 *
 * These use a mock `ReadTransport` (the `queryTransport` slot) and a stub write
 * client (the `client` slot) — the same public seams `startLocalMarketplace()`
 * plugs into for hook e2e — so no RPC, no litesvm, no network.
 */
import { address, createNoopSigner } from "@solana/kit";
import { render, renderHook, screen } from "@testing-library/react";
import { format } from "node:util";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgencProvider,
  createReadTransport,
  REFERRER_FEE_BPS_MAX,
  ReadTransportUnsupportedError,
  resolveReferrerCapability,
  t,
  useAgencContext,
  validateReferrerConfig,
  type AgencProviderConfig,
  type MarketplaceClient,
  type ReadTransport,
} from "../src/index.js";

// A well-formed base58 address (the system program id) for valid-wallet cases.
const VALID_WALLET = "11111111111111111111111111111111";

/** A no-op mock read transport used via the `queryTransport` override slot. */
function mockReadTransport(
  overrides: Partial<ReadTransport> = {},
): ReadTransport {
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
    ...overrides,
  };
}

/** A stub write client used via the `client` override slot. */
function stubClient(): MarketplaceClient {
  return {
    signer: createNoopSigner(address(VALID_WALLET)),
    transport: {} as MarketplaceClient["transport"],
    send: vi.fn(),
  } as unknown as MarketplaceClient;
}

function wrapper(config: AgencProviderConfig) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AgencProvider config={config}>{children}</AgencProvider>;
  };
}

/**
 * React/jsdom reports a render-phase exception to `console.error` before it
 * rethrows it to the assertion. Capture only that expected exception and
 * React's matching component-stack diagnostic. Any different console error is
 * surfaced as a test failure rather than hidden.
 */
function expectReactRenderFailure(
  renderAttempt: () => unknown,
  expected: RegExp,
  component: "AgencProvider" | "TestComponent",
): void {
  const captured: string[] = [];
  const matcher = new RegExp(expected.source, expected.flags.replace("g", ""));
  let expectedWindowErrors = 0;
  const onWindowError = (event: ErrorEvent) => {
    const message =
      event.error instanceof Error ? event.error.message : event.message;
    if (!matcher.test(message)) return;
    expectedWindowErrors += 1;
    // jsdom reports an unhandled render exception through its virtual console
    // unless the matching window error is explicitly handled.
    event.preventDefault();
  };
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      captured.push(format(...args));
    });
  window.addEventListener("error", onWindowError);

  try {
    expect(renderAttempt).toThrowError(expected);
  } finally {
    window.removeEventListener("error", onWindowError);
    errorSpy.mockRestore();
  }

  expect(expectedWindowErrors).toBeGreaterThan(0);
  expect(captured.length).toBeGreaterThan(0);
  const expectedComponentDiagnostic = `The above error occurred in the <${component}> component:`;
  const unexpected = captured.filter(
    (message) =>
      !matcher.test(message) &&
      !message.startsWith(expectedComponentDiagnostic),
  );
  expect(unexpected).toEqual([]);
}

describe("AgencProvider", () => {
  it("renders children", () => {
    render(
      <AgencProvider
        config={{ network: "devnet", queryTransport: mockReadTransport() }}
      >
        <div>hello-marketplace</div>
      </AgencProvider>,
    );
    expect(screen.getByText("hello-marketplace")).toBeDefined();
  });

  it("exposes the read transport via context (queryTransport override slot)", () => {
    const read = mockReadTransport();
    const { result } = renderHook(() => useAgencContext(), {
      wrapper: wrapper({ network: "devnet", queryTransport: read }),
    });
    expect(result.current.read).toBe(read);
    expect(result.current.network).toBe("devnet");
  });

  it("uses the client override slot when provided", () => {
    const client = stubClient();
    const { result } = renderHook(() => useAgencContext(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    expect(result.current.client).toBe(client);
  });

  it("exposes a null client when neither client nor signer+rpc is given", () => {
    const { result } = renderHook(() => useAgencContext(), {
      wrapper: wrapper({
        network: "devnet",
        queryTransport: mockReadTransport(),
      }),
    });
    expect(result.current.client).toBeNull();
    expect(result.current.signer).toBeNull();
  });

  it("rejects a chain-bound signer that mismatches the provider network", () => {
    const signer = {
      ...createNoopSigner(address(VALID_WALLET)),
      chain: "solana:mainnet",
    };
    expectReactRenderFailure(
      () =>
        renderHook(() => useAgencContext(), {
          wrapper: wrapper({
            network: "devnet",
            signer,
            queryTransport: mockReadTransport(),
          }),
        }),
      /solana:mainnet.*devnet|devnet.*solana:mainnet/i,
      "AgencProvider",
    );
  });

  it("keeps endpoint credentials and custom labels out of query keys", () => {
    const { result } = renderHook(() => useAgencContext(), {
      wrapper: wrapper({
        network: "devnet",
        rpcUrl: "https://rpc.example.test/?api-key=super-secret",
        cacheNamespace: "private-customer-name",
        queryTransport: mockReadTransport(),
      }),
    });
    expect(result.current.cacheNamespace).not.toContain("super-secret");
    expect(result.current.cacheNamespace).not.toContain(
      "private-customer-name",
    );
  });

  it("throws a clear error when useAgencContext is used outside a provider", () => {
    expectReactRenderFailure(
      () => renderHook(() => useAgencContext()),
      /within <AgencProvider>/,
      "TestComponent",
    );
  });
});

describe("referrer validation", () => {
  it("accepts and normalizes a valid referrer config", () => {
    const validated = validateReferrerConfig({
      wallet: VALID_WALLET,
      feeBps: 250,
    });
    expect(validated.wallet).toBe(VALID_WALLET);
    expect(validated.feeBps).toBe(250);
  });

  it("rejects a non-base58 wallet", () => {
    expect(() =>
      validateReferrerConfig({ wallet: "not-a-real-address!!!", feeBps: 100 }),
    ).toThrowError(/valid base58/);
  });

  it("rejects an over-range feeBps", () => {
    expect(() =>
      validateReferrerConfig({
        wallet: VALID_WALLET,
        feeBps: REFERRER_FEE_BPS_MAX + 1,
      }),
    ).toThrowError(/basis points/);
  });

  it("rejects a negative feeBps", () => {
    expect(() =>
      validateReferrerConfig({ wallet: VALID_WALLET, feeBps: -1 }),
    ).toThrowError(/basis points/);
  });

  it("rejects a non-integer feeBps", () => {
    expect(() =>
      validateReferrerConfig({ wallet: VALID_WALLET, feeBps: 12.5 }),
    ).toThrowError(/basis points/);
  });

  it("surfaces a referrer validation error at provider construction", () => {
    expectReactRenderFailure(
      () =>
        renderHook(() => useAgencContext(), {
          wrapper: wrapper({
            network: "devnet",
            queryTransport: mockReadTransport(),
            referrer: { wallet: "bad", feeBps: 100 },
          }),
        }),
      /valid base58/,
      "AgencProvider",
    );
  });
});

describe("resolveReferrerCapability", () => {
  it("returns not-live with a reason when no referrer is configured", () => {
    const cap = resolveReferrerCapability(null);
    expect(cap.live).toBe(false);
    expect(cap.reason).toBeTruthy();
    expect(cap.referrer).toBeUndefined();
  });

  it("returns live with a valid referrer", () => {
    const validated = validateReferrerConfig({
      wallet: VALID_WALLET,
      feeBps: 250,
    });
    const cap = resolveReferrerCapability(validated);
    expect(cap.live).toBe(true);
    expect(cap.reason).toBeUndefined();
    expect(cap.referrer).toEqual(validated);
  });

  it("is reachable from context and is live when configured", () => {
    const { result } = renderHook(() => useAgencContext(), {
      wrapper: wrapper({
        network: "mainnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    const cap = result.current.resolveReferrerCapability();
    expect(cap.live).toBe(true);
    expect(result.current.referrer).not.toBeNull();
  });
});

describe("createReadTransport", () => {
  it("returns the queryTransport override verbatim", () => {
    const read = mockReadTransport();
    expect(createReadTransport({ queryTransport: read })).toBe(read);
  });

  it("throws a descriptive error when no read source is configured", () => {
    expect(() => createReadTransport({})).toThrowError(/No read source/);
  });

  it("builds an indexer-backed transport when an indexer baseUrl is set", () => {
    const transport = createReadTransport({
      indexer: { baseUrl: "https://example.test" },
    });
    expect(transport.kind).toBe("indexer");
  });

  it("gPA fallback rejects indexer-only operations with a typed error", async () => {
    const transport = createReadTransport({
      // A minimal ProgramAccountsTransport stand-in (getProgramAccounts present).
      rpc: { getProgramAccounts: () => ({ send: async () => [] }) } as never,
    });
    expect(transport.kind).toBe("gpa");
    await expect(transport.listingHires(VALID_WALLET)).rejects.toBeInstanceOf(
      ReadTransportUnsupportedError,
    );
    await expect(
      transport.agentTrackRecord(VALID_WALLET),
    ).rejects.toBeInstanceOf(ReadTransportUnsupportedError);
  });
});

describe("string catalog", () => {
  it("interpolates {vars}", () => {
    expect(
      t("referrer.invalidFeeBps", { min: 0, max: 10000, feeBps: 99999 }),
    ).toContain("got 99999");
  });

  it("returns the id verbatim for an unknown key", () => {
    expect(t("nope.missing")).toBe("nope.missing");
  });

  it("leaves unmatched placeholders intact", () => {
    expect(
      t(
        "referrer.invalidWallet",
        {},
        { catalog: { "referrer.invalidWallet": "{wallet}" } },
      ),
    ).toBe("{wallet}");
  });
});
