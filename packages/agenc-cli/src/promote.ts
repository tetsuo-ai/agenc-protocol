// `agenc promote` — a READONLY diff against the go-live checklist. It never
// signs, never flips config, never touches money paths; it prints pass/fail
// with the exact next action for each gap.
//
// The version matrix mirrors docs/VERSIONING.md §1.1 (published revision 4)
// and §1.1.1 (the explicitly unreleased revision-5 candidate set). Update
// both the document and this constant on a candidate bump or lockstep publish.
// Compatibility is selected by the finalized on-chain surface revision; the
// two sets must never be unioned because the revision-5 write wire deliberately
// fails against revision 4 and the revision-4 writers fail against revision 5.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import {
  address,
  createKeyPairSignerFromBytes,
  getAddressDecoder,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findProtocolConfigPda,
  getProtocolConfigDecoder,
  getProtocolConfigDiscriminatorBytes,
  readSurfaceRevision,
  SURFACE_REVISION_CURRENT,
  SURFACE_REVISION_FULL,
} from "@tetsuo-ai/marketplace-sdk";
import { loadSolanaKeypairFile } from "@tetsuo-ai/agenc-worker";
import { satisfies, validRange } from "semver";
import {
  loadConfig,
  type AgencConfig,
  AgencConfigError,
  CONFIG_FILENAME,
} from "./config.js";

export const SOLANA_MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const AGENC_PROTOCOL_CONFIG_ADDRESS =
  "DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Reviewed live deployment identities. Update only with a verified cutover. */
export const REVIEWED_MAINNET_RELEASES = [
  {
    surfaceRevision: 4,
    programDataAddress: "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw",
    programDataSlot: 431_918_664,
    upgradeAuthority: "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf",
    executableHash:
      "c6ddc7fdc19f59bb1fcd2f0c87582e09fc1959ee3e615f299c909e07854b4199",
    sourceCommit: "097ded12b03d27e8c89d50ad6ed8813493700129",
  },
] as const;

type PackageSupportMatrix = Readonly<Record<string, readonly string[]>>;

/**
 * docs/VERSIONING.md §1.1/§1.1.1 — compatible package versions selected
 * by the finalized deployed surface revision. A `major.minor` entry admits
 * stable patches in that line; a full SemVer entry admits only that reviewed
 * artifact. Entries are oldest first and install hints point at the last entry.
 */
export const SUPPORT_MATRIX_BY_SURFACE_REVISION = {
  4: {
    "@tetsuo-ai/protocol": ["0.3"],
    "@tetsuo-ai/marketplace-sdk": ["0.8", "0.9", "0.10", "0.11"],
    "@tetsuo-ai/agenc-worker": ["0.1"],
    "@tetsuo-ai/marketplace-react": ["0.4"],
    "@tetsuo-ai/marketplace-tools": ["0.4"],
    "@tetsuo-ai/marketplace-mcp": ["0.4"],
    "@tetsuo-ai/marketplace-moderation": ["0.1"],
    // 0.6.1 is the coordinated revision-5 store cutover, despite sharing the
    // pre-1.0 minor with the published revision-4-compatible 0.6.0 artifact.
    "@tetsuo-ai/store-core": ["0.5", "0.6.0"],
  },
  5: {
    "@tetsuo-ai/protocol": ["0.4"],
    "@tetsuo-ai/marketplace-sdk": ["0.12"],
    "@tetsuo-ai/agenc-worker": ["0.2"],
    "@tetsuo-ai/marketplace-react": ["0.5"],
    "@tetsuo-ai/marketplace-tools": ["0.5"],
    "@tetsuo-ai/marketplace-mcp": ["0.5"],
    "@tetsuo-ai/marketplace-moderation": ["0.2"],
    // The external store release contract identifies 0.6.1, not the whole
    // 0.6.x line: 0.6.0 is the published revision-4 artifact.
    "@tetsuo-ai/store-core": ["0.6.1"],
  },
} as const satisfies Readonly<Record<4 | 5, PackageSupportMatrix>>;

/**
 * Published revision-4 matrix retained for compatibility with the CLI 0.2
 * programmatic export. New code must select from
 * `SUPPORT_MATRIX_BY_SURFACE_REVISION` using finalized chain evidence.
 *
 * @deprecated Use `SUPPORT_MATRIX_BY_SURFACE_REVISION`.
 */
export const SUPPORT_MATRIX: PackageSupportMatrix =
  SUPPORT_MATRIX_BY_SURFACE_REVISION[4];

// These are dependencies of the application being promoted. Do not infer the
// running CLI's version from a possibly unrelated project-local CLI package:
// `agenc promote` may itself be running from npx, a global install, or an
// embedding process. The unscoped CLI alias and create-agenc-store are
// distribution/scaffolding packages, not application runtime dependencies.
const SUPPORTED_PACKAGES = [
  "@tetsuo-ai/protocol",
  "@tetsuo-ai/marketplace-sdk",
  "@tetsuo-ai/agenc-worker",
  "@tetsuo-ai/marketplace-react",
  "@tetsuo-ai/marketplace-tools",
  "@tetsuo-ai/marketplace-mcp",
  "@tetsuo-ai/marketplace-moderation",
  "@tetsuo-ai/store-core",
] as const;

type SupportedPackage = (typeof SUPPORTED_PACKAGES)[number];

const SUPPORTED_PACKAGE_SET = new Set<string>(SUPPORTED_PACKAGES);

/**
 * Relationships that materially couple first-party runtime APIs. Their exact
 * ranges are read from each installed artifact rather than duplicated here.
 * This list only prevents a malformed/tampered manifest from deleting a
 * relationship and thereby bypassing the coherence check.
 */
const MATERIAL_FIRST_PARTY_RELATIONSHIPS = {
  "@tetsuo-ai/agenc-worker": ["@tetsuo-ai/marketplace-sdk"],
  "@tetsuo-ai/marketplace-react": ["@tetsuo-ai/marketplace-sdk"],
  "@tetsuo-ai/marketplace-tools": ["@tetsuo-ai/marketplace-sdk"],
  "@tetsuo-ai/marketplace-mcp": [
    "@tetsuo-ai/marketplace-sdk",
    "@tetsuo-ai/marketplace-tools",
  ],
  "@tetsuo-ai/store-core": [
    "@tetsuo-ai/marketplace-sdk",
    "@tetsuo-ai/marketplace-react",
  ],
} as const satisfies Partial<
  Readonly<Record<SupportedPackage, readonly SupportedPackage[]>>
>;

const SDK_PACKAGE = "@tetsuo-ai/marketplace-sdk";
const WORKER_RUNTIME_PACKAGE = "@tetsuo-ai/agenc-worker";
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;

export type CheckStatus = "pass" | "fail" | "warn";

export interface PromoteCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Exact next action when not passing. */
  action?: string;
}

export interface PromoteInput {
  config: AgencConfig | null;
  configPath: string;
  /** Config-parse failure, when the file exists but is invalid. */
  configError?: string;
  /**
   * Installed `@tetsuo-ai/*` versions (null = not installed or unreadable).
   * Retained for the pre-0.3 programmatic API; `installedPackages` is the
   * authoritative, fail-closed source when deciding readiness.
   */
  installedVersions: Record<string, string | null>;
  /** Manifest state and dependency metadata for every supported package. */
  installedPackages?: InstalledPackageInventory;
  /** Does the configured wallet file exist on disk? */
  walletExists: boolean;
  /** Strict read-only validation of the configured keypair file. */
  walletValidation?: { valid: boolean; address?: string; error?: string };
  /** Finalized, read-only evidence gathered from the configured RPC. */
  chainEvidence?: PromoteChainEvidence;
}

export type InstalledPackageManifest =
  | { readonly status: "absent"; readonly path: string }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly error: string;
    }
  | {
      readonly status: "present";
      readonly path: string;
      readonly version: string;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly peerDependencies: Readonly<Record<string, string>>;
      readonly optionalPeerDependencies: readonly string[];
    };

export type InstalledPackageInventory = Readonly<
  Record<string, InstalledPackageManifest>
>;

export interface PromoteChainEvidence {
  genesisHash?: string;
  finalizedSlot?: number;
  programExecutable?: boolean;
  programOwner?: string;
  programDataAddress?: string;
  programDataOwner?: string;
  programDataExecutable?: boolean;
  programDataSlot?: number;
  upgradeAuthority?: string;
  executableHash?: string;
  releaseCommit?: string;
  protocolConfigAddress?: string;
  protocolConfigOwner?: string;
  protocolConfigDecoded?: boolean;
  protocolPaused?: boolean;
  protocolVersion?: number;
  minSupportedVersion?: number;
  surfaceRevision?: number;
  error?: string;
}

export interface PromoteReport {
  checks: PromoteCheck[];
  passed: number;
  failed: number;
  warned: number;
  ready: boolean;
}

function isLoopback(rpcUrl: string): boolean {
  try {
    const { hostname } = new URL(rpcUrl);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function productionRpcError(rpcUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return "rpcUrl is not an absolute URL";
  }
  if (url.protocol !== "https:") return "rpcUrl must use HTTPS";
  if (url.username !== "" || url.password !== "") {
    return "rpcUrl must not contain URL credentials";
  }
  if (isLoopback(rpcUrl)) return "rpcUrl points at a loopback endpoint";
  return null;
}

function safeRpcLabel(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

function validWalletAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}

type CanonicalSemver = {
  major: string;
  minor: string;
  prerelease: string | null;
};

function parseCanonicalSemver(version: string): CanonicalSemver | null {
  // Build metadata is intentionally outside the accepted production policy:
  // two differently built artifacts must not collapse to the same readiness
  // decision. Numeric identifiers are canonical (no leading zeroes).
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      version,
    );
  if (match === null) return null;
  const prerelease = match[4] ?? null;
  if (
    prerelease !== null &&
    prerelease
      .split(".")
      .some(
        (identifier) =>
          /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier),
      )
  ) {
    return null;
  }
  return { major: match[1]!, minor: match[2]!, prerelease };
}

function isCanonicalMinorLine(entry: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(entry);
}

/**
 * Stable versions match an admitted canonical `major.minor` line or a full
 * canonical SemVer listed as an exact matrix entry. A prerelease is rejected
 * unless its full canonical SemVer is listed exactly. Build metadata is always
 * rejected.
 */
export function versionInMatrix(
  version: string,
  entries: readonly string[],
): boolean {
  const parsed = parseCanonicalSemver(version);
  if (parsed === null) return false;
  return entries.some((entry) => {
    if (isCanonicalMinorLine(entry)) {
      return (
        parsed.prerelease === null &&
        entry === `${parsed.major}.${parsed.minor}`
      );
    }
    return parseCanonicalSemver(entry) !== null && entry === version;
  });
}

function matrixForRevision(
  revision: number | undefined,
): PackageSupportMatrix | null {
  if (revision !== 4 && revision !== 5) return null;
  return SUPPORT_MATRIX_BY_SURFACE_REVISION[revision];
}

function displayMatrixEntry(entry: string): string {
  return isCanonicalMinorLine(entry) ? `${entry}.x` : entry;
}

function installSpecifier(entry: string): string {
  return isCanonicalMinorLine(entry) ? `^${entry}.0` : entry;
}

function installedVersion(
  input: PromoteInput,
  pkg: SupportedPackage,
): string | null {
  const manifest = input.installedPackages?.[pkg];
  if (manifest !== undefined) {
    return manifest.status === "present" ? manifest.version : null;
  }
  // A missing inventory is reported as a readiness failure below. Retaining
  // this fallback lets pre-0.3 embedders receive useful pin diagnostics too.
  return input.installedVersions[pkg] ?? null;
}

function firstPartyRelations(
  pkg: SupportedPackage,
  manifest: Extract<InstalledPackageManifest, { status: "present" }>,
): readonly SupportedPackage[] {
  const materialRelationships = MATERIAL_FIRST_PARTY_RELATIONSHIPS as Partial<
    Readonly<Record<SupportedPackage, readonly SupportedPackage[]>>
  >;
  const relations = new Set<SupportedPackage>(materialRelationships[pkg] ?? []);
  for (const candidate of [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ]) {
    if (SUPPORTED_PACKAGE_SET.has(candidate)) {
      relations.add(candidate as SupportedPackage);
    }
  }
  return [...relations].sort();
}

function pushPackageCoherenceChecks(
  checks: PromoteCheck[],
  input: PromoteInput,
): void {
  const inventory = input.installedPackages;
  if (inventory === undefined) {
    checks.push({
      id: "manifest:inventory",
      label: "installed package manifests",
      status: "fail",
      detail:
        "manifest inventory was not supplied, so installed artifacts and their dependency ranges cannot be verified",
      action:
        "gather promotion input with gatherPromoteInputAsync() from this CLI version",
    });
    return;
  }

  for (const pkg of SUPPORTED_PACKAGES) {
    const manifest = inventory[pkg];
    if (manifest === undefined) {
      checks.push({
        id: `manifest:${pkg}`,
        label: `${pkg} manifest`,
        status: "fail",
        detail:
          "package inventory omitted this package, so absence cannot be distinguished from an unreadable manifest",
        action: "re-run promotion from the project root with the current CLI",
      });
      continue;
    }
    if (manifest.status === "invalid") {
      checks.push({
        id: `manifest:${pkg}`,
        label: `${pkg} manifest`,
        status: "fail",
        detail: `installed manifest is invalid: ${manifest.error}`,
        action: `remove and reinstall ${pkg}, then run \`agenc promote\` again`,
      });
      continue;
    }
    if (manifest.status === "absent") {
      const legacyVersion = input.installedVersions[pkg];
      if (legacyVersion != null) {
        checks.push({
          id: `manifest:${pkg}`,
          label: `${pkg} manifest`,
          status: "fail",
          detail: `version inventory reports ${legacyVersion}, but the package manifest is absent`,
          action: "re-run promotion from the project root with the current CLI",
        });
      }
      continue;
    }

    const legacyVersion = input.installedVersions[pkg];
    if (legacyVersion !== manifest.version) {
      checks.push({
        id: `manifest:${pkg}`,
        label: `${pkg} manifest`,
        status: "fail",
        detail:
          `version inventory mismatch (manifest ${manifest.version}; version view ` +
          `${legacyVersion ?? "missing"})`,
        action: "re-run promotion from the project root with the current CLI",
      });
    }

    for (const target of firstPartyRelations(pkg, manifest)) {
      const dependencyRange = manifest.dependencies[target];
      const peerRange = manifest.peerDependencies[target];
      const relationId = `coherence:${pkg}->${target}`;
      if (dependencyRange !== undefined && peerRange !== undefined) {
        checks.push({
          id: relationId,
          label: `${pkg} / ${target} coherence`,
          status: "fail",
          detail: `${pkg}@${manifest.version} declares ${target} as both a dependency and a peer dependency`,
          action: `reinstall a reviewed ${pkg} artifact with one unambiguous ${target} relationship`,
        });
        continue;
      }
      const range = dependencyRange ?? peerRange;
      if (range === undefined) {
        checks.push({
          id: relationId,
          label: `${pkg} / ${target} coherence`,
          status: "fail",
          detail: `${pkg}@${manifest.version} is missing its required first-party ${target} dependency/peer declaration`,
          action: `reinstall a reviewed ${pkg} artifact and its coordinated package train`,
        });
        continue;
      }
      if (validRange(range, { loose: false }) === null) {
        checks.push({
          id: relationId,
          label: `${pkg} / ${target} coherence`,
          status: "fail",
          detail: `${pkg}@${manifest.version} declares malformed ${target} range ${JSON.stringify(range)}`,
          action: `reinstall a reviewed ${pkg} artifact`,
        });
        continue;
      }

      const targetManifest = inventory[target];
      const optionalPeer =
        peerRange !== undefined &&
        manifest.optionalPeerDependencies.includes(target);
      if (targetManifest?.status === "absent" && optionalPeer) continue;
      if (targetManifest?.status !== "present") {
        checks.push({
          id: relationId,
          label: `${pkg} / ${target} coherence`,
          status: "fail",
          detail:
            `${pkg}@${manifest.version} requires ${target}@${range}, but that package is ` +
            (targetManifest?.status === "invalid"
              ? "installed with an invalid manifest"
              : "not installed"),
          action: `install a ${target} version satisfying ${range}, then run \`agenc promote\` again`,
        });
        continue;
      }
      if (
        !satisfies(targetManifest.version, range, { includePrerelease: false })
      ) {
        checks.push({
          id: relationId,
          label: `${pkg} / ${target} coherence`,
          status: "fail",
          detail:
            `${pkg}@${manifest.version} declares ${target}@${range}, but ` +
            `${targetManifest.version} is installed`,
          action:
            "install a mutually compatible first-party package combination documented in VERSIONING.md",
        });
        continue;
      }
      checks.push({
        id: relationId,
        label: `${pkg} / ${target} coherence`,
        status: "pass",
        detail: `${target}@${targetManifest.version} satisfies ${pkg}@${manifest.version} range ${range}`,
      });
    }
  }
}

/** Pure checklist logic (unit-testable without a filesystem). */
export function runPromoteChecks(input: PromoteInput): PromoteReport {
  const checks: PromoteCheck[] = [];
  const { config } = input;

  // 1) config file
  if (config === null) {
    checks.push({
      id: "config",
      label: "agenc.config.json",
      status: "fail",
      detail:
        input.configError !== undefined
          ? `invalid: ${input.configError}`
          : `not found at ${input.configPath}`,
      action:
        input.configError !== undefined
          ? "fix the JSON (or re-run `agenc init --force`)"
          : "run `agenc init` in the project root first",
    });
  } else {
    checks.push({
      id: "config",
      label: "agenc.config.json",
      status: "pass",
      detail: `${config.name} (${config.kind})`,
    });
  }

  if (config === null || config.network !== "mainnet-beta") {
    checks.push({
      id: "network",
      label: "production network",
      status: "fail",
      detail:
        config === null
          ? "network is unavailable"
          : `network is ${config.network}`,
      action: `set "network" in ${CONFIG_FILENAME} to "mainnet-beta"`,
    });
  } else {
    checks.push({
      id: "network",
      label: "production network",
      status: "pass",
      detail: "mainnet-beta",
    });
  }

  // 2) RPC configured and not localhost
  const rpcUrl = config?.rpcUrl ?? null;
  if (rpcUrl === null || rpcUrl.trim() === "") {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: "rpcUrl is not set (the dev sandbox uses localnet automatically)",
      action:
        `set "rpcUrl" in ${CONFIG_FILENAME} to your mainnet RPC endpoint — ` +
        "https://api.mainnet-beta.solana.com works to start (rate-limited; development only); " +
        "use a dedicated provider (Helius / Triton / QuickNode class) for production traffic",
    });
  } else if (productionRpcError(rpcUrl) !== null) {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "fail",
      detail: productionRpcError(rpcUrl)!,
      action:
        `set "rpcUrl" in ${CONFIG_FILENAME} to a real mainnet RPC endpoint — ` +
        "https://api.mainnet-beta.solana.com works to start (rate-limited; development only); " +
        "use a dedicated provider (Helius / Triton / QuickNode class) for production traffic",
    });
  } else {
    checks.push({
      id: "rpc",
      label: "production RPC endpoint",
      status: "pass",
      detail: safeRpcLabel(rpcUrl),
    });
  }

  // 3) wallet path set, exists, and not a sandbox throwaway
  const walletPath = config?.walletPath ?? null;
  if (walletPath === null || walletPath.trim() === "") {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: "walletPath is not set",
      action:
        `set "walletPath" in ${CONFIG_FILENAME} to your production keypair (never a .localnet key) — ` +
        "no wallet yet? `solana-keygen new --outfile ~/.config/solana/agenc-mainnet.json`, " +
        "then fund it with SOL before going live",
    });
  } else if (walletPath.split(path.sep).includes(".localnet")) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: `walletPath is a localnet sandbox throwaway key (${walletPath})`,
      action: "point walletPath at a real, funded production keypair",
    });
  } else if (!input.walletExists) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail: `walletPath does not exist: ${walletPath}`,
      action:
        "create/copy the keypair to that path (or fix the path) — " +
        `\`solana-keygen new --outfile ${walletPath}\` creates one; fund it with SOL before going live`,
    });
  } else if (
    input.walletValidation?.valid !== true ||
    !validWalletAddress(input.walletValidation.address)
  ) {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "fail",
      detail:
        input.walletValidation?.error ??
        "wallet file has not passed strict keypair and filesystem validation",
      action:
        "use an owner-held regular 64-byte Solana keypair JSON file with mode 600",
    });
  } else {
    checks.push({
      id: "wallet",
      label: "signer wallet",
      status: "pass",
      detail: `${walletPath} (${input.walletValidation.address})`,
    });
  }

  const evidence = input.chainEvidence;
  const revision = evidence?.surfaceRevision;
  const reviewedRelease = REVIEWED_MAINNET_RELEASES.find(
    (release) => release.surfaceRevision === revision,
  );
  if (evidence?.genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "fail",
      detail:
        evidence?.error ??
        (evidence?.genesisHash === undefined
          ? "RPC identity was not verified"
          : `unexpected genesis hash ${evidence.genesisHash}`),
      action:
        "use a healthy Solana mainnet-beta RPC and run `agenc promote` again",
    });
  } else if (
    evidence.finalizedSlot === undefined ||
    !Number.isSafeInteger(evidence.finalizedSlot) ||
    evidence.finalizedSlot <= 0
  ) {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "fail",
      detail: "RPC did not return a valid finalized slot",
      action: "use a healthy finalized Solana mainnet-beta RPC",
    });
  } else {
    checks.push({
      id: "chain:genesis",
      label: "finalized mainnet identity",
      status: "pass",
      detail: `mainnet-beta at finalized slot ${evidence.finalizedSlot}`,
    });
  }

  if (
    evidence?.programExecutable !== true ||
    evidence.programOwner !== UPGRADEABLE_LOADER ||
    evidence.programDataOwner !== UPGRADEABLE_LOADER ||
    evidence.programDataExecutable !== false ||
    reviewedRelease === undefined ||
    evidence.programDataAddress !== reviewedRelease.programDataAddress ||
    evidence.programDataSlot !== reviewedRelease.programDataSlot ||
    evidence.upgradeAuthority !== reviewedRelease.upgradeAuthority ||
    evidence.executableHash !== reviewedRelease.executableHash ||
    evidence.releaseCommit !== reviewedRelease.sourceCommit
  ) {
    checks.push({
      id: "chain:program",
      label: "AgenC program deployment",
      status: "fail",
      detail:
        evidence?.error ??
        "canonical Program/ProgramData, upgrade authority, executable hash, or reviewed release identity did not match",
      action:
        "verify the finalized canonical AgenC deployment against its reviewed ProgramData hash and release commit",
    });
  } else {
    checks.push({
      id: "chain:program",
      label: "AgenC program deployment",
      status: "pass",
      detail:
        `${AGENC_COORDINATION_PROGRAM_ADDRESS} is executable at reviewed commit ` +
        reviewedRelease.sourceCommit,
    });
  }

  if (
    evidence?.protocolConfigOwner !== AGENC_COORDINATION_PROGRAM_ADDRESS ||
    evidence.protocolConfigAddress !== AGENC_PROTOCOL_CONFIG_ADDRESS ||
    evidence.protocolConfigDecoded !== true ||
    evidence.protocolPaused !== false ||
    evidence.protocolVersion !== 1 ||
    evidence.minSupportedVersion === undefined ||
    evidence.minSupportedVersion > 1
  ) {
    checks.push({
      id: "chain:config",
      label: "ProtocolConfig ownership",
      status: "fail",
      detail:
        "canonical ProtocolConfig is missing, paused, incompatible, malformed, or not program-owned",
      action: "verify the RPC and canonical AgenC program/config deployment",
    });
  } else {
    checks.push({
      id: "chain:config",
      label: "ProtocolConfig ownership",
      status: "pass",
      detail: evidence.protocolConfigAddress,
    });
  }

  if (
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < SURFACE_REVISION_FULL ||
    revision > SURFACE_REVISION_CURRENT
  ) {
    checks.push({
      id: "chain:surface",
      label: "deployed protocol surface",
      status: "fail",
      detail: `unsupported or unverified surface revision ${revision ?? "unknown"}`,
      action: "use an SDK version compatible with the deployed mainnet surface",
    });
  } else {
    checks.push({
      id: "chain:surface",
      label: "deployed protocol surface",
      status: "pass",
      detail: `surface revision ${revision}`,
    });
  }

  // 4) installed package pins inside the matrix for the finalized revision.
  // Never union revision 4 and revision 5: their write wires are intentionally
  // bidirectionally incompatible. Independent version buckets are necessary
  // but insufficient: every installed artifact's own first-party dependency
  // and peer ranges must also admit the selected installed package train.
  pushPackageCoherenceChecks(checks, input);
  const revisionMatrix = matrixForRevision(revision);
  for (const pkg of SUPPORTED_PACKAGES) {
    const version = installedVersion(input, pkg);
    if (version == null) continue; // not a dependency of this project — fine
    const lines = revisionMatrix?.[pkg];
    if (lines === undefined) {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "fail",
        detail:
          `${version} cannot be matched to a client release because deployed ` +
          `surface revision ${revision ?? "unknown"} has no reviewed compatibility matrix`,
        action:
          "verify the finalized deployed surface and run `agenc promote` again",
      });
      continue;
    }
    const supported = lines.map(displayMatrixEntry).join(" / ");
    const current = lines[lines.length - 1];
    if (versionInMatrix(version, lines)) {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "pass",
        detail: `${version} (surface revision ${revision}; matrix: ${supported})`,
      });
    } else {
      checks.push({
        id: `pin:${pkg}`,
        label: `${pkg} pin`,
        status: "fail",
        detail:
          `${version} is OUTSIDE the surface-revision-${revision} ` +
          `supported set ${supported} — this client/program skew fails closed`,
        action:
          current === undefined
            ? `install an explicitly supported ${pkg} version (see agenc-protocol docs/VERSIONING.md §1.1)`
            : `npm install ${pkg}@${installSpecifier(current)} (see agenc-protocol docs/VERSIONING.md §1.1)`,
      });
    }
  }
  if (installedVersion(input, SDK_PACKAGE) == null) {
    const sdkEntries = revisionMatrix?.[SDK_PACKAGE];
    const sdkCurrent = sdkEntries?.[sdkEntries.length - 1];
    checks.push({
      id: "pin:sdk",
      label: "@tetsuo-ai/marketplace-sdk pin",
      status: "fail",
      detail: "@tetsuo-ai/marketplace-sdk is not installed in this project",
      action:
        sdkCurrent === undefined
          ? "verify the finalized deployed surface before selecting an SDK version"
          : `npm install ${SDK_PACKAGE}@${installSpecifier(sdkCurrent)} ` +
            "(run it in the project root — `agenc init` scaffolds a package.json when the project has none)",
    });
  }
  if (
    config?.kind === "worker" &&
    installedVersion(input, WORKER_RUNTIME_PACKAGE) == null
  ) {
    const workerEntries = revisionMatrix?.[WORKER_RUNTIME_PACKAGE];
    const workerCurrent = workerEntries?.[workerEntries.length - 1];
    const sdkEntries = revisionMatrix?.[SDK_PACKAGE];
    const sdkCurrent = sdkEntries?.[sdkEntries.length - 1];
    checks.push({
      id: "pin:worker-runtime",
      label: "@tetsuo-ai/agenc-worker runtime",
      status: "fail",
      detail:
        "this worker template cannot run because @tetsuo-ai/agenc-worker is not installed in the project",
      action:
        workerCurrent === undefined || sdkCurrent === undefined
          ? "verify the finalized deployed surface before selecting worker dependencies"
          : `npm install ${WORKER_RUNTIME_PACKAGE}@${installSpecifier(workerCurrent)} ` +
            `${SDK_PACKAGE}@${installSpecifier(sdkCurrent)}`,
    });
  }

  // Wire compatibility is broader than the API surface emitted by this CLI.
  // Generated recovery/listing-verification code requires the current SDK line.
  const sdkVersion = installedVersion(input, SDK_PACKAGE);
  if (
    config !== null &&
    (sdkVersion == null || !versionInMatrix(sdkVersion, ["0.12"]))
  ) {
    checks.push({
      id: "pin:template-sdk",
      label: "generated-template SDK API",
      status: "fail",
      detail: `generated ${config.kind} code requires @tetsuo-ai/marketplace-sdk 0.12.x (installed: ${sdkVersion ?? "missing"})`,
      action:
        "npm install @tetsuo-ai/marketplace-sdk@^0.12.0 and rebuild the generated surface",
    });
  }
  const workerVersion = installedVersion(input, WORKER_RUNTIME_PACKAGE);
  if (
    config?.kind === "worker" &&
    (workerVersion == null || !versionInMatrix(workerVersion, ["0.2"]))
  ) {
    checks.push({
      id: "pin:template-worker",
      label: "generated-worker runtime API",
      status: "fail",
      detail: `generated worker.mjs requires @tetsuo-ai/agenc-worker 0.2.x (installed: ${workerVersion ?? "missing"})`,
      action:
        "npm install @tetsuo-ai/agenc-worker@^0.2.0 and rebuild worker.mjs",
    });
  }

  // The generated checkout is intentionally local-only. Until this command can
  // gather durable auth/admission and bounded deployed-route canary evidence, it
  // must never turn that scaffold into a false production-ready green.
  if (config?.kind === "checkout") {
    checks.push({
      id: "production:checkout-evidence",
      label: "production checkout controls",
      status: "fail",
      detail:
        "not evidenced: production authorization, durable atomic idempotency/recovery, total-debit policy, public job-spec readback, reviewed attestor/listing/version binding, and deployed-route bounded canaries",
      action:
        "replace the generated local-only checkout policy, deploy it, run bounded read-only/funded canaries under operator review, and record those controls in your release process",
    });
  } else if (config?.kind === "worker") {
    checks.push({
      id: "production:worker-evidence",
      label: "production worker runtime",
      status: "fail",
      detail:
        "not evidenced: effective RPC/endpoint/task-thread/uploader configuration, durable private state, wallet funding limits, and a bounded deployed worker canary",
      action:
        "validate the effective environment-injected worker config and complete an operator-reviewed bounded canary before launch",
    });
  }

  // 5) fee-leg payees rent exemption (advisory — payees are runtime inputs)
  checks.push({
    id: "rent-exemption",
    label: "fee-leg payees rent-exempt",
    status: "warn",
    detail:
      "settlement fee legs (operator / referrer / treasury) must be rent-exempt " +
      "accounts on mainnet or the settlement transaction fails",
    action:
      "before going live, confirm every operator/referrer payee wallet holds at " +
      "least the rent-exempt minimum (~0.00089 SOL)",
  });

  // 6) receipts / explorer surface
  checks.push({
    id: "receipts",
    label: "settlement receipts",
    status: "pass",
    detail:
      "mainnet settlements get a shareable receipt at https://agenc.ag/receipt/<signature> " +
      "(SDK: settlementReceiptUrl)",
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  return { checks, passed, failed, warned, ready: failed === 0 };
}

function parseManifestStringMap(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== "string" || range.trim() === "") {
      throw new TypeError(`${field}.${name} must be a non-empty string`);
    }
    result[name] = range;
  }
  return result;
}

function parseOptionalPeerDependencies(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("peerDependenciesMeta must be an object");
  }
  const optional: string[] = [];
  for (const [name, metadata] of Object.entries(value)) {
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new TypeError(`peerDependenciesMeta.${name} must be an object`);
    }
    const flag = (metadata as { optional?: unknown }).optional;
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new TypeError(
        `peerDependenciesMeta.${name}.optional must be a boolean`,
      );
    }
    if (flag === true) optional.push(name);
  }
  return optional.sort();
}

function readPackageManifestFile(file: string): string {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error("package.json is not a regular file");
    if (before.size <= 0 || before.size > MAX_PACKAGE_MANIFEST_BYTES) {
      throw new Error(
        `package.json size must be 1..${MAX_PACKAGE_MANIFEST_BYTES} bytes`,
      );
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) throw new Error("package.json changed while being read");
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new Error("package.json changed while being read");
    }
    const after = fstatSync(descriptor);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("package.json changed while being read");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function locateInstalledPackage(
  dir: string,
  pkg: SupportedPackage,
):
  | { status: "absent"; path: string }
  | { status: "found"; path: string }
  | { status: "invalid"; path: string; error: string } {
  let current = path.resolve(dir);
  const directPath = path.join(
    current,
    "node_modules",
    ...pkg.split("/"),
    "package.json",
  );
  while (true) {
    const pkgDir = path.join(current, "node_modules", ...pkg.split("/"));
    const pkgJson = path.join(pkgDir, "package.json");
    try {
      // Match Node's upward node_modules lookup so promotion sees the same
      // hoisted workspace artifact as the application. The package directory,
      // rather than package.json alone, defines true absence.
      lstatSync(pkgDir);
      return { status: "found", path: pkgJson };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          status: "invalid",
          path: pkgJson,
          error:
            error instanceof Error
              ? error.message
              : "unknown package read error",
        };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { status: "absent", path: directPath };
    current = parent;
  }
}

/**
 * Read exact installed first-party manifests without conflating absence with a
 * broken artifact. This function is readonly and bounds every manifest before
 * parsing it.
 */
export function readInstalledPackageManifests(
  dir: string,
): InstalledPackageInventory {
  const manifests: Record<string, InstalledPackageManifest> = {};
  for (const pkg of SUPPORTED_PACKAGES) {
    const location = locateInstalledPackage(dir, pkg);
    if (location.status === "absent" || location.status === "invalid") {
      manifests[pkg] = location;
      continue;
    }
    const pkgJson = location.path;
    try {
      const parsed: unknown = JSON.parse(readPackageManifestFile(pkgJson));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError("package.json root must be an object");
      }
      const record = parsed as Record<string, unknown>;
      if (record.name !== pkg) {
        throw new TypeError(`package name must be exactly ${pkg}`);
      }
      if (
        typeof record.version !== "string" ||
        parseCanonicalSemver(record.version) === null
      ) {
        throw new TypeError("version must be a canonical SemVer string");
      }
      manifests[pkg] = {
        status: "present",
        path: pkgJson,
        version: record.version,
        dependencies: parseManifestStringMap(
          record.dependencies,
          "dependencies",
        ),
        peerDependencies: parseManifestStringMap(
          record.peerDependencies,
          "peerDependencies",
        ),
        optionalPeerDependencies: parseOptionalPeerDependencies(
          record.peerDependenciesMeta,
        ),
      };
    } catch (error) {
      manifests[pkg] = {
        status: "invalid",
        path: pkgJson,
        error: error instanceof Error ? error.message : "unknown read error",
      };
    }
  }
  return manifests;
}

/**
 * Legacy version-only view. Use `readInstalledPackageManifests` for readiness
 * decisions so invalid manifests cannot masquerade as absent optional packages.
 */
export function readInstalledVersions(
  dir: string,
): Record<string, string | null> {
  const versions: Record<string, string | null> = {};
  for (const [pkg, manifest] of Object.entries(
    readInstalledPackageManifests(dir),
  )) {
    versions[pkg] = manifest.status === "present" ? manifest.version : null;
  }
  return versions;
}

/** Gather everything the checklist needs from `dir` (readonly). */
export function gatherPromoteInput(dir: string): PromoteInput {
  const configPath = path.join(dir, CONFIG_FILENAME);
  let config: AgencConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadConfig(dir)?.config ?? null;
  } catch (error) {
    if (error instanceof AgencConfigError) configError = error.message;
    else throw error;
  }
  const walletPath = config?.walletPath ?? null;
  const walletExists =
    walletPath !== null &&
    walletPath.trim() !== "" &&
    existsSync(
      path.isAbsolute(walletPath) ? walletPath : path.join(dir, walletPath),
    );
  let walletValidation: PromoteInput["walletValidation"];
  if (walletExists && walletPath !== null) {
    const resolved = path.isAbsolute(walletPath)
      ? walletPath
      : path.join(dir, walletPath);
    try {
      loadSolanaKeypairFile(resolved);
      walletValidation = {
        valid: false,
        error:
          "keypair bytes passed parsing but signer address has not been derived",
      };
    } catch (error) {
      walletValidation = { valid: false, error: (error as Error).message };
    }
  }
  const installedPackages = readInstalledPackageManifests(dir);
  const installedVersions: Record<string, string | null> = {};
  for (const [pkg, manifest] of Object.entries(installedPackages)) {
    installedVersions[pkg] =
      manifest.status === "present" ? manifest.version : null;
  }
  return {
    config,
    configPath,
    ...(configError !== undefined ? { configError } : {}),
    installedVersions,
    installedPackages,
    walletExists,
    ...(walletValidation !== undefined ? { walletValidation } : {}),
  };
}

async function readBoundedRpcResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RPC_RESPONSE_BYTES) {
    throw new Error(`RPC response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new Error("RPC returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`RPC response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC answered HTTP ${response.status}`);
  const envelope = await readBoundedRpcResponse(response);
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("RPC returned an invalid JSON-RPC envelope");
  }
  const record = envelope as Record<string, unknown>;
  if (record.error !== undefined)
    throw new Error(`RPC ${method} returned an error`);
  if (!("result" in record)) throw new Error(`RPC ${method} omitted result`);
  return record.result;
}

type RawAccount = {
  executable: boolean;
  owner: string;
  data: [string, string];
};

function rawAccount(value: unknown, label: string): RawAccount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} account is missing`);
  }
  const account = value as Record<string, unknown>;
  if (
    typeof account.executable !== "boolean" ||
    typeof account.owner !== "string" ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    typeof account.data[0] !== "string" ||
    account.data[1] !== "base64"
  ) {
    throw new Error(`${label} account has an invalid RPC shape`);
  }
  return account as RawAccount;
}

function accountData(account: RawAccount, label: string): Buffer {
  const bytes = Buffer.from(account.data[0], "base64");
  if (bytes.toString("base64") !== account.data[0]) {
    throw new Error(`${label} account data is not canonical base64`);
  }
  return bytes;
}

function contextAccount(
  result: unknown,
  label: string,
  minimumSlot: number,
): RawAccount {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`${label} RPC result is invalid`);
  }
  const record = result as { context?: unknown; value?: unknown };
  if (
    typeof record.context !== "object" ||
    record.context === null ||
    Array.isArray(record.context)
  ) {
    throw new Error(`${label} RPC result omitted its finalized context`);
  }
  const slot = (record.context as { slot?: unknown }).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < minimumSlot) {
    throw new Error(
      `${label} RPC context slot is below minContextSlot ${minimumSlot}`,
    );
  }
  return rawAccount(record.value, label);
}

function hashProgramData(data: Buffer): string {
  if (data.length <= 45 || data.readUInt32LE(0) !== 3) {
    throw new Error("ProgramData account has an invalid loader header");
  }
  let end = data.length;
  while (end > 45 && data[end - 1] === 0) end -= 1;
  if (end === 45)
    throw new Error("ProgramData account contains no executable bytes");
  return createHash("sha256").update(data.subarray(45, end)).digest("hex");
}

/** Gather the sync filesystem checks plus finalized mainnet deployment evidence. */
export async function gatherPromoteInputAsync(
  dir: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    rpcUrl?: string;
  } = {},
): Promise<PromoteInput> {
  const input = gatherPromoteInput(dir);
  const injectedRpcUrl = options.rpcUrl ?? process.env.AGENC_RPC_URL?.trim();
  if (
    input.config !== null &&
    injectedRpcUrl !== undefined &&
    injectedRpcUrl !== ""
  ) {
    input.config = { ...input.config, rpcUrl: injectedRpcUrl };
  }
  const rpcUrl = input.config?.rpcUrl ?? null;
  const walletPath = input.config?.walletPath ?? null;
  if (input.walletExists && walletPath !== null) {
    const resolved = path.isAbsolute(walletPath)
      ? walletPath
      : path.join(dir, walletPath);
    try {
      const signer = await createKeyPairSignerFromBytes(
        loadSolanaKeypairFile(resolved),
      );
      input.walletValidation = { valid: true, address: String(signer.address) };
    } catch (error) {
      input.walletValidation = {
        valid: false,
        error: (error as Error).message,
      };
    }
  }
  if (
    input.config?.network !== "mainnet-beta" ||
    rpcUrl === null ||
    productionRpcError(rpcUrl) !== null
  ) {
    return input;
  }
  const evidence: PromoteChainEvidence = {};
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    // Establish one finalized lower bound first. Every account request is then
    // pinned with minContextSlot and its returned context is independently
    // checked, preventing a lagging RPC/cache from mixing deployment epochs.
    const finalizedSlot = await rpcCall(
      rpcUrl,
      "getSlot",
      [{ commitment: "finalized" }],
      fetchImpl,
      timeoutMs,
    );
    if (
      typeof finalizedSlot !== "number" ||
      !Number.isSafeInteger(finalizedSlot) ||
      finalizedSlot <= 0
    ) {
      throw new Error("RPC returned an invalid finalized slot");
    }
    const accountConfig = {
      encoding: "base64",
      commitment: "finalized",
      minContextSlot: finalizedSlot,
    } as const;
    const [protocolConfigAddress] = await findProtocolConfigPda();
    const [genesis, programResult, configResult] = await Promise.all([
      rpcCall(rpcUrl, "getGenesisHash", [], fetchImpl, timeoutMs),
      rpcCall(
        rpcUrl,
        "getAccountInfo",
        [AGENC_COORDINATION_PROGRAM_ADDRESS, accountConfig],
        fetchImpl,
        timeoutMs,
      ),
      rpcCall(
        rpcUrl,
        "getAccountInfo",
        [protocolConfigAddress, accountConfig],
        fetchImpl,
        timeoutMs,
      ),
    ]);
    const program = contextAccount(programResult, "program", finalizedSlot);
    const protocolConfig = contextAccount(
      configResult,
      "ProtocolConfig",
      finalizedSlot,
    );
    const programBytes = accountData(program, "program");
    if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2) {
      throw new Error("program account is not an upgradeable-loader Program");
    }
    const programDataAddress = String(
      getAddressDecoder().decode(programBytes.subarray(4, 36)),
    );
    const programDataResult = await rpcCall(
      rpcUrl,
      "getAccountInfo",
      [programDataAddress, accountConfig],
      fetchImpl,
      timeoutMs,
    );
    const programData = contextAccount(
      programDataResult,
      "ProgramData",
      finalizedSlot,
    );
    const programDataBytes = accountData(programData, "ProgramData");
    if (
      programDataBytes.length <= 45 ||
      programDataBytes.readUInt32LE(0) !== 3
    ) {
      throw new Error("ProgramData account has an invalid loader layout");
    }
    const authorityTag = programDataBytes[12];
    if (authorityTag !== 1) {
      throw new Error("ProgramData must retain the reviewed upgrade authority");
    }
    const programDataSlotBigint = programDataBytes.readBigUInt64LE(4);
    if (programDataSlotBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "ProgramData deployment slot is outside the safe integer range",
      );
    }
    const programDataSlot = Number(programDataSlotBigint);
    const upgradeAuthority = String(
      getAddressDecoder().decode(programDataBytes.subarray(13, 45)),
    );
    const executableHash = hashProgramData(programDataBytes);

    const configBuffer = accountData(protocolConfig, "ProtocolConfig");
    const configBytes = Uint8Array.from(configBuffer);
    const discriminator = getProtocolConfigDiscriminatorBytes();
    if (discriminator.some((byte, index) => configBytes[index] !== byte)) {
      throw new Error("ProtocolConfig account discriminator is invalid");
    }
    const decodedConfig = getProtocolConfigDecoder().decode(configBytes);
    const surfaceRevision = readSurfaceRevision(configBytes);
    const reviewedRelease = REVIEWED_MAINNET_RELEASES.find(
      (release) =>
        release.surfaceRevision === surfaceRevision &&
        release.programDataAddress === programDataAddress &&
        release.programDataSlot === programDataSlot &&
        release.upgradeAuthority === upgradeAuthority &&
        release.executableHash === executableHash,
    );
    if (String(protocolConfigAddress) !== AGENC_PROTOCOL_CONFIG_ADDRESS) {
      throw new Error(
        "derived ProtocolConfig address does not match this CLI build",
      );
    }
    Object.assign(evidence, {
      genesisHash: typeof genesis === "string" ? genesis : undefined,
      finalizedSlot,
      programExecutable: program.executable,
      programOwner: program.owner,
      programDataAddress,
      programDataOwner: programData.owner,
      programDataExecutable: programData.executable,
      programDataSlot,
      upgradeAuthority,
      executableHash,
      releaseCommit: reviewedRelease?.sourceCommit,
      protocolConfigAddress: String(protocolConfigAddress),
      protocolConfigOwner: protocolConfig.owner,
      protocolConfigDecoded: true,
      protocolPaused: decodedConfig.protocolPaused,
      protocolVersion: decodedConfig.protocolVersion,
      minSupportedVersion: decodedConfig.minSupportedVersion,
      surfaceRevision,
    });
  } catch (error) {
    evidence.error = `RPC verification failed: ${(error as Error).message}`;
  }
  return { ...input, chainEvidence: evidence };
}
