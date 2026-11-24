import type { SignedTaskReview } from "./client/task-review.js";
import { WalletError } from "./errors.js";

export async function publishTaskReview(packet: SignedTaskReview, post: typeof fetch) {
  const response = await post(`https://agenc.ag/api/task-reviews/${packet.review.task}`, {
    method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok || (await response.json() as { verified?: boolean }).verified !== true)
    throw new WalletError("NOT_AVAILABLE", "The site could not verify this creator review.");
}

declare module "./store.js" {
  interface WalletState { taskReviews?: Record<string, { packet: SignedTaskReview; published: boolean }> }
}
