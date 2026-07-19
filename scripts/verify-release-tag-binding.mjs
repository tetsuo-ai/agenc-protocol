#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`release tag binding check failed: ${message}`);
  process.exit(1);
}

function gitOutput(args, failureMessage) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) fail(failureMessage);
  return result.stdout.trim();
}

const tag = process.env.GITHUB_REF_NAME;
const expectedCommit = process.env.GITHUB_SHA;

if (!tag || !expectedCommit) {
  fail("GITHUB_REF_NAME and GITHUB_SHA are required");
}
if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) {
  fail("GITHUB_SHA is not a Git object ID");
}

const directRef = `refs/tags/${tag}`;
const peeledRef = `${directRef}^{}`;
if (process.env.GITHUB_REF && process.env.GITHUB_REF !== directRef) {
  fail(`event ref ${process.env.GITHUB_REF} is not ${directRef}`);
}

const refCheck = spawnSync("git", ["check-ref-format", directRef], {
  encoding: "utf8",
});
if (refCheck.status !== 0) {
  fail("release tag is not a valid Git ref");
}

// GitHub can represent an annotated tag event by either the tag object or its
// peeled commit. Normalize the event identity to the exact source commit, while
// also preserving the tag-object identity when GITHUB_SHA names one.
const expectedType = gitOutput(
  ["cat-file", "-t", expectedCommit],
  "GITHUB_SHA is not available in the checkout",
);
if (expectedType !== "commit" && expectedType !== "tag") {
  fail(`GITHUB_SHA names a ${expectedType}, not a commit or annotated tag`);
}
const expectedSourceCommit = gitOutput(
  ["rev-parse", "--verify", `${expectedCommit}^{commit}`],
  "GITHUB_SHA cannot be peeled to a commit",
);
const checkoutCommit = gitOutput(
  ["rev-parse", "--verify", "HEAD^{commit}"],
  "checkout HEAD cannot be resolved",
);
if (checkoutCommit.toLowerCase() !== expectedSourceCommit.toLowerCase()) {
  fail(
    `checkout HEAD ${checkoutCommit} is not event commit ${expectedSourceCommit}`,
  );
}

// actions/checkout fetches all tags for this workflow (fetch-depth: 0). Keep
// the exact tag object fetched for the event as a second identity. GitHub's
// GITHUB_SHA may be the peeled commit for an annotated tag, so comparing only
// peeled commits would otherwise accept a force-replaced annotation/signature
// that still points to the same source commit.
const checkoutTagObject = gitOutput(
  ["rev-parse", "--verify", directRef],
  "release tag is not available in the checkout",
);
const checkoutTagCommit = gitOutput(
  ["rev-parse", "--verify", `${directRef}^{commit}`],
  "checkout release tag cannot be peeled to a commit",
);
if (checkoutTagCommit.toLowerCase() !== expectedSourceCommit.toLowerCase()) {
  fail(
    `checkout tag ${directRef} resolves to ${checkoutTagCommit}, not event commit ${expectedSourceCommit}`,
  );
}
if (
  expectedType === "tag" &&
  checkoutTagObject.toLowerCase() !== expectedCommit.toLowerCase()
) {
  fail(`${directRef} does not name event tag object ${expectedCommit} locally`);
}

// Query origin instead of trusting the checkout's event-time tag ref. Annotated
// tags produce both the tag-object ref and a ^{} record; the peeled commit is the
// release source identity. Lightweight tags use the direct ref as the commit.
const remote = spawnSync(
  "git",
  ["ls-remote", "--exit-code", "origin", directRef, peeledRef],
  { encoding: "utf8" },
);
if (remote.status !== 0) {
  fail(`origin no longer exposes ${directRef}`);
}

let directObject;
let peeledCommit;
for (const line of remote.stdout.split("\n")) {
  const match = line.match(/^([0-9a-f]{40,64})\s+(.+)$/i);
  if (!match) continue;
  if (match[2] === directRef) directObject = match[1];
  if (match[2] === peeledRef) peeledCommit = match[1];
}

if (!directObject) {
  fail(`could not resolve ${directRef} to a Git object`);
}
if (directObject.toLowerCase() !== checkoutTagObject.toLowerCase()) {
  fail(
    `${directRef} names ${directObject} on origin, not checkout tag object ${checkoutTagObject}`,
  );
}
const actualCommit = peeledCommit ?? directObject;
if (actualCommit.toLowerCase() !== expectedSourceCommit.toLowerCase()) {
  fail(
    `${directRef} resolves to ${actualCommit}, not event commit ${expectedSourceCommit}`,
  );
}
if (
  expectedType === "tag" &&
  directObject?.toLowerCase() !== expectedCommit.toLowerCase()
) {
  fail(`${directRef} no longer names event tag object ${expectedCommit}`);
}

console.log(`release tag binding verified: ${directRef} -> ${actualCommit}`);
