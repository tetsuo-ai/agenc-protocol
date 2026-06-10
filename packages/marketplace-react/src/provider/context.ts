/**
 * The React context object + the internal `useAgencContext()` hook.
 *
 * Split from the component file so the context identity is stable and so hooks
 * can import the context without pulling the JSX provider into their module
 * graph. SSR-safe: this module only calls `createContext` at import time, never
 * touches `window`.
 *
 * @module provider/context
 */
import { createContext, useContext } from "react";
import { t } from "../strings/index.js";
import type { AgencContextValue } from "../types.js";

/**
 * The AgenC context. `null` until a `<AgencProvider>` mounts above the consumer
 * — {@link useAgencContext} turns that into a clear developer error.
 */
export const AgencContext = createContext<AgencContextValue | null>(null);
AgencContext.displayName = "AgencContext";

/**
 * Read the AgenC context. INTERNAL hook the package's own hooks build on; also
 * exported from the package root so downstream hooks (components agent) can
 * reach the resolved transport/client/referrer.
 *
 * @throws Error when called outside a `<AgencProvider>`.
 */
export function useAgencContext(): AgencContextValue {
  const ctx = useContext(AgencContext);
  if (ctx === null) {
    throw new Error(t("provider.missingContext"));
  }
  return ctx;
}
