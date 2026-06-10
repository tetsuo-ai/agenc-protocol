/**
 * A deterministic, SSR-safe `ReadTransport` backed by REAL seeded
 * `ServiceListing` account bytes (captured into `listings-fixture.json` by
 * `scripts/capture-fixtures.mjs`). It decodes those bytes with the SDK's
 * `getServiceListingDecoder()` at module load — so it returns GENUINE, fully
 * populated `ServiceListing` accounts (name, category, price, totalHires, …),
 * which is exactly what the real `<ListingGrid>`/`<ListingCard>` render.
 *
 * No network, no `window`, no validator needed at build/test time — yet the grid
 * is populated with the same data a live gPA/indexer read would return. The
 * `queryTransport` slot on `<AgencProvider>` accepts any `ReadTransport`; this is
 * the same public seam the hook tests use. When a real validator is up
 * (NEXT_PUBLIC_AGENC_RPC_URL set), `providers.tsx` swaps this for the SDK's gPA
 * transport instead — both return the same `{ address, account }` row shape.
 */
import { address } from "@solana/kit";
import { getServiceListingDecoder } from "@tetsuo-ai/marketplace-sdk";
import type {
  ReadListingResult,
  ReadTransport,
  ServiceListing,
} from "@tetsuo-ai/marketplace-react";
import { ReadTransportUnsupportedError } from "@tetsuo-ai/marketplace-react";
import fixture from "./listings-fixture.json";

interface CapturedListing {
  address: string;
  accountBase64: string;
}

/** Browser/Node-safe base64 -> bytes. */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

const DECODER = getServiceListingDecoder();

/** Decode the captured fixtures ONCE into real `{address, account}` rows. */
const ROWS: Array<{ address: ReturnType<typeof address>; account: ServiceListing }> =
  (fixture.listings as CapturedListing[]).map((row) => ({
    address: address(row.address),
    account: DECODER.decode(base64ToBytes(row.accountBase64)) as ServiceListing,
  }));

/** Build the static fixture read transport over the real decoded accounts. */
export function createFixtureTransport(): ReadTransport {
  return {
    kind: "gpa",
    listActiveListings: async () => ROWS.map((r) => ({ ...r })),
    getListing: async (pda): Promise<ReadListingResult> => {
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

/** Number of captured fixture listings (for the SSR test's expected count). */
export const FIXTURE_LISTING_COUNT = ROWS.length;
