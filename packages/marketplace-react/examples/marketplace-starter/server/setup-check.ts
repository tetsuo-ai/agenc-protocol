import {
  REFERRER_FEE_BPS_MAX,
  REFERRER_FEE_BPS_MIN,
  validateReferrerConfig,
  type AgencNetwork,
  type ReferrerConfig,
} from "@tetsuo-ai/marketplace-react";
import { isAddress } from "@solana/kit";

type Env = Record<string, string | undefined>;

type StarterReadyNetwork = Exclude<AgencNetwork, "localnet">;

export interface StarterSetupIssue {
  variable: string;
  message: string;
}

export interface StarterFrontendSetupConfig {
  network: StarterReadyNetwork;
  rpcUrl: string;
  rpcSubscriptionsUrl?: string;
  indexerUrl: string;
  backendUrl: string;
  moderator: string;
  referrer?: ReferrerConfig;
}

export interface StarterBackendSetupConfig {
  jobSpecDir: string;
  jobSpecPublicBaseUrl: string;
  taskModerationAttestUrl: string;
  taskModerationAttestToken?: string;
}

export interface StarterSetupConfig {
  frontend: StarterFrontendSetupConfig;
  backend: StarterBackendSetupConfig;
}

export interface StarterSetupCheck {
  ok: boolean;
  errors: StarterSetupIssue[];
  warnings: StarterSetupIssue[];
  config?: StarterSetupConfig;
}

const NETWORKS = new Set<StarterReadyNetwork>(["devnet", "mainnet"]);
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PRIVATE|KEY)/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envString(env: Env, name: string): string | undefined {
  const trimmed = env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function issue(variable: string, message: string): StarterSetupIssue {
  return { variable, message };
}

function requireString(
  env: Env,
  name: string,
  errors: StarterSetupIssue[],
): string | undefined {
  const value = envString(env, name);
  if (!value) {
    errors.push(issue(name, `${name} is required.`));
  }
  return value;
}

function requireUrl(
  env: Env,
  name: string,
  protocols: readonly string[],
  errors: StarterSetupIssue[],
): string | undefined {
  const value = requireString(env, name, errors);
  if (!value) return undefined;
  if (!isUrlWithProtocol(value, protocols)) {
    errors.push(
      issue(
        name,
        `${name} must be an absolute ${protocols.join("/")} URL.`,
      ),
    );
    return undefined;
  }
  return value;
}

function optionalUrl(
  env: Env,
  name: string,
  protocols: readonly string[],
  errors: StarterSetupIssue[],
): string | undefined {
  const value = envString(env, name);
  if (!value) return undefined;
  if (!isUrlWithProtocol(value, protocols)) {
    errors.push(
      issue(
        name,
        `${name} must be an absolute ${protocols.join("/")} URL when set.`,
      ),
    );
    return undefined;
  }
  return value;
}

function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
}

function validateNetwork(
  env: Env,
  errors: StarterSetupIssue[],
): StarterReadyNetwork | undefined {
  const value = requireString(env, "VITE_AGENC_NETWORK", errors);
  if (!value) return undefined;
  if (NETWORKS.has(value as StarterReadyNetwork)) {
    return value as StarterReadyNetwork;
  }
  if (value === "localnet") {
    errors.push(
      issue(
        "VITE_AGENC_NETWORK",
        "VITE_AGENC_NETWORK=localnet is not wired in this browser-wallet starter.",
      ),
    );
  } else {
    errors.push(
      issue(
        "VITE_AGENC_NETWORK",
        'VITE_AGENC_NETWORK must be "devnet" or "mainnet".',
      ),
    );
  }
  return undefined;
}

function validateReferrer(
  env: Env,
  errors: StarterSetupIssue[],
): ReferrerConfig | undefined {
  const wallet = envString(env, "VITE_AGENC_REFERRER_WALLET");
  const feeRaw = envString(env, "VITE_AGENC_REFERRER_FEE_BPS");
  if (!wallet && !feeRaw) return undefined;
  if (!wallet) {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_WALLET",
        "VITE_AGENC_REFERRER_WALLET is required when VITE_AGENC_REFERRER_FEE_BPS is set.",
      ),
    );
    return undefined;
  }
  if (!feeRaw) {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_FEE_BPS",
        "VITE_AGENC_REFERRER_FEE_BPS is required when VITE_AGENC_REFERRER_WALLET is set.",
      ),
    );
    return undefined;
  }
  if (!/^-?\d+$/.test(feeRaw)) {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_FEE_BPS",
        `VITE_AGENC_REFERRER_FEE_BPS must be an integer between ${REFERRER_FEE_BPS_MIN} and ${REFERRER_FEE_BPS_MAX}.`,
      ),
    );
    return undefined;
  }

  const referrer = { wallet, feeBps: Number.parseInt(feeRaw, 10) };
  let valid = true;
  if (!isAddress(wallet)) {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_WALLET",
        "VITE_AGENC_REFERRER_WALLET must be a valid Solana address.",
      ),
    );
    valid = false;
  }
  if (
    referrer.feeBps < REFERRER_FEE_BPS_MIN ||
    referrer.feeBps > REFERRER_FEE_BPS_MAX
  ) {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_FEE_BPS",
        `VITE_AGENC_REFERRER_FEE_BPS must be between ${REFERRER_FEE_BPS_MIN} and ${REFERRER_FEE_BPS_MAX}.`,
      ),
    );
    valid = false;
  }
  if (!valid) return undefined;

  try {
    validateReferrerConfig(referrer);
    return referrer;
  } catch {
    errors.push(
      issue(
        "VITE_AGENC_REFERRER_WALLET",
        "VITE_AGENC_REFERRER_WALLET or VITE_AGENC_REFERRER_FEE_BPS failed provider validation.",
      ),
    );
    return undefined;
  }
}

function validateFrontend(
  env: Env,
  errors: StarterSetupIssue[],
): StarterFrontendSetupConfig | undefined {
  const network = validateNetwork(env, errors);
  const rpcUrl = requireUrl(env, "VITE_AGENC_RPC_URL", ["http:", "https:"], errors);
  const rpcSubscriptionsUrl = optionalUrl(
    env,
    "VITE_AGENC_RPC_SUBSCRIPTIONS_URL",
    ["ws:", "wss:", "http:", "https:"],
    errors,
  );
  const indexerUrl = requireUrl(
    env,
    "VITE_AGENC_INDEXER_URL",
    ["http:", "https:"],
    errors,
  );
  const backendUrl = requireUrl(
    env,
    "VITE_AGENC_BACKEND_URL",
    ["http:", "https:"],
    errors,
  );
  const moderator = requireString(env, "VITE_AGENC_MODERATOR", errors);
  const validModerator = moderator && isAddress(moderator);
  if (moderator && !validModerator) {
    errors.push(
      issue(
        "VITE_AGENC_MODERATOR",
        "VITE_AGENC_MODERATOR must be a valid Solana address.",
      ),
    );
  }
  const referrer = validateReferrer(env, errors);
  if (!network || !rpcUrl || !indexerUrl || !backendUrl || !validModerator) {
    return undefined;
  }
  return {
    network,
    rpcUrl,
    ...(rpcSubscriptionsUrl ? { rpcSubscriptionsUrl } : {}),
    indexerUrl,
    backendUrl,
    moderator,
    ...(referrer ? { referrer } : {}),
  };
}

function validateBackend(
  env: Env,
  errors: StarterSetupIssue[],
): StarterBackendSetupConfig | undefined {
  const jobSpecDir = requireString(env, "AGENC_JOB_SPEC_DIR", errors);
  const jobSpecPublicBaseUrl = requireUrl(
    env,
    "AGENC_JOB_SPEC_PUBLIC_BASE_URL",
    ["http:", "https:"],
    errors,
  );
  const taskModerationAttestUrl = requireUrl(
    env,
    "AGENC_TASK_MODERATION_ATTEST_URL",
    ["http:", "https:"],
    errors,
  );
  const taskModerationAttestToken = envString(
    env,
    "AGENC_TASK_MODERATION_ATTEST_TOKEN",
  );
  if (!jobSpecDir || !jobSpecPublicBaseUrl || !taskModerationAttestUrl) {
    return undefined;
  }
  return {
    jobSpecDir,
    jobSpecPublicBaseUrl,
    taskModerationAttestUrl,
    ...(taskModerationAttestToken ? { taskModerationAttestToken } : {}),
  };
}

export function validateStarterSetupEnv(env: Env): StarterSetupCheck {
  const errors: StarterSetupIssue[] = [];
  const warnings: StarterSetupIssue[] = [
    issue(
      "window.agencWallet",
      "Wallet Standard wiring, wallet signing, RPC broadcast, and settlement are runtime checks; this setup check only validates local configuration shape.",
    ),
  ];
  const frontend = validateFrontend(env, errors);
  const backend = validateBackend(env, errors);
  const config =
    frontend && backend
      ? {
          frontend,
          backend,
        }
      : undefined;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(config ? { config } : {}),
  };
}

export function assertStarterBackendEnv(env: Env): StarterBackendSetupConfig {
  const errors: StarterSetupIssue[] = [];
  const backend = validateBackend(env, errors);
  if (!backend) {
    throw new Error(
      errors.map((entry) => `${entry.variable}: ${entry.message}`).join("\n"),
    );
  }
  return backend;
}

export function parseStarterEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = assignment.indexOf("=");
    if (equals <= 0) continue;

    const key = assignment.slice(0, equals).trim();
    if (!ENV_NAME_RE.test(key)) continue;

    const rawValue = assignment.slice(equals + 1).trim();
    parsed[key] = stripEnvQuotes(rawValue);
  }
  return parsed;
}

export function mergeStarterEnv(fileEnv: Env, processEnv: Env): Env {
  const merged: Env = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

function stripEnvQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
