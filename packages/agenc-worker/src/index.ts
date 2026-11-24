// @tetsuo-ai/agenc-worker — programmatic surface.
//
// Everything the CLI composes is exported here so the worker loop can be
// embedded in another runtime: resolve a config, build a WorkerContext with
// your own transports (litesvm, sandbox, kit RPC), then run ticks or the
// long-running watch.
export {
  createSolanaAccountReaders,
  type AccountInfoReader,
  type AccountSnapshot,
  type Base64AccountInfoFetcher,
  type SolanaAccountReaders,
} from "./account-reader.js";
export {
  ConfigError,
  assertActiveWorkerConfig,
  configFromEnv,
  defaultConfigPath,
  defaultStateDir,
  loadConfigFile,
  resolveWorkerConfig,
  DEFAULT_CAPABILITIES,
  DEFAULT_ENDPOINT,
  DEFAULT_EXECUTOR,
  DEFAULT_EXECUTOR_ENV_ALLOWLIST,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TASK_THREAD_BASE_URL,
  type WorkerConfig,
  type WorkerConfigInput,
  type ExecutorMode,
} from "./config.js";
export {
  buildExecutorArgv,
  assertExecutorPromptFits,
  preflightExecutor,
  runExecutor,
  ExecutorError,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_EXECUTOR_PROMPT_BYTES,
  PROMPT_PLACEHOLDER,
  ABORT_GRACE_MS,
  type ExecutorResult,
} from "./executor.js";
export {
  fetchAndVerifyJobSpec,
  createPublicUriFetcher,
  isDefiniteHttpRefusal,
  isPublicIpAddress,
  JobSpecError,
  JobSpecUnreachableError,
  DEFAULT_MAX_JOB_SPEC_BYTES,
  DEFAULT_MAX_JOB_SPEC_REDIRECTS,
  type AccountReader,
  type HostResolver,
  type PinnedHttpRequester,
  type ResolvedAddress,
  type UriFetcher,
  type VerifiedJobSpec,
} from "./job-spec.js";
export {
  resultDataFromHashHex,
  resultPlaceholderUri,
  ResultUploadError,
  DEFAULT_MAX_RESULT_UPLOAD_RESPONSE_BYTES,
  MAX_RESULT_URI_BYTES,
  sha256,
  sha256Hex,
  uploadResult,
  validateResultUri,
} from "./result.js";
export {
  AGENT_ACCOUNT_RENT_LAMPORTS,
  AGENT_STATS_ACCOUNT_SIZE,
  AGENT_STATS_RENT_LAMPORTS,
  buildPrompt,
  checkSettlements,
  CLAIM_ACCOUNT_RENT_LAMPORTS,
  claimDepositFor,
  claimFundingRequirement,
  clearWorkerPause,
  CONTEST_ENTRY_DEPOSIT_LAMPORTS,
  DEFAULT_CLAIM_DEPOSIT_BUDGET_LAMPORTS,
  decodeTaskDescription,
  DEFAULT_MAX_FAILED_JOBS_IN_A_ROW,
  DEFAULT_MAX_FETCH_WAIT_MS,
  FETCH_RESUME_GAP_MS,
  DEFAULT_MAX_JOB_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  ensureRegistered,
  expectedWorkerPayout,
  FEE_HEADROOM_LAMPORTS,
  jobTitle,
  lamportsToSol,
  listClaimCandidates,
  MAX_RETRY_DELAY_MS,
  processCandidate,
  readClaimAccountRentMinimums,
  readMinAgentStake,
  registrationFundingRequirement,
  resumeOpenClaim,
  runTickOnce,
  runUp,
  shareEarnings,
  couldBeWaitingPay,
  SUBMISSION_ACCOUNT_RENT_LAMPORTS,
  workerStatus,
  type WorkSimulation,
  type WorkerDispatch,
  type VerifiedCandidate,
  type ClaimCandidate,
  type ClaimAccountRentMinimums,
  type ClaimFundingExtras,
  type WorkerAccountRentMinimums,
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
  acquireStateLock,
  readProcessIdentity,
  bytesToHex,
  emptyState,
  FAILED_JOB_RETENTION,
  hexToBytes,
  loadState,
  pendingOwnerClaim,
  readJobEvidence,
  MAX_FAILURE_REASON_CHARS,
  MAX_JOB_TITLE_CHARS,
  newAgentId,
  saveState,
  WORKER_STATE_VERSION,
  WorkerStateError,
  type ExecutionIntent,
  type FailedJob,
  type OpenClaim,
  type JobEvidence,
  type ModelBudget,
  type SubmissionIntent,
  type SubmissionRecord,
  type WorkerPause,
  type WorkerState,
} from "./state.js";
export { formatDiagnosticError, redactSensitiveText } from "./redact.js";
export {
  clusterNowSeconds,
  collectOverdueReviews,
  collectTurnDowns,
  releaseOwnClaims,
  runUpkeep,
  sendReleaseClaim,
  UPKEEP_RETRY_SECONDS,
  type UpkeepMemory,
  type UpkeepReport,
} from "./upkeep.js";
export {
  AGENC_PROGRAM_ID,
  DEFAULT_SETTLEMENT_SIGNATURE_SCAN_LIMIT,
  findVerifiedSettlementSignature,
  isVerifiedSettlementTransaction,
} from "./settlement.js";
export {
  loadSolanaKeypairFile,
  parseSolanaKeypairJson,
  WalletFileError,
} from "./wallet.js";

export { parseJobBrief, briefDeliverable, type BriefTerms } from "./job-brief.js";
export * from "./chosen.js";
export * from "./chosen-release.js";

export { decodeHostedBrief } from "./hosted-brief.js";
export { readReviewEnvelope } from "./review-artifact.js";

export { correctChosenWork } from "./chosen-correction.js";
