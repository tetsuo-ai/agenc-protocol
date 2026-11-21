// Temporary release dry run (scratch branch only, never for main).
// Writes .github/workflows/zz-release-dry-run.yml from release.yml:
//   node .github/release-dry-run/generate.mjs
// The release job's gate and pack steps are kept as they are. Removed: the
// tag-only checks (commit on main, tag binding), the environment, OIDC, the
// published-prerequisites check, release-state inspection and every GitHub
// release or npm mutation. Added: integrity reports, tarball artifacts, a
// clean-install smoke fed with this run's own first-party tarballs, and a
// summary with pins.json.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const release = YAML.parse(
  await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
);
const train = JSON.parse(
  await readFile(path.join(root, "release-train.json"), "utf8"),
);
const releaseSteps = release.jobs.release.steps;
const step = (name) => {
  const found = releaseSteps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`release.yml has no step ${JSON.stringify(name)}`);
  return structuredClone(found);
};

const DROPPED = new Set([
  "Require a release commit from main",
  "Verify exact attested release prerequisites",
  "Inspect resumable release state before mutation",
  "Stop before mutation when npm dist-tags need a manual change",
  "Prepare GitHub Release draft",
  "Attach required verifiable-build hashes",
  "Attach required SPDX release SBOM",
  "Publish reviewed tarball with npm trusted publishing",
  "Verify npm integrity and provenance after publication",
  "Verify final npm dist-tag still binds reviewed provenance",
  "Reinspect every immutable release surface before finalization",
  "Publish GitHub Release",
]);
const SMOKE = "Smoke the exact reviewed tarball surface";
const RESOLVED = "${{ !cancelled() && steps.pkg.outcome == 'success' }}";
const PACKED = "${{ !cancelled() && steps.pack.outcome == 'success' }}";
// The same pinned upload action verify.yml and release.yml use.
const UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD = step("Download required verifiable-build hashes").uses;
const CHECKOUT = step("Checkout").uses;
const SETUP_NODE = step("Setup Node").uses;

// Each run exports the matrix tag as GITHUB_REF_NAME, the way the release
// workflow sees its tag; GitHub does not let `env:` override GITHUB_* names.
const withTag = (original) => {
  const copy = structuredClone(original);
  if (typeof copy.run === "string") {
    copy.run = `export GITHUB_REF_NAME="\${{ matrix.tag }}"\n${copy.run}`;
  }
  return copy;
};

function packSteps({ protocol }) {
  const out = [];
  for (const original of releaseSteps) {
    if (DROPPED.has(original.name)) continue;
    if (original.name === SMOKE && !protocol) continue;
    const copy = withTag(original);
    switch (original.name) {
      case "Download required verifiable-build hashes":
        copy.if = "${{ !cancelled() && steps.pkg.outputs.id == 'protocol' }}";
        break;
      case "Require finalized mainnet cutover for stable releases":
      case "Run reviewed package prepack lifecycle":
        // Evaluated for every package even after a failed gate, so one run
        // reports every check and still yields every tarball.
        copy.if = RESOLVED;
        break;
      case "Build reviewed npm tarball":
        copy.id = "pack";
        copy.if = RESOLVED;
        break;
      case SMOKE:
      case "Generate deterministic SPDX release SBOM":
        copy.if = PACKED;
        break;
      default:
        break;
    }
    out.push(copy);
    if (original.name === "Build reviewed npm tarball") {
      out.push(
        {
          name: "Report the CI-built pack integrity",
          id: "report",
          if: PACKED,
          "working-directory": "${{ steps.pkg.outputs.dir }}",
          env: {
            PACK_JSON: "${{ runner.temp }}/package-pack.json",
            DRY_RUN_TAG: "${{ matrix.tag }}",
            DRY_RUN_ATTEMPT: "${{ matrix.attempt }}",
            PACKAGE_ID: "${{ steps.pkg.outputs.id }}",
          },
          run: 'node "${GITHUB_WORKSPACE}/.github/release-dry-run/report.mjs"',
        },
        {
          name: "Upload the CI-built tarball and its integrity",
          if: "${{ !cancelled() && steps.report.outcome == 'success' }}",
          uses: UPLOAD,
          with: {
            name: "dry-run-pack-${{ matrix.tag }}-${{ matrix.attempt }}",
            path: "${{ runner.temp }}/dry-run-pack",
            "if-no-files-found": "error",
          },
        },
      );
    }
    if (original.name === "Generate deterministic SPDX release SBOM") {
      out.push({
        name: "Upload the SPDX release SBOM",
        if: "${{ !cancelled() && steps.sbom.outcome == 'success' }}",
        uses: UPLOAD,
        with: {
          name: "dry-run-sbom-${{ matrix.tag }}-${{ matrix.attempt }}",
          path: "${{ steps.sbom.outputs.path }}",
          "if-no-files-found": "error",
        },
      });
    }
  }
  return out;
}

const tags = train.packages
  .filter((entry) => entry.id !== "moderation")
  .map((entry) => `${entry.tagPrefix}${entry.expectedVersion}`);
const protocolTag = tags.find((tag) => tag.startsWith("protocol-v"));
const clientTags = tags.filter((tag) => tag !== protocolTag);
const sdkTag = tags.find((tag) => tag.startsWith("sdk-v"));
const packJob = (protocol) => ({
  needs: protocol
    ? ["protocol_verifiable_build", "rust_supply_chain"]
    : ["rust_supply_chain"],
  if: "${{ !cancelled() }}",
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": release.jobs.release["timeout-minutes"],
  permissions: { actions: "read", contents: "read" },
  strategy: {
    "fail-fast": false,
    matrix: protocol
      ? { tag: [protocolTag], attempt: ["a"] }
      : {
          tag: clientTags,
          attempt: ["a"],
          // A second SDK pack on another runner: its tarball carries the
          // CI-built program, so its bytes must not depend on the runner.
          include: [{ tag: sdkTag, attempt: "b" }],
        },
  },
  steps: packSteps({ protocol }),
});

const setupNode = {
  name: "Setup Node",
  uses: SETUP_NODE,
  with: { "node-version": "24.18.0", "registry-url": "https://registry.npmjs.org" },
};
const pinNpm = withTag(step("Pin declared npm release toolchain"));
pinNpm.run = pinNpm.run.replace(/^export GITHUB_REF_NAME=.*\n/, "");
const checkout = { name: "Checkout", uses: CHECKOUT, with: { "persist-credentials": false } };
const downloadAll = {
  name: "Download this run's artifacts",
  uses: DOWNLOAD,
  with: { path: "${{ runner.temp }}/dry-run-artifacts" },
};

const workflow = {
  name: "Release dry run, revision 9 (temporary branch only)",
  on: { push: { branches: ["release-dry-run/rev9"] } },
  permissions: { contents: "read" },
  concurrency: { group: "release-dry-run-rev9", "cancel-in-progress": true },
  env: release.env,
  jobs: {
    protocol_verifiable_build: {
      permissions: { contents: "read" },
      uses: "./.github/workflows/verify.yml",
    },
    rust_supply_chain: {
      permissions: { contents: "read" },
      uses: "./.github/workflows/rust-supply-chain.yml",
    },
    pack_protocol: packJob(true),
    pack_clients: packJob(false),
    smoke_clients: {
      needs: ["pack_clients"],
      if: "${{ !cancelled() }}",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 30,
      permissions: { actions: "read", contents: "read" },
      strategy: { "fail-fast": false, matrix: { tag: clientTags } },
      steps: [
        checkout,
        setupNode,
        pinNpm,
        downloadAll,
        {
          name: "Smoke the reviewed tarball with this run's first-party tarballs",
          env: {
            DRY_RUN_TAG: "${{ matrix.tag }}",
            DRY_RUN_ARTIFACTS: "${{ runner.temp }}/dry-run-artifacts",
          },
          run: "node .github/release-dry-run/smoke.mjs",
        },
      ],
    },
    summary: {
      needs: [
        "protocol_verifiable_build",
        "rust_supply_chain",
        "pack_protocol",
        "pack_clients",
        "smoke_clients",
      ],
      if: "${{ !cancelled() }}",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 15,
      permissions: { actions: "read", contents: "read" },
      steps: [
        checkout,
        setupNode,
        downloadAll,
        {
          name: "Collect the pins and every job result",
          env: {
            DRY_RUN_ARTIFACTS: "${{ runner.temp }}/dry-run-artifacts",
            RESULT_VERIFY: "${{ needs.protocol_verifiable_build.result }}",
            RESULT_RUST: "${{ needs.rust_supply_chain.result }}",
            RESULT_PACK_PROTOCOL: "${{ needs.pack_protocol.result }}",
            RESULT_PACK_CLIENTS: "${{ needs.pack_clients.result }}",
            RESULT_SMOKE: "${{ needs.smoke_clients.result }}",
          },
          run: "node .github/release-dry-run/summary.mjs",
        },
        {
          name: "Upload the pins",
          if: "${{ !cancelled() }}",
          uses: UPLOAD,
          with: {
            name: "dry-run-pins",
            path: "${{ runner.temp }}/dry-run-pins",
            "if-no-files-found": "error",
          },
        },
      ],
    },
  },
};

const header = [
  "# Temporary release dry run, generated from release.yml by",
  "# .github/release-dry-run/generate.mjs. Scratch branch release-dry-run/rev9",
  "# only; never merge to main. It signs nothing and publishes nothing: no",
  "# environment, no OIDC token, no npm publish, no GitHub release.",
  "",
].join("\n");
await writeFile(
  path.join(root, ".github/workflows/zz-release-dry-run.yml"),
  header + YAML.stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false }),
);
console.log(
  `wrote .github/workflows/zz-release-dry-run.yml: ${tags.length} tags, ` +
    `${workflow.jobs.pack_clients.steps.length} client pack steps, ` +
    `${workflow.jobs.pack_protocol.steps.length} protocol pack steps`,
);
