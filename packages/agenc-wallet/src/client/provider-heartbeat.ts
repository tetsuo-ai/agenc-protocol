import { HEARTBEAT_TTL, type ListingHeartbeat, type ListingIdentity } from "./listing-exchange.js";

export interface ServingListing extends ListingIdentity {
  agentId: string;
  roomChecked: number;
  startSeconds: number;
  inquiries: boolean;
}

/** The serving host supplies only active listings with a successful check of their actual rooms. */
export function startProviderHeartbeat(serving: () => Promise<readonly ServingListing[]>,
  publish: (agentId: string, heartbeat: ListingHeartbeat) => Promise<unknown>, now = Date.now) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  async function tick() {
    try {
      for (const { agentId, listing, version, provider, roomChecked, startSeconds, inquiries } of await serving()) {
        const issued = now();
        if (stopped || roomChecked > issued || issued - roomChecked >= HEARTBEAT_TTL) continue;
        const expires = roomChecked + HEARTBEAT_TTL;
        await publish(agentId, { kind: "availability", listing, provider, version, issued, expires, roomChecked, startSeconds, inquiries })
          .catch(() => undefined);
      }
    } catch { /* Going offline lets the last signed heartbeat expire. */ }
    if (!stopped) {
      timer = setTimeout(() => void tick(), HEARTBEAT_TTL / 2);
      timer.unref();
    }
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
