const MAX_INPUT_LENGTH = 512;
const DANGEROUS_CHARS = /[;&|`$(){}[\]<>!\\\x00\n\r]/;

export const SCENARIOS = {
  "DV-05": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "expire_claim",
    ],
    evidenceInstruction: "expire_claim",
  },
  "DV-07A": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "initiate_dispute",
      "vote_dispute",
      "resolve_dispute",
    ],
    evidenceInstruction: "resolve_dispute",
  },
  "DV-07B": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "initiate_dispute",
      "vote_dispute",
      "resolve_dispute",
    ],
    evidenceInstruction: "resolve_dispute",
  },
  "DV-07C": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "initiate_dispute",
      "vote_dispute",
      "resolve_dispute",
    ],
    evidenceInstruction: "resolve_dispute",
  },
  "DV-08A": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "configure_task_validation",
      "submit_task_result",
      "initiate_dispute",
      "expire_dispute",
    ],
    evidenceInstruction: "expire_dispute",
  },
  "DV-08B": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "initiate_dispute",
      "expire_dispute",
    ],
    evidenceInstruction: "expire_dispute",
  },
  "DV-03E": {
    orderedInstructionList: [
      "register_agent",
      "create_task",
      "create_dependent_task",
      "initialize_bid_book",
      "create_bid",
      "accept_bid",
      "complete_task_private",
    ],
    evidenceInstruction: "complete_task_private",
  },
};

export function scenarioNeedsArbiters(scenarioId) {
  return SCENARIOS[scenarioId]?.orderedInstructionList.includes("vote_dispute") ?? false;
}

function pickConfiguredValue(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim().length > 0) {
        return value.trim();
      }
      continue;
    }

    if (value != null) {
      return value;
    }
  }

  return null;
}

function ensureReasonableInput(input, label) {
  if (!input || input.trim().length === 0) {
    throw new Error(`Security: ${label} cannot be empty`);
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(
      `Security: ${label} exceeds maximum length (${MAX_INPUT_LENGTH} characters)`,
    );
  }
  if (DANGEROUS_CHARS.test(input)) {
    throw new Error(`Security: ${label} contains disallowed characters`);
  }
}

function validateProverEndpoint(proverEndpoint) {
  ensureReasonableInput(proverEndpoint, "Prover endpoint");

  let parsed;
  try {
    parsed = new URL(proverEndpoint);
  } catch {
    throw new Error(`Security: Invalid prover endpoint URL: ${proverEndpoint}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Security: Prover endpoint must use http or https protocol");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Security: Prover endpoint must not include credentials");
  }
}

export function parsePositiveTimeoutMs(rawValue, label = "AGENC_PROVER_TIMEOUT_MS") {
  if (rawValue == null || rawValue === "") {
    return undefined;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return timeoutMs;
}

function normalizeProverHeaders(rawValue, label) {
  if (rawValue == null || rawValue === "") {
    return {};
  }

  let parsed = rawValue;
  if (typeof rawValue === "string") {
    try {
      parsed = JSON.parse(rawValue);
    } catch (error) {
      throw new Error(
        `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }

  const headers = {};
  for (const [headerName, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
      throw new Error(`${label} header "${headerName}" must be a non-empty string.`);
    }
    headers[headerName] = headerValue.trim();
  }

  return headers;
}

export function parseProverHeadersJson(rawValue) {
  return normalizeProverHeaders(rawValue, "AGENC_PROVER_HEADERS_JSON");
}

function parseConfigProverHeaders(rawValue) {
  return normalizeProverHeaders(rawValue, "scenarioRunner.prover.headers");
}

export function mergeProverHeaders(baseHeaders, overrideHeaders) {
  return {
    ...baseHeaders,
    ...overrideHeaders,
  };
}

export function buildRemoteProverConfig(
  configSource = {},
  envSource = process.env,
  requiredEndpointMessage =
    "AGENC_PROVER_ENDPOINT or scenarioRunner.prover.endpoint is required for DV-03E.",
) {
  const endpoint = pickConfiguredValue(
    envSource.AGENC_PROVER_ENDPOINT,
    configSource.endpoint,
  );
  if (!endpoint) {
    throw new Error(requiredEndpointMessage);
  }
  validateProverEndpoint(endpoint);

  const apiKeyEnvVar = pickConfiguredValue(
    configSource.apiKeyEnvVar,
    "AGENC_PROVER_API_KEY",
  );
  const apiKey = pickConfiguredValue(
    envSource.AGENC_PROVER_API_KEY,
    typeof apiKeyEnvVar === "string" && apiKeyEnvVar !== "AGENC_PROVER_API_KEY"
      ? envSource[apiKeyEnvVar]
      : null,
  );

  const baseHeaders = {};
  if (apiKey) {
    baseHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const configuredHeaders = parseConfigProverHeaders(configSource.headers ?? {});
  const overrideHeaders = parseProverHeadersJson(envSource.AGENC_PROVER_HEADERS_JSON);
  const headers = mergeProverHeaders(
    mergeProverHeaders(baseHeaders, configuredHeaders),
    overrideHeaders,
  );
  const timeoutMs = parsePositiveTimeoutMs(
    pickConfiguredValue(envSource.AGENC_PROVER_TIMEOUT_MS, configSource.timeoutMs),
    typeof envSource.AGENC_PROVER_TIMEOUT_MS === "string"
      ? "AGENC_PROVER_TIMEOUT_MS"
      : "scenarioRunner.prover.timeoutMs",
  );

  return {
    kind: "remote",
    endpoint,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function buildRemoteProverConfigFromEnv(envSource = process.env) {
  return buildRemoteProverConfig(
    {},
    envSource,
    "AGENC_PROVER_ENDPOINT is required for DV-03E.",
  );
}
