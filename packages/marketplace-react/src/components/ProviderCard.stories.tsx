/**
 * Ladle stories for {@link ProviderCard} — verified / provisional rates /
 * no-data / loading / unsupported-transport error + {@link PoweredByAgenC}.
 */
import type { Story } from "@ladle/react";
import { ProviderCard } from "./ProviderCard.js";
import { PoweredByAgenC } from "./PoweredByAgenC.js";
import {
  FIXTURE_AGENT,
  makeTrackRecord,
} from "./__fixtures__/index.js";
import { ReadTransportUnsupportedError } from "../transport/index.js";

export default {
  title: "Provider / ProviderCard",
};

export const Verified: Story = () => (
  <ProviderCard
    agent={FIXTURE_AGENT}
    trackRecord={makeTrackRecord()}
    verified
  />
);

export const Unverified: Story = () => (
  <ProviderCard agent={FIXTURE_AGENT} trackRecord={makeTrackRecord()} />
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

export const PoweredBy: Story = () => <PoweredByAgenC />;

export const PoweredByUnstyled: Story = () => <PoweredByAgenC unstyled />;
