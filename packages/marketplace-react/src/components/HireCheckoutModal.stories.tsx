/**
 * Ladle stories for {@link HireCheckoutModal} — the money-handling modal across
 * idle / pending / success / error states, with + without a referrer
 * disclosure, plus the not-connected gate.
 *
 * Stories render the modal inline (always `open`) so the dialog surface is
 * always visible for the axe a11y check and visual review.
 */
import type { Story } from "@ladle/react";
import { address } from "@solana/kit";
import { HireCheckoutModal } from "./HireCheckoutModal.js";
import {
  FIXTURE_REFERRER,
  makeIndexerListing,
  makeListing,
  FIXTURE_LISTING,
} from "./__fixtures__/index.js";
import type { ValidatedReferrerConfig } from "../types.js";

export default {
  title: "Hire / HireCheckoutModal",
};

const listing = { address: FIXTURE_LISTING, account: makeListing() };
const referrer: ValidatedReferrerConfig = {
  wallet: address(FIXTURE_REFERRER),
  feeBps: 250,
};

export const Idle: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    moderation={makeIndexerListing()}
  />
);

export const Pending: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    status="pending"
    moderation={makeIndexerListing()}
  />
);

export const Success: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    status="success"
    taskPda={FIXTURE_LISTING}
    onViewTask={() => {}}
    moderation={makeIndexerListing()}
  />
);

export const ErrorState: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    status="error"
    error={new Error("0x1771: listing price changed")}
    moderation={makeIndexerListing()}
  />
);

export const WithReferrerDisclosure: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    moderation={makeIndexerListing()}
    referrer={referrer}
    referrerLive={false}
  />
);

export const NotConnected: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    moderation={makeIndexerListing()}
    connected={false}
  />
);

export const ModerationPending: Story = () => (
  <HireCheckoutModal
    open
    onClose={() => {}}
    listing={listing}
    onConfirm={() => {}}
    moderation={null}
  />
);
