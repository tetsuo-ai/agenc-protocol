import { describe, it, expect } from "vitest";
import {
  getTool,
  type MarketplaceToolContext,
  MarketplaceToolError,
} from "../src/index.js";
import {
  ListingState,
  TaskStatus,
  findTaskJobSpecPda,
} from "@tetsuo-ai/marketplace-sdk";
import {
  encodeListing,
  encodeTask,
  encodeTaskJobSpec,
  fakeTransport,
  fakeRpc,
  A_LISTING_PDA,
  A_TASK_PDA,
  A_PROVIDER,
} from "./fixtures.js";

describe("list_listings handler", () => {
  it("decodes listing accounts against a fake transport", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeListing({ name: "Acme Coder", category: "code-generation" }),
      ]),
    };
    const out = (await getTool("list_listings")!.handler({}, ctx)) as {
      listings: Array<Record<string, unknown>>;
    };
    expect(out.listings).toHaveLength(1);
    const l = out.listings[0]!;
    expect(l.name).toBe("Acme Coder");
    expect(l.category).toBe("code-generation");
    expect(l.state).toBe("Active");
    expect(l.price).toBe("50000000"); // decimal string, not bigint
    expect(l.tags).toEqual(["rust", "solana"]);
    expect(l.provider).toBe(A_PROVIDER);
  });

  it("filters out non-Active listings by default", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeListing({ state: ListingState.Active, pda: A_LISTING_PDA }),
        encodeListing({
          state: ListingState.Paused,
          pda: "Stake11111111111111111111111111111111111112" as never,
        }),
      ]),
    };
    const out = (await getTool("list_listings")!.handler({}, ctx)) as {
      listings: unknown[];
    };
    expect(out.listings).toHaveLength(1);
  });

  it("respects the limit", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([encodeListing(), encodeListing(), encodeListing()]),
    };
    const out = (await getTool("list_listings")!.handler({ limit: 2 }, ctx)) as {
      listings: unknown[];
    };
    expect(out.listings).toHaveLength(2);
  });
});

describe("list_open_tasks handler", () => {
  it("decodes Open tasks and projects JSON-safe fields", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([encodeTask({ status: TaskStatus.Open })]),
    };
    const out = (await getTool("list_open_tasks")!.handler({}, ctx)) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(out.tasks).toHaveLength(1);
    const t = out.tasks[0]!;
    expect(t.status).toBe("Open");
    expect(t.rewardAmount).toBe("25000000");
    expect(t.requiredCapabilities).toBe("1");
    expect(typeof t.taskId).toBe("string");
    // Finding #5: the bulk gPA sweep cannot cheaply confirm pinning, so it
    // leaves jobSpecPinned UNKNOWN (null) — it must NOT claim every Open task
    // is claimable. The field exists on every row so the model can gate on it.
    expect(t).toHaveProperty("jobSpecPinned");
    expect(t.jobSpecPinned).toBeNull();
  });

  it("excludes non-Open tasks via the status memcmp filter", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeTask({ status: TaskStatus.Open, pda: A_TASK_PDA }),
        encodeTask({
          status: TaskStatus.Completed,
          pda: "Config1111111111111111111111111111111111112" as never,
        }),
      ]),
    };
    const out = (await getTool("list_open_tasks")!.handler({}, ctx)) as {
      tasks: unknown[];
    };
    expect(out.tasks).toHaveLength(1);
  });

  it("applies the client-side capability-subset filter", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeTask({ requiredCapabilities: 1n }), // claimable by caps=3
        encodeTask({
          requiredCapabilities: 4n, // NOT a subset of 3
          pda: "Config1111111111111111111111111111111111113" as never,
        }),
      ]),
    };
    const out = (await getTool("list_open_tasks")!.handler(
      { capabilities: "3" },
      ctx,
    )) as { tasks: unknown[] };
    expect(out.tasks).toHaveLength(1);
  });
});

describe("get_listing / get_task handlers", () => {
  it("get_listing fetches and decodes one listing via a fake RPC", async () => {
    const acct = encodeListing({ name: "Solo Listing" });
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([acct]),
      rpc: fakeRpc([acct]) as never,
    };
    const out = (await getTool("get_listing")!.handler(
      { pda: A_LISTING_PDA },
      ctx,
    )) as { listing: Record<string, unknown> | null };
    expect(out.listing).not.toBeNull();
    expect(out.listing!.name).toBe("Solo Listing");
  });

  it("get_listing returns null for a missing account", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([]),
      rpc: fakeRpc([]) as never,
    };
    const out = (await getTool("get_listing")!.handler(
      { pda: A_LISTING_PDA },
      ctx,
    )) as { listing: unknown };
    expect(out.listing).toBeNull();
  });

  it("get_task decodes one task via a fake RPC", async () => {
    const acct = encodeTask({ reward: 99_000_000n });
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([acct]),
      rpc: fakeRpc([acct]) as never,
    };
    const out = (await getTool("get_task")!.handler(
      { pda: A_TASK_PDA },
      ctx,
    )) as { task: Record<string, unknown> | null };
    expect(out.task).not.toBeNull();
    expect(out.task!.rewardAmount).toBe("99000000");
  });

  // Finding #5: an Open task WITH a pinned job-spec account at
  // ["task_job_spec", task] is the only actually-claimable shape.
  it("get_task reports jobSpecPinned=true when the job-spec account exists", async () => {
    const taskAcct = encodeTask({ status: TaskStatus.Open, pda: A_TASK_PDA });
    const [jobSpecPda] = await findTaskJobSpecPda({ task: A_TASK_PDA });
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([taskAcct]),
      rpc: fakeRpc([
        taskAcct,
        { address: jobSpecPda, data: encodeTaskJobSpec(A_TASK_PDA) },
      ]) as never,
    };
    const out = (await getTool("get_task")!.handler(
      { pda: A_TASK_PDA },
      ctx,
    )) as { task: Record<string, unknown> | null };
    expect(out.task).not.toBeNull();
    expect(out.task!.status).toBe("Open");
    expect(out.task!.jobSpecPinned).toBe(true);
  });

  // Finding #5: an Open task with NO job-spec account is NOT claimable —
  // get_task must surface jobSpecPinned=false so the model does not prepare a
  // doomed claim.
  it("get_task reports jobSpecPinned=false for an Open-but-unpinned task", async () => {
    const taskAcct = encodeTask({ status: TaskStatus.Open, pda: A_TASK_PDA });
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([taskAcct]),
      rpc: fakeRpc([taskAcct]) as never, // no job-spec account present
    };
    const out = (await getTool("get_task")!.handler(
      { pda: A_TASK_PDA },
      ctx,
    )) as { task: Record<string, unknown> | null };
    expect(out.task).not.toBeNull();
    expect(out.task!.status).toBe("Open");
    expect(out.task!.jobSpecPinned).toBe(false);
  });

  // Finding #5: pinning is moot for a non-Open task — leave it null (not a
  // misleading false) and don't pay the extra read.
  it("get_task leaves jobSpecPinned=null for a non-Open task", async () => {
    const taskAcct = encodeTask({
      status: TaskStatus.Completed,
      pda: A_TASK_PDA,
    });
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([taskAcct]),
      rpc: fakeRpc([taskAcct]) as never,
    };
    const out = (await getTool("get_task")!.handler(
      { pda: A_TASK_PDA },
      ctx,
    )) as { task: Record<string, unknown> | null };
    expect(out.task).not.toBeNull();
    expect(out.task!.status).toBe("Completed");
    expect(out.task!.jobSpecPinned).toBeNull();
  });

  it("get_task throws a typed error when no RPC is available", async () => {
    const ctx: MarketplaceToolContext = { read: fakeTransport([]) };
    await expect(
      getTool("get_task")!.handler({ pda: A_TASK_PDA }, ctx),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });
});

describe("search handler", () => {
  it("matches listings by name/category/tags substring", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeListing({ name: "Rust Wizard", category: "code-generation" }),
      ]),
    };
    const out = (await getTool("search")!.handler(
      { query: "rust", kind: "listings" },
      ctx,
    )) as { listings: unknown[]; tasks: unknown[] };
    expect(out.listings).toHaveLength(1);
    expect(out.tasks).toHaveLength(0);
  });

  it("returns no listings when the query matches nothing", async () => {
    const ctx: MarketplaceToolContext = {
      read: fakeTransport([
        encodeListing({
          name: "Python Helper",
          category: "data-analysis",
          tags: ["python", "pandas"],
        }),
      ]),
    };
    const out = (await getTool("search")!.handler(
      { query: "rust", kind: "listings" },
      ctx,
    )) as { listings: unknown[] };
    expect(out.listings).toHaveLength(0);
  });
});
