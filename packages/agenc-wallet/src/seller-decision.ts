import { agentOffers, type AgentRecord, type OfferRecord } from "./store.js";

export type SellerEffect = { offer: OfferRecord; enableEarns?: true } | { minPayCents: number };
export interface SellerDecision {
  quoteId: string;
  action: string;
  effect: SellerEffect;
  expiresAt: number;
}

export function saveSellerOffer(agent: AgentRecord, offer: OfferRecord): void {
  const list = agentOffers(agent);
  const previous = list.find((entry) => entry.id === offer.id);
  if (previous) {
    // The chain may have confirmed a listing operation while the quote was open.
    offer = { ...offer, listing: previous.listing, listed: previous.listed, signatures: previous.signatures };
    if (previous.specHashHex === offer.specHashHex) {
      offer.specUri = previous.specUri ?? null;
      offer.refused = previous.refused;
      offer.lastCheckAt = previous.lastCheckAt;
    }
  }
  agent.earn.offers = previous ? list.map(entry => entry.id === offer.id ? offer : entry) : [...list, offer];
  delete agent.earn.offer;
}

/** Apply only inside the journal write that resolves the funding signature. */
export function applySellerDecision(agent: AgentRecord, decision: SellerDecision, landed: boolean, signature?: string): void {
  const receipts = agent.earn.sellerDecisions ??= {};
  receipts[decision.quoteId] = { action: decision.action, landed, ...(signature && { signature }) };
  // Older IDs remain spent after eviction: only a live quote can authorize a send.
  const ids = Object.keys(receipts);
  if (ids.length > 128) delete receipts[ids[0]!];
  if (!landed) return;
  if ("offer" in decision.effect) {
    saveSellerOffer(agent, { ...decision.effect.offer, fundingConfirmed: true });
    if (decision.effect.enableEarns && agent.earn.retiredAt == null) {
      agent.earn.enabled = true;
      agent.earn.lastError = null;
    }
  }
  else {
    for (const offer of agentOffers(agent)) {
      if (offer.wanted) offer.fundingConfirmed = true;
    }
    agent.earn.enabled = agent.earn.retiredAt == null;
    agent.earn.minPayCents = decision.effect.minPayCents;
    agent.earn.lastError = null;
  }
}
