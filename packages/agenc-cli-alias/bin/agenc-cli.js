#!/usr/bin/env node
// `agenc-cli` — unscoped alias for @tetsuo-ai/agenc-cli. Executes the scoped
// package's CLI entry in-process (same argv, same exit codes).
import { runCliProcess } from "@tetsuo-ai/agenc-cli/cli";

void runCliProcess();
