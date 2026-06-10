/**
 * Ladle stories for {@link TaskTimeline} — every lifecycle stage + the
 * off-path terminals + loading / empty / error.
 */
import type { Story } from "@ladle/react";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import { TaskTimeline } from "./TaskTimeline.js";

export default {
  title: "Task / TaskTimeline",
};

export const Open: Story = () => <TaskTimeline status={TaskStatus.Open} />;
export const InProgress: Story = () => (
  <TaskTimeline status={TaskStatus.InProgress} />
);
export const PendingReview: Story = () => (
  <TaskTimeline status={TaskStatus.PendingValidation} />
);
export const Completed: Story = () => (
  <TaskTimeline status={TaskStatus.Completed} />
);
export const Cancelled: Story = () => (
  <TaskTimeline status={TaskStatus.Cancelled} />
);
export const Disputed: Story = () => (
  <TaskTimeline status={TaskStatus.Disputed} />
);
export const RejectFrozen: Story = () => (
  <TaskTimeline status={TaskStatus.RejectFrozen} />
);
export const Loading: Story = () => <TaskTimeline status={null} isLoading />;
export const Empty: Story = () => <TaskTimeline status={null} />;
export const ErrorState: Story = () => (
  <TaskTimeline
    status={null}
    error={new Error("could not read task")}
    onRetry={() => {}}
  />
);
export const Unstyled: Story = () => (
  <TaskTimeline status={TaskStatus.InProgress} unstyled />
);
