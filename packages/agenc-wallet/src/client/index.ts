// `@tetsuo-ai/agenc-wallet/client`: talk to a running wallet service.
// No keys, no chain code, no dependencies beyond node:net.
export type {
  ActivityKind,
  ActivityView,
  AgentPolicy,
  AgentView,
  ApprovalView,
  EarnState,
  EarnView,
  JobResult,
  JobStatus,
  JobView,
  Lamports,
  Money,
  ProviderView,
  ServiceView,
  WalletErrorCode,
  WalletErrorShape,
  WalletNetwork,
  WalletOverview,
} from "./types.js";
export {
  AGENT_METHODS,
  MAX_FRAME_BYTES,
  type AmountInput,
  type MethodParams,
  type MethodResult,
  type RpcHello,
  type RpcHelloReply,
  type RpcRequest,
  type RpcResponse,
  type WalletEvent,
  type WalletMethod,
  type WalletMethods,
} from "./protocol.js";
export {
  connectWallet,
  createLineReader,
  WalletClientError,
  type WalletClient,
  type WalletClientOptions,
} from "./socket-client.js";
export {
  formatDuration,
  formatMoney,
  formatSol,
  formatUsd,
  formatWait,
} from "./format.js";
export {
  deliveryFileProblem,
  deliveryFileType,
  isPictureType,
  MAX_DELIVERY_FILE_BYTES,
  MAX_DELIVERY_FILES,
  splitDelivery,
  withFiles,
  type DeliveryFile,
} from "./delivery-files.js";
export {
  MARKET_TOOL_INSTRUCTIONS,
  MARKET_TOOLS,
  runMarketTool,
  type MarketToolName,
  type MarketToolOptions,
  type MarketToolResult,
  type MarketToolSpec,
} from "./tools.js";
