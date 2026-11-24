// The owner pipe's mutual hello. A client that holds a wallet credential
// proves it without sending it, and only after the service proved it holds the
// same credential. So a program that took the pipe's name first learns
// nothing it could use. Node built-ins only, so a host can vendor this folder.
//
//   client -> { hello: 2, nonce, actAs?, events? }
//   server -> { hello: 2, nonce, proofs: [owner proof, agent proof?] }
//   client -> { hello: 2, proof }
//   server -> RpcHelloReply
//
// Each proof is an HMAC under the credential over a context string, both
// one-time values, the hello's own fields and the direction, so a proof means
// nothing in the other direction or on another connection.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HELLO_PROOF_CONTEXT = "agenc-wallet hello proof v1";

/** A one-time value: 32 random bytes, base64url. */
export const HELLO_NONCE = /^[A-Za-z0-9_-]{43}$/;

export interface HelloProofStart {
  hello: 2;
  nonce: string;
  events?: boolean;
  actAs?: string;
}

export interface HelloProofChallenge {
  hello: 2;
  nonce: string;
  proofs: string[];
}

export interface HelloProofAnswer {
  hello: 2;
  proof: string;
}

export interface HelloProofContext {
  clientNonce: string;
  serverNonce: string;
  actAs?: string | undefined;
  events?: boolean | undefined;
}

export function helloNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** The proof the holder of `credential` gives, as `side`, for one hello. */
export function helloProof(credential: string, side: "server" | "client", context: HelloProofContext): string {
  return createHmac("sha256", credential)
    .update(JSON.stringify([
      HELLO_PROOF_CONTEXT,
      side,
      context.clientNonce,
      context.serverNonce,
      context.actAs ?? null,
      context.events === true,
    ]))
    .digest("base64url");
}

export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
