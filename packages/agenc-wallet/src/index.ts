// @tetsuo-ai/agenc-wallet — a wallet an agent can use but cannot drain.
//
// `AgencWallet` is the whole thing in-process. `serveWallet` puts it behind a
// local socket so a desktop app or an agent host can talk to it without ever
// holding a key. `@tetsuo-ai/agenc-wallet/client` is the dependency-free side
// of that socket.
export * from "./client/index.js";
export { AgencWallet, type WalletConfig } from "./wallet.js";
export { WalletError, toWalletErrorShape } from "./errors.js";
export { KeyVault, type OpenVaultOptions } from "./vault.js";
export {
  createRpcChain,
  DEFAULT_RPC_URLS,
  transferInstruction,
  type Chain,
  type RawAccount,
  type RpcChainOptions,
} from "./chain.js";
export {
  buildJobSpec,
  createHostedServices,
  DEFAULT_ATTEST_URL,
  DEFAULT_SITE_URL,
  jobSpecHash,
  type CatalogRow,
  type HostedServicesOptions,
  type MarketServices,
  type ResultUploader,
} from "./services.js";
export {
  centsToLamports,
  decodePythPrice,
  fixedPrice,
  lamportsToCents,
  pythPrice,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_SOL_USD_FEED_ID,
  type PriceSource,
} from "./pricing.js";
export { type EarnExecutor, type EarnOptions } from "./earn.js";
export {
  PRACTICE_SERVICES,
  SANDBOX_USD_PER_SOL,
  startSandbox,
  type HouseService,
  type OpenJob,
  type Sandbox,
  type StartSandboxOptions,
} from "./sandbox.js";
export {
  agentToken,
  defaultSocketPath,
  serveWallet,
  type ServeWalletOptions,
  type WalletServer,
} from "./server.js";
export {
  BACKUP_FORMAT,
  checkBackup,
  createBackup,
  MIN_BACKUP_PASSWORD,
  readBackupFile,
  readBackupHeader,
  restoreBackup,
  writeBackupFile,
  type BackupHeader,
} from "./backup.js";
