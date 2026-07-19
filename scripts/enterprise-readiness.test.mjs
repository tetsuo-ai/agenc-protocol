import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_READINESS_CONFIG,
  auditEnterpriseReadiness,
  auditLocalRepository,
  parseSecurityTxt,
} from "./enterprise-readiness.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const API_ROOT = "https://api.github.com/repos/tetsuo-ai/agenc-protocol";
const AUDITED_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();

function response(
  body,
  { status = 200, contentType = "application/json", headers = {} } = {},
) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType, ...headers },
  });
}

function mockFetch(fixtures, calls) {
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method });
    assert.equal(
      method,
      "GET",
      `readiness checks must not mutate: ${method} ${url}`,
    );
    const fixture = fixtures.get(url);
    if (!fixture)
      return response({ message: "missing test fixture" }, { status: 404 });
    return typeof fixture === "function"
      ? fixture({ url, init })
      : fixture.clone();
  };
}

async function readyFixtures() {
  const codeowners = await readFile(
    path.join(REPO_ROOT, ".github/CODEOWNERS"),
    "utf8",
  );
  const listingSchema = JSON.parse(
    await readFile(
      path.join(
        REPO_ROOT,
        "packages/sdk-ts/schemas/listing-metadata.schema.json",
      ),
      "utf8",
    ),
  );
  const agentSchema = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "schemas/agent-metadata.schema.json"),
      "utf8",
    ),
  );
  const workflows = DEFAULT_READINESS_CONFIG.requiredWorkflows.map(
    ({ name, path: file }) => ({
      name,
      path: file,
      state: "active",
    }),
  );
  const workflowSources = new Map(
    await Promise.all(
      DEFAULT_READINESS_CONFIG.requiredWorkflows.map(async ({ path: file }) => [
        file,
        await readFile(path.join(REPO_ROOT, file), "utf8"),
      ]),
    ),
  );
  const securityTxt = (canonical) =>
    `Contact: mailto:security@agenc.tech\nContact: https://github.com/tetsuo-ai/agenc-protocol/security/advisories/new\nExpires: 2027-01-01T00:00:00Z\nCanonical: ${canonical}\nPolicy: https://github.com/tetsuo-ai/agenc-protocol/security/policy\n`;

  return new Map([
    [
      `${API_ROOT}/immutable-releases`,
      response({ enabled: true, enforced_by_owner: false }),
    ],
    [`${API_ROOT}/actions/workflows?per_page=100`, response({ workflows })],
    [`${API_ROOT}/commits/main`, response({ sha: AUDITED_COMMIT })],
    [
      `${API_ROOT}/branches/main/protection`,
      response({
        required_status_checks: {
          strict: true,
          contexts: [...DEFAULT_READINESS_CONFIG.requiredStatusChecks],
        },
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
          required_approving_review_count: 2,
        },
        enforce_admins: { enabled: true },
      }),
    ],
    [
      `${API_ROOT}/rulesets?per_page=100`,
      response([
        {
          id: 7,
          name: "Immutable protocol release tags",
          target: "tag",
          enforcement: "active",
        },
      ]),
    ],
    [
      `${API_ROOT}/rulesets/7`,
      response({
        id: 7,
        name: "Immutable protocol release tags",
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: [...DEFAULT_READINESS_CONFIG.releaseTagRefPatterns],
            exclude: [],
          },
        },
        rules: [{ type: "deletion" }, { type: "update" }],
      }),
    ],
    [
      `${API_ROOT}/environments?per_page=100`,
      response({
        environments: [
          {
            name: "production-release",
            protection_rules: [
              {
                type: "required_reviewers",
                reviewers: [
                  { type: "User", reviewer: { login: "7etsuo" } },
                  { type: "User", reviewer: { login: "signerless" } },
                ],
                prevent_self_review: true,
              },
            ],
            deployment_branch_policy: {
              protected_branches: false,
              custom_branch_policies: true,
            },
          },
        ],
      }),
    ],
    [
      `${API_ROOT}/environments/production-release`,
      response({
        name: "production-release",
        protection_rules: [
          {
            type: "required_reviewers",
            reviewers: [
              { type: "User", reviewer: { login: "7etsuo" } },
              { type: "User", reviewer: { login: "signerless" } },
            ],
            prevent_self_review: true,
          },
        ],
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }),
    ],
    [
      `${API_ROOT}/environments/production-release/deployment-branch-policies?per_page=100`,
      response({
        total_count: DEFAULT_READINESS_CONFIG.releaseTagNamePatterns.length,
        branch_policies: DEFAULT_READINESS_CONFIG.releaseTagNamePatterns.map(
          (name, index) => ({ id: 9 + index, name, type: "tag" }),
        ),
      }),
    ],
    [
      `${API_ROOT}/actions/permissions`,
      response({
        enabled: true,
        allowed_actions: "selected",
        sha_pinning_required: true,
      }),
    ],
    [
      `${API_ROOT}/actions/permissions/selected-actions`,
      response({
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: ["dtolnay/rust-toolchain@*"],
      }),
    ],
    [
      `${API_ROOT}/private-vulnerability-reporting`,
      response({ enabled: true }),
    ],
    [
      `${API_ROOT}/contents/.github/CODEOWNERS?ref=${AUDITED_COMMIT}`,
      response({
        encoding: "base64",
        content: Buffer.from(codeowners).toString("base64"),
      }),
    ],
    ...[...workflowSources].map(([file, source]) => [
      `${API_ROOT}/contents/${file}?ref=${AUDITED_COMMIT}`,
      response({ encoding: "base64", content: Buffer.from(source).toString("base64") }),
    ]),
    [
      `${API_ROOT}/collaborators/7etsuo/permission`,
      response({ permission: "admin" }),
    ],
    [
      `${API_ROOT}/collaborators/signerless/permission`,
      response({ permission: "admin" }),
    ],
    [
      API_ROOT,
      response({
        default_branch: "main",
        visibility: "public",
        immutable_releases_enabled: true,
        security_and_analysis: {
          dependabot_security_updates: { status: "enabled" },
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
          secret_scanning_validity_checks: { status: "enabled" },
        },
      }),
    ],
    ...DEFAULT_READINESS_CONFIG.securityTxtUrls.map((url) => [
      url,
      response(securityTxt(url), { contentType: "text/plain; charset=utf-8" }),
    ]),
    [
      "https://agenc.tech/schemas/listing-metadata-v1.schema.json",
      response(listingSchema, {
        contentType: "application/schema+json",
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      }),
    ],
    [
      "https://agenc.tech/schemas/agent-metadata-v1.schema.json",
      response(agentSchema, {
        contentType: "application/schema+json",
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      }),
    ],
    [
      "https://agenc.ag/schemas/agenc.agentCard.v1.json",
      response(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://agenc.ag/schemas/agenc.agentCard.v1.json",
          type: "object",
        },
        {
          contentType: "application/schema+json",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        },
      ),
    ],
  ]);
}

test("ready fixture passes and every network request is read-only", async () => {
  const calls = [];
  const result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(await readyFixtures(), calls),
    now: new Date("2026-07-19T00:00:00Z"),
  });

  assert.equal(
    result.ok,
    true,
    result.checks
      .filter((check) => !check.ok)
      .map((c) => c.message)
      .join("\n"),
  );
  assert.ok(calls.length >= 10);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("broad action or deployment patterns do not satisfy the allowlists", async () => {
  const fixtures = await readyFixtures();
  fixtures.set(
    `${API_ROOT}/actions/permissions/selected-actions`,
    response({
      github_owned_allowed: true,
      verified_allowed: true,
      patterns_allowed: ["*"],
    }),
  );
  fixtures.set(
    `${API_ROOT}/environments/production-release/deployment-branch-policies?per_page=100`,
    response({
      total_count: 2,
      branch_policies: [
        { id: 9, name: "protocol-v*", type: "tag" },
        { id: 10, name: "*", type: "branch" },
      ],
    }),
  );

  const result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(fixtures, []),
    now: new Date("2026-07-19T00:00:00Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.id === "github.actions-policy")?.ok,
    false,
  );
  assert.equal(
    result.checks.find((check) => check.id === "github.release-environment")
      ?.ok,
    false,
  );
});

test("readiness binds local audited bytes to remote main and protects every release-train tag", async () => {
  const staleCommit = await readyFixtures();
  staleCommit.set(`${API_ROOT}/commits/main`, response({ sha: "34".repeat(20) }));
  let result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(staleCommit, []),
    now: new Date("2026-07-19T00:00:00Z"),
  });
  assert.equal(result.checks.find(({ id }) => id === "github.audited-revision")?.ok, false);

  const changedWorkflow = await readyFixtures();
  const workflow = DEFAULT_READINESS_CONFIG.requiredWorkflows[0];
  changedWorkflow.set(
    `${API_ROOT}/contents/${workflow.path}?ref=${AUDITED_COMMIT}`,
    response({ encoding: "base64", content: Buffer.from("name: stale\n").toString("base64") }),
  );
  result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(changedWorkflow, []),
    now: new Date("2026-07-19T00:00:00Z"),
  });
  assert.equal(result.checks.find(({ id }) => id === "github.audited-revision")?.ok, false);

  const incompleteTags = await readyFixtures();
  incompleteTags.set(
    `${API_ROOT}/rulesets/7`,
    response({
      id: 7,
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/tags/protocol-v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "update" }],
    }),
  );
  result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(incompleteTags, []),
    now: new Date("2026-07-19T00:00:00Z"),
  });
  assert.equal(result.checks.find(({ id }) => id === "github.release-tags")?.ok, false);
});

test("not-ready fixture reports each external governance, intake, and schema blocker", async () => {
  const calls = [];
  const fixtures = new Map([
    [
      `${API_ROOT}/immutable-releases`,
      response({ enabled: false, enforced_by_owner: false }),
    ],
    [
      `${API_ROOT}/actions/workflows?per_page=100`,
      response({
        workflows: DEFAULT_READINESS_CONFIG.requiredWorkflows
          .slice(0, -1)
          .map(({ name, path: file }) => ({
            name,
            path: file,
            state: "disabled_manually",
          })),
      }),
    ],
    [
      `${API_ROOT}/branches/main/protection`,
      response({ message: "Branch not protected" }, { status: 404 }),
    ],
    [`${API_ROOT}/rulesets?per_page=100`, response([])],
    [`${API_ROOT}/environments?per_page=100`, response({ environments: [] })],
    [
      `${API_ROOT}/actions/permissions`,
      response({
        enabled: true,
        allowed_actions: "all",
        sha_pinning_required: false,
      }),
    ],
    [
      `${API_ROOT}/actions/permissions/selected-actions`,
      response({ message: "Conflict" }, { status: 409 }),
    ],
    [
      `${API_ROOT}/private-vulnerability-reporting`,
      response({ enabled: false }),
    ],
    [
      `${API_ROOT}/contents/.github/CODEOWNERS?ref=${AUDITED_COMMIT}`,
      response({ message: "Not Found" }, { status: 404 }),
    ],
    [
      `${API_ROOT}/collaborators/7etsuo/permission`,
      response({ permission: "none" }),
    ],
    [
      `${API_ROOT}/collaborators/signerless/permission`,
      response({ permission: "none" }),
    ],
    [
      API_ROOT,
      response({
        default_branch: "main",
        visibility: "public",
        immutable_releases_enabled: false,
        security_and_analysis: {
          dependabot_security_updates: { status: "disabled" },
          secret_scanning: { status: "disabled" },
          secret_scanning_push_protection: { status: "disabled" },
          secret_scanning_validity_checks: { status: "disabled" },
        },
      }),
    ],
    ...DEFAULT_READINESS_CONFIG.securityTxtUrls.map((url) => [
      url,
      response("<!doctype html><title>landing</title>", {
        contentType: "text/html",
      }),
    ]),
    [
      "https://agenc.tech/schemas/listing-metadata-v1.schema.json",
      response("<!doctype html>", { contentType: "text/html" }),
    ],
    [
      "https://agenc.tech/schemas/agent-metadata-v1.schema.json",
      response("not found", { status: 404, contentType: "text/plain" }),
    ],
    [
      "https://agenc.ag/schemas/agenc.agentCard.v1.json",
      response({ $id: "https://example.invalid/schema.json", type: "object" }),
    ],
  ]);

  const result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: mockFetch(fixtures, calls),
    now: new Date("2026-07-19T00:00:00Z"),
  });
  const failedIds = new Set(
    result.checks.filter((check) => !check.ok).map((check) => check.id),
  );

  assert.equal(result.ok, false);
  for (const id of [
    "github.workflows",
    "github.codeowners",
    "github.main-protection",
    "github.release-tags",
    "github.release-environment",
    "github.actions-policy",
    "github.immutable-releases",
    "github.security-features",
    "github.private-vulnerability-reporting",
    "host.security-txt",
    "host.schemas",
  ]) {
    assert.ok(failedIds.has(id), `expected ${id} to fail`);
  }
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(
    result.checks.find((check) => check.id === "host.security-txt").message
      .length < 1_000,
  );
});

test("local repository audit requires workflows, sensitive CODEOWNERS coverage, and truthful schema docs", async () => {
  const result = await auditLocalRepository({ repoRoot: REPO_ROOT });
  assert.equal(
    result.ok,
    true,
    result.checks
      .filter((check) => !check.ok)
      .map((c) => c.message)
      .join("\n"),
  );
});

test("security.txt parser preserves repeated fields and rejects malformed lines", () => {
  const parsed = parseSecurityTxt(
    "Contact: mailto:security@example.test\nContact: https://example.test/security\nExpires: 2027-01-01T00:00:00Z\n",
  );
  assert.deepEqual(parsed.fields.get("contact"), [
    "mailto:security@example.test",
    "https://example.test/security",
  ]);
  assert.deepEqual(parsed.errors, []);

  const invalid = parseSecurityTxt(
    "Contact mailto:missing-colon@example.test\n",
  );
  assert.equal(invalid.errors.length, 1);
});

test("transport failures become failed evidence instead of throwing or skipping", async () => {
  const result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
    now: new Date("2026-07-19T00:00:00Z"),
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.checks.some(
      (check) => !check.ok && check.message.includes("network unavailable"),
    ),
  );
});

test("oversized responses fail closed with bounded evidence", async () => {
  const result = await auditEnterpriseReadiness({
    repoRoot: REPO_ROOT,
    fetchImpl: async () =>
      response("too large", {
        contentType: "text/plain",
        headers: { "content-length": "4096" },
      }),
    config: { maxResponseBytes: 32 },
    now: new Date("2026-07-19T00:00:00Z"),
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.checks.some((check) =>
      check.message.includes("response body exceeds 32 bytes"),
    ),
  );
});
