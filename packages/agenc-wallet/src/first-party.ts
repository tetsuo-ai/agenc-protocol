// The marketplace's own accounts on the live network. What they buy, sell
// and rate is the marketplace testing itself: the fee they pay goes to the
// marketplace, so it costs them nothing, and a record they build proves
// nothing to a buyer. Their jobs are left out of every record a buyer sees
// (trust.ts). Each entry says how it is known to be the marketplace's own;
// every one was read from the chain or the marketplace's own site on
// 2026-11-19.
import type { WalletNetwork } from "./client/types.js";
import { NO_FIRST_PARTY, type FirstParty } from "./trust.js";

interface Entry {
  address: string;
  why: string;
}

const WALLETS: readonly Entry[] = [
  { address: "HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh", why: "the marketplace's authority, and one of its three signers" },
  { address: "BXDanWrvVBvb8QbnpmWo9MHSRrGeK272kMx2g7zqahf9", why: "one of the marketplace's three signers" },
  { address: "4QcKBgtmfWvGFrXMLC9N1FqFoVAW7gX1DomKNvCPTiDT", why: "one of the marketplace's three signers" },
  { address: "4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n", why: "the marketplace's treasury, where every fee goes" },
  { address: "9UEu2Gv9Q7DwBtumR2rUSq5g8v7b6mxn26ZNQCky82RJ", why: "the marketplace's safety checker" },
  {
    address: "Fv1pBRo5JKwiB4kE71W3Yw5caegMBio7ANNTQva28wmS",
    why: "owns the service named \"First-party dogfood loop\"; its other services are described on agenc.ag itself",
  },
  {
    address: "8cJ9HH5JdaqzBYaerVjFEWeoJHFmnqqsM6kPDPH4K5xP",
    why: "owns \"Managed Repo Repair\", described on repair.agenc.tech (agenc.tech is the marketplace's own domain)",
  },
  // The wallets that hired the dogfood loop: the buying side of the
  // marketplace testing itself.
  { address: "8VmhZ32QTpTsBNjKW4jNZsCuGRKnt6VyveP7jFz6L1Ec", why: "buys from the dogfood loop" },
  { address: "9DxBkahqY5RugFeHhWHjh6azRgxAf9RbqbMBhiHB5Zgp", why: "buys from the dogfood loop" },
  { address: "B1o48mFGvVWAvFDkeTYUgM3mZDkiFv6QUQt7JYddYFAF", why: "buys from the dogfood loop" },
  { address: "CHd4HDwvaTH8cGBJGt4ECdmnf5wsjYNmLJfR4bPQEVpZ", why: "buys from the dogfood loop" },
  { address: "CfwnewK9phKZcJUJePw6JNGHBfXi6GCnwZ5PneZ57mgG", why: "buys from the dogfood loop" },
  { address: "DaeRU7Ayy4cg79fLAPDFU5haoTa1BpX2rnhxf2tNnYnt", why: "buys from the dogfood loop" },
  { address: "FEsmuf6EodTyfggqnVFYoaxk6oZ7UZ8H8zVE9oTJJL3d", why: "buys from the dogfood loop" },
  { address: "GymTbTHRxW6uFWQAhjVz9F7DUWu3P2QcRdFUwj3LeEE5", why: "buys from the dogfood loop" },
];

const AGENTS: readonly Entry[] = [
  { address: "3cZeUpRdhDhmRSRHFqm96Hw2gRpgtXFxUtoVARnS6gZN", why: "the agent behind \"First-party dogfood loop\"" },
  { address: "Fc1HSGxyfbYvy5Ye8m6hoFwG2AnWme7JXzJUwPg2uSWW", why: "owned by the marketplace's treasury; described on mmo.agenc.ag" },
  { address: "3PgS4jwwpquqxVotTKkvR8wxNUZrExqtZckHehiABKAg", why: "the agent behind \"Managed Repo Repair\"" },
];

const LISTINGS: readonly Entry[] = [
  { address: "8HtcGBDTZvarRc1YbFzmM3C1ZrWQc8antcwHAYHsHC9b", why: "\"First-party dogfood loop\"" },
  { address: "5K3qmQxiKvdnVUNGB8wBo46Uyp2Vq2frYyxP3pszmv7b", why: "\"Canary 4-way split\", by the dogfood loop's agent" },
  { address: "7n9eiCfbRx4S9SeQWv77DZ6FHARSa51G47VKHbz7gVEC", why: "\"Roster-trust capstone\", by the dogfood loop's agent" },
  { address: "9KgMKwmiZBzbX6eF5S1z6cByvgweVkHhw2vJFtkhcQ5e", why: "\"Canary Node reverse\", by the dogfood loop's agent" },
  { address: "6sm6rtdC6c6m6er1n3XnrJGjijqJsBESts215L6ctL4i", why: "\"Founding Settler Charter\", owned by the treasury" },
  { address: "A3SUfbyMgA9qEx6s8y5tDufgftUJsa91MJmk2uiEuDYA", why: "\"Player-Crafted Round Shield\", owned by the treasury" },
];

const set = (entries: readonly Entry[]): ReadonlySet<string> => new Set(entries.map((entry) => entry.address));

/** The live network's own accounts, with why each one is on the list. */
export const MAINNET_FIRST_PARTY: FirstParty & {
  readonly reasons: ReadonlyMap<string, string>;
} = {
  wallets: set(WALLETS),
  agents: set(AGENTS),
  listings: set(LISTINGS),
  reasons: new Map([...WALLETS, ...AGENTS, ...LISTINGS].map((entry) => [entry.address, entry.why])),
};

/**
 * The marketplace's own accounts on a network. Only the live one has any
 * listed: practice money is the practice marketplace's own from end to end,
 * and other networks are for testing.
 */
export function firstPartyAccounts(network: WalletNetwork): FirstParty {
  return network === "mainnet" ? MAINNET_FIRST_PARTY : NO_FIRST_PARTY;
}
