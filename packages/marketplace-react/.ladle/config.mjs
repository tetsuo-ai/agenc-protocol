/**
 * Ladle config for @tetsuo-ai/marketplace-react component stories.
 *
 * Ladle (Vite-native) renders every component's states (default / loading /
 * error / empty) for visual smoke + the axe accessibility check. Stories live
 * in `src/components/**.stories.tsx`.
 *
 * Run:
 *   npm run ladle        # dev server at http://localhost:61000
 *   npm run ladle:build  # static build into ./build (for a CI screenshot job)
 */
export default {
  stories: "src/components/**/*.stories.{ts,tsx}",
  defaultStory: "",
  addons: {
    a11y: { enabled: true },
    theme: { enabled: true, defaultState: "dark" },
    width: { enabled: true },
  },
};
