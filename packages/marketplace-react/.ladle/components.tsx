/**
 * Ladle global provider — loads the AgenC theme so every story renders styled.
 *
 * Component stories that need the live `AgencProvider` (the connected
 * `HireButton`) wrap themselves with a fixture provider locally; this global
 * only ensures the `--agenc-*` token sheet + component recipes are present and
 * frames the canvas on the dark void background.
 */
import type { GlobalProvider } from "@ladle/react";
import "../src/theme/agenc-tokens.css";
import "../src/components/agenc-components.css";

export const Provider: GlobalProvider = ({ children }) => (
  <div
    className="agenc"
    style={{
      background: "var(--agenc-void)",
      color: "var(--agenc-text)",
      minHeight: "100vh",
      padding: "24px",
      fontFamily:
        "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    }}
  >
    {children}
  </div>
);
