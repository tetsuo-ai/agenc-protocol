// A paid hire keeps its job record open for a while so it can still be rated
// (wallet.ts `#stepTidy`). The program frees the service's slot for a new job
// only when that record is closed (close_task lowers the listing's
// `open_jobs`). For a service at its limit, waiting left it refusing every
// new hire as busy after its only job was delivered and paid (owner real
// test 4, tester C). Such a record is closed at once instead.

import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { readListing } from "./market.js";

/** True when the listing takes a limited number of jobs and every one of them is taken. */
export async function listingIsFull(chain: Chain, listing: Address): Promise<boolean> {
  const account = await readListing(chain, listing).catch(() => null);
  return account !== null && account.maxOpenJobs > 0 && account.openJobs >= account.maxOpenJobs;
}
