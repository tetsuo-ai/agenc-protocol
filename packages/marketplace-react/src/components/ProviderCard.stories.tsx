/**
 * Ladle stories for {@link ProviderCard} — the P7.3(3) trust surface
 * (on-chain VERIFIED domain vs merely-CLAIMED operator domain vs unverified) +
 * provisional rates / no-data / loading / unsupported-transport error +
 * {@link PoweredByAgenC}.
 */
import type { Story } from "@ladle/react";
import { ProviderCard } from "./ProviderCard.js";
import { PoweredByAgenC } from "./PoweredByAgenC.js";
import {
  FIXTURE_AGENT,
  FIXTURE_VERIFIED_DOMAIN,
  makeTrackRecord,
  makeUnverified,
  makeVerified,
} from "./__fixtures__/index.js";
import { ReadTransportUnsupportedError } from "../transport/index.js";

export default {
  title: "Provider / ProviderCard",
};

/** Live on-chain verification → the success "Verified: <domain>" badge. */
export const Verified: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verification={makeVerified()}
    operatorDomain={FIXTURE_VERIFIED_DOMAIN}
  />
);

/**
 * A provider that CLAIMS a domain in its metadata but has NO on-chain
 * verification — renders the distinct, neutral "Claims: <domain>" pill and the
 * Unverified badge. Never reads as verified.
 */
export const ClaimedOnly: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verification={makeUnverified()}
    operatorDomain="totally-real-agents.example"
  />
);

/** No verification and no claimed domain → just the Unverified badge. */
export const Unverified: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verification={makeUnverified()}
  />
);

/**
 * A REVOKED on-chain record — `useAgentVerification` resolves this to
 * `{ verified: false }`, so the card shows the claimed pill (if any) + the
 * Unverified badge, never the verified domain.
 */
export const RevokedClaimsDomain: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verification={makeUnverified()}
    operatorDomain={FIXTURE_VERIFIED_DOMAIN}
  />
);

export const NullRates: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord({
      completionRate: null,
      disputeRate: null,
      completions: 0,
      disputesLost: 0,
    })}
  />
);

export const Loading: Story = () => (
  <ProviderCard agent={FIXTURE_AGENT} trackRecord={null} isLoading />
);

export const NoData: Story = () => (
  <ProviderCard agent={FIXTURE_AGENT} trackRecord={null} />
);

export const Unsupported: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={null}
    error={new ReadTransportUnsupportedError("agentTrackRecord")}
    onRetry={() => {}}
  />
);

export const Unstyled: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verification={makeVerified()}
    operatorDomain={FIXTURE_VERIFIED_DOMAIN}
    unstyled
  />
);

export const PoweredBy: Story = () => <PoweredByAgenC />;

export const PoweredByUnstyled: Story = () => <PoweredByAgenC unstyled />;
