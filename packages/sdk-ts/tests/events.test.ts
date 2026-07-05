// Structural tests for the event layer: generated discriminator-table
// completeness vs the IDL, a hand-built event byte fixture, log-line parsing
// edge cases, and the subscription/wait helpers driven by FAKE rpc objects
// (no network, no litesvm).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  address,
  getAddressEncoder,
  isSome,
  isNone,
  none,
  some,
  type Address,
} from "@solana/kit";
import {
  AGENC_EVENT_DECODERS,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  TASK_CREATED_EVENT_DISCRIMINATOR,
  getTaskEncoder,
  TaskStatus,
  TaskType,
  DependencyType,
  type AgencEvent,
} from "../src/generated/index.js";
import {
  decodeAgencEvent,
  parseAgencCoordinationEvents,
  subscribeMarketplaceEvents,
  subscribeMarketplaceEventsViaPolling,
  waitForTaskStatus,
  type LogsNotification,
  type SignatureInfo,
} from "../src/events/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDL_PATH = path.resolve(
  __dirname,
  "../../../artifacts/anchor/idl/agenc_coordination.json",
);

const hex = (bytes: readonly number[] | Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const dataLine = (bytes: Uint8Array): string => `Program data: ${toBase64(bytes)}`;

// ---------------------------------------------------------------------------
// invoke-stack context helpers: the parser only decodes `Program data:` lines
// emitted while the agenc-coordination program is the executing program, so
// fixtures wrap their data lines in a real invoke frame.
// ---------------------------------------------------------------------------

/** A foreign on-chain program (the SPL Token program id) used to forge events. */
const FOREIGN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const invokeLine = (program: string, depth = 1): string =>
  `Program ${program} invoke [${depth}]`;

const successLine = (program: string): string => `Program ${program} success`;

/** Wraps log lines in an agenc-coordination invoke frame so they attribute. */
const inAgencContext = (...lines: string[]): string[] => [
  invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
  ...lines,
  successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
];

// ---------------------------------------------------------------------------
// hand-built TaskCreated fixture (layout assembled byte-by-byte, NOT via the
// generated decoder's encoding counterpart)
// ---------------------------------------------------------------------------

const CREATOR = address("BPFLoaderUpgradeab1e11111111111111111111111");
const MINT = address("So11111111111111111111111111111111111111112");

type TaskCreatedFixtureFields = {
  rewardMint: Address | null;
  rewardAmount?: bigint;
};

/** Hand-assembles `discriminator ++ borsh(TaskCreated)` bytes. */
function buildTaskCreatedBlob({
  rewardMint,
  rewardAmount = 5_000_000n,
}: TaskCreatedFixtureFields): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const size = 8 + 32 + 32 + 8 + 8 + 1 + 8 + 2 + (rewardMint === null ? 1 : 33) + 8;
  const blob = new Uint8Array(size);
  const view = new DataView(blob.buffer);
  let offset = 0;

  blob.set(TASK_CREATED_EVENT_DISCRIMINATOR, offset); // discriminator
  offset += 8;
  blob.fill(0x11, offset, offset + 32); // task_id: [u8; 32]
  offset += 32;
  blob.set(addressEncoder.encode(CREATOR), offset); // creator: pubkey
  offset += 32;
  view.setBigUint64(offset, 7n, true); // required_capabilities: u64 LE
  offset += 8;
  view.setBigUint64(offset, rewardAmount, true); // reward_amount: u64 LE
  offset += 8;
  blob[offset] = 2; // task_type: u8
  offset += 1;
  view.setBigInt64(offset, -42n, true); // deadline: i64 LE (negative on purpose)
  offset += 8;
  view.setUint16(offset, 250, true); // min_reputation: u16 LE
  offset += 2;
  if (rewardMint === null) {
    blob[offset] = 0; // Option::None
    offset += 1;
  } else {
    blob[offset] = 1; // Option::Some
    offset += 1;
    blob.set(addressEncoder.encode(rewardMint), offset);
    offset += 32;
  }
  view.setBigInt64(offset, 1_700_000_123n, true); // timestamp: i64 LE
  offset += 8;
  expect(offset).toBe(size);
  return blob;
}

describe("generated event discriminator table", () => {
  it("has a decoder entry for every event in the IDL (all 98)", () => {
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as {
      events: { name: string; discriminator: number[] }[];
    };
    // P6 surface: 82 -> 84 (+AgentTrackRecordUpdated [P6.6], +ListingRated [P6.1],
    // +ModerationAttestorAssigned/Revoked [P6.8]; -ArbiterVotesCleanedUp,
    // -DisputeVoteCast from the P6.3 vote_dispute retirement) -> 86
    // (+ReferrerFeePaid [P6.2 demand-side referral leg],
    // +ProtocolConfigMigrated [P6.5 surface-versioning realloc]) -> 88
    // (+AgentVerified, +AgentVerificationRevoked [P7.3 agent verification]) -> 94
    // (+ModerationAttestorRegistered, +AttestorExitRequested,
    // +AttestorExitFinalized, +ModerationBlockSet, +ModerationBlockCleared,
    // +DefaultTrustListUpdated [P1.2 hardened open roster]) -> 98
    // (+StoreRegistered, +StoreUpdated, +StoreClosed [batch-2 store identity],
    // +ModerationHeartbeatRecorded [batch-2 A2 moderation liveness]) -> 99
    // (+GhostShareDistributed [batch-3 WS-CONTEST ghost-split]).
    expect(idl.events.length).toBe(99);
    expect(Object.keys(AGENC_EVENT_DECODERS).length).toBe(idl.events.length);
    for (const event of idl.events) {
      const entry = AGENC_EVENT_DECODERS[hex(event.discriminator)];
      expect(entry, `missing decoder for ${event.name}`).toBeDefined();
      expect(entry!.eventName).toBe(event.name);
      expect(typeof entry!.decode).toBe("function");
    }
  });
});

describe("hand-built event fixture round-trip", () => {
  it("decodes a hand-assembled TaskCreated blob (Some reward mint) field-by-field", () => {
    const blob = buildTaskCreatedBlob({ rewardMint: MINT });
    const event = decodeAgencEvent(
      inAgencContext("Program log: noise", dataLine(blob)),
    );
    expect(event).not.toBeNull();
    expect(event!.eventName).toBe("TaskCreated");
    if (event!.eventName !== "TaskCreated") throw new Error("unreachable");
    const data = event!.data;
    expect(new Uint8Array(data.taskId)).toEqual(new Uint8Array(32).fill(0x11));
    expect(data.creator).toBe(CREATOR);
    expect(data.requiredCapabilities).toBe(7n);
    expect(data.rewardAmount).toBe(5_000_000n);
    expect(data.taskType).toBe(2);
    expect(data.deadline).toBe(-42n);
    expect(data.minReputation).toBe(250);
    expect(isSome(data.rewardMint)).toBe(true);
    expect(data.rewardMint).toEqual(some(MINT));
    expect(data.timestamp).toBe(1_700_000_123n);
  });

  it("decodes the None reward-mint variant", () => {
    const blob = buildTaskCreatedBlob({ rewardMint: null });
    const events = parseAgencCoordinationEvents(inAgencContext(dataLine(blob)));
    expect(events).toHaveLength(1);
    if (events[0]!.eventName !== "TaskCreated") throw new Error("unreachable");
    expect(isNone(events[0]!.data.rewardMint)).toBe(true);
    expect(events[0]!.data.rewardMint).toEqual(none());
  });
});

describe("log-line parsing edge cases", () => {
  const validBlob = buildTaskCreatedBlob({ rewardMint: null });

  it("ignores non-event log lines", () => {
    const logs = [
      "Program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK invoke [1]",
      "Program log: Instruction: HireFromListing",
      "Program consumption: 12345 units remaining",
      "Program HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK success",
    ];
    expect(parseAgencCoordinationEvents(logs)).toEqual([]);
    expect(decodeAgencEvent(logs)).toBeNull();
  });

  it("skips unknown discriminators silently", () => {
    const unknown = new Uint8Array(16).fill(0xff); // 8-byte unknown disc + payload
    expect(parseAgencCoordinationEvents(inAgencContext(dataLine(unknown)))).toEqual(
      [],
    );
  });

  it("skips malformed base64 silently", () => {
    expect(
      parseAgencCoordinationEvents(
        inAgencContext("Program data: !!!not-base64!!!"),
      ),
    ).toEqual([]);
  });

  it("skips blobs shorter than the 8-byte discriminator", () => {
    expect(
      parseAgencCoordinationEvents(
        inAgencContext(dataLine(new Uint8Array([1, 2, 3]))),
      ),
    ).toEqual([]);
  });

  it("skips a known discriminator with a truncated payload", () => {
    const truncated = validBlob.slice(0, 20);
    expect(
      parseAgencCoordinationEvents(inAgencContext(dataLine(truncated))),
    ).toEqual([]);
  });

  it("still decodes the real event among garbage lines", () => {
    const logs = inAgencContext(
      "Program log: Instruction: CreateTask",
      "Program data: !!!not-base64!!!",
      dataLine(new Uint8Array(16).fill(0xff)),
      dataLine(validBlob),
      "Program success",
    );
    const events = parseAgencCoordinationEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe("TaskCreated");
    expect(decodeAgencEvent(logs)?.eventName).toBe("TaskCreated");
  });
});

// ---------------------------------------------------------------------------
// emitting-program attribution (#6): events are decoded ONLY while the
// agenc-coordination program is the executing program on the invoke stack.
// ---------------------------------------------------------------------------

describe("emitting-program attribution (invoke-stack tracking)", () => {
  const blob = buildTaskCreatedBlob({ rewardMint: null });

  it("REVERT-SENSITIVE: ignores a byte-perfect event blob logged by a foreign program", () => {
    // A foreign program can sol_log_data an exact copy of an agenc event blob;
    // without invoke-stack attribution this forgery decodes as genuine.
    const logs = [
      invokeLine(FOREIGN_PROGRAM),
      dataLine(blob),
      successLine(FOREIGN_PROGRAM),
    ];
    expect(parseAgencCoordinationEvents(logs)).toEqual([]);
    expect(decodeAgencEvent(logs)).toBeNull();
  });

  it("ignores an unattributable bare data line (empty invoke stack — fail closed)", () => {
    expect(parseAgencCoordinationEvents([dataLine(blob)])).toEqual([]);
    expect(decodeAgencEvent([dataLine(blob)])).toBeNull();
  });

  it("decodes an agenc event inside an inner CPI invoke, and ignores the outer program's forgery in the SAME logs", () => {
    const logs = [
      invokeLine(FOREIGN_PROGRAM, 1),
      "Program log: Instruction: Wrapper",
      invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS, 2),
      dataLine(blob), // real: agenc-coordination is executing (inner frame)
      successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
      dataLine(blob), // forged: the outer foreign program is executing again
      successLine(FOREIGN_PROGRAM),
    ];
    const events = parseAgencCoordinationEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe("TaskCreated");
  });

  it("ignores a forged data line under a CPI from agenc INTO a foreign program", () => {
    const logs = [
      invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS, 1),
      invokeLine(FOREIGN_PROGRAM, 2),
      dataLine(blob), // forged: the inner foreign program is executing
      successLine(FOREIGN_PROGRAM),
      dataLine(blob), // real: control returned to agenc-coordination
      successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
    ];
    expect(parseAgencCoordinationEvents(logs)).toHaveLength(1);
  });

  it('treats "Program log:" text as inert: a logged "success" string must not pop the stack', () => {
    const logs = [
      invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
      "Program log: success", // program-emitted TEXT, not a terminator
      dataLine(blob),
      successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
    ];
    expect(parseAgencCoordinationEvents(logs)).toHaveLength(1);
  });

  it("fails closed on malformed sequences", () => {
    // Stray terminator for a never-invoked program: ignored, stack intact.
    const strayTerminator = [
      invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
      successLine(FOREIGN_PROGRAM), // stray — not on the stack
      dataLine(blob),
      successLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
    ];
    expect(parseAgencCoordinationEvents(strayTerminator)).toHaveLength(1);

    // Depth jump pads missing frames as UNKNOWN; data under an unknown frame
    // is never decoded.
    const depthJump = [
      invokeLine(FOREIGN_PROGRAM, 3), // depths 1-2 were never logged
      successLine(FOREIGN_PROGRAM),
      dataLine(blob), // top of stack is an UNKNOWN frame — fail closed
    ];
    expect(parseAgencCoordinationEvents(depthJump)).toEqual([]);

    // `failed` terminates a frame just like `success`.
    const failedPop = [
      invokeLine(AGENC_COORDINATION_PROGRAM_ADDRESS),
      `Program ${AGENC_COORDINATION_PROGRAM_ADDRESS} failed: custom program error: 0x1771`,
      dataLine(blob), // nothing is executing any more
    ];
    expect(parseAgencCoordinationEvents(failedPop)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// subscribeMarketplaceEvents with a FAKE rpcSubscriptions
// ---------------------------------------------------------------------------

type FakeSubscriptionCall = {
  mentions: readonly string[];
  config: unknown;
};

function makeFakeSubscriptions(
  notificationsByAddress: Record<string, LogsNotification[]>,
  { hang = false }: { hang?: boolean } = {},
) {
  const calls: FakeSubscriptionCall[] = [];
  let sawAbort = false;
  const rpcSubscriptions = {
    logsNotifications(
      filter: { readonly mentions: readonly [Address] },
      config?: unknown,
    ) {
      calls.push({ mentions: filter.mentions, config });
      const items = notificationsByAddress[filter.mentions[0]] ?? [];
      return {
        subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) =>
          (async function* () {
            for (const item of items) yield item;
            if (hang) {
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) return resolve();
                abortSignal.addEventListener(
                  "abort",
                  () => {
                    sawAbort = true;
                    resolve();
                  },
                  { once: true },
                );
              });
            }
          })(),
      };
    },
  };
  return { rpcSubscriptions, calls, sawAbort: () => sawAbort };
}

const notif = (
  logs: readonly string[] | null,
  { err = null as unknown, signature = "sig-default" } = {},
): LogsNotification => ({ value: { err, logs, signature } });

describe("subscribeMarketplaceEvents (fake rpcSubscriptions)", () => {
  const eventBlob = buildTaskCreatedBlob({ rewardMint: null });

  it("subscribes on the program address by default and yields decoded events", async () => {
    const { rpcSubscriptions, calls } = makeFakeSubscriptions({
      [AGENC_COORDINATION_PROGRAM_ADDRESS]: [
        notif(inAgencContext("Program log: noise", dataLine(eventBlob)), {
          signature: "s1",
        }),
        notif(inAgencContext(dataLine(eventBlob)), {
          err: { failed: true },
          signature: "s2",
        }), // failed tx
        notif(null, { signature: "s3" }), // null logs
        notif(inAgencContext(dataLine(new Uint8Array(16).fill(0xff))), {
          signature: "s4",
        }), // unknown disc
      ],
    });
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(rpcSubscriptions)) {
      received.push(event);
    }
    expect(received).toHaveLength(1);
    expect(received[0]!.eventName).toBe("TaskCreated");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mentions).toEqual([AGENC_COORDINATION_PROGRAM_ADDRESS]);
  });

  it("filters by event name via options.events", async () => {
    const { rpcSubscriptions } = makeFakeSubscriptions({
      [AGENC_COORDINATION_PROGRAM_ADDRESS]: [
        notif(inAgencContext(dataLine(eventBlob))),
      ],
    });
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
      events: ["AgentRegistered"],
    })) {
      received.push(event);
    }
    expect(received).toEqual([]);
  });

  it("opens one mentions subscription per watched address and dedupes by signature", async () => {
    const a = address("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
    const b = address("8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh1");
    const shared = notif(inAgencContext(dataLine(eventBlob)), {
      signature: "shared-sig",
    });
    const { rpcSubscriptions, calls } = makeFakeSubscriptions({
      [a]: [shared],
      [b]: [shared],
    });
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
      addresses: [a, b],
    })) {
      received.push(event);
    }
    expect(received).toHaveLength(1); // deduped across the two subscriptions
    expect(calls.map((c) => c.mentions[0]).sort()).toEqual([a, b].sort());
  });

  it("yields nothing and never subscribes when the signal is already aborted", async () => {
    const { rpcSubscriptions, calls } = makeFakeSubscriptions({
      [AGENC_COORDINATION_PROGRAM_ADDRESS]: [
        notif(inAgencContext(dataLine(eventBlob))),
      ],
    });
    const controller = new AbortController();
    controller.abort();
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
      abortSignal: controller.signal,
    })) {
      received.push(event);
    }
    expect(received).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("aborts the underlying subscription when the consumer stops iterating", async () => {
    const fake = makeFakeSubscriptions(
      {
        [AGENC_COORDINATION_PROGRAM_ADDRESS]: [
          notif(inAgencContext(dataLine(eventBlob))),
        ],
      },
      { hang: true },
    );
    for await (const event of subscribeMarketplaceEvents(fake.rpcSubscriptions)) {
      expect(event.eventName).toBe("TaskCreated");
      break; // consumer walks away; generator cleanup must abort the pump
    }
    expect(fake.sawAbort()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// subscribeMarketplaceEventsViaPolling with a FAKE rpc
// ---------------------------------------------------------------------------

/**
 * Scripted polling fake: each `getSignaturesForAddress` call consumes the
 * next `rounds` entry (regardless of cursors). Shared by the polling and
 * automatic-fallback suites.
 */
function makePollingRpc(
  rounds: SignatureInfo[][],
  logsBySignature: Record<string, string[] | null>,
) {
  let round = 0;
  const signatureCalls: { address: string; config: unknown }[] = [];
  const transactionCalls: string[] = [];
  const rpc = {
    getSignaturesForAddress(
      addr: Address,
      config?: { readonly commitment?: string; readonly until?: string },
    ) {
      signatureCalls.push({ address: addr, config });
      const result = rounds[round] ?? [];
      round += 1;
      return { send: async () => result as readonly SignatureInfo[] };
    },
    getTransaction(signature: string) {
      transactionCalls.push(signature);
      return {
        send: async () => ({
          meta: { logMessages: logsBySignature[signature] ?? null },
        }),
      };
    },
  };
  return { rpc, signatureCalls, transactionCalls };
}

describe("subscribeMarketplaceEventsViaPolling (fake rpc)", () => {
  const eventBlob = buildTaskCreatedBlob({ rewardMint: null });

  it("baselines on the first round, then yields only NEW successful txs oldest-first", async () => {
    const { rpc, signatureCalls, transactionCalls } = makePollingRpc(
      [
        // round 1 (history; newest first) — baseline only, never emitted
        [{ signature: "old-2", err: null }, { signature: "old-1", err: null }],
        // round 2 — two new txs (one failed) on top of the watermark
        [
          { signature: "new-2", err: null },
          { signature: "new-1-failed", err: { code: 1 } },
        ],
        // round 3+ — nothing new
        [],
      ],
      {
        "new-2": inAgencContext("Program log: x", dataLine(eventBlob)),
      },
    );

    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEventsViaPolling(rpc, {
      pollIntervalMs: 1,
    })) {
      received.push(event);
      break; // stop after the expected event
    }

    expect(received).toHaveLength(1);
    expect(received[0]!.eventName).toBe("TaskCreated");
    // history was never fetched, the failed tx was skipped
    expect(transactionCalls).toEqual(["new-2"]);
    // round 1 has no watermark; round 2 polls "until" the round-1 newest sig
    expect(signatureCalls[0]!.address).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect((signatureCalls[0]!.config as { until?: string }).until).toBeUndefined();
    expect((signatureCalls[1]!.config as { until?: string }).until).toBe("old-2");
  });

  it("applies the events filter and stops on abort", async () => {
    const controller = new AbortController();
    const { rpc } = makePollingRpc(
      [[], [{ signature: "new-1", err: null }], []],
      { "new-1": inAgencContext(dataLine(eventBlob)) },
    );
    const received: AgencEvent[] = [];
    const iteration = (async () => {
      for await (const event of subscribeMarketplaceEventsViaPolling(rpc, {
        pollIntervalMs: 1,
        events: ["AgentRegistered"], // TaskCreated filtered out
        abortSignal: controller.signal,
      })) {
        received.push(event);
      }
    })();
    setTimeout(() => controller.abort(), 25);
    await iteration; // must terminate (abort), yielding nothing
    expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// polling pagination (#7): a burst larger than one signature page must be
// drained with a `before`-cursor loop, bounded by maxPagesPerRound.
// ---------------------------------------------------------------------------

describe("subscribeMarketplaceEventsViaPolling pagination (fake paged rpc)", () => {
  /**
   * Paged fake with FAITHFUL real-RPC semantics: a newest-first ledger,
   * `before` (exclusive) starts after that signature, `until` (exclusive)
   * stops before it, and every response is capped at `pageSize` entries.
   * `afterBaseline` fires once after the first response, so a burst can land
   * strictly between the baseline round and the next poll.
   */
  function makePagedRpc(
    pageSize: number,
    { afterBaseline }: { afterBaseline?: () => void } = {},
  ) {
    const ledger: string[] = []; // newest first
    const logsBySignature: Record<string, string[]> = {};
    const signatureCalls: Array<{ until?: string; before?: string }> = [];
    let baselineDone = false;
    const rpc = {
      getSignaturesForAddress(
        _addr: Address,
        config?: {
          readonly commitment?: string;
          readonly until?: string;
          readonly before?: string;
        },
      ) {
        signatureCalls.push({ until: config?.until, before: config?.before });
        return {
          send: async (): Promise<readonly SignatureInfo[]> => {
            let list = ledger.slice();
            if (config?.before !== undefined) {
              const beforeIndex = list.indexOf(config.before);
              list = beforeIndex === -1 ? list : list.slice(beforeIndex + 1);
            }
            if (config?.until !== undefined) {
              const untilIndex = list.indexOf(config.until);
              if (untilIndex !== -1) list = list.slice(0, untilIndex);
            }
            const page = list
              .slice(0, pageSize)
              .map((signature) => ({ signature, err: null as unknown }));
            if (!baselineDone) {
              baselineDone = true;
              afterBaseline?.();
            }
            return page;
          },
        };
      },
      getTransaction(signature: string) {
        return {
          send: async () => ({
            meta: { logMessages: logsBySignature[signature] ?? null },
          }),
        };
      },
    };
    return { rpc, ledger, logsBySignature, signatureCalls };
  }

  /** Seeds 5 burst signatures (new-1 oldest .. new-5 newest), each with one event. */
  function seedBurst(ledger: string[], logsBySignature: Record<string, string[]>) {
    for (let n = 1; n <= 5; n += 1) {
      ledger.unshift(`new-${n}`); // ends up ["new-5", ..., "new-1", ...]
      logsBySignature[`new-${n}`] = inAgencContext(
        dataLine(
          buildTaskCreatedBlob({ rewardMint: null, rewardAmount: BigInt(n) }),
        ),
      );
    }
  }

  async function collectRewards(
    iterator: AsyncGenerator<AgencEvent, void, void>,
  ): Promise<bigint[]> {
    const received: bigint[] = [];
    for await (const event of iterator) {
      if (event.eventName !== "TaskCreated") throw new Error("unexpected event");
      received.push(event.data.rewardAmount);
    }
    return received;
  }

  it("REVERT-SENSITIVE: drains a multi-page burst with a before-cursor loop (no silent drop)", async () => {
    const fake = makePagedRpc(2, {
      afterBaseline: () => seedBurst(fake.ledger, fake.logsBySignature),
    });
    fake.ledger.push("base"); // pre-existing history: baseline only

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const received = await collectRewards(
      subscribeMarketplaceEventsViaPolling(fake.rpc, {
        pollIntervalMs: 1,
        abortSignal: controller.signal,
      }),
    );

    // ALL 5 burst events arrive, oldest-first — nothing beyond the first
    // page is silently dropped.
    expect(received).toEqual([1n, 2n, 3n, 4n, 5n]);
    // The drain round actually paged with a before cursor down the burst.
    expect(fake.signatureCalls.slice(0, 5).map((c) => c.before)).toEqual([
      undefined, // baseline round
      undefined, // page 1 of the drain round
      "new-4", // page 2
      "new-2", // page 3
      "new-1", // page 4 (empty -> stop)
    ]);
    expect(fake.signatureCalls[1]!.until).toBe("base");
  });

  it("bounds each round at maxPagesPerRound and drops the overflow (documented)", async () => {
    const fake = makePagedRpc(2, {
      afterBaseline: () => seedBurst(fake.ledger, fake.logsBySignature),
    });
    fake.ledger.push("base");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const received = await collectRewards(
      subscribeMarketplaceEventsViaPolling(fake.rpc, {
        pollIntervalMs: 1,
        maxPagesPerRound: 1, // only the newest page per round
        abortSignal: controller.signal,
      }),
    );

    // The newest page ([new-5, new-4]) is delivered oldest-first; the
    // watermark still advances to new-5, so new-1..new-3 are dropped —
    // exactly the documented overflow behavior, and no duplicates later.
    expect(received).toEqual([4n, 5n]);
  });
});

// ---------------------------------------------------------------------------
// automatic polling fallback (#8): subscribeMarketplaceEvents must delegate
// to the polling generator when WebSocket subscriptions are unavailable.
// ---------------------------------------------------------------------------

describe("subscribeMarketplaceEvents automatic polling fallback", () => {
  const eventBlob = buildTaskCreatedBlob({ rewardMint: null });
  const pollingFixture = () =>
    makePollingRpc(
      [[], [{ signature: "new-1", err: null }], []],
      { "new-1": inAgencContext(dataLine(eventBlob)) },
    );

  it("REVERT-SENSITIVE: falls back to polling when rpcSubscriptions is absent", async () => {
    const { rpc, signatureCalls } = pollingFixture();
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(undefined, {
      rpc,
      pollIntervalMs: 1,
    })) {
      received.push(event);
      break;
    }
    expect(received).toHaveLength(1);
    expect(received[0]!.eventName).toBe("TaskCreated");
    expect(signatureCalls.length).toBeGreaterThan(0); // polling path engaged
  });

  it("REVERT-SENSITIVE: falls back to polling when WebSocket subscription setup fails", async () => {
    const rpcSubscriptions = {
      logsNotifications() {
        return {
          subscribe: async (): Promise<AsyncIterable<LogsNotification>> => {
            throw new Error("WebSocket not supported");
          },
        };
      },
    };
    const { rpc, signatureCalls } = pollingFixture();
    const received: AgencEvent[] = [];
    for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
      rpc,
      pollIntervalMs: 1,
    })) {
      received.push(event);
      break;
    }
    expect(received).toHaveLength(1);
    expect(received[0]!.eventName).toBe("TaskCreated");
    expect(signatureCalls.length).toBeGreaterThan(0);
  });

  it("rethrows the setup error when no fallback rpc is provided", async () => {
    const rpcSubscriptions = {
      logsNotifications() {
        return {
          subscribe: async (): Promise<AsyncIterable<LogsNotification>> => {
            throw new Error("WebSocket not supported");
          },
        };
      },
    };
    await expect(
      (async () => {
        for await (const event of subscribeMarketplaceEvents(rpcSubscriptions)) {
          void event;
        }
      })(),
    ).rejects.toThrow("WebSocket not supported");
  });

  it("throws a clear error when rpcSubscriptions is absent and no fallback rpc is provided", async () => {
    await expect(
      (async () => {
        for await (const event of subscribeMarketplaceEvents(undefined)) {
          void event;
        }
      })(),
    ).rejects.toThrow(/options\.rpc/);
  });
});

// ---------------------------------------------------------------------------
// waitForTaskStatus with a FAKE rpc
// ---------------------------------------------------------------------------

describe("waitForTaskStatus (fake rpc)", () => {
  const TASK_PDA = address("J7nSEX8ADf3pVVicd6yKy2Skvg8iLePEmkLUisAAaioD");

  function encodeTaskBase64(status: TaskStatus): string {
    const bytes = getTaskEncoder().encode({
      taskId: new Uint8Array(32).fill(1),
      creator: CREATOR,
      requiredCapabilities: 1n,
      description: new Uint8Array(64),
      constraintHash: new Uint8Array(32),
      rewardAmount: 5_000_000n,
      maxWorkers: 1,
      currentWorkers: 1,
      status,
      taskType: TaskType.Exclusive,
      createdAt: 1_700_000_000n,
      deadline: 1_700_003_600n,
      completedAt: 0n,
      escrow: CREATOR,
      result: new Uint8Array(64),
      completions: 0,
      requiredCompletions: 1,
      bump: 255,
      protocolFeeBps: 100,
      dependsOn: null,
      dependencyType: DependencyType.None,
      minReputation: 0,
      rewardMint: null,
      operator: CREATOR,
      operatorFeeBps: 0,
      reserved: new Uint8Array(16),
      // P6.2: no-referrer default (Pubkey::default() == system program), fee 0.
      referrer: address("11111111111111111111111111111111"),
      referrerFeeBps: 0,
    });
    return toBase64(new Uint8Array(bytes));
  }

  function makeAccountRpc(responses: (string | null)[]) {
    let call = 0;
    const rpc = {
      getAccountInfo(_address: Address, _config?: unknown) {
        const data = responses[Math.min(call, responses.length - 1)] ?? null;
        call += 1;
        return {
          send: async () => ({
            value: data === null ? null : { data: [data, "base64"] as const },
          }),
        };
      },
    };
    return rpc;
  }

  it("resolves with the decoded Task once it reaches the target status", async () => {
    const rpc = makeAccountRpc([
      null, // not created yet
      encodeTaskBase64(TaskStatus.Open),
      encodeTaskBase64(TaskStatus.Completed),
    ]);
    const task = await waitForTaskStatus(rpc, TASK_PDA, TaskStatus.Completed, {
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });
    expect(task.status).toBe(TaskStatus.Completed);
    expect(task.creator).toBe(CREATOR);
    expect(task.rewardAmount).toBe(5_000_000n);
  });

  it("rejects with a clear error (including the last observed status) on timeout", async () => {
    const rpc = makeAccountRpc([encodeTaskBase64(TaskStatus.Open)]);
    await expect(
      waitForTaskStatus(rpc, TASK_PDA, TaskStatus.Completed, {
        timeoutMs: 30,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/timed out after 30ms.*Completed.*last observed: Open/s);
  });

  it("reports 'account not found' when the task never appears", async () => {
    const rpc = makeAccountRpc([null]);
    await expect(
      waitForTaskStatus(rpc, TASK_PDA, TaskStatus.Open, {
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/account not found/);
  });
});
