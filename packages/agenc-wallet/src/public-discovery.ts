
// Standalone catalog used before custody is initialized. It needs neither a data directory nor a signer.
import { getTaskMarkerSize } from "@tetsuo-ai/marketplace-sdk";
import { createRpcChain, type Chain } from "./chain.js";
import { DISCOVERY_CAPABILITY, type DiscoveryQuery } from "./client/discovery.js";
import { createHostedServices, type MarketServices } from "./services.js";
import { createRecordKeeper } from "./records.js";
import { firstPartyAccounts } from "./first-party.js";
import { fillCatalogTerms } from "./seller-terms.js";
import { recordRow, ServiceDiscovery } from "./service-discovery.js";
import { readProtocolConfig } from "./market.js";
import { pythPrice, type PriceSource } from "./pricing.js";
import { jobNetworkFees } from "./job-money.js";
import { money } from "./views.js";

export function createPublicCatalog(chain: Chain, services: MarketServices, prices: PriceSource) {
  const records = createRecordKeeper({ chain, services, firstParty: firstPartyAccounts(chain.network) });
  const discovery = new ServiceDiscovery({
    publicNetwork: chain.network === "mainnet", now: Date.now, rate: () => prices.solUsd(),
    listServices: filters => services.listServices(filters), fillTerms: rows => fillCatalogTerms(chain, rows),
    ownServices: async () => [],
    context: async (rows, rate) => {
      const [known, feeBps] = await Promise.all([
        records.read(rows.filter(row => !row.recordPending).map(recordRow), 4000),
        readProtocolConfig(chain).then(config => config.protocolFeeBps).catch(() => null),
      ]);
      const byProvider = new Map<string, { listing: string; name: string }[]>();
      for (const row of rows) {
        const list = byProvider.get(row.providerAgent) ?? [];
        list.push({ listing: row.listing, name: row.name });
        byProvider.set(row.providerAgent, list);
      }
      return { known, feeBps, rate, byProvider };
    },
  });
  return async (params: DiscoveryQuery) => {
    if (params.offset && !params.cursor) throw new Error("Start the search again for a new cursor.");
    const { page, rate } = await discovery.search(params);
    const rent = await chain.getMinimumBalanceForRentExemption(getTaskMarkerSize());
    return { ...page, discovery: DISCOVERY_CAPABILITY, networkFee: money(rent + jobNetworkFees(chain.transferFeeLamports), rate) };
  };
}

export async function servePublicCatalog() {
  if (!process.send) throw new Error("Public discovery requires a local IPC connection.");
  const chain = createRpcChain({ network: "mainnet", rpcUrl: "https://marketplace.agenc.tech/api/rpc" });
  const search = createPublicCatalog(chain, createHostedServices(), pythPrice(chain));
  let active = 0;
  process.on("message", async (request: { id: string; query: DiscoveryQuery }) => {
    if (!request || typeof request.id !== "string" || !request.query) return;
    if (active >= 8) { process.send?.({ id: request.id, error: "Too many searches. Try again." }); return; }
    active++;
    try { process.send?.({ id: request.id, page: await search(request.query) }); }
    catch (err) { process.send?.({ id: request.id, error: err instanceof Error ? err.message : "Search failed." }); }
    finally { active--; }
  });
  await new Promise<void>(resolve => process.once("disconnect", resolve));
  return 0;
}
