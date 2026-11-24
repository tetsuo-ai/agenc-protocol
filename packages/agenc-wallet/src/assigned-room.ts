import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExchangeRelay } from "./exchange-relay.js";
import { handleJobExchange } from "./job-exchange-rpc.js";
import type { JobExchangeSession } from "./job-exchange-session.js";
import type { JobView } from "./client/types.js";
import type { ExchangeAction } from "./client/exchange-methods.js";
import type { AgencWallet } from "./wallet.js";
import { WalletError } from "./errors.js";
export interface ExchangeWallet {
  jobExchangeHistory(
    id: string,
    agent?: string,
    context?: number,
    before?: number,
  ): Promise<unknown>;
  jobExchangeSession(
    id: string,
    room: string,
    relay: ExchangeRelay,
    agent?: string,
  ): Promise<JobExchangeSession>;
  /** B: the verified paid or current submission, selected by the wallet itself. No room lookup. */
  collectJobOutput(id: string, relay: ExchangeRelay, agent?: string): Promise<unknown>;
}
export class AssignedRooms {
  constructor(
    private readonly directory: string,
    private readonly origin: string | undefined,
  ) {}
  private claim(job: JobView) {
    const parties = job.parties;
    if (!job.task || !parties?.workerRegistration || !parties.claimedAt)
      throw new WalletError(
        "NOT_AVAILABLE",
        "Waiting for a verified job claim.",
      );
    // A new claim generation on the same task needs a fresh assignment.
    const generation = (parties as { claimGeneration?: unknown }).claimGeneration;
    return createHash("sha256")
      .update(
        JSON.stringify([
          job.task,
          parties.workerRegistration,
          parties.claimedAt,
          ...(typeof generation === "string" && generation.length > 0 ? [generation] : []),
        ]),
      )
      .digest("hex");
  }
  /** The room assigned to this job's current claim, or null. */
  roomForJob(job: JobView): string | null {
    try {
      const room = readFileSync(join(this.directory, this.claim(job)), "utf8");
      return /^[a-f0-9]{64}$/.test(room) ? room : null;
    } catch { return null; }
  }
  /** Trusted owner/room host only. A change of claim needs a fresh assignment. */
  bind(job: JobView, room: string) {
    if (!/^[a-f0-9]{64}$/.test(room))
      throw new WalletError("BAD_REQUEST", "Choose a verified room.");
    const key = this.claim(job);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, key),
      temp = file + "." + randomUUID();
    writeFileSync(temp, room, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, file);
    return { bound: true };
  }
  async dispatch(
    wallet: AgencWallet,
    scope: { role: "owner" | "agent"; agentId: string | null },
    id: string,
    request: ExchangeAction,
  ) {
    const owner = scope.role === "owner";
    const agent = owner ? undefined : (scope.agentId ?? undefined);
    const job = await wallet.getJob(id, owner, agent);
    if (
      !request ||
      typeof request !== "object" ||
      typeof Reflect.get(wallet, "jobExchangeSession") !== "function"
    )
      throw new WalletError(
        "NOT_AVAILABLE",
        "Update Market to use the private job exchange.",
      );
    if (!this.origin && request.action !== "history")
      throw new WalletError(
        "NOT_AVAILABLE",
        "No local exchange relay is configured.",
      );
    const host = {
      relay: new ExchangeRelay(this.origin ?? "http://127.0.0.1"),
      roomFor: async () => {
        const path = join(this.directory, this.claim(job));
        try {
          const room = readFileSync(path, "utf8");
          if (/^[a-f0-9]{64}$/.test(room)) return room;
        } catch {}
        throw new WalletError(
          "NOT_AVAILABLE",
          "The verified room has not been assigned to this claim.",
        );
      },
    };
    return handleJobExchange(
      wallet,
      host,
      { owner, ...(agent !== undefined && { agentId: agent }) },
      id,
      request,
    );
  }
}
