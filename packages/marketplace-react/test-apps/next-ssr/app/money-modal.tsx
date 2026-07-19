"use client";

/**
 * SSR proof for the MONEY path (finding #6). The funded checkout is the most
 * load-bearing surface shipped to third parties, yet the A1 SSR fixture only
 * server-rendered the read/listing path. This island puts the actual shipped
 * money components into the server-rendered tree so `check-ssr.mjs` proves they
 * server-render without throwing and without touching `window`/`document`:
 *
 * - `<HireButton>` — the connected drop-in (renders its CTA + a CLOSED modal);
 * - `<HireCheckoutModal open>` — the dialog rendered OPEN so its full markup
 *   (price, escrow note, confirm button, the focus-trap-bearing dialog) is in
 *   the SERVER HTML. All `document` access lives in the focus-trap effect,
 *   which never runs on the server, so the OPEN modal is SSR-safe by
 *   construction — this fixture is what proves it stays that way.
 *
 * The listing is decoded SYNCHRONOUSLY at module load from the SAME byte-true
 * captured account the listing grid uses (no `useListings`, no validator, no
 * signer), so the money surface is present on the single synchronous server
 * pass — exactly what the HTTP SSR check reads.
 */
import { address } from "@solana/kit";
import { getServiceListingDecoder } from "@tetsuo-ai/marketplace-sdk";
import {
  HireButton,
  HireCheckoutModal,
} from "@tetsuo-ai/marketplace-react/components";
import type {
  HireCheckoutListing,
  ServiceListing,
} from "@tetsuo-ai/marketplace-react";
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

/** Decode the first captured fixture listing ONCE (real on-chain bytes). */
const FIRST = (fixture.listings as CapturedListing[])[0]!;
const FIXTURE_LISTING: HireCheckoutListing = {
  address: address(FIRST.address),
  account: getServiceListingDecoder().decode(
    base64ToBytes(FIRST.accountBase64),
  ) as ServiceListing,
};
const FIXTURE_MODERATOR = address(
  "7HiVp4xTm3XxuN1gGWcKQn39vwyS2kUcWAjw4MwpS1v5",
);

export function MoneyModal() {
  return (
    <section data-agenc-money-shell="ready">
      {/* Connected drop-in: renders the CTA + a CLOSED modal. */}
      <HireButton
        listing={FIXTURE_LISTING}
        buildHireInput={(l) => ({
          listing: l.address,
          providerAgent: l.account.providerAgent,
          creatorAgent: l.account.providerAgent,
          taskId: new Uint8Array(32),
          expectedPrice: l.account.price,
          expectedVersion: l.account.version,
          moderator: FIXTURE_MODERATOR,
        })}
      />
      {/* The OPEN money dialog, server-rendered to prove it SSRs without throwing. */}
      <HireCheckoutModal
        open
        onClose={() => {}}
        listing={FIXTURE_LISTING}
        onConfirm={() => {}}
      />
    </section>
  );
}
