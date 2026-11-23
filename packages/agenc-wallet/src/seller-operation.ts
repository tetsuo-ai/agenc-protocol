import { applySellerDecision as apply, type SellerDecision } from "./seller-decision.js";
import { agentOffers, type AgentRecord } from "./store.js";

export interface SellerOperation {
  quoteId: string; seller: string; offerId: string; listingId: string; listing: string | null;
  terms: string; metadataHash: string; priceLamports: string; fundedLamports: string;
  state: "pending" | "confirmed" | "failed"; fundingSignature: string | null; listingSignature: string | null;
}
declare module "./store.js" { interface AgentRecord { sellerOperations?: Record<string, SellerOperation> } }

function describe(agent: AgentRecord, decision: SellerDecision, state: SellerOperation["state"], signature: string | null, amount: string): SellerOperation | null {
  if (!("offer" in decision.effect)) return null;
  const offer = decision.effect.offer;
  return { quoteId: decision.quoteId, seller: agent.address, offerId: offer.id, listingId: offer.listingIdHex,
    listing: offer.listing, terms: decision.action, metadataHash: offer.specHashHex, priceLamports: offer.priceLamports,
    fundedLamports: amount, state, fundingSignature: signature, listingSignature: offer.signatures.create ?? null };
}

// Called in the same wallet-state commit that consumes the one-use funding quote.
export function recordSellerDecision(agent: AgentRecord, decision: SellerDecision, landed: boolean, signature?: string, amount = "0") {
  apply(agent, decision, landed, signature);
  const row = describe(agent, decision, landed ? "confirmed" : "failed", signature ?? null, amount);
  if (row) (agent.sellerOperations ??= {})[decision.quoteId] = row;
}

export function sellerReceipt(agent: AgentRecord, quoteId: string) {
  const saved = agent.sellerOperations?.[quoteId];
  if (saved) {
    const offer = agentOffers(agent).find(o => o.id === saved.offerId && o.listingIdHex === saved.listingId && o.specHashHex === saved.metadataHash && o.priceLamports === saved.priceLamports);
    return { ...saved, listing: saved.listing ?? offer?.listing ?? null, listingSignature: saved.listingSignature ?? offer?.signatures.create ?? null };
  }
  for (const { operation, signature } of agent.earn.pendingListingSends ?? []) {
    if (operation?.kind === "funding" && operation.decision?.quoteId === quoteId)
      return describe(agent, operation.decision, "pending", signature, operation.lamports);
  }
  return null;
}
