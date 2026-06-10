/**
 * Type declarations for the JS worker scaffolding `worker-harness.mjs` so TS
 * test files (checkout.e2e.test.tsx, checkout.spec.ts) typecheck under the
 * parent tsconfig.
 */
import type { ServiceListing, Task, TransactionSigner } from "@tetsuo-ai/marketplace-sdk";

// `kit` and the kit RPC types vary; the harness only needs the module shape, so
// these are intentionally loose (`any`) at the declaration boundary.

export function loadKeypairSigner(
  kit: unknown,
  keyPath: string,
): Promise<TransactionSigner>;

export function fetchListing(
  rpc: unknown,
  kit: unknown,
  listingAddr: string,
): Promise<ServiceListing>;

export function fetchTask(
  rpc: unknown,
  kit: unknown,
  taskAddr: string,
): Promise<Task | null>;

export interface CompleteWorkerSideParams {
  kit: unknown;
  rpcUrl: string;
  taskPda: string;
  workerAgentPda: string;
  seederKeyPath: string;
  moderatorKeyPath: string;
  buyerSigner: TransactionSigner;
}

export function completeWorkerSide(
  params: CompleteWorkerSideParams,
): Promise<{ workerAuthority: string; workerAgent: string }>;
