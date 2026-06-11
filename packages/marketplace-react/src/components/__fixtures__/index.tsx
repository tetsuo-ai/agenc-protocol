/**
 * Deterministic fixtures shared by the component stories AND the axe/structural
 * tests. Kept out of the package barrel (an internal `__fixtures__` dir) so it
 * never ships as public API; tsup only bundles the entry points.
 *
 * The fixtures build BYTE-TRUE listing fields via the SDK's canonical encoders
 * so `ListingCard`'s decode path is exercised for real, and otherwise cast the
 * remaining on-chain fields to keep the fixtures small.
 *
 * @module components/__fixtures__
 */
import type { ReactNode } from "react";
import { address } from "@solana/kit";
import { values } from "@tetsuo-ai/marketplace-sdk";
import { AgencProvider } from "../../provider/index.js";
import type {
  Address,
  AgencProviderConfig,
  IndexerListing,
  MarketplaceClient,
  ReadTransport,
  ServiceListing,
} from "../../types.js";
import type { ListingCardData } from "../ListingCard.js";
import type { AgentTrackRecord } from "../../hooks/useAgentTrackRecord.js";
import type { AgentVerificationResult } from "../useAgentVerification.js";

/** A stable provider-agent PDA for fixtures. */
export const FIXTURE_AGENT = address(
  "So11111111111111111111111111111111111111112",
) as Address;

/** A stable listing PDA for fixtures. */
export const FIXTURE_LISTING = address(
  "Stake11111111111111111111111111111111111111",
) as Address;

/** A stable referrer wallet for the disclosure fixtures. */
export const FIXTURE_REFERRER = "11111111111111111111111111111111";

/**
 * Build a decoded `ServiceListing` with byte-true metadata fields. Overrides
 * are shallow-merged.
 */
export function makeListing(
  overrides: Partial<ServiceListing> = {},
): ServiceListing {
  return {
    providerAgent: FIXTURE_AGENT,
    authority: FIXTURE_AGENT,
    name: values.encodeListingName("Translation service"),
    category: values.encodeListingCategory("translation"),
    tags: values.encodeListingTags(["english-to-french", "docs"]),
    specHash: new Uint8Array(32),
    specUri: "agenc://job-spec/sha256/" + "0".repeat(64),
    price: 250_000_000n,
    priceMint: { __option: "None" },
    totalHires: 42n,
    version: 3n,
    state: 0,
    ...overrides,
  } as unknown as ServiceListing;
}

/** A `ListingCardData` (address + decoded account) fixture. */
export function makeListingRow(
  addr: Address = FIXTURE_LISTING,
  overrides: Partial<ServiceListing> = {},
): ListingCardData {
  return { address: addr, account: makeListing(overrides) };
}

/** A small set of listing rows for the grid story. */
export function makeListingRows(count = 6): ListingCardData[] {
  const base = [
    "Stake11111111111111111111111111111111111111",
    "Vote111111111111111111111111111111111111111",
    "Config1111111111111111111111111111111111111",
    "BPFLoader1111111111111111111111111111111111",
    "Sysvar1111111111111111111111111111111111111",
    "Feature111111111111111111111111111111111111",
  ];
  return Array.from({ length: count }, (_, i) =>
    makeListingRow(address(base[i % base.length]!) as Address, {
      name: values.encodeListingName(`Service #${i + 1}`),
      price: BigInt((i + 1) * 100_000_000),
      totalHires: BigInt(i * 7),
    }),
  );
}

/** An indexer listing projection fixture (attested by default). */
export function makeIndexerListing(
  overrides: Partial<IndexerListing> = {},
): IndexerListing {
  return {
    pda: String(FIXTURE_LISTING),
    accountData: "",
    decoded: {} as IndexerListing["decoded"],
    metadataValid: true,
    metadataIssues: [],
    lastSlot: 1,
    lastSignature: "sig",
    ...overrides,
  } as IndexerListing;
}

/** A projected track record fixture. */
export function makeTrackRecord(
  overrides: Partial<AgentTrackRecord> = {},
): AgentTrackRecord {
  return {
    agent: FIXTURE_AGENT,
    completions: 18,
    disputesInitiated: 1,
    disputesLost: 2,
    completionRate: 0.9,
    disputeRate: 0.1,
    slashHistory: [],
    recentOutcomes: [],
    partial: true,
    ...overrides,
  };
}

/** The verified operator domain used across the verification fixtures. */
export const FIXTURE_VERIFIED_DOMAIN = "acme-agents.example";

/**
 * A live (verified, non-revoked, non-expired) verification result fixture.
 * Overrides are shallow-merged onto the verified shape.
 */
export function makeVerified(
  overrides: Partial<Extract<AgentVerificationResult, { verified: true }>> = {},
): AgentVerificationResult {
  return {
    verified: true,
    domain: FIXTURE_VERIFIED_DOMAIN,
    method: 0,
    verifiedBy: FIXTURE_AGENT,
    verifiedAt: 1_700_000_000n,
    expiresAt: 0n,
    revoked: false,
    ...overrides,
  };
}

/** The unverified result fixture (account absent / revoked / expired). */
export function makeUnverified(): AgentVerificationResult {
  return { verified: false };
}

/** A no-op read transport for provider-wrapped stories. */
export function fixtureReadTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: async () => [],
    getListing: async () => {
      throw new Error("fixture: getListing not wired");
    },
    listingHires: async () => [],
    agentTrackRecord: async () => {
      throw new Error("fixture: agentTrackRecord not wired");
    },
  };
}

/** A stub write client whose hire resolves successfully (for HireButton). */
export function fixtureClient(): MarketplaceClient {
  return {
    signer: { address: FIXTURE_AGENT } as MarketplaceClient["signer"],
    transport: {} as MarketplaceClient["transport"],
    send: async () => ({ signature: "fixture-sig", logs: [] }),
    hireFromListing: async () => ({ signature: "fixture-sig", logs: [] }),
  } as unknown as MarketplaceClient;
}

/**
 * Wrap a story in an `AgencProvider` with the fixture transport/client and an
 * optional referrer (for the connected `HireButton` story + the disclosure).
 */
export function FixtureProvider({
  children,
  referrer,
  withClient = true,
}: {
  children: ReactNode;
  referrer?: { wallet: string; feeBps: number };
  withClient?: boolean;
}): ReactNode {
  const config: AgencProviderConfig = {
    network: "localnet",
    queryTransport: fixtureReadTransport(),
    client: withClient ? fixtureClient() : undefined,
    signer: withClient
      ? ({ address: FIXTURE_AGENT } as AgencProviderConfig["signer"])
      : undefined,
    referrer,
  };
  return <AgencProvider config={config}>{children}</AgencProvider>;
}
