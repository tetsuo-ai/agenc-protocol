import type { AgencWallet } from "./wallet.js";
import type { MoneyMethods } from "./client/money-operations.js";
import { WalletError } from "./errors.js";

type Caller = { role: "owner" | "agent"; agentId: string | null };
type Handlers = { [M in keyof MoneyMethods]: (input: MoneyMethods[M]["params"], caller: Caller) => Promise<MoneyMethods[M]["result"]> };
function owner(caller: Caller) {
  if (caller.role !== "owner") throw new WalletError("NOT_ALLOWED", "Only the owner can do this in Market.");
}
export function moneyHandlers(wallet: AgencWallet): Handlers {
  return {
    "wallet.transferQuote": async (p, session) => { owner(session); return wallet.quoteTransfer(p); },
    "wallet.confirmTransfer": async (p, session) => { owner(session); return wallet.confirmTransfer(p.id); },
    "wallet.pendingTransfers": async (_p, session) => { owner(session); return wallet.pendingTransfers(); },
    "wallet.operationOutcome": async (p, session) => { owner(session); return wallet.operationOutcome(p.id); },
    "wallet.moneyHistory": async (p, session) => { owner(session); return wallet.readMoneyHistory(p); },
    "jobs.ratingQuote": async (p, session) => wallet.quoteRating(p.jobId, p.score, session.role === "owner", session.agentId ?? undefined),
    "jobs.publishReview": async (p, session) => { owner(session); return wallet.publishOrdinaryReview(p.jobId, p.stars, p.text); },
    "jobs.contestRegistrations": async (_p, session) => { owner(session); return wallet.contestRegistrations(); },
    "jobs.contestStake": async (p, session) => { owner(session); return wallet.quoteContestRetirement(p.jobId); },
    "jobs.retireRegistration": async (p, session) => { owner(session); return wallet.retireContestRegistration(p.id); },
    "earn.operation": async (p, session) => {
      if (session.role !== "owner" && (!session.agentId || session.agentId !== p.agentId)) throw new WalletError("NOT_ALLOWED", "This is another seller's operation.");
      return wallet.sellerOperation(p.agentId, p.quoteId);
    },
  };
}
