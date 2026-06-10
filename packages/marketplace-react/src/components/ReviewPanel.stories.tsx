/**
 * Ladle stories for {@link ReviewPanel} — submission-present / awaiting /
 * pending / success / error.
 */
import type { Story } from "@ladle/react";
import { ReviewPanel } from "./ReviewPanel.js";

export default {
  title: "Task / ReviewPanel",
};

export const Default: Story = () => (
  <ReviewPanel
    hasSubmission
    onAccept={() => {}}
    onReject={() => {}}
    onRequestChanges={() => {}}
  />
);

export const AwaitingSubmission: Story = () => (
  <ReviewPanel hasSubmission={false} />
);

export const Pending: Story = () => (
  <ReviewPanel
    hasSubmission
    status="pending"
    onAccept={() => {}}
    onReject={() => {}}
    onRequestChanges={() => {}}
  />
);

export const Accepted: Story = () => (
  <ReviewPanel
    hasSubmission
    status="success"
    settledAction="accept"
    onAccept={() => {}}
    onReject={() => {}}
    onRequestChanges={() => {}}
  />
);

export const ErrorState: Story = () => (
  <ReviewPanel
    hasSubmission
    status="error"
    error={new Error("0x1772: task not pending validation")}
    onAccept={() => {}}
    onReject={() => {}}
    onRequestChanges={() => {}}
  />
);

export const Unstyled: Story = () => (
  <ReviewPanel
    hasSubmission
    unstyled
    onAccept={() => {}}
    onReject={() => {}}
    onRequestChanges={() => {}}
  />
);
