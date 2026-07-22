// @vitest-environment node

import { describe, expect, it } from "vitest";

import checkoutViteConfig from "../../test-apps/checkout/vite.config.js";
import checkoutPlaywrightConfig from "./playwright.config.js";

describe("checkout browser fixture server binding", () => {
  it("binds the same explicit loopback address that Playwright probes", () => {
    const expectedOrigin = "http://127.0.0.1:3200";
    const webServer = checkoutPlaywrightConfig.webServer;

    expect(Array.isArray(webServer)).toBe(false);
    expect(webServer).toMatchObject({
      url: `${expectedOrigin}/`,
      reuseExistingServer: false,
    });
    expect(checkoutViteConfig.server).toMatchObject({
      host: "127.0.0.1",
      port: 3200,
      strictPort: true,
    });
    expect(checkoutViteConfig.preview).toMatchObject({
      host: "127.0.0.1",
      port: 3200,
      strictPort: true,
    });
  });
});
