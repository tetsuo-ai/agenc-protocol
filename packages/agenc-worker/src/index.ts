// @tetsuo-ai/agenc-worker — programmatic surface.
//
// Everything the CLI composes is exported here so the worker loop can be
// embedded in another runtime: resolve a config, build a WorkerContext with
// your own transports (litesvm, sandbox, kit RPC), then run ticks or the
// long-running watch.
export {
  ConfigError,
  configFromEnv,
  defaultConfigPath,
  defaultStateDir,
  loadConfigFile,
  resolveWorkerConfig,
  DEFAULT_CAPABILITIES,
  DEFAULT_ENDPOINT,
  DEFAULT_EXECUTOR,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type WorkerConfig,
  type WorkerConfigInput,
} from "./config.js";
export {
  buildExecutorArgv,
  runExecutor,
  ExecutorError,
  DEFAULT_MAX_STDOUT_BYTES,
  PROMPT_PLACEHOLDER,
  type ExecutorResult,
} from "./executor.js";
export {
  fetchAndVerifyJobSpec,
  JobSpecError,
  DEFAULT_MAX_JOB_SPEC_BYTES,
  type AccountReader,
  type UriFetcher,
  type VerifiedJobSpec,
} from "./job-spec.js";
export {
  resultDataFromHashHex,
  resultPlaceholderUri,
  ResultUploadError,
  sha256,
  sha256Hex,
  uploadResult,
} from "./result.js";
export {
  AGENT_ACCOUNT_RENT_LAMPORTS,
  buildPrompt,
  checkSettlements,
  CLAIM_ACCOUNT_RENT_LAMPORTS,
  decodeTaskDescription,
  ensureRegistered,
  FEE_HEADROOM_LAMPORTS,
  lamportsToSol,
  listClaimCandidates,
  processCandidate,
  readMinAgentStake,
  registrationFundingRequirement,
  resumeOpenClaim,
  runTickOnce,
  runUp,
  SUBMISSION_ACCOUNT_RENT_LAMPORTS,
  workerStatus,
  type ClaimCandidate,
  type ProcessOutcome,
  type SettlementReport,
  type TickResult,
  type WorkerAgent,
  type WorkerContext,
  type WorkerLogEvent,
  type WorkerLogger,
  type WorkerRuntimeConfig,
  type WorkerStatus,
} from "./runtime.js";
export {
  bytesToHex,
  emptyState,
  hexToBytes,
  loadState,
  newAgentId,
  saveState,
  type OpenClaim,
  type SubmissionRecord,
  type WorkerState,
} from "./state.js";
