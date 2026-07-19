import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import postcss from "postcss";
import type { AcceptedPlugin } from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";
import { describe, expect, it } from "vitest";

type PluginDescriptor = {
  readonly handler: (api: {
    addUtilities(utilities: Record<string, unknown>): void;
    addComponents(components: Record<string, unknown>): void;
  }) => void;
  readonly config: undefined;
};

type AgenCTailwindPreset = {
  readonly theme: Config["theme"];
  readonly plugin: PluginDescriptor;
};

const require = createRequire(import.meta.url);
const presetPath = require.resolve("../src/theme/agenc-tailwind-preset.cjs");
const preset = require(presetPath) as AgenCTailwindPreset;

describe("AgenC Tailwind preset package boundary", () => {
  it("exports Tailwind v3's dependency-free plugin descriptor", async () => {
    expect(typeof preset.plugin.handler).toBe("function");
    expect(preset.plugin.config).toBeUndefined();

    const source = await readFile(presetPath, "utf8");
    expect(source).not.toMatch(/require\(["']tailwindcss(?:\/plugin)?["']\)/);
  });

  it("compiles theme, utility, and component output with pinned Tailwind v3", async () => {
    const config = {
      content: [
        {
          raw: '<div class="bg-agenc-void text-glitch hud-frame"></div>',
          extension: "html",
        },
      ],
      corePlugins: { preflight: false },
      theme: preset.theme,
      plugins: [preset.plugin],
    } as Config;

    // Tailwind and this workspace intentionally resolve independently pinned
    // PostCSS patch releases. They share the runtime plugin contract, while
    // their nominal TypeScript declarations are distinct module instances.
    const plugin = tailwindcss(config) as unknown as AcceptedPlugin;
    const result = await postcss([plugin]).process(
      "@tailwind components;\n@tailwind utilities;",
      { from: undefined },
    );

    expect(result.css).toContain(".hud-frame");
    expect(result.css).toContain(".bg-agenc-void");
    expect(result.css).toContain(".text-glitch");
  });
});
