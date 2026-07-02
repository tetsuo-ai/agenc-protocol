// The sandbox ENVIRONMENT SEAM: one resolution point deciding which cluster,
// RPC endpoints, attestor, and fixtures every sandbox helper targets.
// Browser-safe: `process` is only touched behind `typeof process` guards, and
// node:fs is only loaded through a dynamic import inside that guard — the
// browser bundle never references it statically.
import { SANDBOX_FIXTURES, type SandboxFixtures } from "./fixtures.js";

/** Default devnet HTTP RPC endpoint used by the sandbox helpers. */
export const SANDBOX_DEVNET_RPC_URL = "https://api.devnet.solana.com";
/** Default devnet WebSocket endpoint used by the sandbox helpers. */
export const SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL =
  "wss://api.devnet.solana.com";
/** Default localnet HTTP RPC endpoint (`solana-test-validator` default port). */
export const SANDBOX_LOCALNET_RPC_URL = "http://127.0.0.1:8899";
/**
 * Default localnet WebSocket endpoint. `solana-test-validator` serves PubSub
 * on RPC port + 1 (8900), so this is NOT derivable from the HTTP URL.
 */
export const SANDBOX_LOCALNET_RPC_SUBSCRIPTIONS_URL = "ws://127.0.0.1:8900";

/**
 * Default endpoint of the hosted devnet sandbox moderation auto-attestor.
 *
 * The service itself ships in Phase 2.3 (PLAN.md P2.3 — a devnet-only service
 * holding the devnet moderation authority key, rate-limited per IP). This
 * constant is updated when the human operator deploys it; until then, calls
 * against the default endpoint fail at the network layer, and you can point
 * `requestSandboxAttestation` at a self-hosted instance via `input.endpoint`
 * or the `AGENC_SANDBOX_ATTESTOR_URL` environment variable.
 */
export const DEFAULT_SANDBOX_ATTESTOR_URL =
  "https://sandbox.agenc.tech/api/sandbox/attest";

/**
 * Shipped default for the hosted marketplace moderation API — the open,
 * self-hostable service in `github.com/tetsuo-ai/agenc-moderation-api`
 * (WP-C1/P1.5), deployed at `attest.agenc.ag`. It accepts the same request
 * body this client sends (`{ spec | specUri, listing? }`) and returns
 * `{ verdict, riskScore, specHash, attestation, policyHash }`.
 *
 * This is the LISTING moderation route. Applies only when nothing else
 * resolves and the cluster is NOT localnet/devnet — a local sandbox points at
 * its own attestor via `.localnet/env.json`'s `moderationUrl` /
 * `AGENC_SANDBOX_MODERATION_URL`. Override for any cluster with that env var
 * or the `endpoint` option.
 */
export const DEFAULT_HOSTED_MODERATION_LISTINGS_URL =
  "https://attest.agenc.ag/v1/moderation/listings";

/** The clusters the sandbox environment seam can describe. */
export const SANDBOX_CLUSTERS = ["localnet", "devnet", "mainnet"] as const;

/**
 * A sandbox environment cluster. `"mainnet"` exists so the `.localnet/env.json`
 * convention can describe a future hosted surface, but the sandbox helpers
 * themselves stay devnet/localnet-only: {@link resolveSandboxEnvironment}
 * ships no mainnet defaults, and `createSandboxClient`'s cluster guard still
 * refuses non-devnet, non-local RPC URLs.
 */
export type SandboxCluster = (typeof SANDBOX_CLUSTERS)[number];

/**
 * Explicit overrides for {@link resolveSandboxEnvironment}. Every field beats
 * the corresponding `AGENC_SANDBOX_*` environment variable, which in turn
 * beats the shipped default.
 */
export interface ResolveSandboxEnvironmentOptions {
  /** Target cluster (beats `AGENC_SANDBOX_CLUSTER`; default `"devnet"`). */
  cluster?: SandboxCluster;
  /** HTTP RPC endpoint (beats `AGENC_SANDBOX_RPC_URL`). */
  rpcUrl?: string;
  /** WebSocket endpoint (beats `AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL`). */
  rpcSubscriptionsUrl?: string;
  /** Moderation auto-attestor endpoint (beats `AGENC_SANDBOX_ATTESTOR_URL`). */
  attestorUrl?: string;
  /**
   * Moderation-scan endpoint — the Phase-3 storefront
   * `POST /api/moderation/listings` surface `requestListingModeration` posts
   * to (beats `AGENC_SANDBOX_MODERATION_URL`; the `.localnet/env.json`
   * convention carries it as the `moderationUrl` field). Unlike the other
   * endpoints there is NO shipped default: when neither this option nor the
   * env var is set, the resolved value is `null`.
   */
  moderationUrl?: string;
  /**
   * Fixtures object (beats `AGENC_SANDBOX_FIXTURES`). Passing this is also
   * the browser-side escape hatch: the env-var path is a FILE path, which
   * only Node can read.
   */
  fixtures?: SandboxFixtures;
}

/** The fully resolved sandbox environment. See {@link resolveSandboxEnvironment}. */
export interface SandboxEnvironment {
  /** Resolved cluster (`"devnet"` unless overridden). */
  cluster: SandboxCluster;
  /** Resolved HTTP RPC endpoint. */
  rpcUrl: string;
  /** Resolved WebSocket endpoint. */
  rpcSubscriptionsUrl: string;
  /** Resolved moderation auto-attestor endpoint. */
  attestorUrl: string;
  /**
   * Resolved moderation-scan endpoint (`AGENC_SANDBOX_MODERATION_URL` /
   * env-file `moderationUrl`), or `null` when no endpoint is configured —
   * there is no shipped default while the hosted moderation API (PLAN.md
   * P3.4) is not deployed.
   */
  moderationUrl: string | null;
  /** Resolved sandbox fixtures (shipped, file-loaded, or explicit). */
  fixtures: SandboxFixtures;
}

/**
 * Read `process.env` behind a `typeof` guard so this module stays
 * browser-safe: in browsers `process` does not exist and every
 * `AGENC_SANDBOX_*` variable is simply absent.
 */
function readSandboxEnvVars(): Record<string, string | undefined> {
  if (
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    process.env !== null
  ) {
    return process.env;
  }
  return {};
}

/** Trimmed env-var value, with empty/whitespace-only treated as unset. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Validate a cluster string (env vars arrive untyped). */
function parseSandboxCluster(value: string, source: string): SandboxCluster {
  if ((SANDBOX_CLUSTERS as readonly string[]).includes(value)) {
    return value as SandboxCluster;
  }
  throw new TypeError(
    `${source} must be one of ${SANDBOX_CLUSTERS.join(" | ")}; got ${JSON.stringify(value)}`,
  );
}

/**
 * Derive the WebSocket endpoint matching a custom HTTP RPC endpoint:
 * `http://` → `ws://`, `https://` → `wss://`, host/port/path unchanged.
 * Non-http(s) inputs (already `ws(s)://`) pass through untouched.
 *
 * NOTE: a default `solana-test-validator` serves PubSub on port 8900 (RPC
 * port + 1), which this same-port derivation cannot know — localnet stacks
 * should set `AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL` (the `.localnet/env.json`
 * convention carries `rpcSubscriptionsUrl` for exactly this reason).
 */
export function deriveSandboxSubscriptionsUrl(rpcUrl: string): string {
  if (/^https:\/\//i.test(rpcUrl)) {
    return `wss://${rpcUrl.slice("https://".length)}`;
  }
  if (/^http:\/\//i.test(rpcUrl)) {
    return `ws://${rpcUrl.slice("http://".length)}`;
  }
  return rpcUrl;
}

/** Minimal structural check that a parsed JSON file is a fixtures object. */
function assertFixturesShape(
  parsed: unknown,
  filePath: string,
): SandboxFixtures {
  const problems: string[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("not a JSON object");
  } else {
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.seeded !== "boolean") {
      problems.push("`seeded` must be a boolean");
    }
    if (candidate.cluster !== "devnet" && candidate.cluster !== "localnet") {
      problems.push('`cluster` must be "devnet" or "localnet"');
    }
    if (typeof candidate.programId !== "string") {
      problems.push("`programId` must be a string");
    }
    if (!Array.isArray(candidate.providers)) {
      problems.push("`providers` must be an array");
    }
    if (!Array.isArray(candidate.listings)) {
      problems.push("`listings` must be an array");
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `sandbox fixtures file ${filePath} (from AGENC_SANDBOX_FIXTURES) does ` +
        `not match the SandboxFixtures shape: ${problems.join("; ")}`,
    );
  }
  return parsed as SandboxFixtures;
}

/**
 * Lazy-read a fixtures JSON file (Node only). node:fs is loaded through a
 * dynamic import INSIDE the `typeof process` guard so the browser bundle of
 * `./sandbox` never references it statically and never executes this path.
 */
async function readSandboxFixturesFile(
  filePath: string,
): Promise<SandboxFixtures> {
  if (typeof process === "undefined") {
    throw new Error(
      `AGENC_SANDBOX_FIXTURES points at a file path (${filePath}), which can ` +
        `only be read in Node. In a browser, pass the fixtures object via ` +
        `resolveSandboxEnvironment({ fixtures }) instead.`,
    );
  }
  // The specifier is held in a const so bundlers cannot statically analyze a
  // Node builtin out of this Node-only branch (and esbuild cannot rewrite the
  // literal): the browser bundle keeps a plain, never-executed dynamic import.
  const nodeFsSpecifier = "node:fs/promises";
  const { readFile } = (await import(
    /* @vite-ignore */ /* webpackIgnore: true */ nodeFsSpecifier
  )) as typeof import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new Error(
      `could not read sandbox fixtures file ${filePath} (from ` +
        `AGENC_SANDBOX_FIXTURES) — does the file exist? For localnet, run ` +
        `the localnet stack (scripts/localnet-up.mjs at the repo root) so ` +
        `the seeding step writes it.`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `sandbox fixtures file ${filePath} (from AGENC_SANDBOX_FIXTURES) is ` +
        `not valid JSON`,
      { cause },
    );
  }
  return assertFixturesShape(parsed, filePath);
}

/**
 * Resolve the sandbox environment — THE switchover point between localnet,
 * devnet, and a future hosted surface. Every sandbox helper
 * (`createSandboxClient`, `requestSandboxAttestation`, the
 * `examples/devnet-first-hire.ts` flow) routes its defaults through this
 * function, so retargeting a whole workflow is a matter of exporting
 * variables (or editing the one `.localnet/env.json` file a Node runner
 * derives them from) — never a refactor.
 *
 * ## Resolution order (per field)
 *
 * 1. **Explicit options** passed to this function (or to the helper that
 *    forwards into it).
 * 2. **`AGENC_SANDBOX_*` environment variables**, read via a guarded
 *    `typeof process` check — absent in browsers, where this step is a no-op:
 *    `AGENC_SANDBOX_CLUSTER`, `AGENC_SANDBOX_RPC_URL`,
 *    `AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL`, `AGENC_SANDBOX_ATTESTOR_URL`,
 *    `AGENC_SANDBOX_MODERATION_URL`,
 *    `AGENC_SANDBOX_FIXTURES` (a JSON file path — Node only).
 * 3. **Shipped defaults**: public devnet RPC endpoints,
 *    {@link DEFAULT_SANDBOX_ATTESTOR_URL}, and the shipped
 *    {@link SANDBOX_FIXTURES} (for cluster `"localnet"` the RPC defaults are
 *    the `solana-test-validator` ports instead — see
 *    {@link SANDBOX_LOCALNET_RPC_URL}). The moderation-scan endpoint
 *    (`moderationUrl`) has NO shipped default and resolves to `null` when
 *    nothing sets it.
 *
 * When `rpcUrl` is overridden but `rpcSubscriptionsUrl` is not, the WebSocket
 * endpoint is derived from it (`http` → `ws`, `https` → `wss`, same
 * host/port/path) so confirmations come from the same cluster sends go to.
 *
 * ## The three stages
 *
 * | Stage             | How to point the SDK at it                                                                                                              |
 * | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
 * | **localnet (now)** | Run the one-command localnet stack (`scripts/localnet-up.mjs`, repo root); it writes `.localnet/env.json` and Node runners export the `AGENC_SANDBOX_*` variables from it (`CLUSTER=localnet`, localhost RPC, local attestor or `null`, `AGENC_SANDBOX_FIXTURES=.localnet/fixtures.json`). |
 * | **devnet (later)** | Unset every `AGENC_SANDBOX_*` variable — the shipped defaults (public devnet + {@link DEFAULT_SANDBOX_ATTESTOR_URL} + shipped fixtures) take over. No code change. |
 * | **hosted (later)** | Export `AGENC_SANDBOX_RPC_URL` / `AGENC_SANDBOX_ATTESTOR_URL` (or pass options) pointing at the hosted endpoints — a one-file env change, never a refactor. |
 *
 * Mainnet note: `"mainnet"` is representable (the env-file convention covers
 * it) but has no shipped RPC defaults — resolving cluster `"mainnet"` without
 * an explicit `rpcUrl` throws, and `createSandboxClient`'s guard still
 * refuses non-devnet/non-local URLs.
 *
 * @param options - Explicit overrides; see
 *   {@link ResolveSandboxEnvironmentOptions}.
 * @returns The resolved `{ cluster, rpcUrl, rpcSubscriptionsUrl, attestorUrl,
 *   moderationUrl, fixtures }`.
 * @throws TypeError when a cluster value (option or env var) is not
 *   `localnet`/`devnet`/`mainnet`.
 * @throws Error when cluster `"mainnet"` resolves without an explicit
 *   `rpcUrl`, or when `AGENC_SANDBOX_FIXTURES` points at an unreadable /
 *   malformed fixtures file.
 *
 * @example
 * ```ts
 * // Local stack running? `AGENC_SANDBOX_CLUSTER=localnet` (plus the other
 * // exports from .localnet/env.json) retargets this without code changes:
 * const env = await resolveSandboxEnvironment();
 * const sandbox = await createSandboxClient({ rpcUrl: env.rpcUrl });
 * ```
 */
export async function resolveSandboxEnvironment(
  options: ResolveSandboxEnvironmentOptions = {},
): Promise<SandboxEnvironment> {
  const envVars = readSandboxEnvVars();
  const envCluster = nonEmpty(envVars.AGENC_SANDBOX_CLUSTER);
  const envRpcUrl = nonEmpty(envVars.AGENC_SANDBOX_RPC_URL);
  const envSubscriptionsUrl = nonEmpty(
    envVars.AGENC_SANDBOX_RPC_SUBSCRIPTIONS_URL,
  );
  const envAttestorUrl = nonEmpty(envVars.AGENC_SANDBOX_ATTESTOR_URL);
  const envModerationUrl = nonEmpty(envVars.AGENC_SANDBOX_MODERATION_URL);
  const envFixturesPath = nonEmpty(envVars.AGENC_SANDBOX_FIXTURES);

  const cluster =
    options.cluster ??
    (envCluster !== undefined
      ? parseSandboxCluster(envCluster, "AGENC_SANDBOX_CLUSTER")
      : "devnet");

  const explicitRpcUrl = options.rpcUrl ?? envRpcUrl;
  let rpcUrl: string;
  if (explicitRpcUrl !== undefined) {
    rpcUrl = explicitRpcUrl;
  } else if (cluster === "localnet") {
    rpcUrl = SANDBOX_LOCALNET_RPC_URL;
  } else if (cluster === "devnet") {
    rpcUrl = SANDBOX_DEVNET_RPC_URL;
  } else {
    throw new Error(
      `resolveSandboxEnvironment: cluster "mainnet" has no shipped RPC ` +
        `default (the sandbox is devnet/localnet-only) — pass rpcUrl ` +
        `explicitly or set AGENC_SANDBOX_RPC_URL.`,
    );
  }

  const rpcSubscriptionsUrl =
    options.rpcSubscriptionsUrl ??
    envSubscriptionsUrl ??
    (explicitRpcUrl !== undefined
      ? deriveSandboxSubscriptionsUrl(explicitRpcUrl)
      : cluster === "localnet"
        ? SANDBOX_LOCALNET_RPC_SUBSCRIPTIONS_URL
        : SANDBOX_DEVNET_RPC_SUBSCRIPTIONS_URL);

  const attestorUrl =
    options.attestorUrl ?? envAttestorUrl ?? DEFAULT_SANDBOX_ATTESTOR_URL;

  // Moderation endpoint resolution: explicit option > env var > shipped hosted
  // default (mainnet only) > null. The hosted default is the live, open
  // marketplace moderation API (WP-C1); localnet/devnet resolve to null unless
  // their env-file/env-var names a local attestor, so a sandbox never silently
  // dials the mainnet service.
  const moderationUrl =
    options.moderationUrl ??
    envModerationUrl ??
    (cluster === "mainnet" ? DEFAULT_HOSTED_MODERATION_LISTINGS_URL : null);

  const fixtures =
    options.fixtures ??
    (envFixturesPath !== undefined
      ? await readSandboxFixturesFile(envFixturesPath)
      : SANDBOX_FIXTURES);

  return {
    cluster,
    rpcUrl,
    rpcSubscriptionsUrl,
    attestorUrl,
    moderationUrl,
    fixtures,
  };
}
