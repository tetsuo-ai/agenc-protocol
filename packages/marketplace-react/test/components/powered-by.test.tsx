/**
 * PoweredByAgenC href sanitization (finding #4).
 *
 * React does NOT block `javascript:`/`data:` in an anchor href, so an embedder
 * wiring untrusted data into the `href` prop would create a click-to-execute
 * XSS on a money surface. The component now scheme-validates the href (only
 * http/https/mailto) and falls back to DEFAULT_TRUST_HREF otherwise, and emits
 * `rel="noopener noreferrer"` for new-tab links.
 *
 * REVERT-SENSITIVITY: against the pre-fix code (raw `href={href}`) the
 * "javascript: is neutralized" assertion goes red (the anchor keeps the
 * javascript: URL).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  DEFAULT_TRUST_HREF,
  PoweredByAgenC,
} from "../../src/components/index.js";

afterEach(cleanup);

function link(): HTMLAnchorElement {
  return screen.getByRole("link") as HTMLAnchorElement;
}

describe("PoweredByAgenC href sanitization (finding #4)", () => {
  it("neutralizes a javascript: href (falls back to the default trust href)", () => {
    render(<PoweredByAgenC href={"javascript:alert(document.domain)" as string} />);
    const a = link();
    expect(a.getAttribute("href")).toBe(DEFAULT_TRUST_HREF);
    expect(a.getAttribute("href")).not.toMatch(/^javascript:/i);
  });

  it("neutralizes a data: href", () => {
    render(<PoweredByAgenC href={"data:text/html,<script>x</script>" as string} />);
    expect(link().getAttribute("href")).toBe(DEFAULT_TRUST_HREF);
  });

  it("preserves a safe https href", () => {
    render(<PoweredByAgenC href="https://example.com/trust" />);
    expect(link().getAttribute("href")).toBe("https://example.com/trust");
  });

  it("preserves a mailto href", () => {
    render(<PoweredByAgenC href="mailto:hi@example.com" />);
    expect(link().getAttribute("href")).toBe("mailto:hi@example.com");
  });

  it("emits rel='noopener noreferrer' for new-tab links", () => {
    render(<PoweredByAgenC />);
    const a = link();
    expect(a.getAttribute("target")).toBe("_blank");
    const rel = a.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });
});
