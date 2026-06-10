/**
 * Ladle stories for {@link DisputeBanner} — open / none / initiate-able /
 * pending / opened / error.
 */
import type { Story } from "@ladle/react";
import { DisputeBanner } from "./DisputeBanner.js";

export default {
  title: "Task / DisputeBanner",
};

export const Open: Story = () => <DisputeBanner disputeOpen />;

export const NoneInformational: Story = () => (
  <DisputeBanner disputeOpen={false} />
);

export const NoneInitiatable: Story = () => (
  <DisputeBanner disputeOpen={false} onInitiate={() => {}} />
);

export const Pending: Story = () => (
  <DisputeBanner disputeOpen={false} status="pending" onInitiate={() => {}} />
);

export const Opened: Story = () => (
  <DisputeBanner disputeOpen={false} status="success" onInitiate={() => {}} />
);

export const ErrorState: Story = () => (
  <DisputeBanner
    disputeOpen={false}
    status="error"
    error={new Error("0x1773: task not disputable")}
    onInitiate={() => {}}
  />
);

export const Unstyled: Story = () => <DisputeBanner disputeOpen unstyled />;
