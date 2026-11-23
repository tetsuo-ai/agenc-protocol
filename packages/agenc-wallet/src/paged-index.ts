import { createHash } from "node:crypto";
import { WalletError } from "./errors.js";
import { record } from "./hosted-http.js";

export type ReadJson = (path: string, timeout: number) => Promise<{ status: number; body: unknown }>;

class IndexChanged extends WalletError {
  constructor() { super("NETWORK", "The marketplace list changed while loading. Try again."); }
}

/** Only complete, consistent passes become visible. A timeout leaves the next page to resume. */
export function createPagedIndex<T>(options: {
  now: () => number;
  ttl: number;
  budget: number;
  read: (page: number, timeout: number) => ReturnType<ReadJson>;
  parse: (item: Record<string, unknown>) => T | null;
}) {
  function start() {
    return { ids: new Set<string>(), rows: [] as T[], hashes: [] as string[], page: 1, total: -1,
      generation: undefined as unknown, verifying: false };
  }
  let progress = start();
  let published: { at: number; rows: T[] } | null = null;
  let running: Promise<T[]> | null = null;
  const cached = () => published && options.now() - published.at < options.ttl ? published.rows : null;

  async function scan(deadline: number) {
    const p = progress;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new WalletError("NETWORK", "The marketplace list is still loading. Try again to continue.");
      const { status, body } = await options.read(p.page, remaining);
      const data = record(body);
      if (status !== 200 || !Array.isArray(data?.items)) {
        throw new WalletError("NETWORK", "The marketplace list could not be loaded. Try again in a moment.");
      }
      const total = data.total;
      const generation = data.generation ?? data.slot;
      if (generation !== undefined && typeof generation !== "string" && !Number.isSafeInteger(generation)) throw new IndexChanged();
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
          (data.page !== undefined && data.page !== p.page)) throw new IndexChanged();
      if (p.total < 0) { p.total = total; p.generation = generation; }
      if (total !== p.total || generation !== p.generation) throw new IndexChanged();

      const digest = createHash("sha256").update(JSON.stringify(data.items)).digest("hex");
      if (p.verifying) {
        if (p.hashes[p.page - 1] !== digest) throw new IndexChanged();
        if (p.page === p.hashes.length) return p.rows;
      } else {
        if (data.items.length === 0 && p.ids.size < total) throw new IndexChanged();
        for (const raw of data.items) {
          const item = record(raw);
          if (!item || typeof item.pda !== "string" || p.ids.has(item.pda)) throw new IndexChanged();
          p.ids.add(item.pda);
          const row = options.parse(item);
          if (row !== null) p.rows.push(row);
        }
        if (p.ids.size > total) throw new IndexChanged();
        p.hashes.push(digest);
        if (p.ids.size === total) {
          if (generation !== undefined || p.page === 1) return p.rows;
          // The public page-number API has no snapshot token. Verify the same ordered pages.
          p.verifying = true;
          p.page = 1;
          continue;
        }
      }
      p.page++;
    }
  }

  async function load() {
    const deadline = Date.now() + options.budget;
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await scan(deadline);
        published = { rows, at: options.now() };
        progress = start();
        return rows;
      } catch (error) {
        if (!(error instanceof IndexChanged)) throw error;
        progress = start();
        if (attempt >= 1) throw error;
      }
    }
  }
  return { cached, load: () => cached() ?? (running ??= load().finally(() => { running = null; })) };
}
