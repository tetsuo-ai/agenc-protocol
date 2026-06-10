/**
 * Webhooks — verification helper for AgenC indexer webhook deliveries
 * (PLAN.md P3.3).
 *
 * The hosted indexer signs every delivery with an `X-Agenc-Signature` header
 * (`t=<unixMillis>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>`);
 * {@link verifyAgencWebhookSignature} checks it against the endpoint's
 * signing secret with replay-window enforcement. Register endpoints with
 * `createIndexerClient(...).registerWebhook(...)` (the `indexer` module).
 *
 * Browser-safe: WebCrypto only — no Node built-ins.
 *
 * @module webhooks
 */
export {
  verifyAgencWebhookSignature,
  type VerifyAgencWebhookSignatureInput,
} from "./verify.js";
