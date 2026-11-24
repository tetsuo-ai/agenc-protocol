import { WalletError } from "./errors.js";
import type { WalletMethods } from "./client/protocol.js";
import type { MoneyMethods } from "./client/money-operations.js";
import type { ListingMethods } from "./client/listing-methods.js";
import type { BusinessMethods } from "./client/business.js";
import type { ChildHireMethods, ChildResult } from "./client/child-hire.js";
import type { ExchangeMethods } from "./client/exchange-methods.js";
import type { AgencWallet } from "./wallet.js";
import { moneyHandlers } from "./money-handlers.js";
import { listingHandlers } from "./listing-handlers.js";

type Features = MoneyMethods &
  ListingMethods &
  BusinessMethods &
  ChildHireMethods &
  ExchangeMethods;
type Caller = { role: "owner" | "agent"; agentId: string | null; connection?: { id: string } };
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

export function featureRoutes(
  wallet: AgencWallet,
  rooms?: import("./assigned-room.js").AssignedRooms,
): Routes {
  const assignment = () => {
    if (!rooms)
      throw new WalletError("NOT_AVAILABLE", "No verified room is assigned.");
    return rooms;
  };
  const child = <T>(method: string, ...args: unknown[]) =>
    featureCall<T>(Reflect.get(wallet, "childHires"), method, ...args);
  const agent = (s: Caller, requested?: string) => {
    const id = s.role === "owner" ? requested : s.agentId;
    if (!id) throw new WalletError("NOT_ALLOWED", "Choose a wallet agent.");
    return id;
  };
  // Owner routes are excluded from AGENT_METHODS and from the paired broker's allowlist.
  return {
    // The feature owners' handlers, unchanged: A's money routes and E's listing routes with their owner checks.
    ...moneyHandlers(wallet),
    ...listingHandlers(wallet),
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
    "jobs.exchange": (p, s) =>
      assignment().dispatch(wallet, s, p.jobId, p.request),
    "jobs.bindRoom": async (p, s) => {
      if (s.role !== "owner")
        throw new WalletError(
          "NOT_ALLOWED",
          "Only the room host can assign a verified room.",
        );
      return assignment().bind(await wallet.getJob(p.jobId, true), p.room);
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
    // B: the owner reads through its own path; a paying agent reads, and is challenged, as itself.
    "jobs.readDeliveryChunk": (p, s) =>
      s.role === "owner"
        ? featureCall(wallet, "readOwnerDeliveryChunk", p.jobId, p.part, p.offset)
        : featureCall(wallet, "readDeliveryChunk", p.jobId, agent(s), p.part, p.offset, s.connection?.id),
    "jobs.acknowledgeDeliveryChunk": async (p, s) => {
      if (s.role !== "agent")
        throw new WalletError("NOT_ALLOWED", "Only the paying agent can confirm it received a delivery.");
      return featureCall(wallet, "acknowledgeDeliveryChunk", p.jobId, agent(s), p.ack, s.connection?.id);
    },
    "child.policy": (p) =>
      child("setPolicy", p.sellerAgentId, p.listing, p.policy),
    // E: a caller-written share grant is refused; the buyer's signed approval arrives through the order exchange.
    "child.request": async (p) => {
      if (p.shareGrant !== undefined)
        throw new WalletError("NOT_ALLOWED", "The buyer approves shared files in Market. The approval arrives with the order.");
      return child("request", p.grant, p.request);
    },
    // Consent and refresh stay on the owner channel (never in AGENT_METHODS or the paired allowlist).
    "child.authorizeShare": (p, s) => {
      if (s.role !== "owner") throw new WalletError("NOT_ALLOWED", "Only the owner can do this in Market.");
      return child("authorizeShare", p.jobId, p.binding);
    },
    "child.refresh": (p, s) => {
      if (s.role !== "owner") throw new WalletError("NOT_ALLOWED", "Only the owner can do this in Market.");
      return child("refresh", p.parentTask, p.quoteId);
    },
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
    // G's wallet serves bounded parts from its verified staging (childHires.part).
    "child.part": (p) => child("part", p.grant, p.receipt, p.part, p.offset),
    "child.imported": async (p) => {
      await child("acknowledgeImport", p.grant, p.receipt);
      return { imported: true };
    },
  };
}
