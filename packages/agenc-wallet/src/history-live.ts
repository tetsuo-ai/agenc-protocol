import type { StateStore, WalletState } from "./store.js";

/**
 * How far back a Lately line's money must already be in the history (rt13-a bug 4). Short on
 * purpose: a send the network never kept has no row ever, and "still catching up" must not
 * keep Market re-reading the history (every read asks the network about every account).
 */
export const HISTORY_CATCH_UP_WINDOW_MS = 2 * 60_000;
/** How long one read of the history waits for the chain before it answers what it has. */
export const HISTORY_CATCH_UP_WAIT_MS = 5_000;

/**
 * True while a recent move of money this wallet made (a Lately line with a receipt) has no
 * history row yet on any of the wallet's own accounts, so the history must say it is behind.
 */
export function historyBehind(state: WalletState, archive: StateStore["archive"], accounts: readonly string[], now: number): boolean {
  const recent = state.activity.filter(a => a.signature && now - a.ts <= HISTORY_CATCH_UP_WINDOW_MS);
  return recent.some(a => !accounts.some(account =>
    state.moneyRows?.[a.signature + "/" + account] || archive.hasChange(account, a.signature!)));
}

/** Run one catch-up pass, or give up after `waitMs`. True when it finished. */
export async function catchUp(pass: () => Promise<void>, waitMs = HISTORY_CATCH_UP_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); });
  try {
    return await Promise.race([pass().then(() => true, () => false), late]);
  } finally { clearTimeout(timer); }
}
