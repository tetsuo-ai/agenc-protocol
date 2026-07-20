#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";

const DAY_MS = 24 * 60 * 60 * 1_000;
const execFile = promisify(execFileCallback);
const RELEASE_TAG_PREFIXES = Object.freeze([
  "protocol-v",
  "sdk-v",
  "moderation-v",
  "react-v",
  "tools-v",
  "worker-v",
  "mcp-v",
  "cli-v",
  "cli-alias-v",
]);

export const DEFAULT_READINESS_CONFIG = Object.freeze({
  owner: "tetsuo-ai",
  repo: "agenc-protocol",
  githubApiUrl: "https://api.github.com",
  defaultBranch: "main",
  releaseEnvironment: "production-release",
  releaseTagNamePatterns: Object.freeze(RELEASE_TAG_PREFIXES.map((prefix) => `${prefix}*`)),
  releaseTagRefPatterns: Object.freeze(
    RELEASE_TAG_PREFIXES.map((prefix) => `refs/tags/${prefix}*`),
  ),
  timeoutMs: 10_000,
  maxResponseBytes: 1_000_000,
  requiredStatusChecks: Object.freeze([
    "verify",
    "sdk-checks",
    "sdk-e2e",
    "idl-drift",
    "node-minimum",
    "rust-msrv",
    "program-coverage",
    "Clean-install SSR and browser smoke",
    "Advisory, license, and source policy",
    "CodeQL JavaScript/TypeScript",
    "Full-history secret scan",
    "npm license and policy controls",
  ]),
  allowedActionPatterns: Object.freeze(["dtolnay/rust-toolchain@*"]),
  requiredWorkflows: Object.freeze([
    Object.freeze({
      name: "CI",
      path: ".github/workflows/ci.yml",
      requiredKeys: ["workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "IDL Drift",
      path: ".github/workflows/idl-drift.yml",
      requiredKeys: ["workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "Release",
      path: ".github/workflows/release.yml",
      requiredKeys: ["push", "tags", "environment: production-release"],
    }),
    Object.freeze({
      name: "Sandbox Nightly",
      path: ".github/workflows/sandbox-nightly.yml",
      requiredKeys: ["schedule", "workflow_dispatch"],
    }),
    Object.freeze({
      name: "SDK",
      path: ".github/workflows/sdk.yml",
      requiredKeys: ["workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "Verifiable Build",
      path: ".github/workflows/verify.yml",
      requiredKeys: ["workflow_call", "workflow_dispatch"],
    }),
    Object.freeze({
      name: "Minimum Toolchain Compatibility",
      path: ".github/workflows/compatibility.yml",
      requiredKeys: ["workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "Program Coverage",
      path: ".github/workflows/coverage.yml",
      requiredKeys: ["workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "React Fixtures",
      path: ".github/workflows/react-fixtures.yml",
      requiredKeys: ["schedule", "workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "Rust Supply Chain",
      path: ".github/workflows/rust-supply-chain.yml",
      requiredKeys: ["workflow_call", "workflow_dispatch", "pull_request", "push"],
    }),
    Object.freeze({
      name: "Supply Chain",
      path: ".github/workflows/supply-chain.yml",
      requiredKeys: ["schedule", "workflow_dispatch", "pull_request", "push"],
    }),
  ]),
  requiredCodeownerPatterns: Object.freeze([
    "*",
    "/.github/",
    "/programs/agenc-coordination/",
    "/packages/",
    "/scripts/",
    "/schemas/",
    "/tests-integration/",
    "/SECURITY.md",
    "/.well-known/security.txt",
    "/.gitleaks.toml",
    "/Anchor.toml",
    "/Cargo.toml",
    "/Cargo.lock",
    "/coverage-policy.json",
    "/deny.toml",
    "/package.json",
    "/package-lock.json",
    "/release-train.json",
    "/rust-toolchain.toml",
    "/supply-chain/",
  ]),
  minimumCodeownersPerRule: 2,
  requiredCodeowners: Object.freeze(["@7etsuo", "@signerless"]),
  securityTxtUrls: Object.freeze([
    "https://agenc.ag/.well-known/security.txt",
    "https://agenc.tech/.well-known/security.txt",
  ]),
  requiredSecurityContacts: Object.freeze([
    "https://github.com/tetsuo-ai/agenc-protocol/security/advisories/new",
  ]),
  schemaEndpoints: Object.freeze([
    Object.freeze({
      url: "https://agenc.tech/schemas/listing-metadata-v1.schema.json",
      localPath: "packages/sdk-ts/schemas/listing-metadata.schema.json",
    }),
    Object.freeze({
      url: "https://agenc.tech/schemas/agent-metadata-v1.schema.json",
      localPath: "schemas/agent-metadata.schema.json",
    }),
    Object.freeze({
      url: "https://agenc.ag/schemas/agenc.agentCard.v1.json",
    }),
  ]),
});

function withConfig(overrides = {}) {
  return { ...DEFAULT_READINESS_CONFIG, ...overrides };
}

function makeCheck(id, ok, message, evidence) {
  return evidence === undefined
    ? { id, ok, message }
    : { id, ok, message, evidence };
}

function summarize(checks) {
  return { ok: checks.every((check) => check.ok), checks };
}

function joinFailures(failures, limit = 12) {
  if (failures.length <= limit) return failures.join("; ");
  return `${failures.slice(0, limit).join("; ")}; ${failures.length - limit} additional failure(s) omitted`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readBoundedResponse(
  response,
  maxResponseBytes,
  abortController,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    abortController.abort();
    throw new Error(
      `response body exceeds ${maxResponseBytes} bytes (content-length ${declaredLength})`,
    );
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        abortController.abort();
        throw new Error(`response body exceeds ${maxResponseBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function getText(url, options) {
  const { fetchImpl, headers = {}, maxResponseBytes, timeoutMs } = options;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        "user-agent": "agenc-enterprise-readiness/1",
        ...headers,
      },
      signal: abortController.signal,
    });
    const body = await readBoundedResponse(
      response,
      maxResponseBytes,
      abortController,
    );
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      cacheControl: response.headers.get("cache-control") ?? "",
      etag: response.headers.get("etag") ?? "",
      body,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `request timed out or was aborted after ${timeoutMs}ms`
        : errorMessage(error);
    return {
      ok: false,
      status: 0,
      contentType: "",
      cacheControl: "",
      etag: "",
      body: "",
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options) {
  const result = await getText(url, {
    ...options,
    headers: { accept: "application/vnd.github+json", ...options.headers },
  });
  if (!result.body) {
    return {
      ...result,
      ok: false,
      error: result.error ?? `HTTP ${result.status} returned no JSON body`,
    };
  }
  try {
    return { ...result, data: JSON.parse(result.body) };
  } catch (error) {
    return {
      ...result,
      ok: false,
      error: `invalid JSON: ${errorMessage(error)}`,
    };
  }
}

function failedRequest(result) {
  if (result.error) return result.error;
  const detail =
    result.data &&
    typeof result.data === "object" &&
    typeof result.data.message === "string"
      ? `: ${result.data.message}`
      : "";
  return `HTTP ${result.status}${detail}`;
}

function hasYamlKey(source, key) {
  if (key.includes(":")) return source.includes(key);
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "m").test(source);
}

function parseCodeowners(source) {
  const rules = new Map();
  for (const [index, original] of source.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/u);
    const pattern = tokens.shift();
    const owners = tokens.filter(
      (token) => token.startsWith("@") && token.length > 1,
    );
    rules.set(pattern, { owners, line: index + 1 });
  }
  return rules;
}

function validateCodeownersSource(source, config) {
  const rules = parseCodeowners(source);
  const failures = [];
  for (const pattern of config.requiredCodeownerPatterns) {
    const rule = rules.get(pattern);
    if (!rule) {
      failures.push(`missing ${pattern}`);
      continue;
    }
    const owners = new Set(rule.owners);
    if (owners.size < config.minimumCodeownersPerRule) {
      failures.push(
        `${pattern} has ${owners.size} owner(s), expected at least ${config.minimumCodeownersPerRule}`,
      );
    }
    const missingOwners = config.requiredCodeowners.filter(
      (owner) => !owners.has(owner),
    );
    if (missingOwners.length > 0)
      failures.push(`${pattern} is missing ${missingOwners.join(", ")}`);
  }
  return failures;
}

async function readRepoFile(repoRoot, relativePath, readFileImpl) {
  return readFileImpl(path.join(repoRoot, ...relativePath.split("/")), "utf8");
}

function decodeGithubContents(result, label) {
  if (
    !result.ok ||
    result.data?.encoding !== "base64" ||
    typeof result.data?.content !== "string"
  ) {
    throw new Error(
      result.ok
        ? `${label} response is not base64 file content`
        : `${label}: ${failedRequest(result)}`,
    );
  }
  const encoded = result.data.content.replace(/\s/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`${label} response contains malformed base64`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function auditLocalRepository({
  repoRoot = process.cwd(),
  readFileImpl = readFile,
  config: configOverrides,
} = {}) {
  const config = withConfig(configOverrides);
  const checks = [];

  const workflowFailures = [];
  await Promise.all(
    config.requiredWorkflows.map(async (workflow) => {
      try {
        const source = await readRepoFile(
          repoRoot,
          workflow.path,
          readFileImpl,
        );
        if (
          !new RegExp(
            `^name:\\s*["']?${escapeRegExp(workflow.name)}["']?\\s*$`,
            "m",
          ).test(source)
        ) {
          workflowFailures.push(
            `${workflow.path} does not declare name: ${workflow.name}`,
          );
        }
        const missing = workflow.requiredKeys.filter(
          (key) => !hasYamlKey(source, key),
        );
        if (missing.length > 0) {
          workflowFailures.push(
            `${workflow.path} is missing ${missing.join(", ")}`,
          );
        }
      } catch (error) {
        workflowFailures.push(`${workflow.path}: ${errorMessage(error)}`);
      }
    }),
  );
  checks.push(
    makeCheck(
      "local.workflows",
      workflowFailures.length === 0,
      workflowFailures.length === 0
        ? `all ${config.requiredWorkflows.length} required workflow definitions are present`
        : workflowFailures.join("; "),
    ),
  );

  try {
    const train = JSON.parse(
      await readRepoFile(repoRoot, "release-train.json", readFileImpl),
    );
    const prefixes = Array.isArray(train?.packages)
      ? train.packages.map(({ tagPrefix }) => tagPrefix)
      : [];
    const namePatterns = prefixes.map((prefix) => `${prefix}*`).sort();
    const refPatterns = prefixes.map((prefix) => `refs/tags/${prefix}*`).sort();
    const expectedNames = [...config.releaseTagNamePatterns].sort();
    const expectedRefs = [...config.releaseTagRefPatterns].sort();
    const valid =
      prefixes.length > 0 &&
      new Set(prefixes).size === prefixes.length &&
      isDeepStrictEqual(namePatterns, expectedNames) &&
      isDeepStrictEqual(refPatterns, expectedRefs);
    checks.push(
      makeCheck(
        "local.release-tag-policy",
        valid,
        valid
          ? `release governance covers all ${prefixes.length} release-train tag families`
          : "release governance tag patterns have drifted from release-train.json",
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "local.release-tag-policy",
        false,
        `release-train.json: ${errorMessage(error)}`,
      ),
    );
  }

  try {
    const codeownersSource = await readRepoFile(
      repoRoot,
      ".github/CODEOWNERS",
      readFileImpl,
    );
    const failures = validateCodeownersSource(codeownersSource, config);
    checks.push(
      makeCheck(
        "local.codeowners",
        failures.length === 0,
        failures.length === 0
          ? "sensitive paths have redundant CODEOWNERS coverage"
          : joinFailures(failures),
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "local.codeowners",
        false,
        `.github/CODEOWNERS: ${errorMessage(error)}`,
      ),
    );
  }

  const documentationFailures = [];
  for (const relativePath of [
    "docs/LISTING_METADATA.md",
    "docs/AGENT_METADATA.md",
    "packages/sdk-ts/src/values/agent-metadata.ts",
  ]) {
    try {
      const source = await readRepoFile(repoRoot, relativePath, readFileImpl);
      if (
        /\bpublished\s+as\b/iu.test(source) ||
        /\bpublished\s+JSON\s+Schema\b/iu.test(source)
      ) {
        documentationFailures.push(
          `${relativePath} still asserts current hosted schema publication`,
        );
      }
    } catch (error) {
      documentationFailures.push(`${relativePath}: ${errorMessage(error)}`);
    }
  }
  checks.push(
    makeCheck(
      "local.schema-documentation",
      documentationFailures.length === 0,
      documentationFailures.length === 0
        ? "schema documentation distinguishes identifiers from hosted publication status"
        : documentationFailures.join("; "),
    ),
  );

  const localSchemaFailures = [];
  for (const endpoint of config.schemaEndpoints.filter(
    (candidate) => candidate.localPath,
  )) {
    try {
      const parsed = JSON.parse(
        await readRepoFile(repoRoot, endpoint.localPath, readFileImpl),
      );
      if (parsed.$id !== endpoint.url) {
        localSchemaFailures.push(
          `${endpoint.localPath} has unexpected $id ${String(parsed.$id)}`,
        );
      }
    } catch (error) {
      localSchemaFailures.push(`${endpoint.localPath}: ${errorMessage(error)}`);
    }
  }
  checks.push(
    makeCheck(
      "local.schemas",
      localSchemaFailures.length === 0,
      localSchemaFailures.length === 0
        ? "in-repo schema identifiers match their reserved versioned URLs"
        : localSchemaFailures.join("; "),
    ),
  );

  return summarize(checks);
}

function githubRequestOptions(config, fetchImpl, token) {
  const headers = {
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return {
    fetchImpl,
    headers,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  };
}

function protectionContexts(protection) {
  const required = protection?.required_status_checks;
  const contexts = Array.isArray(required?.contexts) ? required.contexts : [];
  const checks = Array.isArray(required?.checks)
    ? required.checks
        .map((check) => check?.context)
        .filter((context) => typeof context === "string")
    : [];
  return new Set([...contexts, ...checks]);
}

async function auditGitHub({
  config,
  fetchImpl,
  token,
  repoRoot,
  readFileImpl,
  expectedCommit,
}) {
  const repositoryBase = `${config.githubApiUrl}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const options = githubRequestOptions(config, fetchImpl, token);
  const [
    repository,
    defaultBranchCommit,
    immutableReleases,
    workflows,
    protection,
    rulesets,
    environments,
    actionPermissions,
    selectedActions,
    pvr,
    remoteCodeowners,
    ...codeownerPermissions
  ] = await Promise.all([
    getJson(repositoryBase, options),
    getJson(
      `${repositoryBase}/commits/${encodeURIComponent(config.defaultBranch)}`,
      options,
    ),
    getJson(`${repositoryBase}/immutable-releases`, options),
    getJson(`${repositoryBase}/actions/workflows?per_page=100`, options),
    getJson(
      `${repositoryBase}/branches/${encodeURIComponent(config.defaultBranch)}/protection`,
      options,
    ),
    getJson(`${repositoryBase}/rulesets?per_page=100`, options),
    getJson(`${repositoryBase}/environments?per_page=100`, options),
    getJson(`${repositoryBase}/actions/permissions`, options),
    getJson(`${repositoryBase}/actions/permissions/selected-actions`, options),
    getJson(`${repositoryBase}/private-vulnerability-reporting`, options),
    getJson(
      `${repositoryBase}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(expectedCommit)}`,
      options,
    ),
    ...config.requiredCodeowners.map((owner) =>
      getJson(
        `${repositoryBase}/collaborators/${encodeURIComponent(owner.slice(1))}/permission`,
        options,
      ),
    ),
  ]);
  const checks = [];

  const revisionMatches =
    /^[0-9a-f]{40}$/.test(expectedCommit) &&
    repository.ok &&
    repository.data?.default_branch === config.defaultBranch &&
    defaultBranchCommit.ok &&
    defaultBranchCommit.data?.sha === expectedCommit;
  const auditedFileFailures = [];
  const remoteWorkflowContents = await Promise.all(
    config.requiredWorkflows.map((workflow) =>
      getJson(
        `${repositoryBase}/contents/${workflow.path}?ref=${encodeURIComponent(expectedCommit)}`,
        options,
      ),
    ),
  );
  for (const [index, result] of remoteWorkflowContents.entries()) {
    const workflow = config.requiredWorkflows[index];
    try {
      const [remote, local] = await Promise.all([
        Promise.resolve(decodeGithubContents(result, workflow.path)),
        readRepoFile(repoRoot, workflow.path, readFileImpl),
      ]);
      if (remote !== local) auditedFileFailures.push(`${workflow.path} differs from remote audited commit`);
    } catch (error) {
      auditedFileFailures.push(errorMessage(error));
    }
  }
  checks.push(
    makeCheck(
      "github.audited-revision",
      revisionMatches && auditedFileFailures.length === 0,
      revisionMatches && auditedFileFailures.length === 0
        ? `local workflow bytes are identical to remote ${config.defaultBranch} at ${expectedCommit}`
        : joinFailures([
            ...(revisionMatches
              ? []
              : [`local audited commit ${expectedCommit} is not remote ${config.defaultBranch}`]),
            ...auditedFileFailures,
          ]),
    ),
  );

  if (!workflows.ok) {
    checks.push(
      makeCheck(
        "github.workflows",
        false,
        `cannot verify workflows: ${failedRequest(workflows)}`,
      ),
    );
  } else {
    const remote = Array.isArray(workflows.data?.workflows)
      ? workflows.data.workflows
      : [];
    const failures = [];
    for (const required of config.requiredWorkflows) {
      const found = remote.find((workflow) => workflow?.path === required.path);
      if (!found) failures.push(`${required.path} is absent`);
      else if (found.name !== required.name)
        failures.push(`${required.path} is named ${String(found.name)}`);
      else if (found.state !== "active")
        failures.push(`${required.name} is ${String(found.state)}`);
    }
    checks.push(
      makeCheck(
        "github.workflows",
        failures.length === 0,
        failures.length === 0
          ? "all required GitHub workflows are active"
          : failures.join("; "),
      ),
    );
  }

  if (!remoteCodeowners.ok) {
    checks.push(
      makeCheck(
        "github.codeowners",
        false,
        `cannot verify landed CODEOWNERS: ${failedRequest(remoteCodeowners)}`,
      ),
    );
  } else {
    const failures = [];
    let source;
    if (
      remoteCodeowners.data?.encoding !== "base64" ||
      typeof remoteCodeowners.data?.content !== "string"
    ) {
      failures.push("GitHub contents response is not base64 file content");
    } else {
      try {
        source = decodeGithubContents(remoteCodeowners, ".github/CODEOWNERS");
        const localSource = await readRepoFile(
          repoRoot,
          ".github/CODEOWNERS",
          readFileImpl,
        );
        if (source !== localSource) {
          failures.push("local CODEOWNERS differs from the remote audited commit");
        }
        failures.push(...validateCodeownersSource(source, config));
      } catch (error) {
        failures.push(`cannot decode CODEOWNERS: ${errorMessage(error)}`);
      }
    }
    for (const [index, permission] of codeownerPermissions.entries()) {
      const owner = config.requiredCodeowners[index];
      if (!permission.ok) {
        failures.push(
          `${owner} permission cannot be verified: ${failedRequest(permission)}`,
        );
        continue;
      }
      if (
        !new Set(["admin", "maintain", "write"]).has(
          permission.data?.permission,
        )
      ) {
        failures.push(
          `${owner} has ineligible ${String(permission.data?.permission)} permission`,
        );
      }
    }
    checks.push(
      makeCheck(
        "github.codeowners",
        failures.length === 0,
        failures.length === 0
          ? "landed CODEOWNERS names two eligible maintainers on every sensitive rule"
          : joinFailures(failures),
      ),
    );
  }

  if (!protection.ok) {
    checks.push(
      makeCheck(
        "github.main-protection",
        false,
        `cannot verify ${config.defaultBranch} protection: ${failedRequest(protection)}`,
      ),
    );
  } else {
    const data = protection.data ?? {};
    const review = data.required_pull_request_reviews ?? {};
    const contexts = protectionContexts(data);
    const missingContexts = config.requiredStatusChecks.filter(
      (context) => !contexts.has(context),
    );
    const failures = [];
    if (data.required_status_checks?.strict !== true)
      failures.push("strict status checks are not enabled");
    if (missingContexts.length > 0)
      failures.push(`missing checks: ${missingContexts.join(", ")}`);
    if ((review.required_approving_review_count ?? 0) < 2)
      failures.push("fewer than two approvals required");
    if (review.require_code_owner_reviews !== true)
      failures.push("code-owner review is not required");
    if (review.dismiss_stale_reviews !== true)
      failures.push("stale approvals are not dismissed");
    if (data.enforce_admins?.enabled !== true)
      failures.push("administrators can bypass protection");
    if (data.allow_force_pushes?.enabled === true)
      failures.push("force pushes are allowed");
    if (data.allow_deletions?.enabled === true)
      failures.push("branch deletion is allowed");
    checks.push(
      makeCheck(
        "github.main-protection",
        failures.length === 0,
        failures.length === 0
          ? `${config.defaultBranch} has enforced review and status gates`
          : failures.join("; "),
      ),
    );
  }

  if (!rulesets.ok) {
    checks.push(
      makeCheck(
        "github.release-tags",
        false,
        `cannot verify tag rulesets: ${failedRequest(rulesets)}`,
      ),
    );
  } else {
    const candidates = (Array.isArray(rulesets.data) ? rulesets.data : [])
      .filter(
        (ruleset) =>
          ruleset?.target === "tag" && ruleset?.enforcement === "active",
      )
      .slice(0, 25);
    const details = await Promise.all(
      candidates.map((ruleset) =>
        getJson(`${repositoryBase}/rulesets/${ruleset.id}`, options),
      ),
    );
    const protectedPatterns = new Set();
    for (const detail of details) {
      if (!detail.ok) continue;
      const data = detail.data ?? {};
      const includes = data.conditions?.ref_name?.include;
      const excludes = data.conditions?.ref_name?.exclude;
      const ruleTypes = new Set(
        (Array.isArray(data.rules) ? data.rules : [])
          .map((rule) => rule?.type)
          .filter(Boolean),
      );
      if (
        data.target === "tag" &&
        data.enforcement === "active" &&
        Array.isArray(includes) &&
        Array.isArray(excludes) &&
        excludes.length === 0 &&
        ruleTypes.has("deletion") &&
        ruleTypes.has("update") &&
        Array.isArray(data.bypass_actors) &&
        data.bypass_actors.length === 0
      ) {
        for (const pattern of includes) protectedPatterns.add(pattern);
      }
    }
    const missingPatterns = config.releaseTagRefPatterns.filter(
      (pattern) => !protectedPatterns.has(pattern),
    );
    const valid = missingPatterns.length === 0;
    checks.push(
      makeCheck(
        "github.release-tags",
        valid,
        valid
          ? `all ${config.releaseTagRefPatterns.length} release tag families are protected against update and deletion`
          : `active bypass-free tag rulesets do not protect: ${missingPatterns.join(", ")}`,
      ),
    );
  }

  if (!environments.ok) {
    checks.push(
      makeCheck(
        "github.release-environment",
        false,
        `cannot verify release environment: ${failedRequest(environments)}`,
      ),
    );
  } else {
    const environment = (
      Array.isArray(environments.data?.environments)
        ? environments.data.environments
        : []
    ).find((candidate) => candidate?.name === config.releaseEnvironment);
    let detail = environment;
    let detailFailure;
    let deploymentPolicies;
    if (environment) {
      const environmentPath = `${repositoryBase}/environments/${encodeURIComponent(config.releaseEnvironment)}`;
      const [detailResult, policyResult] = await Promise.all([
        getJson(environmentPath, options),
        getJson(
          `${environmentPath}/deployment-branch-policies?per_page=100`,
          options,
        ),
      ]);
      if (detailResult.ok) detail = detailResult.data;
      else detailFailure = failedRequest(detailResult);
      if (policyResult.ok) deploymentPolicies = policyResult.data;
      else if (!detailFailure)
        detailFailure = `deployment tag policy: ${failedRequest(policyResult)}`;
    }
    const reviewerRule = detail?.protection_rules?.find(
      (rule) => rule?.type === "required_reviewers",
    );
    const reviewerCount = Array.isArray(reviewerRule?.reviewers)
      ? reviewerRule.reviewers.length
      : 0;
    const policy = detail?.deployment_branch_policy;
    const deploymentPolicyList = Array.isArray(
      deploymentPolicies?.branch_policies,
    )
      ? deploymentPolicies.branch_policies
      : [];
    const deploymentTagPatterns = deploymentPolicyList
      .filter(({ type }) => type === "tag")
      .map(({ name }) => name)
      .sort();
    const releaseTagPolicy =
      deploymentPolicyList.length === config.releaseTagNamePatterns.length &&
      isDeepStrictEqual(
        deploymentTagPatterns,
        [...config.releaseTagNamePatterns].sort(),
      );
    const valid =
      !detailFailure &&
      reviewerCount >= 2 &&
      reviewerRule?.prevent_self_review === true &&
      policy?.protected_branches === false &&
      policy?.custom_branch_policies === true &&
      releaseTagPolicy;
    const failure = !environment
      ? `${config.releaseEnvironment} does not exist`
      : detailFailure
        ? `cannot inspect ${config.releaseEnvironment}: ${detailFailure}`
        : `${config.releaseEnvironment} must require two reviewers, prevent self-review, and allow exactly every release-train tag family`;
    checks.push(
      makeCheck(
        "github.release-environment",
        valid,
        valid
          ? `${config.releaseEnvironment} has protected deployment approvals`
          : failure,
      ),
    );
  }

  if (!actionPermissions.ok) {
    checks.push(
      makeCheck(
        "github.actions-policy",
        false,
        `cannot verify Actions policy: ${failedRequest(actionPermissions)}`,
      ),
    );
  } else {
    const data = actionPermissions.data ?? {};
    const basicPolicy =
      data.enabled === true &&
      data.allowed_actions === "selected" &&
      data.sha_pinning_required === true;
    const configuredPatterns = Array.isArray(
      selectedActions.data?.patterns_allowed,
    )
      ? selectedActions.data.patterns_allowed
      : [];
    const patternsMatch =
      configuredPatterns.length === config.allowedActionPatterns.length &&
      config.allowedActionPatterns.every((pattern) =>
        configuredPatterns.includes(pattern),
      );
    const selectedPolicy =
      selectedActions.ok &&
      selectedActions.data?.github_owned_allowed === true &&
      selectedActions.data?.verified_allowed === false &&
      patternsMatch;
    const valid = basicPolicy && selectedPolicy;
    let failure;
    if (!basicPolicy) {
      failure = `expected enabled/selected/SHA-pinned Actions, got enabled=${String(data.enabled)}, allowed_actions=${String(data.allowed_actions)}, sha_pinning_required=${String(data.sha_pinning_required)}`;
    } else if (!selectedActions.ok) {
      failure = `cannot verify selected Actions allowlist: ${failedRequest(selectedActions)}`;
    } else {
      failure = `expected GitHub-owned actions plus only ${config.allowedActionPatterns.join(", ")}; got verified_allowed=${String(selectedActions.data?.verified_allowed)}, patterns=${configuredPatterns.join(", ")}`;
    }
    checks.push(
      makeCheck(
        "github.actions-policy",
        valid,
        valid
          ? "Actions permits only GitHub-owned actions and the pinned Rust toolchain action"
          : failure,
      ),
    );
  }

  if (!immutableReleases.ok) {
    checks.push(
      makeCheck(
        "github.immutable-releases",
        false,
        `cannot verify immutable releases: ${failedRequest(immutableReleases)}`,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "github.immutable-releases",
        immutableReleases.data?.enabled === true,
        immutableReleases.data?.enabled === true
          ? "immutable releases are enabled"
          : "immutable releases are not enabled",
      ),
    );
  }

  if (!repository.ok) {
    const failure = failedRequest(repository);
    checks.push(
      makeCheck(
        "github.security-features",
        false,
        `cannot verify repository settings: ${failure}`,
      ),
    );
  } else {
    const analysis = repository.data?.security_and_analysis ?? {};
    const requiredFeatures = [
      "dependabot_security_updates",
      "secret_scanning",
      "secret_scanning_push_protection",
      "secret_scanning_validity_checks",
    ];
    const disabled = requiredFeatures.filter(
      (feature) => analysis[feature]?.status !== "enabled",
    );
    checks.push(
      makeCheck(
        "github.security-features",
        disabled.length === 0,
        disabled.length === 0
          ? "Dependabot updates and secret-scanning protections are enabled"
          : `not enabled: ${disabled.join(", ")}`,
      ),
    );
  }

  if (!pvr.ok) {
    checks.push(
      makeCheck(
        "github.private-vulnerability-reporting",
        false,
        `cannot verify private vulnerability reporting: ${failedRequest(pvr)}`,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        "github.private-vulnerability-reporting",
        pvr.data?.enabled === true,
        pvr.data?.enabled === true
          ? "private vulnerability reporting is enabled"
          : "private vulnerability reporting is disabled",
      ),
    );
  }

  return summarize(checks);
}

export function parseSecurityTxt(source) {
  const fields = new Map();
  const errors = [];
  let omittedErrors = 0;
  const recordError = (message) => {
    if (errors.length < 25) errors.push(message);
    else omittedErrors += 1;
  };
  for (const [index, original] of source.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0 || colon === line.length - 1) {
      recordError(`line ${index + 1} is not a field-name: value pair`);
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || !value) {
      recordError(`line ${index + 1} has an invalid field name or empty value`);
      continue;
    }
    const values = fields.get(name) ?? [];
    values.push(value);
    fields.set(name, values);
  }
  if (omittedErrors > 0)
    errors.push(`${omittedErrors} additional parse error(s) omitted`);
  return { fields, errors };
}

function validSecurityTxt(result, url, config, now) {
  const failures = [];
  if (!result.ok) return [`${url}: ${failedRequest(result)}`];
  if (
    result.contentType.split(";", 1)[0].trim().toLowerCase() !== "text/plain"
  ) {
    failures.push(
      `${url}: content-type is ${result.contentType || "missing"}, expected text/plain`,
    );
  }
  if (/^\s*(?:<!doctype|<html|<head|<body)/iu.test(result.body)) {
    failures.push(`${url}: body looks like HTML`);
  }
  if (failures.length > 0) return failures;
  const parsed = parseSecurityTxt(result.body);
  failures.push(...parsed.errors.map((error) => `${url}: ${error}`));
  const contacts = parsed.fields.get("contact") ?? [];
  for (const required of config.requiredSecurityContacts) {
    if (!contacts.includes(required))
      failures.push(`${url}: missing Contact ${required}`);
  }
  const expiresValues = parsed.fields.get("expires") ?? [];
  if (expiresValues.length !== 1) {
    failures.push(`${url}: expected exactly one Expires field`);
  } else {
    const timestamp = expiresValues[0];
    const rfc3339 =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
    const expires = new Date(timestamp);
    if (!rfc3339.test(timestamp) || !Number.isFinite(expires.getTime())) {
      failures.push(`${url}: Expires is not an RFC 3339 timestamp`);
    } else if (expires <= now)
      failures.push(`${url}: Expires is not in the future`);
    else if (expires.getTime() - now.getTime() > 366 * DAY_MS) {
      failures.push(`${url}: Expires is more than 366 days in the future`);
    }
  }
  const canonicals = parsed.fields.get("canonical") ?? [];
  if (!canonicals.includes(url))
    failures.push(`${url}: Canonical does not name the fetched URL`);
  const policies = parsed.fields.get("policy") ?? [];
  if (!policies.some((value) => value.startsWith("https://"))) {
    failures.push(`${url}: missing HTTPS Policy field`);
  }
  return failures;
}

function hasSafeVersionedCache(cacheControl, etag) {
  const directives = cacheControl
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  const maxAge = directives.find((directive) =>
    directive.startsWith("max-age="),
  );
  const seconds = maxAge ? Number(maxAge.slice("max-age=".length)) : Number.NaN;
  if (
    !directives.includes("public") ||
    !Number.isFinite(seconds) ||
    seconds < 0
  )
    return false;
  if (directives.includes("immutable") && seconds >= 86_400) return true;
  return (
    directives.includes("must-revalidate") &&
    typeof etag === "string" &&
    etag.length > 0
  );
}

function isCanonicalJsonSchemaDialect(value) {
  return value === "https://json-schema.org/draft/2020-12/schema";
}

async function auditHosted({ config, fetchImpl, readFileImpl, repoRoot, now }) {
  const options = {
    fetchImpl,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  };
  const securityResults = await Promise.all(
    config.securityTxtUrls.map(async (url) => ({
      url,
      result: await getText(url, options),
    })),
  );
  const securityFailures = securityResults.flatMap(({ url, result }) =>
    validSecurityTxt(result, url, config, now),
  );

  const schemaResults = await Promise.all(
    config.schemaEndpoints.map(async (endpoint) => ({
      endpoint,
      result: await getText(endpoint.url, {
        ...options,
        headers: { accept: "application/schema+json, application/json" },
      }),
    })),
  );
  const schemaFailures = [];
  for (const { endpoint, result } of schemaResults) {
    if (!result.ok) {
      schemaFailures.push(`${endpoint.url}: ${failedRequest(result)}`);
      continue;
    }
    const mediaType = result.contentType.split(";", 1)[0].trim().toLowerCase();
    if (
      mediaType !== "application/json" &&
      mediaType !== "application/schema+json"
    ) {
      schemaFailures.push(
        `${endpoint.url}: content-type is ${result.contentType || "missing"}`,
      );
      continue;
    }
    if (!hasSafeVersionedCache(result.cacheControl, result.etag)) {
      schemaFailures.push(
        `${endpoint.url}: missing an explicit public versioned cache policy and validator`,
      );
    }
    let hosted;
    try {
      hosted = JSON.parse(result.body);
    } catch (error) {
      schemaFailures.push(
        `${endpoint.url}: invalid JSON: ${errorMessage(error)}`,
      );
      continue;
    }
    if (!hosted || typeof hosted !== "object" || Array.isArray(hosted)) {
      schemaFailures.push(`${endpoint.url}: schema is not a JSON object`);
      continue;
    }
    if (hosted.$id !== endpoint.url) {
      schemaFailures.push(`${endpoint.url}: $id is ${String(hosted.$id)}`);
    }
    if (!isCanonicalJsonSchemaDialect(hosted.$schema)) {
      schemaFailures.push(`${endpoint.url}: missing a JSON Schema dialect URI`);
    }
    if (endpoint.localPath) {
      try {
        const local = JSON.parse(
          await readRepoFile(repoRoot, endpoint.localPath, readFileImpl),
        );
        if (!isDeepStrictEqual(hosted, local)) {
          schemaFailures.push(
            `${endpoint.url}: hosted JSON differs from ${endpoint.localPath}`,
          );
        }
      } catch (error) {
        schemaFailures.push(`${endpoint.localPath}: ${errorMessage(error)}`);
      }
    }
  }

  return summarize([
    makeCheck(
      "host.security-txt",
      securityFailures.length === 0,
      securityFailures.length === 0
        ? "security.txt is canonical and advertises the required contacts on both public domains"
        : joinFailures(securityFailures),
    ),
    makeCheck(
      "host.schemas",
      schemaFailures.length === 0,
      schemaFailures.length === 0
        ? "versioned schema endpoints serve the expected cache-safe JSON"
        : joinFailures(schemaFailures),
    ),
  ]);
}

export async function auditEnterpriseReadiness({
  repoRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  token = process.env.GITHUB_TOKEN,
  now = new Date(),
  localOnly = false,
  expectedCommit,
  config: configOverrides,
} = {}) {
  if (typeof fetchImpl !== "function" && !localOnly) {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const config = withConfig(configOverrides);
  const local = await auditLocalRepository({ repoRoot, readFileImpl, config });
  if (localOnly) return local;

  let auditedCommit = expectedCommit;
  if (auditedCommit === undefined) {
    try {
      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      auditedCommit = stdout.trim().toLowerCase();
    } catch (error) {
      auditedCommit = `unresolved:${errorMessage(error)}`;
    }
  }

  const [github, hosted] = await Promise.all([
    auditGitHub({
      config,
      fetchImpl,
      token,
      repoRoot,
      readFileImpl,
      expectedCommit: auditedCommit,
    }),
    auditHosted({ config, fetchImpl, readFileImpl, repoRoot, now }),
  ]);
  return summarize([...local.checks, ...github.checks, ...hosted.checks]);
}

function printHuman(result) {
  const passed = result.checks.filter((check) => check.ok).length;
  process.stdout.write(
    `Enterprise readiness: ${result.ok ? "PASS" : "FAIL"} (${passed}/${result.checks.length})\n`,
  );
  for (const check of result.checks) {
    process.stdout.write(
      `${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.message}\n`,
    );
  }
}

function usage() {
  return `Usage: node scripts/enterprise-readiness.mjs [--json] [--local-only]\n\nPerforms read-only local, GitHub, security.txt, and hosted-schema readiness checks.\nSet GITHUB_TOKEN for authenticated GitHub settings evidence. No setting is mutated.\n`;
}

async function runCli(argv) {
  const unknown = argv.filter(
    (arg) => !["--json", "--local-only", "--help", "-h"].includes(arg),
  );
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown argument(s): ${unknown.join(", ")}\n${usage()}`,
    );
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return 0;
  }
  const result = await auditEnterpriseReadiness({
    repoRoot: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    localOnly: argv.includes("--local-only"),
  });
  if (argv.includes("--json"))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);
  return result.ok ? 0 : 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
