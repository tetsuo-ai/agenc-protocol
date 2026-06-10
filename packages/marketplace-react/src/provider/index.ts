/**
 * Provider surface barrel.
 * @module provider
 */
export { AgencProvider, type AgencProviderProps } from "./AgencProvider.js";
export { AgencContext, useAgencContext } from "./context.js";
export {
  REFERRER_FEE_BPS_MAX,
  REFERRER_FEE_BPS_MIN,
  resolveReferrerCapability,
  validateReferrerConfig,
} from "./referrer.js";
export {
  deriveSubscriptionsUrl,
  resolveEndpoints,
  type ResolvedEndpoints,
} from "./network.js";
