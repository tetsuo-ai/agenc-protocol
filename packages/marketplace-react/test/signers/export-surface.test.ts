/**
 * Export-surface guard for the test-only mock embedded wallet (finding #3).
 *
 * `createMockEmbeddedWallet` holds a private key IN-PROCESS, so it must NOT be
 * reachable from the production barrels (the package root or `./signers`) where
 * a third-party integrator could discover it via IDE autocomplete and ship it.
 * It belongs only on the dedicated `./testing` subpath.
 *
 * REVERT-SENSITIVITY: against the pre-fix code (mock re-exported from the root
 * + ./signers barrels) the "absent from root/signers" assertions go red.
 */
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import * as signers from "../../src/signers/index.js";
import * as testing from "../../src/testing/index.js";

describe("mock embedded wallet export surface (finding #3)", () => {
  it("is NOT exported from the package root barrel", () => {
    expect("createMockEmbeddedWallet" in root).toBe(false);
    expect(
      (root as Record<string, unknown>).createMockEmbeddedWallet,
    ).toBeUndefined();
  });

  it("is NOT exported from the ./signers barrel", () => {
    expect("createMockEmbeddedWallet" in signers).toBe(false);
    expect(
      (signers as Record<string, unknown>).createMockEmbeddedWallet,
    ).toBeUndefined();
  });

  it("IS exported from the ./testing subpath", () => {
    expect("createMockEmbeddedWallet" in testing).toBe(true);
    expect(typeof testing.createMockEmbeddedWallet).toBe("function");
  });

  it("the production embedded-wallet signer is still on root + signers", () => {
    // The relocation must not strip the REAL production adapter.
    expect(typeof root.signerFromEmbeddedWallet).toBe("function");
    expect(typeof signers.signerFromEmbeddedWallet).toBe("function");
  });
});
