import { WalletError } from "./errors.js";
import type { WalletMethods } from "./client/protocol.js";
import type { MoneyMethods } from "./client/money-operations.js";
import type { ListingMethods } from "./client/listing-methods.js";
import type { BusinessMethods } from "./client/business.js";
import type { ChildHireMethods, ChildResult } from "./client/child-hire.js";
import type { ExchangeMethods } from "./client/exchange-methods.js";
import type { AgencWallet } from "./wallet.js";

type Features = MoneyMethods &
  ListingMethods &
  BusinessMethods &
  ChildHireMethods &
  ExchangeMethods;
type Caller = { role: "owner" | "agent"; agentId: string | null };
type Routes = {
  [K in keyof Features]: (
    input: WalletMethods[K]["params"],
    caller: Caller,
  ) => Promise<WalletMethods[K]["result"]>;
};

/** Older service builds may lack a feature. Only the fixed routes below select wallet functions. */
export async function featureCall<T>(
  provider: object | undefined,
  name: string,
  ...args: unknown[]
): Promise<T> {
  const method = provider && Reflect.get(provider, name);
  if (typeof method !== "function")
    throw new WalletError(
      "NOT_AVAILABLE",
      "This wallet needs the updated Market feature.",
    );
  return (await Reflect.apply(method, provider, args)) as T;
}

export function featureRoutes(wallet: AgencWallet): Routes {
  const child = <T>(method: string, ...args: unknown[]) =>
    featureCall<T>(Reflect.get(wallet, "childHires"), method, ...args);
  const agent = (s: Caller, requested?: string) => {
    const id = s.role === "owner" ? requested : s.agentId;
    if (!id) throw new WalletError("NOT_ALLOWED", "Choose a wallet agent.");
    return id;
  };
  // Owner routes are excluded from AGENT_METHODS and from the paired broker's allowlist.
  return {
    "wallet.transferQuote": (p) => featureCall(wallet, "quoteTransfer", p),
    "wallet.confirmTransfer": (p) =>
      featureCall(wallet, "confirmTransfer", p.id),
    "wallet.operationOutcome": (p) =>
      featureCall(wallet, "operationOutcome", p.id),
    "wallet.moneyHistory": (p) => featureCall(wallet, "moneyHistory", p.jobId),
    "jobs.ratingQuote": (p, s) =>
      featureCall(
        wallet,
        "quoteRating",
        p.jobId,
        p.score,
        s.role === "owner",
        s.agentId ?? undefined,
      ),
    "jobs.publishReview": (p) =>
      featureCall(wallet, "publishOrdinaryReview", p.jobId, p.stars, p.text),
    "jobs.contestStake": (p) =>
      featureCall(wallet, "quoteContestRetirement", p.jobId),
    "jobs.retireRegistration": (p) =>
      featureCall(wallet, "retireContestRegistration", p.id),
    "earn.operation": (p, s) =>
      featureCall(wallet, "sellerOperation", agent(s, p.agentId), p.quoteId),
    "jobs.inbox": (_, s) =>
      featureCall(wallet, "jobInbox", s.agentId ?? undefined),
    "jobs.dismiss": (p, s) =>
      featureCall(wallet, "dismissJobAction", p.id, s.agentId ?? undefined),
    "work.inspect": (p) =>
      featureCall(
        wallet,
        "inspectWork",
        p.agentId,
        p.task,
        p.hash,
        p.part,
        p.offset,
      ),
    "work.correct": (p) =>
      featureCall(wallet, "correctWork", p.agentId, p.task, p.hash, p.note),
    "work.quoteManual": (p) =>
      featureCall(wallet, "quoteManualWork", p.agentId),
    "work.startManual": (p) =>
      featureCall(wallet, "startManualWork", p.agentId, p.fundingQuoteId),
    "business.status": () => featureCall(wallet, "businessStatus"),
    "business.resume": (p) =>
      featureCall(wallet, "confirmRestoredDevice", p.restoredAt),
    "listings.inquiries": (p) =>
      featureCall(wallet, "listingExchange", p.listing),
    "listings.message": async (p, s) => {
      if (!["question", "reply"].includes(p.message?.kind))
        throw new WalletError("BAD_REQUEST", "Choose a question or reply.");
      return featureCall(
        wallet,
        "postListingMessage",
        agent(s, p.agentId),
        p.message,
      );
    },
    "listings.heartbeat": async (p) => {
      if (p.message?.kind !== "availability")
        throw new WalletError(
          "BAD_REQUEST",
          "Expected a host availability report.",
        );
      return featureCall(wallet, "postListingMessage", p.agentId, p.message);
    },
    "jobs.stageInputs": (p) =>
      featureCall(
        wallet,
        "stageJobInputs",
        p.files,
        p.recipient,
        p.processing,
        p.outputs,
      ),
    "jobs.readDeliveryChunk": (p, s) =>
      featureCall(
        wallet,
        "readDeliveryChunk",
        p.jobId,
        agent(s),
        p.part,
        p.offset,
      ),
    "child.policy": (p) =>
      child("setPolicy", p.sellerAgentId, p.listing, p.policy),
    "child.request": (p) => child("request", p.grant, p.request),
    "child.timeline": (p) => child("timeline", p.parentTask),
    "child.decide": (p) => child("decide", p.parentTask, p.quoteId, p.approve),
    "child.delivery": async (p) => {
      const { text, files, ...binding } = await child<ChildResult>(
        "delivery",
        p.grant,
      );
      return {
        ...binding,
        textBytes: Buffer.byteLength(text),
        files: files.map(({ base64, ...metadata }) => metadata),
      };
    },
    "child.part": async (p) => {
      const result = await child<ChildResult>("delivery", p.grant);
      const file = result.files.find((f) => f.name === p.part);
      const bytes =
        p.part === "text"
          ? Buffer.from(result.text)
          : file && Buffer.from(file.base64, "base64");
      if (
        result.receipt !== p.receipt ||
        !bytes ||
        !Number.isSafeInteger(p.offset) ||
        p.offset < 0 ||
        p.offset > bytes.length
      )
        throw new WalletError(
          "BAD_REQUEST",
          "The selected supplier part changed.",
        );
      return {
        base64: bytes
          .subarray(p.offset, p.offset + 24 * 1024)
          .toString("base64"),
        total: bytes.length,
      };
    },
    "child.imported": async (p) => {
      await child("acknowledgeImport", p.grant, p.receipt);
      return { imported: true };
    },
  };
}
