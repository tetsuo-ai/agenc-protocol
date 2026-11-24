import { address, type Address, type Instruction } from "@solana/kit";
import type { ReviewedDelivery } from "./client/reviews.js";
import { sentInstruction } from "./settlement.js";

const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
type BuyerDecision = "approve" | "change" | "reject";

export function reviewMemo(action: BuyerDecision, claim: Address, delivery: ReviewedDelivery): Instruction {
  const text = `agenc.review.v1 ${action} ${claim} ${delivery.submissionCount} ${delivery.deliveryHash}`;
  return { programAddress: MEMO, data: Buffer.from(text) };
}

// Only the memo immediately preceding this top-level buyer decision counts.
// jsonParsed RPC decodes SPL memos as strings. LiteSVM returns raw instructions.
export function intendedDelivery(raw: unknown, claim: Address, action: string): ReviewedDelivery | undefined {
  const memo = raw as { programId?: unknown; parsed?: unknown } | undefined;
  if (memo?.programId !== MEMO) return;
  const bytes = sentInstruction(raw)?.data;
  const text = typeof memo.parsed === "string" ? memo.parsed : bytes && Buffer.from(bytes).toString("utf8");
  if (!text) return;
  const fields = text.split(" ");
  if (fields.length !== 5 || fields[0] !== "agenc.review.v1" || fields[1] !== action || fields[2] !== claim ||
      !/^[1-9][0-9]{0,4}$/.test(fields[3]!) || Number(fields[3]) > 65535 || !/^[0-9a-f]{64}$/.test(fields[4]!)) return;
  return { submissionCount: Number(fields[3]), deliveryHash: fields[4]! };
}
