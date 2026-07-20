# Enterprise readiness gate

`scripts/enterprise-readiness.mjs` is the read-only evidence gate for repository
governance, private security intake, and the versioned public schema endpoints.
It never enables a workflow, edits a repository setting, uploads content, or
contacts a reporter. Every network operation is an HTTP `GET` with a bounded
response body and timeout.

Run the deterministic mocked regression suite first:

```bash
node --test scripts/enterprise-readiness.test.mjs
```

Check only repository-controlled files in the current worktree without network
access:

```bash
node scripts/enterprise-readiness.mjs --local-only
```

Collect live evidence after an authorized administrator has configured GitHub
and the hosted domains:

```bash
GITHUB_TOKEN=<read-capable-token> node scripts/enterprise-readiness.mjs
```

Use `--json` for machine-readable output. A missing permission, unreachable
endpoint, malformed response, or unavailable setting is a failure: the gate
does not silently downgrade missing evidence to a warning.

## Required GitHub state

The live gate requires:

- the audited local commit to equal the remote `main` commit, with every required
  workflow and CODEOWNERS byte-for-byte identical at that exact revision;
- every release, verification, compatibility, fixture, coverage, and supply-chain
  workflow in the readiness policy to exist remotely and have state `active`;
- strict protection on `main`, including the core build/e2e checks plus minimum
  toolchain, browser fixture, Rust advisory/license/source, CodeQL, full-history
  secret, npm license, and program-coverage checks; two approvals; CODEOWNER
  review; stale-review dismissal; and no administrator/force-push/deletion bypass;
- active, bypass-free tag rulesets that block update and deletion for every tag
  prefix in `release-train.json` (protocol, SDK, React, tools, MCP, moderation,
  worker, CLI, and CLI alias);
- the `production-release` environment to name two eligible reviewers, prevent
  self-review, and accept deployments only from those exact release-train tag
  families (GitHub requires one eligible reviewer to approve an environment;
  the separate branch rule requires two pull-request approvals);
- Actions to allow GitHub-owned actions plus only `dtolnay/rust-toolchain@*`,
  with all action references still forced to full commit SHAs;
- immutable releases, Dependabot security updates, secret scanning, push
  protection, validity checks, and Private Vulnerability Reporting to be
  enabled.

`.github/CODEOWNERS` names two current repository administrators for the global
rule and security-, release-, package-, program-, workflow-, and script-sensitive
paths. CODEOWNERS has no enforcement effect until the `main` protection rule
requires code-owner review.

## Required security intake state

Both of these endpoints must return active RFC 9116-style plain text:

- `https://agenc.ag/.well-known/security.txt`
- `https://agenc.tech/.well-known/security.txt`

Each document must name its fetched URL in `Canonical`, carry a future `Expires`
date no more than 366 days away, link the HTTPS security policy, and expose the
enabled GitHub private-advisory form. `security@agenc.tech` remains intentionally
unadvertised until an operator verifies mailbox delivery and alerting end to end.
The checker verifies GitHub's PVR setting and the documents served over HTTP.

## Required schema state

The gate checks all three reserved versioned schema URLs for a JSON Schema media
type, matching `$id`, a declared JSON Schema dialect, and an explicit public
cache policy (long-lived immutable caching or validator-backed revalidation):

- `https://agenc.tech/schemas/listing-metadata-v1.schema.json`
- `https://agenc.tech/schemas/agent-metadata-v1.schema.json`
- `https://agenc.ag/schemas/agenc.agentCard.v1.json`

The first two hosted documents must also be structurally identical to their
in-repo source files. Until the live gate passes, consumers must use the in-repo
or in-package copies; a schema `$id` is an identifier, not proof that a URL is
deployed.

## Operator boundary

Repository administrators and hosting operators must perform the settings and
deployment changes through their reviewed operational process. This repository
gate only observes the resulting state. A green fixture test proves checker
logic; only a green authenticated live run proves current external readiness.
