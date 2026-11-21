// Temporary release dry run (scratch branch only, never for main).
// Runs release.yml's clean-install smoke (scripts/release-pack-smoke.mjs) on
// this run's tarball, with the package's first-party dependencies installed
// from this run's own tarballs. They are not on npm yet, which is why the
// revision 8 dry run's smoke failed for every downstream package.
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { smokePackedArtifact } from "../../scripts/release-pack-smoke.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tag = process.env.DRY_RUN_TAG;
const artifacts = process.env.DRY_RUN_ARTIFACTS;
if (!tag || !artifacts) {
  throw new Error("DRY_RUN_TAG and DRY_RUN_ARTIFACTS are required");
}

const train = JSON.parse(
  await readFile(path.join(root, "release-train.json"), "utf8"),
);
const byId = new Map(train.packages.map((entry) => [entry.id, entry]));
const entry = train.packages.find(
  (candidate) =>
    tag.startsWith(candidate.tagPrefix) &&
    tag.slice(candidate.tagPrefix.length) === candidate.expectedVersion,
);
if (entry === undefined) {
  throw new Error(`${tag} is not a release-train tag at its expected version`);
}

// Every transitive prerequisite except protocol, which no package depends
// on at run time (the train lists it for release order only).
const prerequisites = [];
const visit = (id) => {
  for (const required of byId.get(id).requires) {
    if (!prerequisites.includes(required)) {
      prerequisites.push(required);
      visit(required);
    }
  }
};
visit(entry.id);
const runtime = prerequisites.filter((id) => id !== "protocol");

const packed = async (dependency) => {
  const directory = path.join(
    artifacts,
    `dry-run-pack-${dependency.tagPrefix}${dependency.expectedVersion}-a`,
  );
  const info = JSON.parse(
    await readFile(path.join(directory, "integrity.json"), "utf8"),
  );
  if (
    info.name !== dependency.name ||
    info.version !== dependency.expectedVersion
  ) {
    throw new Error(
      `${directory} holds ${info.name}@${info.version}, not ${dependency.name}@${dependency.expectedVersion}`,
    );
  }
  return path.join(directory, info.filename);
};

const tarballPath = await packed(entry);
const dependencyTarballs = [];
for (const id of runtime) dependencyTarballs.push(await packed(byId.get(id)));

const execFileFn = (command, args, options) => {
  if (command === "npm" && args[0] === "install") {
    // The smoke installs exactly one tarball, as its last argument. Put this
    // run's first-party dependency tarballs before it.
    args = [...args.slice(0, -1), ...dependencyTarballs, args[args.length - 1]];
    console.log(`npm ${args.join(" ")}`);
  }
  return execFile(command, args, options);
};

const plan = await smokePackedArtifact({
  tarballPath,
  expectedName: entry.name,
  expectedVersion: entry.expectedVersion,
  execFileFn,
});
console.log(
  `smoked ${entry.name}@${entry.expectedVersion} with ` +
    `${runtime.length > 0 ? runtime.join(", ") : "no first-party dependencies"}: ` +
    `${plan.files.length} files, ${plan.executions.length} module loads, ` +
    `${plan.bins.length} bins`,
);
