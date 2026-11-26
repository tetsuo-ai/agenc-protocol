import type { AgencWallet } from "./wallet.js";
import type { ExchangeRelay } from "./exchange-relay.js";
import type { JobMessage, RecipientGrantPreview } from "./client/job-exchange.js";
import { WalletError } from "./errors.js";

/** D constructs this scope after transport authentication. Handoff-only reads
 * use the separate projection endpoint; they do not inherit payer decisions. */
interface Caller { owner: boolean; agentId?: string }
interface Host { roomFor: (jobId: string) => Promise<string>; relay: ExchangeRelay }
export type JobExchangeAction =
  | { action: "join" | "refresh" | "grantPreview" | "retryMessages" | "retryInputs" }
  | { action: "history"; contextIndex?: number; beforeEntry?: number }
  | { action: "status"; beforeEntry?: number }
  | { action: "release"; preview: RecipientGrantPreview }
  | { action: "send"; message: JobMessage }
  | { action: "collect" };

export async function handleJobExchange(wallet: AgencWallet, host: Host, caller: Caller, jobId: string, request: JobExchangeAction) {
  if (!caller.owner && (!caller.agentId || ["grantPreview", "release", "retryInputs"].includes(request.action))) {
    throw new WalletError("NOT_ALLOWED", "This private handoff needs the owner in Market.");
  }
  if (request.action === "history") return wallet.jobExchangeHistory(jobId, caller.owner ? undefined : caller.agentId, request.contextIndex, request.beforeEntry);
  if (request.action === "collect") return wallet.collectJobOutput(jobId, host.relay, caller.owner ? undefined : caller.agentId);
  const session = await wallet.jobExchangeSession(jobId, await host.roomFor(jobId), host.relay, caller.owner ? undefined : caller.agentId);
  switch (request.action) {
    case "status": return session.status(request.beforeEntry);
    case "refresh": return session.refresh();
    case "join": return session.join();
    case "grantPreview": return session.grantPreview();
    case "release": {
      const current = await session.grantPreview();
      if (!current || request.preview.commitment !== current.commitment) throw new WalletError("NOT_ALLOWED", "The approved file set changed.");
      return session.release(request.preview.parties, request.preview.keySignature);
    }
    case "send": return session.send(request.message);
    case "retryMessages": return session.retryMessages();
    case "retryInputs": return session.retryInputs();
    default: throw new WalletError("BAD_REQUEST", "Unknown job exchange action.");
  }
}
