// The site and the wallet sign exactly this UTF-8 tuple, including the program,
// chain, original posting and terminal payment. Public text is never HTML.
export interface TaskReview {
  domain: "agenc.ag/task-review/v1"; network: string; program: string; task: string; worker: string;
  creator: string; creation: string; settlement: string; stars: number; text: string;
}
export interface SignedTaskReview { review: TaskReview; signature: string }
export function reviewBytes(r: TaskReview) {
  return new TextEncoder().encode(JSON.stringify([r.domain, r.network, r.program, r.task, r.creator, r.worker,
    r.creation, r.settlement, r.stars, r.text]));
}
