// @tetsuo-ai/agenc-cli — programmatic surface. Everything the `agenc` CLI
// composes is exported here so the pieces can be embedded/tested directly.
export {
  AgencConfigError,
  CONFIG_FILENAME,
  DEFAULT_OPERATOR_FEE_BPS,
  DEFAULT_PRICE_LAMPORTS,
  DEFAULT_REFERRER_FEE_BPS,
  defaultConfig,
  loadConfig,
  parseConfig,
  serializeConfig,
  type AgencConfig,
  type AgencListingConfig,
} from "./config.js";
export { detectProject, type DetectedProject, type ProjectKind } from "./detect.js";
export {
  planInitFiles,
  runInit,
  type InitFileResult,
  type InitFileStatus,
  type InitOptions,
  type InitResult,
} from "./init.js";
export {
  runDevLoop,
  type DevActor,
  type DevListingTerms,
  type DevLoopDeps,
  type DevLoopResult,
} from "./bots.js";
export { runDev, type DevOptions, type DevRunSummary } from "./dev.js";
export {
  assertLocalOnly,
  bootLocalnet,
  checkLocalnetHealth,
  findLocalnetEnv,
  LocalnetError,
  localnetTooling,
  SETUP_INSTRUCTIONS,
  type LocalnetEnv,
} from "./localnet.js";
export {
  gatherPromoteInput,
  readInstalledVersions,
  runPromoteChecks,
  SUPPORT_MATRIX,
  versionInMatrix,
  type CheckStatus,
  type PromoteCheck,
  type PromoteInput,
  type PromoteReport,
} from "./promote.js";
export {
  formatSplitTable,
  lamportsToSol,
  percentOfReward,
  type SettlementLeg,
} from "./split.js";
