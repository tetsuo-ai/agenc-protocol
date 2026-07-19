/** Runtime shape of the optional `litesvm` peer. Type-only at module load. */
export type LiteSvmPeer = typeof import("litesvm");

let peerPromise: Promise<LiteSvmPeer> | undefined;

/**
 * Load the node-only LiteSVM peer only when a testing helper is actually used.
 *
 * Keeping this import behind the async helper lets consumers inspect/import the
 * `@tetsuo-ai/marketplace-sdk/testing` surface without installing a native peer
 * they never invoke. Calls that need the VM fail here with an actionable error.
 */
export function loadLiteSvmPeer(): Promise<LiteSvmPeer> {
  if (peerPromise === undefined) {
    peerPromise = import("litesvm").catch((cause: unknown) => {
      peerPromise = undefined;
      throw new Error(
        "@tetsuo-ai/marketplace-sdk/testing could not load its optional " +
          "`litesvm` peer. Install it before using LiteSVM helpers: " +
          "npm install --save-dev litesvm",
        { cause },
      );
    });
  }
  return peerPromise;
}
