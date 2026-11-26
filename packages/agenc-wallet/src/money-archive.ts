// The signing journal owns unresolved sends. Completed receipts and account
// history live in a private, indexed archive carried by the wallet backup.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SellerOperation } from "./seller-operation.js";
import type { WalletState, JobRecord, ContestRegistration } from "./store.js";
import type { MoneyOperation, TransferReservation } from "./operation-receipts.js";
import type { ContestStakeQuote } from "./contest-retirement.js";
import type { HistoryQuery, HistoryRow, RatingQuote } from "./client/money-operations.js";
import { WalletError } from "./errors.js";

export const ARCHIVE_FILE = "money.sqlite";
interface Quotes { transfer?: TransferReservation; retirement?: ContestStakeQuote; rating?: RatingQuote }
type Terminal = { operation: MoneyOperation; quotes: Quotes };

export class MoneyArchive {
  readonly #db: DatabaseSync;
  readonly id: string;

  constructor(file: string, expectedId?: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) {
      if (expectedId) throw new WalletError("INTERNAL", "The wallet receipt archive is missing.");
      closeSync(openSync(file, "wx", 0o600));
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
      throw new WalletError("INTERNAL", "The receipt archive must be a private wallet file.");
    this.#db = new DatabaseSync(file);
    this.#db.exec(`PRAGMA trusted_schema=OFF;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, body TEXT NOT NULL, quotes TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operation_signature ON operations(signature);
      CREATE TABLE IF NOT EXISTS bindings (kind TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,key));
      CREATE TABLE IF NOT EXISTS sellers (agent TEXT, quote TEXT, body TEXT NOT NULL, PRIMARY KEY(agent,quote));
      CREATE TABLE IF NOT EXISTS contests (job TEXT PRIMARY KEY, registration TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS contest_registration ON contests(registration);
      CREATE TABLE IF NOT EXISTS purchases (key TEXT PRIMARY KEY, approval TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS purchase_approval ON purchases(approval);
      CREATE TABLE IF NOT EXISTS history (account TEXT, signature TEXT, at INTEGER NOT NULL, job TEXT, body TEXT NOT NULL,
        PRIMARY KEY(account, signature));
      CREATE INDEX IF NOT EXISTS history_page ON history(at, signature, account);
      CREATE INDEX IF NOT EXISTS account_page ON history(account, at, signature);
      CREATE INDEX IF NOT EXISTS job_page ON history(job, at, signature, account);`);
    const saved = this.#db.prepare("SELECT id FROM identity").get();
    if (expectedId && saved?.id !== expectedId) {
      this.#db.close();
      throw new WalletError("INTERNAL", "The receipt archive does not match this wallet.");
    }
    this.id = saved ? String(saved.id) : randomUUID();
    if (!saved) this.#db.prepare("INSERT INTO identity VALUES (?)").run(this.id);
  }

  close() { this.#db.close(); }

  operation(id: string): Terminal | undefined {
    const row = this.#db.prepare("SELECT body, quotes FROM operations WHERE id=?").get(id);
    return row && { operation: JSON.parse(String(row.body)), quotes: JSON.parse(String(row.quotes)) };
  }

  bySignature(signature: string): MoneyOperation | undefined {
    const row = this.#db.prepare("SELECT body FROM operations WHERE signature=?").get(signature);
    return row && JSON.parse(String(row.body));
  }

  binding(kind: "legacy", key: string): string | undefined;
  binding(kind: "purchase", key: string): NonNullable<WalletState["purchaseBindings"]>[string] | undefined;
  binding(kind: string, key: string) {
    const row = this.#db.prepare("SELECT value FROM bindings WHERE kind=? AND key=?").get(kind, key);
    return row && JSON.parse(String(row.value));
  }

  seller(agent: string, quote: string): SellerOperation | undefined {
    const row = this.#db.prepare("SELECT body FROM sellers WHERE agent=? AND quote=?").get(agent, quote);
    return row && JSON.parse(String(row.body));
  }

  contest(job: string): ContestRegistration | undefined {
    const row = this.#db.prepare("SELECT body FROM contests WHERE job=?").get(job);
    return row && JSON.parse(String(row.body));
  }

  contestJobs(agentId: string) {
    return this.#db.prepare("SELECT job FROM contests WHERE registration=? ORDER BY job").all(agentId).map(r => String(r.job));
  }

  contestRepresentatives() {
    return this.#db.prepare("SELECT registration, min(job) AS job FROM contests GROUP BY registration").all()
      .map(r => ({ agentId: String(r.registration), jobId: String(r.job) }));
  }

  purchase(key: string, byApproval = false): JobRecord | undefined {
    const row = this.#db.prepare(byApproval ? "SELECT body FROM purchases WHERE approval=?" : "SELECT body FROM purchases WHERE key=?").get(key);
    return row && JSON.parse(String(row.body));
  }

  hasChange(account: string, signature: string) {
    return !!this.#db.prepare("SELECT 1 FROM history WHERE account=? AND signature=?").get(account, signature);
  }

  page(query: HistoryQuery, jobSignatures: string[]) {
    const limit = Math.max(1, Math.min(100, Number.isSafeInteger(query.limit) ? query.limit! : 50));
    const where: string[] = [], args: SQLInputValue[] = [];
    if (query.account) { where.push("account=?"); args.push(query.account); }
    if (query.jobId) {
      const signatures = jobSignatures.map(() => "?").join(",");
      where.push(signatures ? `(job=? OR signature IN (${signatures}))` : "job=?");
      args.push(query.jobId, ...jobSignatures);
    }
    if (query.before) {
      const { account, signature } = query.before;
      const cursor = this.#db.prepare("SELECT at FROM history WHERE account=? AND signature=?").get(account, signature);
      if (!cursor || (query.account && account !== query.account)) throw new WalletError("BAD_REQUEST", "Unknown history cursor.");
      where.push("(at,signature,account) < (?,?,?)");
      args.push(Number(cursor.at), signature, account);
    }
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";
    const result = this.#db.prepare(`SELECT body FROM history ${clause} ORDER BY at DESC,signature DESC,account DESC LIMIT ?`).all(...args, limit + 1);
    const rows: HistoryRow[] = result.slice(0, limit).map(r => JSON.parse(String(r.body)));
    const last = rows.at(-1);
    return { rows, next: last && result.length > limit ? { account: last.account, signature: last.signature } : null };
  }

  // Only spill a state.json snapshot already durably committed. A crash before
  // the compacted journal is renamed leaves duplicate, idempotent archive work.
  checkpoint(state: WalletState): boolean {
    const rows = Object.values(state.moneyRows ?? {});
    const operations = Object.values(state.moneyOperations ?? {}).filter(op => op.state !== "pending");
    const purchases = Object.entries(state.callReceipts ?? {});
    const legacy = Object.entries(state.legacyTransfers ?? {});
    const bindings = Object.entries(state.purchaseBindings ?? {});
    const contests = Object.entries(state.contestRegistrations ?? {});
    const sellers = Object.values(state.agents).flatMap(agent => Object.values(agent.sellerOperations ?? {})
      .filter(row => row.state === "failed" || (row.state === "confirmed" && row.listing && row.listingSignature))
      .map(row => ({ agent, row })));
    if (!rows.length && !operations.length && !purchases.length && !legacy.length && !bindings.length &&
        !contests.length && !sellers.length) return false;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const saveHistory = this.#db.prepare("INSERT OR IGNORE INTO history VALUES (?,?,?,?,?)");
      for (const row of rows) saveHistory.run(row.account, row.signature, row.at ?? 0, row.jobId ?? null, JSON.stringify(row));
      const saveOperation = this.#db.prepare("INSERT OR REPLACE INTO operations VALUES (?,?,?,?)");
      for (const op of operations) {
        const quotes = this.operation(op.id)?.quotes ?? {};
        const transfer = state.transferQuotes?.[op.id], rating = state.ratingQuotes?.[op.id], retirement = state.retirementQuotes?.[op.id];
        if (transfer) quotes.transfer = transfer;
        if (rating) quotes.rating = rating;
        if (retirement) quotes.retirement = retirement;
        saveOperation.run(op.id, op.receipt.signature, JSON.stringify(op), JSON.stringify(quotes));
      }
      const saveBinding = this.#db.prepare("INSERT OR IGNORE INTO bindings VALUES (?,?,?)");
      for (const [key, value] of legacy) saveBinding.run("legacy", key, JSON.stringify(value));
      for (const [key, value] of bindings) saveBinding.run("purchase", key, JSON.stringify(value));
      const saveContest = this.#db.prepare("INSERT OR IGNORE INTO contests VALUES (?,?,?)");
      for (const [jobId, reg] of contests) saveContest.run(jobId, reg.agentId, JSON.stringify(reg));
      const saveSeller = this.#db.prepare("INSERT OR IGNORE INTO sellers VALUES (?,?,?)");
      for (const { agent, row } of sellers) saveSeller.run(agent.id, row.quoteId, JSON.stringify(row));
      const savePurchase = this.#db.prepare("INSERT OR IGNORE INTO purchases VALUES (?,?,?)");
      for (const [key, job] of purchases) {
        savePurchase.run(key, job.approvalId ?? null, JSON.stringify(job));
        // Migrate already compacted keyed contests from older journals.
        if (job.role === "buying" && job.payer === "main" && job.terms?.contest && job.contestRegistration)
          saveContest.run(job.id, job.contestRegistration.agentId, JSON.stringify(job.contestRegistration));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    delete state.moneyRows;
    delete state.callReceipts;
    delete state.contestRegistrations;
    for (const { agent, row } of sellers) delete agent.sellerOperations![row.quoteId];
    delete state.legacyTransfers;
    delete state.purchaseBindings;
    for (const { id } of operations) {
      delete state.moneyOperations![id];
      delete state.transferQuotes?.[id];
      delete state.ratingQuotes?.[id];
      delete state.retirementQuotes?.[id];
    }
    state.moneyArchiveId = this.id;
    return true;
  }
}
