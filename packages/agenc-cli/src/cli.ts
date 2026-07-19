/**
 * Side-effect-free command API for the `agenc` executable.
 *
 * - `init`     wire the CURRENT repo into an AgenC node (Next.js checkout
 *              surface or a worker loop; framework-detected, idempotent).
 * - `dev`      boot/reuse the localnet sandbox and run counterparty bots that
 *              hire + complete your listing — printing the LIVE 4-way
 *              settlement split (worker/operator/referrer/protocol treasury).
 * - `promote`  READONLY diff against the go-live checklist (never signs).
 *
 * (An older runtime package, @tetsuo-ai/agenc, also installs a bin named
 * `agenc` — invoke this one as `npx @tetsuo-ai/agenc-cli <cmd>` when both
 * are installed.)
 *
 * Importing this module never reads argv, writes output, or changes the process
 * exit code. Executable wrappers must call `runCliProcess()` explicitly.
 *
 * @module cli
 */
import { parseArgs } from "node:util";
import { AgencConfigError } from "./config.js";
import { runInit } from "./init.js";
import { runDev } from "./dev.js";
import { LocalnetError } from "./localnet.js";
import { gatherPromoteInputAsync, runPromoteChecks } from "./promote.js";

const USAGE = `agenc — init/dev/promote for the AgenC marketplace

USAGE
  agenc <init|dev|promote> [flags]

SUBCOMMANDS
  init      wire THIS repo into an AgenC node (Next.js -> checkout surface,
            anything else -> worker loop; writes agenc.config.json + owned files)
  dev       sandbox show: counterparty bots hire + complete your listing and
            the LIVE 4-way settlement split is printed. Uses the localnet
            stack when one is discoverable, else falls back to the in-process
            sandbox (litesvm) — zero setup on a cold machine
  promote   readonly go-live checklist diff (RPC, wallet, version pins, ...)

FLAGS
  init:
    --kind <checkout|worker>   override framework detection
    --router <app|pages>       override Next router (for reviewed migrations)
    --force                    overwrite files whose content differs
  dev:
    --env-file <path>          explicit .localnet/env.json (beats discovery; implies --localnet)
    --purge                    kill + re-boot the localnet stack first (implies --localnet)
    --sandbox                  force the in-process litesvm sandbox (skip localnet discovery)
    --localnet                 require the localnet stack (fail instead of falling back)
  promote:
    --json                     machine-readable checklist output
  --dir <path>                 project directory (default: cwd)
  --help                       this text

`;

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      router: { type: "string" },
      force: { type: "boolean" },
      "env-file": { type: "string" },
      purge: { type: "boolean" },
      sandbox: { type: "boolean" },
      localnet: { type: "boolean" },
      json: { type: "boolean" },
      dir: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help === true ? 0 : 2;
  }
  const subcommand = positionals[0];
  const dir = values.dir ?? process.cwd();

  if (subcommand === "init") {
    const kind = values.kind;
    const router = values.router;
    if (kind !== undefined && kind !== "checkout" && kind !== "worker") {
      process.stderr.write(
        `--kind must be "checkout" or "worker" (got ${kind})\n`,
      );
      return 2;
    }
    if (router !== undefined && router !== "app" && router !== "pages") {
      process.stderr.write(
        `--router must be "app" or "pages" (got ${router})\n`,
      );
      return 2;
    }
    const result = runInit(dir, {
      ...(kind !== undefined ? { kind } : {}),
      ...(values.force === true ? { force: true } : {}),
      ...(router !== undefined ? { router } : {}),
    });
    const lines = [
      `agenc init — ${result.projectName} (${result.kind})`,
      "",
      ...result.files.map((file) => {
        const badge =
          file.status === "written"
            ? "wrote    "
            : file.status === "removed"
              ? "removed  "
              : file.status === "unchanged"
                ? "unchanged"
                : "REFUSED  ";
        return `  ${badge} ${file.path}`;
      }),
      "",
      ...result.instructions.map((line) => `  ${line}`),
      "",
    ];
    process.stdout.write(lines.join("\n"));
    return result.refused ? 1 : 0;
  }

  if (subcommand === "dev") {
    await runDev(dir, {
      ...(values["env-file"] !== undefined
        ? { envFile: values["env-file"] }
        : {}),
      ...(values.purge === true ? { purge: true } : {}),
      ...(values.sandbox === true ? { sandbox: true } : {}),
      ...(values.localnet === true ? { localnet: true } : {}),
    });
    return 0;
  }

  if (subcommand === "promote") {
    const report = runPromoteChecks(await gatherPromoteInputAsync(dir));
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ready ? 0 : 1;
    }
    const badge = { pass: "PASS", fail: "FAIL", warn: "WARN" } as const;
    const lines = [
      `agenc promote — go-live checklist (readonly; nothing was changed)`,
      "",
    ];
    for (const check of report.checks) {
      lines.push(`  [${badge[check.status]}] ${check.label}: ${check.detail}`);
      if (check.action !== undefined) lines.push(`         -> ${check.action}`);
    }
    lines.push(
      "",
      report.ready
        ? `  ready: ${report.passed} passed, ${report.warned} advisory warning(s).`
        : `  NOT ready: ${report.failed} failing check(s), ${report.passed} passed, ${report.warned} warning(s).`,
      "",
    );
    process.stdout.write(lines.join("\n"));
    return report.ready ? 0 : 1;
  }

  process.stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
  return 2;
}

/** Run the CLI against the current process and translate its result into an exit code. */
export async function runCliProcess(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  try {
    process.exitCode = await runCli(args);
  } catch (error) {
    if (error instanceof AgencConfigError || error instanceof LocalnetError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  }
}
