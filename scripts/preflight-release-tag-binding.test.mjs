import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TAG_BINDING_SCRIPT = fileURLToPath(
  new URL("./verify-release-tag-binding.mjs", import.meta.url),
);

function run(command, args, { cwd, env } = {}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });
}

function git(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

function verify(cwd, { sha, tag, ref = `refs/tags/${tag}` }) {
  return run(process.execPath, [TAG_BINDING_SCRIPT], {
    cwd,
    env: {
      ...process.env,
      GITHUB_SHA: sha,
      GITHUB_REF_NAME: tag,
      GITHUB_REF: ref,
    },
  });
}

function assertVerified(result) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /release tag binding verified/);
}

function assertRejected(result, pattern) {
  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, pattern);
}

test("release tag binding follows exact event and remote Git identities", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-release-tag-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const remote = join(temporaryRoot, "origin.git");
  const source = join(temporaryRoot, "source");
  const checkout = join(temporaryRoot, "checkout");
  const lightweightTag = "sdk-v1.2.3";
  const annotatedTag = "protocol-v2.0.0";
  const shellLookingTag = "sdk-v1.2.3;touch_PWNED";

  git(temporaryRoot, ["init", "--bare", remote]);
  git(temporaryRoot, ["init", source]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, [
    "-c",
    "user.name=release-test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "first",
  ]);
  const firstCommit = git(source, ["rev-parse", "HEAD"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(source, [
    "-c",
    "user.name=release-test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "second",
  ]);
  const eventCommit = git(source, ["rev-parse", "HEAD"]);
  git(source, ["push", "origin", "main"]);
  git(source, ["tag", lightweightTag]);
  git(source, [
    "-c",
    "user.name=release-test",
    "-c",
    "user.email=release-test@example.invalid",
    "tag",
    "-a",
    annotatedTag,
    "-m",
    "original annotation",
  ]);
  const eventTagObject = git(source, [
    "rev-parse",
    `refs/tags/${annotatedTag}`,
  ]);
  git(source, ["tag", shellLookingTag]);
  git(source, [
    "push",
    "origin",
    `refs/tags/${lightweightTag}`,
    `refs/tags/${annotatedTag}`,
    `refs/tags/${shellLookingTag}`,
  ]);

  // Mirrors actions/checkout with fetch-depth: 0: the checkout retains the
  // event-time direct tag objects while later ls-remote calls remain readonly.
  git(temporaryRoot, ["clone", remote, checkout]);
  git(checkout, ["checkout", "--detach", eventCommit]);

  await t.test("accepts a correctly bound lightweight tag", () => {
    assertVerified(verify(checkout, { sha: eventCommit, tag: lightweightTag }));
  });

  await t.test("accepts either annotated-tag event SHA representation", () => {
    assertVerified(
      verify(checkout, { sha: eventTagObject, tag: annotatedTag }),
    );
    assertVerified(verify(checkout, { sha: eventCommit, tag: annotatedTag }));

    const ancestor = run(
      "git",
      ["merge-base", "--is-ancestor", eventTagObject, "origin/main"],
      { cwd: checkout },
    );
    assert.equal(ancestor.status, 0, ancestor.stderr);
  });

  await t.test("treats shell-looking tag text as data", async () => {
    assertVerified(
      verify(checkout, { sha: eventCommit, tag: shellLookingTag }),
    );
    await assert.rejects(access(join(checkout, "touch_PWNED")));
  });

  await t.test("rejects an event-ref mismatch and an invalid ref", () => {
    assertRejected(
      verify(checkout, {
        sha: eventCommit,
        tag: lightweightTag,
        ref: "refs/heads/main",
      }),
      /event ref .* is not refs\/tags\//,
    );
    assertRejected(
      verify(checkout, {
        sha: eventCommit,
        tag: "sdk-v1.2.3 bad",
        ref: "refs/tags/sdk-v1.2.3 bad",
      }),
      /not a valid Git ref/,
    );
  });

  await t.test("rejects a checkout at a different commit", () => {
    git(checkout, ["checkout", "--detach", firstCommit]);
    assertRejected(
      verify(checkout, { sha: eventCommit, tag: lightweightTag }),
      /checkout HEAD .* is not event commit/,
    );
    git(checkout, ["checkout", "--detach", eventCommit]);
  });

  await t.test("rejects a lightweight tag retargeted to another commit", () => {
    git(source, ["tag", "-f", lightweightTag, firstCommit]);
    git(source, ["push", "--force", "origin", `refs/tags/${lightweightTag}`]);
    assertRejected(
      verify(checkout, { sha: eventCommit, tag: lightweightTag }),
      /not checkout tag object|not event commit/,
    );
  });

  await t.test(
    "rejects an annotated tag object replacement at the same commit",
    () => {
      git(source, ["tag", "-d", annotatedTag]);
      git(source, [
        "-c",
        "user.name=release-test",
        "-c",
        "user.email=release-test@example.invalid",
        "tag",
        "-a",
        annotatedTag,
        eventCommit,
        "-m",
        "replacement annotation",
      ]);
      git(source, ["push", "--force", "origin", `refs/tags/${annotatedTag}`]);

      // The peeled-commit form is the regression: comparing only commits used
      // to accept a replacement annotation/signature for the same source tree.
      assertRejected(
        verify(checkout, { sha: eventCommit, tag: annotatedTag }),
        /not checkout tag object/,
      );
      assertRejected(
        verify(checkout, { sha: eventTagObject, tag: annotatedTag }),
        /not checkout tag object|no longer names event tag object/,
      );
    },
  );

  await t.test("rejects a tag deleted from origin", () => {
    git(source, ["push", "--delete", "origin", shellLookingTag]);
    assertRejected(
      verify(checkout, { sha: eventCommit, tag: shellLookingTag }),
      /origin no longer exposes/,
    );
  });
});
