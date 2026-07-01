import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  isSecretEnvName,
  mergeStarterEnv,
  parseStarterEnvFile,
  validateStarterSetupEnv,
  type StarterSetupIssue,
} from "../server/setup-check.js";

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  const fileEnv = await loadEnvFile(envFile);
  const check = validateStarterSetupEnv(mergeStarterEnv(fileEnv, process.env));

  if (check.errors.length > 0) {
    console.error("AgenC starter setup check failed:");
    for (const error of check.errors) {
      console.error(`- ${formatIssue(error)}`);
    }
  }

  if (check.warnings.length > 0) {
    console.warn("AgenC starter setup warnings:");
    for (const warning of check.warnings) {
      console.warn(`- ${formatIssue(warning)}`);
    }
  }

  if (!check.ok) {
    process.exitCode = 1;
    return;
  }

  console.log("AgenC starter setup check passed.");
}

function resolveEnvFile(): string {
  return process.env.AGENC_STARTER_ENV_FILE?.trim() || ".env.local";
}

async function loadEnvFile(file: string): Promise<Record<string, string>> {
  if (!existsSync(file)) {
    if (process.env.AGENC_STARTER_ENV_FILE?.trim()) {
      throw new Error(`Configured AGENC_STARTER_ENV_FILE does not exist: ${file}`);
    }
    return {};
  }
  return parseStarterEnvFile(await readFile(file, "utf8"));
}

function formatIssue(issue: StarterSetupIssue): string {
  const suffix = isSecretEnvName(issue.variable)
    ? " Value redacted from diagnostics."
    : "";
  return `${issue.variable}: ${issue.message}${suffix}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
