// How the wallet talks to a Solana endpoint that turns away anyone who asks
// too fast: it keeps to the endpoint's pace, and waits out a "too many
// requests" instead of failing what it was doing.
import { describe, expect, it } from "vitest";
import {
  getAddressDecoder,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from "@solana/kit";
import { AgencError } from "@tetsuo-ai/marketplace-sdk";
import { createRpcChain, isNetworkTrouble, politeTransport } from "../src/chain.js";
import { WalletError } from "../src/errors.js";

function refused(status: number, retryAfter?: string): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    statusCode: status,
    message: status === 429 ? "Too Many Requests" : "Refused",
    headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
  } as never);
}

/**
 * A clock that stands still until everything is waiting, then jumps to the
 * next thing anybody is waiting for; and an endpoint that follows a script.
 */
function setup(script: Array<number | "ok"> = []) {
  let now = 0;
  const timers: Array<{ at: number; wake: () => void }> = [];
  const starts: Array<{ id: unknown; at: number }> = [];
  const base = (async (config: { payload: unknown }) => {
    starts.push({ id: (config.payload as { id: unknown }).id, at: now });
    const next = script.shift() ?? "ok";
    if (next !== "ok") throw refused(next);
    return { result: (config.payload as { id: unknown }).id };
  }) as unknown as RpcTransport;
  const options = {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        timers.push({ at: now + ms, wake });
      }),
    jitter: () => 0,
  };
  const call = (transport: RpcTransport, id: number) =>
    transport({ payload: { id } }) as Promise<{ result: number }>;
  /** Let `work` finish, moving the clock on whenever nothing else can happen. */
  async function run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const outcome = work.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) break;
      if (timers.length === 0) throw new Error("nothing is waiting and nothing finished");
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      now = Math.max(now, next.at);
      next.wake();
    }
    const result = await outcome;
    if ("error" in result) throw result.error;
    return result.value;
  }
  return { starts, base, options, call, run };
}

describe("a paced endpoint", () => {
  it("starts requests a set time apart, in the order they were made", async () => {
    const { starts, base, options, call, run } = setup();
    const transport = politeTransport(base, { minGapMs: 280, ...options });

    const answers = await run(Promise.all([1, 2, 3, 4].map((id) => call(transport, id))));

    expect(answers.map((answer) => answer.result)).toEqual([1, 2, 3, 4]);
    expect(starts).toEqual([
      { id: 1, at: 0 },
      { id: 2, at: 280 },
      { id: 3, at: 560 },
      { id: 4, at: 840 },
    ]);
  });

  it("does not hold anything back when no pace is set", async () => {
    const { starts, base, options, call, run } = setup();
    const transport = politeTransport(base, { minGapMs: 0, ...options });
    await run(Promise.all([1, 2, 3].map((id) => call(transport, id))));
    expect(starts.map((entry) => entry.at)).toEqual([0, 0, 0]);
  });
});

describe("an endpoint that is too busy", () => {
  it("is asked again after a growing wait, and the answer comes through", async () => {
    const { starts, base, options, call, run } = setup([429, 429, 503, "ok"]);
    const transport = politeTransport(base, { minGapMs: 0, ...options });

    expect(await run(call(transport, 7))).toEqual({ result: 7 });

    // 0.5 s, 1 s, then 2 s.
    expect(starts.map((entry) => entry.at)).toEqual([0, 500, 1_500, 3_500]);
  });

  it("is given the time it asks for", async () => {
    const { starts, base, options, call, run } = setup();
    let first = true;
    const picky = (async (config: { payload: unknown }) => {
      if (first) {
        first = false;
        throw refused(429, "3");
      }
      return base(config as never);
    }) as unknown as RpcTransport;
    const transport = politeTransport(picky, { minGapMs: 0, ...options });

    await run(call(transport, 1));

    expect(starts).toEqual([{ id: 1, at: 3_000 }]);
  });

  it("makes every other request wait as well, so it is not asked ten times at once", async () => {
    const { starts, base, options, call, run } = setup([429, "ok", "ok", "ok"]);
    const transport = politeTransport(base, { minGapMs: 100, ...options });

    await run(Promise.all([1, 2, 3].map((id) => call(transport, id))));

    // The first try is refused at 0. Nothing else goes out before the wait is
    // over, and then everything keeps its pace.
    expect(starts[0]).toEqual({ id: 1, at: 0 });
    for (const later of starts.slice(1)) expect(later.at).toBeGreaterThanOrEqual(500);
    const times = starts.slice(1).map((entry) => entry.at).sort((a, b) => a - b);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(100);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(100);
    expect(new Set(starts.slice(1).map((entry) => entry.id))).toEqual(new Set([1, 2, 3]));
  });

  it("gives up after a few tries and says why", async () => {
    const { starts, base, options, call, run } = setup(Array.from({ length: 20 }, () => 429 as const));
    const transport = politeTransport(base, { minGapMs: 0, retries: 3, ...options });

    const error = await run(call(transport, 1)).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(starts).toHaveLength(4);
    expect(isNetworkTrouble(error)).toBe(true);
  });

  it("passes a plain no straight through", async () => {
    for (const status of [400, 401, 403, 500]) {
      const { starts, base, options, call, run } = setup([status]);
      const transport = politeTransport(base, { minGapMs: 0, ...options });
      await expect(run(call(transport, 1))).rejects.toBeInstanceOf(SolanaError);
      expect(starts).toHaveLength(1);
    }
  });
});

describe("telling a busy network from a no", () => {
  it("sees through the errors wrapped around it", () => {
    const wrapped = new AgencError("Transaction failed: HTTP error (429): Too Many Requests", {
      code: null,
      errorName: null,
      logs: [],
      signature: null,
      cause: refused(429),
    });
    expect(isNetworkTrouble(wrapped)).toBe(true);
    expect(isNetworkTrouble(new WalletError("NETWORK", "x", { cause: refused(503) }))).toBe(true);
    expect(isNetworkTrouble(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkTrouble(new Error("x", { cause: new Error("socket hang up") }))).toBe(true);
  });

  it("does not mistake an answer for trouble", () => {
    const program = new AgencError("custom program error: 0x1770", {
      code: 0x1770,
      errorName: "ListingChanged",
      logs: [],
      signature: null,
    });
    expect(isNetworkTrouble(program)).toBe(false);
    expect(isNetworkTrouble(refused(400))).toBe(false);
    expect(isNetworkTrouble(refused(403))).toBe(false);
    // A sentence written for a person is not a diagnosis.
    expect(isNetworkTrouble(new WalletError("NETWORK", "The network could not be reached."))).toBe(false);
    expect(isNetworkTrouble("fetch failed")).toBe(false);
    expect(isNetworkTrouble(null)).toBe(false);
  });
});

describe("reading many accounts", () => {
  it("asks for at most a hundred at a time and keeps the order", async () => {
    const asked: string[][] = [];
    const transport = (async (config: { payload: { id: unknown; method: string; params: unknown[] } }) => {
      const { id, method, params } = config.payload;
      expect(method).toBe("getMultipleAccounts");
      const addresses = params[0] as string[];
      asked.push(addresses);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: 1 },
          value: addresses.map((address, index) =>
            index % 2 === 1
              ? null
              : {
                  data: [Buffer.from(address.slice(0, 4)).toString("base64"), "base64"],
                  executable: false,
                  lamports: 7,
                  owner: "11111111111111111111111111111111",
                  rentEpoch: 0,
                  space: 4,
                },
          ),
        },
      };
    }) as unknown as RpcTransport;
    const chain = createRpcChain({ network: "mainnet", rpcUrl: "https://rpc.example", transport, minRequestGapMs: 0 });
    const addresses = Array.from({ length: 150 }, (_, index) =>
      getAddressDecoder().decode(new Uint8Array(32).fill(index + 1)),
    );
    const accounts = await chain.readRawAccounts(addresses);
    expect(asked.map((batch) => batch.length)).toEqual([100, 50]);
    expect(accounts).toHaveLength(150);
    expect(accounts[1]).toBeNull();
    expect(accounts[100]).toEqual({
      data: new Uint8Array(Buffer.from(addresses[100]!.slice(0, 4))),
      owner: "11111111111111111111111111111111",
      lamports: 7n,
    });
  });
});
