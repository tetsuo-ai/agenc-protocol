/**
 * `<TaskTimeline>` — the lifecycle progress of a hired task.
 *
 * Renders the canonical happy-path stages (Open → In progress → Pending review
 * → Completed) as an ordered, accessible list with the current stage marked,
 * and surfaces the terminal off-path states (Cancelled / Disputed / Rejected-
 * frozen) when reached. Presentational: it takes a `TaskStatus | null` (from
 * `useTaskStatus().status`) plus loading/error, so it renders under SSR and in
 * Ladle without owning a reader.
 *
 * @module components/TaskTimeline
 */
import type { ReactNode } from "react";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import { tc } from "./format.js";
import { StateMessage, cx, rootClass, type ThemableProps } from "./primitives.js";

/** Props for {@link TaskTimeline}. */
export interface TaskTimelineProps extends ThemableProps {
  /** The current task status (from `useTaskStatus().status`). */
  status: TaskStatus | null;
  /** True while loading the status. */
  isLoading?: boolean;
  /** A read error. */
  error?: Error | null;
  /** Retry handler for the error state. */
  onRetry?: () => void;
}

/** The happy-path stages in order. */
const HAPPY_PATH: ReadonlyArray<{ status: TaskStatus; stringId: string }> = [
  { status: TaskStatus.Open, stringId: "components.taskTimeline.status.Open" },
  {
    status: TaskStatus.InProgress,
    stringId: "components.taskTimeline.status.InProgress",
  },
  {
    status: TaskStatus.PendingValidation,
    stringId: "components.taskTimeline.status.PendingValidation",
  },
  {
    status: TaskStatus.Completed,
    stringId: "components.taskTimeline.status.Completed",
  },
];

/** Off-path terminal statuses + their tone class suffix. */
const OFF_PATH: Partial<Record<TaskStatus, { stringId: string; tone: string }>> =
  {
    [TaskStatus.Cancelled]: {
      stringId: "components.taskTimeline.status.Cancelled",
      tone: "cancelled",
    },
    [TaskStatus.Disputed]: {
      stringId: "components.taskTimeline.status.Disputed",
      tone: "disputed",
    },
    [TaskStatus.RejectFrozen]: {
      stringId: "components.taskTimeline.status.RejectFrozen",
      tone: "rejected",
    },
  };

/** The index of `status` within the happy path, or -1. */
function happyIndex(status: TaskStatus): number {
  return HAPPY_PATH.findIndex((s) => s.status === status);
}

/**
 * Render a task's lifecycle progress.
 */
export function TaskTimeline({
  status,
  isLoading = false,
  error = null,
  onRetry,
  unstyled,
  className,
}: TaskTimelineProps): ReactNode {
  const timelineClass = rootClass("agenc-timeline", unstyled, className);

  if (error) {
    return (
      <div className={timelineClass}>
        <StateMessage kind="error" onRetry={onRetry} unstyled={unstyled} />
      </div>
    );
  }
  if (isLoading && status === null) {
    return (
      <div className={timelineClass}>
        <StateMessage kind="loading" unstyled={unstyled} />
      </div>
    );
  }
  if (status === null) {
    return (
      <div className={timelineClass}>
        <StateMessage
          kind="empty"
          message={tc("components.taskTimeline.empty")}
          unstyled={unstyled}
        />
      </div>
    );
  }

  const offPath = OFF_PATH[status];
  const currentIndex = offPath ? -1 : happyIndex(status);

  return (
    <div className={timelineClass} aria-label={tc("components.taskTimeline.title")}>
      <ol className={unstyled ? undefined : "agenc-timeline__list"}>
        {HAPPY_PATH.map((stage, index) => {
          const done = currentIndex > index;
          const current = currentIndex === index;
          const state = done ? "done" : current ? "current" : "upcoming";
          return (
            <li
              key={stage.status}
              className={
                unstyled
                  ? undefined
                  : cx("agenc-timeline__step", `agenc-timeline__step--${state}`)
              }
              aria-current={current ? "step" : undefined}
            >
              <span
                className={unstyled ? undefined : "agenc-timeline__marker"}
                aria-hidden="true"
              />
              <span className={unstyled ? undefined : "agenc-timeline__label"}>
                {tc(stage.stringId)}
              </span>
            </li>
          );
        })}
      </ol>
      {offPath ? (
        <p
          className={
            unstyled
              ? undefined
              : cx(
                  "agenc-timeline__terminal",
                  `agenc-timeline__terminal--${offPath.tone}`,
                )
          }
          role="status"
        >
          {tc(offPath.stringId)}
        </p>
      ) : null}
    </div>
  );
}
