/**
 * Prebuilt, themable components for `@tetsuo-ai/marketplace-react` (PLAN_2 A3).
 *
 * Every component:
 * - is built over the A2 headless hooks (the connected `HireButton`) or takes
 *   their result fields (the presentational read/review/dispute components);
 * - themes via `--agenc-*` CSS custom properties and accepts `unstyled` for
 *   full white-label — NO CSS-in-JS runtime;
 * - routes every user-facing string through the component string catalog;
 * - is SSR-safe (no `window`/`document` at module scope).
 *
 * The default theme CSS is OPTIONAL and shipped separately — import
 * `@tetsuo-ai/marketplace-react/theme.css` (foundation tokens) +
 * `@tetsuo-ai/marketplace-react/components.css` (component recipes) for the
 * styled look, or pass `unstyled` and bring your own.
 *
 * @module components
 */

// Shared primitives + theming helpers.
export {
  Badge,
  Button,
  Spinner,
  StateMessage,
  cx,
  elementClass,
  rootClass,
  type BadgeProps,
  type BadgeTone,
  type ButtonProps,
  type ButtonVariant,
  type SpinnerProps,
  type StateKind,
  type StateMessageProps,
  type ThemableProps,
} from "./primitives.js";

// Shared badges.
export {
  ModerationBadge,
  VerifiedBadge,
  moderationStateOf,
  type ModerationBadgeProps,
  type ModerationState,
  type VerifiedBadgeProps,
} from "./badges.js";

// Presentational formatting helpers + the component string resolver.
export {
  decodeListingCategory,
  decodeListingName,
  decodeListingTags,
  formatPriceSol,
  formatRate,
  formatSol,
  tc,
  toHex,
  truncateAddress,
} from "./format.js";
export {
  COMPONENT_CATALOG,
  EN_COMPONENT_STRINGS,
  type ComponentStringId,
} from "./strings.js";

// Accessible modal primitive + focus trap.
export { Modal, type ModalProps } from "./Modal.js";
export { useFocusTrap } from "./useFocusTrap.js";

// Listing components.
export {
  ListingCard,
  type ListingCardData,
  type ListingCardProps,
} from "./ListingCard.js";
export { ListingGrid, type ListingGridProps } from "./ListingGrid.js";

// Hire / checkout (the money path).
export { HireButton, type HireButtonProps } from "./HireButton.js";
export {
  HireCheckoutModal,
  type HireCheckoutListing,
  type HireCheckoutModalProps,
} from "./HireCheckoutModal.js";
export {
  ReferrerDisclosure,
  type ReferrerDisclosureProps,
} from "./ReferrerDisclosure.js";

// Task lifecycle + settlement.
export { TaskTimeline, type TaskTimelineProps } from "./TaskTimeline.js";
export { ReviewPanel, type ReviewPanelProps } from "./ReviewPanel.js";
export { DisputeBanner, type DisputeBannerProps } from "./DisputeBanner.js";

// Reputation + attribution.
export { ProviderCard, type ProviderCardProps } from "./ProviderCard.js";
export {
  PoweredByAgenC,
  DEFAULT_TRUST_HREF,
  type PoweredByAgenCProps,
} from "./PoweredByAgenC.js";
