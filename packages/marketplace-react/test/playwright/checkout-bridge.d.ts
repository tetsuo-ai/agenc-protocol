/**
 * The `window.__checkout` control channel the checkout SPA exposes for the
 * Playwright harness (see test-apps/checkout/src/App.tsx). Declared here so the
 * spec's `page.evaluate` is typed.
 */
export {};

declare global {
  interface Window {
    __checkout?: {
      buyerAddress: string;
      taskPda: string | null;
      workerReady: boolean;
      accepted: boolean;
      error: string | null;
    };
  }
}
