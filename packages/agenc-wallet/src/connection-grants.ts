import {
  createHash,
  generateKeyPairSync,
  sign,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ConnectionScope,
  JobHandoff,
  HandoffPermission,
} from "./client/connections.js";
import { WalletError } from "./errors.js";
import { jobGrant } from "./job-grants.js";

interface Entry extends ConnectionScope {
  key: string | null;
  secretHash: string | null;
  pairUntil: number;
  subscriptions: string[];
  cursor: number;
  changes: { cursor: number; jobId: string }[];
}
interface State {
  version: 1;
  brokerSecret: string;
  entries: Entry[];
  handoffs: JobHandoff[];
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const denied = () =>
  new WalletError(
    "NOT_ALLOWED",
    "Pair again in Market. This connection is unavailable.",
  );
function publicScope({
  id,
  label,
  project,
  agentId,
  access,
  expiresAt,
}: Entry): ConnectionScope {
  return { id, label, project, agentId, access, expiresAt };
}
function label(value: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new WalletError(
      "BAD_REQUEST",
      "Enter a short connection and project name.",
    );
  return value.trim();
}

/** Single writer under the wallet service lock. This file is outside wallet backups. */
export class ConnectionGrants {
  #state: State;
  readonly #tickets = new Map<string, { id: string; until: number }>();
  constructor(
    private file: string,
    readonly socket: string,
    private now = Date.now,
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as State;
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.entries) ||
        !Array.isArray(saved.handoffs)
      )
        throw denied();
      this.#state = saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const pair = generateKeyPairSync("ed25519");
      this.#state = {
        version: 1,
        brokerSecret: pair.privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
        entries: [],
        handoffs: [],
      };
    }
  }
  #save(next: State) {
    const temporary = this.file + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(next), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, this.file);
    this.#state = next;
  }
  #replace(entry: Entry) {
    this.#save({
      ...this.#state,
      entries: this.#state.entries.map((e) => (e.id === entry.id ? entry : e)),
    });
  }
  #active(id: string) {
    const entry = this.#state.entries.find(
      (e) => e.id === id && e.expiresAt > this.now(),
    );
    if (!entry) throw denied();
    return entry;
  }
  invite(
    input: Pick<ConnectionScope, "label" | "project" | "agentId" | "access">,
  ) {
    if (input.access !== "read" && input.access !== "trade") throw denied();
    const now = this.now(),
      code = randomBytes(18).toString("base64url"),
      id = randomUUID();
    const entries = this.#state.entries.filter(
      (e) => e.expiresAt > now && (e.key || e.pairUntil > now),
    );
    if (entries.length >= 256)
      throw new WalletError("BUSY", "Revoke an unused connection first.");
    const pairUntil = now + 5 * 60_000;
    entries.push({
      id,
      label: label(input.label),
      project: label(input.project),
      agentId: input.agentId,
      access: input.access,
      expiresAt: now + 90 * 86400_000,
      key: null,
      secretHash: digest(code),
      pairUntil,
      cursor: 0,
      subscriptions: [],
      changes: [],
    });
    this.#save({
      ...this.#state,
      entries,
      handoffs: this.#state.handoffs.filter((h) =>
        entries.some((e) => e.id === h.connectionId),
      ),
    });
    const brokerKey = createPublicKey(this.#state.brokerSecret)
      .export({ format: "der", type: "spki" })
      .toString("base64");
    return { socket: this.socket, code, id, expiresAt: pairUntil, brokerKey };
  }
  challenge(probe: string, nonce: string) {
    if (typeof probe !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(probe))
      throw denied();
    const data = Buffer.from(
      JSON.stringify(["agenc.market.broker.v1", probe, nonce]),
    );
    return {
      protocol: 1,
      challenge: nonce,
      proof: sign(null, data, this.#state.brokerSecret).toString("base64"),
      capabilities: ["scope", "handoff", "changes"],
    };
  }
  /** A fresh nonce belongs to one socket and one attempt. Newly enrolled
   * keys also prove possession before consuming their one-use invitation. */
  authenticate(
    nonce: string,
    proof: { id: string; code?: string; key?: string; signature: string },
  ) {
    const entry = this.#active(proof.id);
    const enrolling = entry.key === null;
    if (
      enrolling &&
      (entry.pairUntil <= this.now() ||
        typeof proof.code !== "string" ||
        entry.secretHash !== digest(proof.code))
    )
      throw denied();
    const key = entry.key ?? proof.key;
    try {
      if (
        !key ||
        key.length > 100 ||
        typeof proof.signature !== "string" ||
        proof.signature.length > 100
      )
        throw denied();
      const pub = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        pub.asymmetricKeyType !== "ed25519" ||
        !verify(
          null,
          Buffer.from(
            JSON.stringify(["agenc.market.pair.v1", entry.id, nonce, key]),
          ),
          pub,
          Buffer.from(proof.signature, "base64"),
        )
      )
        throw denied();
      if (enrolling) this.#replace({ ...entry, key, secretHash: null });
    } catch {
      throw denied();
    }
    return publicScope(entry);
  }
  scope(id: string) {
    const entry = this.#active(id);
    if (!entry.key) throw denied();
    return publicScope(entry);
  }
  attach(id: string) {
    this.scope(id);
    const now = this.now();
    for (const [key, entry] of this.#tickets)
      if (entry.until <= now) this.#tickets.delete(key);
    if (this.#tickets.size >= 256)
      throw new WalletError("BUSY", "Too many pending Desktop sessions.");
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { id, until: now + 15_000 });
    return { ticket };
  }
  redeem(ticket: string) {
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!entry || entry.until <= this.now()) throw denied();
    return this.scope(entry.id);
  }
  list() {
    return {
      connections: this.#state.entries
        .filter(
          (e) =>
            e.expiresAt > this.now() && (e.key || e.pairUntil > this.now()),
        )
        .map(publicScope),
      handoffs: this.#state.handoffs,
    };
  }
  revoke(id: string) {
    const entries = this.#state.entries.filter((e) => e.id !== id);
    if (entries.length === this.#state.entries.length)
      return { revoked: false };
    this.#save({
      ...this.#state,
      entries,
      handoffs: this.#state.handoffs.filter((h) => h.connectionId !== id),
    });
    return { revoked: true };
  }
  grant(
    id: string,
    jobId: string,
    payer: string,
    permissions: HandoffPermission[],
  ) {
    this.#active(id);
    const grant = jobGrant(id, jobId, payer, permissions);
    const handoffs = this.#state.handoffs.filter(
      (h) => h.connectionId !== id || h.jobId !== jobId,
    );
    if (permissions.length) handoffs.push(grant);
    const entries = this.#state.entries.map((e) =>
      e.id !== id || permissions.includes("status")
        ? e
        : {
            ...e,
            subscriptions: e.subscriptions.filter((job) => job !== jobId),
            changes: e.changes.filter((c) => c.jobId !== jobId),
          },
    );
    this.#save({ ...this.#state, entries, handoffs });
    return { saved: true };
  }
  permission(id: string, jobId: string, permission: HandoffPermission) {
    this.scope(id);
    const grant = this.#state.handoffs.find(
      (g) =>
        g.connectionId === id &&
        g.jobId === jobId &&
        g.permissions.includes(permission),
    );
    if (!grant)
      throw new WalletError(
        "NOT_ALLOWED",
        "The owner must grant this access to the job in Market.",
      );
    return grant;
  }
  subscribe(id: string, jobId: string) {
    const entry = this.#active(id);
    if (!entry.subscriptions.includes(jobId)) {
      if (entry.subscriptions.length >= 256)
        throw new WalletError(
          "BUSY",
          "This connection has too many job subscriptions.",
        );
      this.#replace({
        ...entry,
        subscriptions: [...entry.subscriptions, jobId],
      });
    }
    return { subscribed: true };
  }
  changed(jobId: string) {
    if (!this.#state.entries.some((e) => e.subscriptions.includes(jobId)))
      return;
    this.#save({
      ...this.#state,
      entries: this.#state.entries.map((e) => {
        if (!e.subscriptions.includes(jobId)) return e;
        const cursor = e.cursor + 1;
        return {
          ...e,
          cursor,
          changes: [...e.changes.slice(-127), { cursor, jobId }],
        };
      }),
    });
  }
  changes(id: string, after = 0) {
    const e = this.#active(id);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new WalletError("BAD_REQUEST", "Invalid subscription cursor.");
    const reset =
      after === 0 ||
      after > e.cursor ||
      after < (e.changes[0]?.cursor ?? 0) - 1;
    return {
      cursor: e.cursor,
      reset,
      jobs: reset
        ? e.subscriptions
        : [
            ...new Set(
              e.changes.filter((c) => c.cursor > after).map((c) => c.jobId),
            ),
          ],
    };
  }
}
