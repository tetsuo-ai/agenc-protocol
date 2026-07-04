/**
 * `<GuaranteedBadge task={...} />` — the Guaranteed Hire badge (WP-H3).
 *
 * Renders NOTHING unless the task is guaranteed (a live worker completion
 * bond: the worker staked 25% of the reward on passing review). When it is,
 * shows a small success-tone badge with plain-English copy; the full detail
 * sentence rides on `title`/`aria-label`.
 *
 * Connected by default: given `task`, it reads through {@link useTaskGuarantee}
 * (provider `rpcUrl` gPA read, or the `guaranteeReader` seam). Pass a
 * pre-resolved `guarantee` to use it presentationally (no read at all) — an
 * explicit `guarantee` (including `null`) wins over the `task` read.
 *
 * HONEST BOUNDARY (phase 1): the copy says the buyer is refunded and the
 * worker FORFEITS the bond — it deliberately does NOT promise the buyer the
 * bond itself, because a forfeited bond pays the protocol treasury until
 * phase 2 redirects it to the harmed party. Keep host copy within that line.
 *
 * @module components/GuaranteedBadge
 */
import type { ReactNode } from "react";
import type { TaskGuarantee } from "@tetsuo-ai/marketplace-sdk";
import {
  useTaskGuarantee,
  type TaskGuaranteeReader,
} from "../hooks/useTaskGuarantee.js";
import type { Address } from "../types.js";
import { tc } from "./format.js";
import { Badge, type ThemableProps } from "./primitives.js";

/** Props for {@link GuaranteedBadge}. */
export interface GuaranteedBadgeProps extends ThemableProps {
  /** The Task PDA to read the guarantee for (connected mode). */
  task?: Address | string | null;
  /**
   * Pre-resolved guarantee state (presentational mode — overrides the `task`
   * read entirely; pass `null` for a known-unguaranteed task).
   */
  guarantee?: TaskGuarantee | null;
  /** Injected reader seam forwarded to {@link useTaskGuarantee} (tests/litesvm). */
  guaranteeReader?: TaskGuaranteeReader;
}

/**
 * Show that a task's result is backed by the worker's 25% completion bond.
 * Renders nothing while loading, on read errors, and for unguaranteed tasks —
 * the badge only ever ASSERTS a live guarantee, never its absence.
 */
export function GuaranteedBadge({
  task,
  guarantee,
  guaranteeReader,
  unstyled,
  className,
}: GuaranteedBadgeProps): ReactNode {
  const overridden = guarantee !== undefined;
  const read = useTaskGuarantee(overridden ? null : task, {
    guaranteeReader,
    enabled: !overridden,
  });
  const resolved = overridden ? guarantee : read.guarantee;
  if (!resolved?.guaranteed) return null;
  return (
    <Badge
      tone="success"
      unstyled={unstyled}
      className={className}
      label={tc("components.guarantee.detail")}
    >
      {tc("components.guarantee.badge")}
    </Badge>
  );
}
