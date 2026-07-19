// P7.1 task-thread rails (buyer<->worker comms): the canonical message
// envelope, its `json-stable-v1` content hash (which equals the on-chain
// changes_hash / rejection_hash / rationale_hash it anchors), and the
// publish/read/resolve helpers over the injectable content-rails transport.
//
// Browser-safe: WebCrypto + fetch only — no Node built-ins.
//
// @module task-thread
export {
  TASK_THREAD_ENVELOPE_VERSION,
  canonicalEnvelopeJson,
  envelopeHash,
  assertTaskThreadEnvelope,
  type TaskThreadEnvelope,
  type TaskThreadAttachment,
  type TaskThreadRole,
} from "./envelope.js";
export {
  DEFAULT_CONTENT_TRANSPORT_TIMEOUT_MS,
  DEFAULT_MAX_CONTENT_RESPONSE_BYTES,
  createContentTransport,
  ContentTransportError,
  type ContentTransport,
  type ContentTransportOptions,
  type ContentBodyReader,
  type ContentBodyStream,
  type ContentFetchLike,
  type UploadTicket,
} from "./transport.js";
export {
  DEFAULT_MAX_TASK_THREAD_MESSAGES,
  postTaskMessage,
  fetchTaskThread,
  resolveChangesRequest,
  type FetchTaskThreadOptions,
  type TaskThread,
  type PostTaskMessageResult,
} from "./client.js";
