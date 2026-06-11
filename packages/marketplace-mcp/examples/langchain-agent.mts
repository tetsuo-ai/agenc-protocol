/**
 * P5.2 LangChain-style agent example — browse listings and PREPARE (never sign)
 * a hire, using ONLY the public packages.
 *
 * This demonstrates the framework-adapter path: `toLangChainTools` re-shapes the
 * `@tetsuo-ai/marketplace-tools` registry into LangChain `StructuredTool`-
 * compatible descriptors ({ name, description, schema, func }) bound to a read
 * context. A LangChain agent would hand these `schema`s to the model and call
 * `descriptor.func(args)` when the model picks a tool. Here we drive the same
 * descriptors directly (the framework is just a router over them — no heavy
 * `langchain` install is required to demonstrate the contract):
 *
 *   1. boot the REAL agenc-coordination program in litesvm (the local stack),
 *      seed a provider + a published ServiceListing,
 *   2. build the LangChain tool descriptors over a litesvm-backed read context,
 *   3. the "agent" calls `list_listings` -> picks a listing,
 *   4. the "agent" calls `prepare_hire` -> gets an UNSIGNED transaction artifact,
 *   5. we assert it is genuinely unsigned (no signatures) and never broadcast.
 *
 * The bot holds NO key and signs NOTHING — `prepare_hire` only BUILDS the
 * transaction; a real agent would sign it with its own wallet behind its own
 * policy gate. That keyless, prepare-only posture is the whole point.
 *
 * Run: `node examples/langchain-agent.mts` (Node 23+ strips the TS types).
 * Typecheck: `npm run examples:check`. Exits non-zero on failure.
 */
import { strict as assert } from "node:assert";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  facade,
  findAgentPda,
} from "@tetsuo-ai/marketplace-sdk";
import type {
  GpaFilter,
  ProgramAccountsTransport,
} from "@tetsuo-ai/marketplace-sdk";
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import {
  marketplaceTools,
  toLangChainTools,
} from "@tetsuo-ai/marketplace-tools";
import type { MarketplaceToolContext } from "@tetsuo-ai/marketplace-tools";
import type { Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";

// --- litesvm-backed read seams (gPA list path + single-account fetch) --------
class LiteSvmGpa implements ProgramAccountsTransport {
  readonly #svm: LiteSVM;
  readonly #addresses = new Set<Address>();
  constructor(svm: LiteSVM) {
    this.#svm = svm;
  }
  register(...addresses: Address[]): this {
    for (const a of addresses) this.#addresses.add(a);
    return this;
  }
  async getProgramAccounts({ filters }: { filters: readonly GpaFilter[] }) {
    const out: Array<{ address: Address; data: Uint8Array }> = [];
    for (const address of this.#addresses) {
      const acct = this.#svm.getAccount(address);
      if (!acct || !acct.exists) continue;
      if (acct.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) continue;
      const data = Uint8Array.from(acct.data);
      const ok = filters.every((f) =>
        "dataSize" in f
          ? data.length === f.dataSize
          : f.memcmp.offset + f.memcmp.bytes.length <= data.length &&
            f.memcmp.bytes.every((b, i) => data[f.memcmp.offset + i] === b),
      );
      if (ok) out.push({ address, data });
    }
    return out;
  }
}

function liteSvmRpc(svm: LiteSVM) {
  // base64 of bytes (the account-info shape kit parses).
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  return {
    getAccountInfo(address: Address) {
      return {
        async send() {
          const acct = svm.getAccount(address);
          if (!acct || !acct.exists) return { value: null };
          const data = Uint8Array.from(acct.data);
          return {
            value: {
              data: [b64(data), "base64"],
              executable: acct.executable,
              lamports: acct.lamports,
              owner: acct.programAddress,
              rentEpoch: 0n,
              space: BigInt(data.length),
            },
          };
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const market = await startLocalMarketplace();

  // --- seed: a provider with a published, moderation-CLEAN ServiceListing ---
  const provider = await market.fundedSigner();
  const providerClient = market.clientFor(provider);
  const providerAgentId = new Uint8Array(32).fill(11);
  await providerClient.registerAgent({
    authority: provider,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "http://provider.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

  const listingId = new Uint8Array(32).fill(33);
  const listingSpecHash = new Uint8Array(32).fill(7);
  const price = 50_000_000n;
  await providerClient.createServiceListing({
    providerAgent,
    authority: provider,
    listingId,
    name: fixedWidth("Acme Coder", 32),
    category: fixedWidth("code-generation", 32),
    tags: fixedWidth("rust", 64),
    specHash: listingSpecHash,
    specUri: "agenc://job-spec/sha256/test",
    price,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  const [listingPda] = await facade.findListingPda({ providerAgent, listingId });
  await market.moderator.attestListing(listingPda, listingSpecHash);

  // --- the BUYER agent's read/prepare context (keyless) ---
  const buyer = await market.fundedSigner();
  const buyerAgentId = new Uint8Array(32).fill(22);
  await market.clientFor(buyer).registerAgent({
    authority: buyer,
    agentId: buyerAgentId,
    capabilities: 1n,
    endpoint: "http://buyer.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

  const gpa = new LiteSvmGpa(market.svm).register(listingPda, providerAgent);
  const ctx = {
    read: gpa,
    rpc: liteSvmRpc(market.svm),
  } as unknown as MarketplaceToolContext;

  // --- the LangChain tool surface (the ONLY thing the "agent" sees) ---
  // A real LangChain agent registers these descriptors; the model picks a tool
  // by name and the framework calls `descriptor.func(jsonArgs)`. We drive them
  // directly to demonstrate the contract without a heavy langchain install.
  const tools = toLangChainTools(marketplaceTools, ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  console.log(
    `[langchain-agent] tools available to the model: ${tools
      .map((t) => t.name)
      .join(", ")}`,
  );

  // 1) the agent browses listings.
  const listTool = byName.get("list_listings");
  assert.ok(listTool, "list_listings tool missing");
  const listJson = await listTool.func({ category: "code-generation" });
  const { listings } = JSON.parse(listJson) as {
    listings: Array<{ pda: string; name: string; price: string; version: string }>;
  };
  assert.ok(listings.length >= 1, "no listings discovered");
  const chosen = listings[0]!;
  console.log(
    `[langchain-agent] discovered listing ${chosen.pda} ("${chosen.name}") ` +
      `at ${chosen.price} lamports (v${chosen.version}) — preparing a hire.`,
  );

  // 2) the agent PREPARES a hire (builds, never signs).
  const prepareTool = byName.get("prepare_hire");
  assert.ok(prepareTool, "prepare_hire tool missing");
  const taskIdHex = "44".repeat(32); // 32 bytes as 64 hex chars
  const prepJson = await prepareTool.func({
    listing: chosen.pda,
    buyer: buyer.address,
    creatorAgent: buyerAgent,
    taskId: taskIdHex,
    expectedPrice: chosen.price,
    expectedVersion: chosen.version,
    listingSpecHash: toHex(listingSpecHash),
  });
  const unsigned = JSON.parse(prepJson) as {
    programAddress: string;
    accounts: Array<{ address: string; role: { writable: boolean; signer: boolean } }>;
    dataBase64: string;
    signatures: unknown[];
  };

  // 3) assert it is a genuine UNSIGNED transaction — never signed, never sent.
  assert.equal(
    unsigned.programAddress,
    AGENC_COORDINATION_PROGRAM_ADDRESS,
    "wrong program",
  );
  assert.ok(unsigned.accounts.length > 0, "no account metas");
  assert.ok(unsigned.dataBase64.length > 0, "no instruction data");
  assert.deepEqual(unsigned.signatures, [], "artifact must carry NO signatures");
  assert.ok(
    unsigned.accounts.some((a) => a.address === buyer.address && a.role.signer),
    "buyer must be a required signer (the caller signs it, not the agent)",
  );

  console.log(
    `[langchain-agent] OK — prepared an UNSIGNED hire_from_listing ` +
      `(${unsigned.accounts.length} accounts, ${unsigned.dataBase64.length}b base64 data, ` +
      `0 signatures). The agent signed NOTHING and broadcast NOTHING; a real ` +
      `caller would sign it with their own wallet behind their own policy gate.`,
  );
}

/** NUL-padded fixed-width listing field (mirrors values.encodeListing*). */
function fixedWidth(text: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(new TextEncoder().encode(text).subarray(0, width));
  return out;
}

/** Lowercase hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

main().catch((error: unknown) => {
  console.error(
    "[langchain-agent] FAILED:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
