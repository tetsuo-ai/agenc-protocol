import type { BusinessMethods } from "./client/business.js";
import type { AgencWallet } from "./wallet.js";
import { WalletError } from "./errors.js";
type Session = { role: "owner" | "agent"; agentId: string | null };
type Handlers = {
  [M in keyof BusinessMethods]: (
    p: BusinessMethods[M]["params"],
    session: Session,
  ) => Promise<BusinessMethods[M]["result"]>;
};
function owner(session: Session) {
  if (session.role !== "owner")
    throw new WalletError(
      "NOT_ALLOWED",
      "This decision needs the owner in Market.",
    );
}
function scope(session: Session) {
  if (session.role === "owner") return undefined;
  if (!session.agentId)
    throw new WalletError("NOT_ALLOWED", "This chat has no assigned agent.");
  return session.agentId;
}
export function businessHandlers(wallet: AgencWallet): Handlers {
  return {
    "jobs.inbox": async (_p, s) => wallet.jobInbox(scope(s)),
    "jobs.dismiss": async (p, s) => wallet.dismissJobAction(p.id, scope(s)),
    "work.inspect": async (p, s) => {
      owner(s);
      return wallet.inspectWork(p.agentId, p.task, p.hash, p.part, p.offset);
    },
    "work.correct": async (p, s) => {
      owner(s);
      return wallet.correctWork(p.agentId, p.task, p.hash, p.note);
    },
    "work.quoteManual": async (p, s) => {
      owner(s);
      return wallet.quoteManualWork(p.agentId);
    },
    "work.startManual": async (p, s) => {
      owner(s);
      return wallet.startManualWork(p.agentId, p.fundingQuoteId);
    },
    "business.status": async (_p, s) => {
      owner(s);
      return wallet.businessStatus();
    },
    "business.resume": async (p, s) => {
      owner(s);
      return wallet.confirmRestoredDevice(p.restoredAt);
    },
  };
}
