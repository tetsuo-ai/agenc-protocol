// MCP server e2e: drive a REAL MCP Client over an in-memory transport pair
// against an AgenC marketplace MCP server whose read context is backed by the
// REAL compiled agenc-coordination program running in litesvm
// (startLocalMarketplace). This is the localnet-adapted P5.1 Done-when: the
// server's readonly tools resolve listings / tasks / agents against the local
// stack's actual on-chain accounts.
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { facade, findAgentPda, findTaskPda } from "@tetsuo-ai/marketplace-sdk";
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import type {
  MarketplaceTool,
  MarketplaceToolContext,
} from "@tetsuo-ai/marketplace-tools";
import type { Address } from "@solana/kit";
import { createMarketplaceMcpServer } from "../src/index.js";
import { LiteSvmGpa, liteSvmRpc } from "./litesvm-harness.js";

// ---- One seeded local marketplace shared across the read-only assertions ----

interface Seeded {
  context: MarketplaceToolContext;
  listingPda: Address;
  taskPda: Address;
  providerAgent: Address;
  creatorAgent: Address;
  listingName: string;
  listingCategory: string;
  taskReward: bigint;
  taskCapabilities: bigint;
  creatorWallet: Address;
}

let seeded: Seeded;

beforeAll(async () => {
  const market = await startLocalMarketplace();

  // --- provider: register agent + publish a real ServiceListing ---
  const provider = await market.fundedSigner();
  const providerClient = market.clientFor(provider);
  const providerAgentId = new Uint8Array(32).fill(11);
  await providerClient.registerAgent({
    authority: provider,
    agentId: providerAgentId,
    capabilities: 1n,
    endpoint: "http://provider.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

  const listingId = new Uint8Array(32).fill(33);
  const listingName = "Acme Coder";
  const listingCategory = "code-generation";
  await providerClient.createServiceListing({
    providerAgent,
    authority: provider,
    listingId,
    name: facadeEncode(listingName, 32),
    category: facadeEncode(listingCategory, 32),
    tags: facadeEncode("rust", 64),
    specHash: new Uint8Array(32).fill(7),
    specUri: "agenc://job-spec/sha256/test",
    price: 50_000_000n,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: null,
    operatorFeeBps: 0,
  });
  const [listingPda] = await facade.findListingPda({
    providerAgent,
    listingId,
  });

  // --- creator: register agent + create a real Open Task ---
  const creator = await market.fundedSigner();
  const creatorClient = market.clientFor(creator);
  const creatorAgentId = new Uint8Array(32).fill(22);
  await creatorClient.registerAgent({
    authority: creator,
    agentId: creatorAgentId,
    capabilities: 1n,
    endpoint: "http://creator.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

  const taskId = new Uint8Array(32).fill(44);
  const taskReward = 25_000_000n;
  const taskCapabilities = 1n;
  const now = market.svm.getClock().unixTimestamp;
  await creatorClient.send([
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: taskCapabilities,
      description: new Uint8Array(64).fill(7, 0, 32),
      rewardAmount: taskReward,
      maxWorkers: 1,
      deadline: now + 3600n,
      taskType: 0,
      constraintHash: null,
      minReputation: 0,
      rewardMintArg: null,
    }),
  ]);
  const [taskPda] = await findTaskPda({ creator: creator.address, taskId });

  // --- the litesvm-backed read context the MCP server runs against ---
  const gpa = new LiteSvmGpa(market.svm).register(
    listingPda,
    taskPda,
    providerAgent,
    creatorAgent,
  );
  const rpc = liteSvmRpc(market.svm);
  const context = {
    read: gpa,
    rpc,
  } as unknown as MarketplaceToolContext;

  seeded = {
    context,
    listingPda,
    taskPda,
    providerAgent,
    creatorAgent,
    listingName,
    listingCategory,
    taskReward,
    taskCapabilities,
    creatorWallet: creator.address,
  };
});

/** Connect a real MCP Client to a server built over `seeded.context`. */
async function connectClient(
  opts: {
    enableMutations?: boolean;
    tools?: ReadonlyArray<MarketplaceTool>;
  } = {},
) {
  const { server } = createMarketplaceMcpServer({
    context: seeded.context,
    ...(opts.enableMutations !== undefined
      ? { enableMutations: opts.enableMutations }
      : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, close: () => client.close() };
}

/** Parse the JSON text content of a tools/call result. */
function parseResult(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(r.isError).not.toBe(true);
  const text = r.content?.find((c) => c.type === "text")?.text;
  expect(text).toBeDefined();
  return JSON.parse(text!);
}

/** Assert and parse the stable structured error returned by tools/call. */
function parseToolError(result: unknown): {
  error: { tool: string; code: string; message: string };
} {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(r.isError).toBe(true);
  const text = r.content?.find((entry) => entry.type === "text")?.text;
  expect(text).toBeDefined();
  return JSON.parse(text ?? "null") as {
    error: { tool: string; code: string; message: string };
  };
}

describe("MCP server: tool registration", () => {
  it("readonly mode advertises exactly the 6 readonly tools (no prepare_*)", async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "get_agent_track_record",
          "get_listing",
          "get_task",
          "list_listings",
          "list_open_tasks",
          "search",
        ].sort(),
      );
      // No mutation tools are present without the opt-in.
      expect(names).not.toContain("prepare_hire");
      expect(names).not.toContain("prepare_claim");
      expect(names).not.toContain("prepare_submit");
      // Every readonly tool is hinted readOnly + non-destructive.
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
        // The JSON-Schema input envelope passes through.
        expect(t.inputSchema.type).toBe("object");
      }
    } finally {
      await close();
    }
  });

  it("mutation opt-in adds the keyless prepare_* lifecycle tools (19 total)", async () => {
    const { client, close } = await connectClient({ enableMutations: true });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toHaveLength(19);
      expect(names).toContain("prepare_register_agent");
      expect(names).toContain("prepare_hire");
      expect(names).toContain("prepare_hire_humanless");
      expect(names).toContain("prepare_set_task_job_spec");
      expect(names).toContain("prepare_claim");
      expect(names).toContain("prepare_submit");
      expect(names).toContain("prepare_accept_task_result");
      expect(names).toContain("prepare_reject_task_result");
      expect(names).toContain("prepare_auto_accept_task_result");
      expect(names).toContain("prepare_cancel_task");
      expect(names).toContain("prepare_close_task");
      expect(names).toContain("prepare_rate_hire");
      expect(names).toContain("prepare_create_service_listing");
      // prepare tools are not readOnly but are non-destructive (build, not send).
      const claim = tools.find((t) => t.name === "prepare_claim");
      expect(claim?.annotations?.readOnlyHint).toBe(false);
      expect(claim?.annotations?.destructiveHint).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects malformed tool arguments before dispatching to a handler", async () => {
    const calls: unknown[] = [];
    const validationProbe: MarketplaceTool = {
      name: "validation_probe",
      description: "MCP runtime input validation probe.",
      kind: "readonly",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["count"],
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 2,
            description: "A bounded count.",
          },
        },
      },
      async handler(input) {
        calls.push(input);
        return { ok: true };
      },
    };
    const { client, close } = await connectClient({ tools: [validationProbe] });
    try {
      for (const invalid of [
        {},
        { count: "1" },
        { count: 3 },
        { count: 1, unexpected: true },
      ]) {
        const result = await client.callTool({
          name: "validation_probe",
          arguments: invalid,
        });
        expect(result.isError).toBe(true);
        const content = result.content as Array<{
          type: string;
          text?: string;
        }>;
        const text = content.find((entry) => entry.type === "text")?.text;
        expect(JSON.parse(text ?? "null")).toMatchObject({
          error: {
            tool: "validation_probe",
            code: "INVALID_TOOL_INPUT",
          },
        });
      }
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("rejects an invalid envelope through MCP for every shipped tool", async () => {
    const { client, close } = await connectClient({ enableMutations: true });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);
      for (const tool of tools) {
        const result = await client.callTool({
          name: tool.name,
          arguments: { __unexpected: true },
        });
        expect(parseToolError(result)).toMatchObject({
          error: {
            tool: tool.name,
            code: "INVALID_TOOL_INPUT",
          },
        });
      }
    } finally {
      await close();
    }
  });

  it.each([
    ["get_listing", { pda: "not-a-solana-address" }],
    ["list_open_tasks", { capabilities: "-1" }],
    [
      "prepare_submit",
      {
        task: () => seeded.taskPda,
        worker: () => seeded.providerAgent,
        workerAuthority: () => seeded.creatorWallet,
        proofHash: () => "07".repeat(31),
      },
    ],
    [
      "prepare_set_task_job_spec",
      {
        task: () => seeded.taskPda,
        creator: () => seeded.creatorWallet,
        jobSpecHash: () => "07".repeat(32),
        jobSpecUri: "javascript:alert(1)",
        moderator: () => seeded.creatorWallet,
      },
    ],
    [
      "prepare_register_agent",
      {
        authority: () => seeded.creatorWallet,
        agentId: () => "07".repeat(32),
        capabilities: "1",
        endpoint: "ipfs://not-an-http-endpoint",
      },
    ],
  ])("rejects strict production format via MCP: %s", async (name, template) => {
    const args = Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        typeof value === "function" ? value() : value,
      ]),
    );
    const { client, close } = await connectClient({ enableMutations: true });
    try {
      const result = await client.callTool({ name, arguments: args });
      expect(parseToolError(result)).toMatchObject({
        error: { tool: name, code: "INVALID_TOOL_INPUT" },
      });
    } finally {
      await close();
    }
  });
});

describe("MCP server: readonly tools resolve REAL local-stack accounts", () => {
  it("list_listings returns the seeded Active listing", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "list_listings",
        arguments: {},
      });
      const out = parseResult(result) as {
        listings: Array<{
          pda: string;
          name: string;
          category: string;
          state: string;
        }>;
      };
      expect(out.listings.length).toBe(1);
      expect(out.listings[0]!.pda).toBe(seeded.listingPda);
      expect(out.listings[0]!.name).toBe(seeded.listingName);
      expect(out.listings[0]!.category).toBe(seeded.listingCategory);
      expect(out.listings[0]!.state).toBe("Active");
    } finally {
      await close();
    }
  });

  it("get_listing fetches the seeded listing by PDA", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_listing",
        arguments: { pda: seeded.listingPda },
      });
      const out = parseResult(result) as { listing: { pda: string } | null };
      expect(out.listing).not.toBeNull();
      expect(out.listing!.pda).toBe(seeded.listingPda);
    } finally {
      await close();
    }
  });

  it("list_open_tasks returns the seeded Open task (capability-filtered)", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "list_open_tasks",
        arguments: { capabilities: seeded.taskCapabilities.toString() },
      });
      const out = parseResult(result) as {
        tasks: Array<{ pda: string; status: string; rewardAmount: string }>;
      };
      expect(out.tasks.length).toBe(1);
      expect(out.tasks[0]!.pda).toBe(seeded.taskPda);
      expect(out.tasks[0]!.status).toBe("Open");
      expect(out.tasks[0]!.rewardAmount).toBe(seeded.taskReward.toString());
    } finally {
      await close();
    }
  });

  it("get_task fetches the seeded task by PDA", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_task",
        arguments: { pda: seeded.taskPda },
      });
      const out = parseResult(result) as {
        task: { pda: string; status: string } | null;
      };
      expect(out.task).not.toBeNull();
      expect(out.task!.pda).toBe(seeded.taskPda);
      expect(out.task!.status).toBe("Open");
    } finally {
      await close();
    }
  });

  it("get_agent_track_record reads the seeded provider agent", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_agent_track_record",
        arguments: { agent: seeded.providerAgent },
      });
      const out = parseResult(result) as { source: string; agent: string };
      expect(out.source).toBe("onchain");
      expect(out.agent).toBe(seeded.providerAgent);
    } finally {
      await close();
    }
  });

  it("search matches the seeded listing by name/category text", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "code-generation", kind: "listings" },
      });
      const out = parseResult(result) as {
        listings: Array<{ pda: string }>;
        tasks: Array<{ pda: string }>;
      };
      expect(out.listings.map((l) => l.pda)).toContain(seeded.listingPda);
    } finally {
      await close();
    }
  });
});

describe("MCP server: mutation prepare tools return UNSIGNED transactions", () => {
  it("prepare_claim builds an unsigned claim instruction (keyless, no signatures)", async () => {
    const { client, close } = await connectClient({ enableMutations: true });
    try {
      const result = await client.callTool({
        name: "prepare_claim",
        arguments: {
          task: seeded.taskPda,
          worker: seeded.providerAgent,
          workerAuthority: seeded.creatorWallet,
          jobSpecHash: "07".repeat(32),
        },
      });
      const out = parseResult(result) as {
        programAddress: string;
        accounts: Array<{
          address: string;
          role: { writable: boolean; signer: boolean };
        }>;
        dataBase64: string;
        signatures: unknown[];
      };
      // It is an UNSIGNED artifact: program + account metas + data, no signatures.
      expect(out.programAddress).toBe(
        "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
      );
      expect(out.accounts.length).toBeGreaterThan(0);
      expect(out.dataBase64.length).toBeGreaterThan(0);
      expect(out.signatures).toEqual([]);
      // The worker authority appears as a signer meta (the caller signs it).
      expect(
        out.accounts.some(
          (a) => a.address === seeded.creatorWallet && a.role.signer,
        ),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("prepare_claim is unreachable in readonly mode (MethodNotFound)", async () => {
    const { client, close } = await connectClient();
    try {
      await expect(
        client.callTool({
          name: "prepare_claim",
          arguments: {
            task: seeded.taskPda,
            worker: seeded.providerAgent,
            workerAuthority: seeded.creatorWallet,
          },
        }),
      ).rejects.toThrow(/Unknown tool|MethodNotFound|-32601/i);
    } finally {
      await close();
    }
  });
});

// Local listing-field encoder (NUL-padded fixed-width), mirroring values.* but
// without importing the namespace into the test surface.
function facadeEncode(text: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  const bytes = new TextEncoder().encode(text);
  out.set(bytes.subarray(0, width));
  return out;
}
