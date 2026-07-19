/* ============================================================================
 * VENDORED — do not hand-edit for brand changes; re-sync from source.
 *
 * Source repo:   agenc-ui-design-skill (sibling repo, NOT importable in CI)
 * Source path:   tokens/tailwind.config.cjs
 * Source commit: c842bba8eb9e8d029a13fbfd111686f831cd566f (2026-04-29)
 * Vendored into: packages/marketplace-react/src/theme/agenc-tailwind-preset.cjs
 * Reason:        cross-repo imports are impossible in CI; consumers read the
 *                AgenC Tailwind preset FROM this package via
 *                "@tetsuo-ai/marketplace-react/tailwind-preset".
 * Local adaptation: export Tailwind's dependency-free plugin descriptor shape
 *                directly so importing this optional preset never requires
 *                Tailwind from the React package itself.
 * Resync:        copy tokens/tailwind.config.cjs from agenc-ui-design-skill
 *                HEAD, preserve the local plugin-descriptor adaptation, and
 *                update the commit line above.
 * ============================================================================
 */

/**
 * Tetsuo.ai / AgenC Tailwind config fragment.
 *
 * Drop-in extension for an existing Tailwind v3 project (works alongside
 * shadcn/ui's default config). Colors are sRGB hex.
 *
 * Usage in your tailwind.config.{js,cjs,ts}:
 *
 *   const tetsuo = require('./path/to/tokens/tailwind.config.cjs');
 *   module.exports = {
 *     content: [...],
 *     theme: {
 *       extend: {
 *         ...tetsuo.theme.extend,
 *       },
 *     },
 *     plugins: [tetsuo.plugin],
 *   };
 */

const colors = {
  // AgenC neon (canonical product palette)
  agenc: {
    void: "#0A0612",
    surface: "#16102A",
    "surface-2": "#221638",
    "surface-3": "#2E1A4A",
    violet: "#7B3FFF",
    magenta: "#FF2E93",
    orange: "#FF6B1A",
    cyan: "#48C8EF",
    grid: "#3A1F66",
    text: "#F5F0FF",
    "text-muted": "#B8A8D9",
    "text-dim": "#6E5C8F",
    success: "#3FFFA0",
    warning: "#FFC53F",
    danger: "#FF3D3D",
    border: "#2E1A4A",
    "border-strong": "#4A2E7A",
  },
  // Tetsuo.ai noir (marketing / community)
  tetsuo: {
    noir: "#0A0A0A",
    "noir-2": "#141414",
    paper: "#F8F5E9",
    "akira-red": "#E30426",
    "akira-red-bright": "#FA1232",
    blood: "#7A0000",
    cyan: "#48C8EF",
    magenta: "#D01D7D",
    "synth-pink": "#EF5EC2",
    "synth-pink-soft": "#F3A8CE",
    "synth-purple": "#7B3FFF",
    "synth-eggplant": "#441535",
  },
};

const backgroundImage = {
  "agenc-gradient":
    "linear-gradient(135deg, #7B3FFF 0%, #FF2E93 60%, #FF6B1A 100%)",
  "agenc-gradient-cool": "linear-gradient(135deg, #48C8EF 0%, #7B3FFF 100%)",
  "agenc-gradient-text":
    "linear-gradient(90deg, #7B3FFF 0%, #FF2E93 50%, #FF6B1A 100%)",
  "tetsuo-gradient-glitch": "linear-gradient(90deg, #48C8EF 0%, #D01D7D 100%)",
  "tetsuo-gradient-synth":
    "linear-gradient(135deg, #441535 0%, #D01D7D 50%, #EF5EC2 100%)",
  // Synthwave grid floor — pair with a perspective transform on a child
  "agenc-grid-floor":
    "linear-gradient(transparent 95%, #3A1F66 95%), linear-gradient(90deg, transparent 95%, #3A1F66 95%)",
};

const boxShadow = {
  "glow-violet":
    "0 0 24px rgba(123, 63, 255, 0.4), 0 0 48px rgba(123, 63, 255, 0.2)",
  "glow-magenta":
    "0 0 24px rgba(255, 46, 147, 0.4), 0 0 48px rgba(255, 46, 147, 0.2)",
  "glow-cyan":
    "0 0 24px rgba(72, 200, 239, 0.4), 0 0 48px rgba(72, 200, 239, 0.2)",
  "glow-orange":
    "0 0 24px rgba(255, 107, 26, 0.4), 0 0 48px rgba(255, 107, 26, 0.2)",
  "glow-akira":
    "0 0 24px rgba(227, 4, 38, 0.5), 0 0 64px rgba(227, 4, 38, 0.25)",
};

const fontFamily = {
  // Display: jagged / glitch / cyberpunk. Pick one and load via @font-face.
  "agenc-display": [
    '"Audiowide"',
    '"Major Mono Display"',
    "system-ui",
    "sans-serif",
  ],
  // Body: clean geometric sans
  "agenc-body": ['"Geist"', '"Inter"', "system-ui", "sans-serif"],
  // Mono: for HUD / status / readouts
  "agenc-mono": [
    '"JetBrains Mono"',
    '"IBM Plex Mono"',
    "ui-monospace",
    "monospace",
  ],
};

const fontSize = {
  // Display scale skews dramatic — these are AgenC-specific overrides.
  "display-xs": ["2rem", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
  "display-sm": ["2.5rem", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
  "display-md": ["3.5rem", { lineHeight: "1.0", letterSpacing: "-0.03em" }],
  "display-lg": ["5rem", { lineHeight: "0.95", letterSpacing: "-0.04em" }],
  "display-xl": ["7rem", { lineHeight: "0.9", letterSpacing: "-0.04em" }],
};

// Plugin: utilities that aren't trivially expressible as theme extensions.
const tetsuoPlugin = {
  // Tailwind v3's `plugin(handler)` helper returns exactly this
  // `{ handler, config }` descriptor. Keeping the descriptor local prevents an
  // optional preset export from creating a runtime dependency on Tailwind.
  handler({ addUtilities, addComponents }) {
    addUtilities({
      // Chromatic aberration glitch text — drop on any text element.
      ".text-glitch": {
        position: "relative",
        color: "#F8F5E9",
        textShadow: "2px 0 0 #48C8EF, -2px 0 0 #D01D7D",
      },
      ".text-glitch-strong": {
        position: "relative",
        color: "#F8F5E9",
        textShadow:
          "3px 0 0 #48C8EF, -3px 0 0 #D01D7D, 0 0 8px rgba(255,255,255,0.15)",
      },
      // Neon-stroked outline text
      ".text-neon-stroke": {
        color: "transparent",
        WebkitTextStroke: "1.5px #FF2E93",
        textShadow: "0 0 12px rgba(255, 46, 147, 0.6)",
      },
      // Scanline overlay — apply to a positioned container.
      ".bg-scanlines": {
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.18) 2px, rgba(0,0,0,0.18) 3px)",
      },
      // CRT vignette
      ".bg-vignette": {
        backgroundImage:
          "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.55) 100%)",
      },
    });

    addComponents({
      // HUD frame: corner brackets only, transparent middle.
      ".hud-frame": {
        position: "relative",
        padding: "24px",
        "&::before, &::after": {
          content: '""',
          position: "absolute",
          width: "24px",
          height: "24px",
          borderColor: "#7B3FFF",
          borderStyle: "solid",
        },
        "&::before": {
          top: "0",
          left: "0",
          borderWidth: "2px 0 0 2px",
        },
        "&::after": {
          bottom: "0",
          right: "0",
          borderWidth: "0 2px 2px 0",
        },
      },
    });
  },
  config: undefined,
};

module.exports = {
  theme: {
    extend: {
      colors,
      backgroundImage,
      boxShadow,
      fontFamily,
      fontSize,
    },
  },
  plugin: tetsuoPlugin,
};
