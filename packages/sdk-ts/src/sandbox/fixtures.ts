// Seeded devnet sandbox fixtures (PLAN.md P2.4).
//
// `fixtures.json` is the machine-written record of the ~10 provider agents and
// Active service listings seeded on devnet by `scripts/seed-devnet-sandbox.mjs`.
// Until the devnet full-surface redeploy (P2.2) and the seeding run happen, the
// file ships with `seeded: false` and empty arrays — the helpers below throw a
// descriptive error in that state so consumers learn to check `seeded` instead
// of silently iterating an empty list.
//
// Browser-safe: pure data + pure functions, no Node built-ins.
import type { Address } from "@solana/kit";
import type { ListingCategory } from "../values/index.js";
import fixturesJson from "./fixtures.json";

/**
 * One seeded sandbox provider: a registered devnet agent whose authority key
 * is held server-side by the seeding operator (you can hire it, but only the
 * operator can act as it).
 */
export interface SandboxProviderFixture {
  /** The provider's wallet authority (base58). */
  authority: Address;
  /** The provider's AgentRegistration PDA. */
  agent: Address;
  /** Human-readable provider name (also the listing display name). */
  name: string;
}

/** One seeded Active ServiceListing on devnet, hireable at a known address. */
export interface SandboxListingFixture {
  /** The ServiceListing PDA. */
  address: Address;
  /** The provider AgentRegistration PDA this listing belongs to (matches {@link SandboxProviderFixture.agent}). */
  provider: Address;
  /** LISTING_METADATA v1 display name. */
  name: string;
  /** Canonical LISTING_METADATA v1 category token. */
  category: ListingCategory;
  /**
   * Listing price in lamports as a JSON-safe number (devnet fixture prices are
   * tiny; numbers are exact below 2^53 ≈ 9M SOL). Convert with `BigInt(...)`
   * for `expectedPrice`.
   */
  priceLamports: number;
}

/**
 * The cluster a fixtures file was seeded against. The SHIPPED
 * `src/sandbox/fixtures.json` is always `"devnet"`; a localnet stack writes
 * its own `"localnet"` fixtures file (e.g. `.localnet/fixtures.json`) and
 * routes it in through the environment seam (`AGENC_SANDBOX_FIXTURES` /
 * `resolveSandboxEnvironment({ fixtures })`). Never mainnet.
 */
export type SandboxFixturesCluster = "devnet" | "localnet";

/** The shape of `src/sandbox/fixtures.json`. */
export interface SandboxFixtures {
  /**
   * `false` until `scripts/seed-devnet-sandbox.mjs` has populated devnet and
   * rewritten the file. ALWAYS check this (or use {@link sandboxListings} /
   * {@link sandboxProviders}, which check it for you).
   */
  seeded: boolean;
  /** Fixtures are devnet- or localnet-only. Never point these at mainnet. */
  cluster: SandboxFixturesCluster;
  /** The agenc-coordination program ID the fixtures were seeded against. */
  programId: Address;
  /** Devnet slot observed when the seeding run finished, or `null` when unseeded. */
  seededAtSlot: number | null;
  providers: SandboxProviderFixture[];
  listings: SandboxListingFixture[];
}

/**
 * The seeded devnet sandbox fixtures, straight from `fixtures.json`.
 *
 * Ships with `seeded: false` today: the devnet full-surface redeploy (PLAN.md
 * P2.2) is pending, and the seeding script populates the file afterwards. The
 * cast below (through `unknown`, because `Address` is a branded string) is
 * the one place the JSON's plain strings are branded as `Address` /
 * `ListingCategory` — the seeding script only ever writes base58 addresses
 * derived through the SDK's own PDA helpers and canonical LISTING_METADATA
 * v1 category tokens.
 */
export const SANDBOX_FIXTURES: SandboxFixtures =
  fixturesJson as unknown as SandboxFixtures;

/** Thrown by the fixture helpers while the sandbox is not seeded yet. */
export class SandboxNotSeededError extends Error {
  constructor(what: string) {
    super(
      `The devnet sandbox is not seeded yet, so there are no ${what} fixtures to use. ` +
        `SANDBOX_FIXTURES.seeded is false in this build of @tetsuo-ai/marketplace-sdk: ` +
        `the devnet full-surface redeploy (PLAN.md P2.2) and the seeding run ` +
        `(scripts/seed-devnet-sandbox.mjs) have not happened yet, or you are on a ` +
        `pre-seeding release. Check SANDBOX_FIXTURES.seeded before using fixtures, ` +
        `and upgrade the SDK once a seeded release ships.`,
    );
    this.name = "SandboxNotSeededError";
  }
}

/**
 * Assert that the sandbox fixtures are seeded.
 *
 * @throws {@link SandboxNotSeededError} when `fixtures.seeded` is `false`.
 */
export function assertSandboxSeeded(
  fixtures: SandboxFixtures = SANDBOX_FIXTURES,
): void {
  if (!fixtures.seeded) throw new SandboxNotSeededError("sandbox");
}

/**
 * The seeded devnet listings, guarded: throws a descriptive
 * {@link SandboxNotSeededError} instead of returning an empty array while the
 * sandbox is unseeded.
 */
export function sandboxListings(
  fixtures: SandboxFixtures = SANDBOX_FIXTURES,
): readonly SandboxListingFixture[] {
  if (!fixtures.seeded) throw new SandboxNotSeededError("listing");
  return fixtures.listings;
}

/**
 * The seeded devnet provider agents, guarded: throws a descriptive
 * {@link SandboxNotSeededError} instead of returning an empty array while the
 * sandbox is unseeded.
 */
export function sandboxProviders(
  fixtures: SandboxFixtures = SANDBOX_FIXTURES,
): readonly SandboxProviderFixture[] {
  if (!fixtures.seeded) throw new SandboxNotSeededError("provider");
  return fixtures.providers;
}
