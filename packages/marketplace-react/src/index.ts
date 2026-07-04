/**
 * `@tetsuo-ai/marketplace-react` — headless React hooks + themable components
 * for the AgenC marketplace.
 *
 * This barrel exposes the FOUNDATION layer (PLAN.md P4.2 / PLAN_2 Part A):
 * - `<AgencProvider>` + `useAgencContext()` — the one context wiring reads,
 *   writes, and the live referrer config;
 * - `createReadTransport()` — indexer-first read transport with gPA fallback;
 * - the referrer validation + capability resolver (`resolveReferrerCapability()`,
 *   not-live today per PLAN_2 §0);
 * - the `--agenc-*` theme contract helpers + the English string catalog.
 *
 * Hooks (`useListings`, `useHire`, ...) and components (`ListingCard`, ...) bind
 * to the context value and transport exposed here.
 *
 * SSR-safe, tree-shakeable, zero required CSS imports for headless use.
 *
 * @packageDocumentation
 */

// Provider + context (the foundation hooks/components bind to).
export {
  AgencContext,
  AgencProvider,
  useAgencContext,
  type AgencProviderProps,
} from "./provider/index.js";
export {
  REFERRER_FEE_BPS_MAX,
  REFERRER_FEE_BPS_MIN,
  resolveReferrerCapability,
  validateReferrerConfig,
} from "./provider/referrer.js";
export {
  deriveSubscriptionsUrl,
  resolveEndpoints,
  type ResolvedEndpoints,
} from "./provider/network.js";

// Read transport.
export {
  createReadTransport,
  ReadTransportUnsupportedError,
} from "./transport/index.js";

// Theme contract (CSS is shipped separately via the "./theme.css" export).
export {
  AGENC_THEME_CLASS,
  AGENC_TOKENS_CSS_PATH,
  agencThemeStyleTag,
  resolveThemeClassName,
} from "./theme/index.js";

// String catalog.
export {
  EN_STRINGS,
  t,
  type StringCatalog,
  type StringId,
  type StringVars,
  type TranslateOptions,
} from "./strings/index.js";

// Browser-wallet → kit `TransactionSigner` bridges (P4.1 / PLAN_2 D-1). Also
// available tree-shaken via the "./signers" subpath. The test-only MOCK
// embedded wallet is deliberately NOT re-exported here — it lives behind the
// "./testing" subpath so it can never reach a production bundle by accident.
export {
  EN_SIGNER_STRINGS,
  signerFromEmbeddedWallet,
  signerFromWalletAccount,
  signerFromWalletAdapter,
  type EmbeddedWalletConnection,
  type EmbeddedWalletProvider,
  type SignerFromWalletAccountOptions,
  type SignerFromWalletAdapterOptions,
  type SignerStringId,
  type VersionedTransactionCtor,
  type VersionedTransactionLike,
  type WalletAdapterLike,
  type WalletStandardAccountLike,
  type WalletStandardSignTransaction,
} from "./signers/index.js";

// Prebuilt themable components (PLAN_2 A3). Also tree-shaken via "./components".
export {
  Badge,
  Button,
  DEFAULT_TRUST_HREF,
  DisputeBanner,
  GuaranteedBadge,
  HireButton,
  HireCheckoutModal,
  ListingCard,
  ListingGrid,
  Modal,
  ModerationBadge,
  PoweredByAgenC,
  ProviderCard,
  ReferrerDisclosure,
  ReviewPanel,
  Spinner,
  StateMessage,
  TaskTimeline,
  VerifiedBadge,
  UNVERIFIED,
  agentVerificationReaderFromRpc,
  evaluateAgentVerification,
  useAgentVerification,
  COMPONENT_CATALOG,
  EN_COMPONENT_STRINGS,
  cx,
  decodeListingCategory,
  decodeListingName,
  decodeListingTags,
  elementClass,
  formatPriceSol,
  formatRate,
  formatSol,
  moderationStateOf,
  rootClass,
  tc,
  toHex,
  truncateAddress,
  useFocusTrap,
  type AgentVerificationReader,
  type AgentVerificationReaderOptions,
  type AgentVerificationResult,
  type AgentVerificationRpc,
  type BadgeProps,
  type BadgeTone,
  type ButtonProps,
  type ButtonVariant,
  type ComponentStringId,
  type DisputeBannerProps,
  type GuaranteedBadgeProps,
  type HireButtonProps,
  type HireCheckoutListing,
  type HireCheckoutModalProps,
  type ListingCardData,
  type ListingCardProps,
  type ListingGridProps,
  type ModalProps,
  type ModerationBadgeProps,
  type ModerationState,
  type PoweredByAgenCProps,
  type ProviderCardProps,
  type ReferrerDisclosureProps,
  type ReviewPanelProps,
  type SpinnerProps,
  type StateKind,
  type StateMessageProps,
  type TaskTimelineProps,
  type ThemableProps,
  type UseAgentVerificationOptions,
  type UseAgentVerificationResult,
  type VerifiedBadgeProps,
} from "./components/index.js";

// Shared types (the public contract for the hooks/components agents).
export type {
  Address,
  AgencContextValue,
  AgencNetwork,
  AgencProviderConfig,
  CreateReadTransportConfig,
  DecodedProgramAccount,
  GpaReadSource,
  IndexerAgentTrackRecord,
  IndexerConfig,
  IndexerHire,
  IndexerListing,
  ListActiveListingsOptions,
  MarketplaceClient,
  ReadListingResult,
  ReadTransport,
  ReferrerCapability,
  ReferrerConfig,
  ServiceListing,
  TransactionSigner,
  ValidatedReferrerConfig,
} from "./types.js";
