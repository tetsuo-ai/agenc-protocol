import { Buffer } from "node:buffer";
import { describe, it, expect } from "vitest";
import {
  getTool,
  MarketplaceToolError,
  type MarketplaceToolContext,
  type UnsignedInstructionView,
} from "../src/index.js";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getCreateServiceListingInstructionDataDecoder,
  getHireFromListingInstructionDataDecoder,
  getRegisterAgentInstructionDataDecoder,
} from "@tetsuo-ai/marketplace-sdk";
import {
  A_LISTING_PDA,
  A_TASK_PDA,
  A_PROVIDER,
  A_AUTHORITY,
  A_CREATOR,
} from "./fixtures.js";

// prepare-* tools build instructions purely from args; no transport needed.
const ctx: MarketplaceToolContext = { read: { async getProgramAccounts() {
  return [];
} } };

const HEX32 = "07".repeat(32);
/** A valid fixed 64-byte resultData payload (128 hex chars). */
const HEX64 = "ab".repeat(64);

function decodeDataBase64(ix: UnsignedInstructionView): Uint8Array {
  return Buffer.from(ix.dataBase64, "base64");
}

describe("prepare_create_service_listing handler", () => {
  it("returns an unsigned create listing instruction and encodes listing terms", async () => {
    const ix = (await getTool("prepare_create_service_listing")!.handler(
      {
        providerAgent: A_PROVIDER,
        authority: A_AUTHORITY,
        listingId: HEX32,
        name: "Research Summary",
        category: "research",
        tags: ["solana", "analysis"],
        specHash: HEX32,
        specUri: "agenc://job-spec/sha256/" + HEX32,
        price: "50000000",
        requiredCapabilities: "7",
        defaultDeadlineSecs: "3600",
        maxOpenJobs: 5,
        operator: A_CREATOR,
        operatorFeeBps: 250,
      },
      ctx,
    )) as UnsignedInstructionView;

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    const authority = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(authority?.role.signer).toBe(true);

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(
      decodeDataBase64(ix),
    );
    expect(Array.from(decoded.listingId)).toEqual(Array(32).fill(7));
    expect(Array.from(decoded.specHash)).toEqual(Array(32).fill(7));
    expect(decoded.specUri).toBe("agenc://job-spec/sha256/" + HEX32);
    expect(decoded.price).toBe(50_000_000n);
    expect(decoded.priceMint.__option).toBe("None");
    expect(decoded.requiredCapabilities).toBe(7n);
    expect(decoded.defaultDeadlineSecs).toBe(3600n);
    expect(decoded.maxOpenJobs).toBe(5);
    expect(decoded.operatorFeeBps).toBe(250);
    expect(decoded.operator.__option).toBe("Some");
    if (decoded.operator.__option !== "Some") throw new Error("expected operator");
    expect(decoded.operator.value).toBe(A_CREATOR);
  });

  it("rejects non-zero operatorFeeBps without an operator payee", async () => {
    await expect(
      getTool("prepare_create_service_listing")!.handler(
        {
          providerAgent: A_PROVIDER,
          authority: A_AUTHORITY,
          listingId: HEX32,
          name: "Research Summary",
          category: "research",
          tags: ["solana"],
          specHash: HEX32,
          specUri: "agenc://job-spec/sha256/" + HEX32,
          price: "50000000",
          requiredCapabilities: "7",
          defaultDeadlineSecs: "3600",
          maxOpenJobs: 5,
          operatorFeeBps: 250,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });
});

describe("prepare_hire handler", () => {
  it("returns an UNSIGNED instruction targeting the agenc program with no signatures", async () => {
    const ix = (await getTool("prepare_hire")!.handler(
      {
        listing: A_LISTING_PDA,
        buyer: A_AUTHORITY,
        creatorAgent: A_PROVIDER,
        taskId: HEX32,
        expectedPrice: "50000000",
        expectedVersion: "4",
      },
      ctx,
    )) as UnsignedInstructionView;

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // The canonical assertion: it carries NO signatures.
    expect(ix.signatures).toEqual([]);
    expect(Array.isArray(ix.accounts)).toBe(true);
    expect(ix.accounts.length).toBeGreaterThan(0);
    expect(typeof ix.dataBase64).toBe("string");
    expect(ix.dataBase64.length).toBeGreaterThan(0);

    // The buyer wallet appears as a writable signer (fee payer); a noop signer
    // carries the address but never produced a signature.
    const buyerMeta = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(buyerMeta, "buyer is an account meta").toBeDefined();
    expect(buyerMeta!.role.signer).toBe(true);
  });

  it("encodes an optional referrer leg for registered-agent hires", async () => {
    const ix = (await getTool("prepare_hire")!.handler(
      {
        listing: A_LISTING_PDA,
        buyer: A_AUTHORITY,
        creatorAgent: A_PROVIDER,
        taskId: HEX32,
        expectedPrice: "50000000",
        expectedVersion: "4",
        referrer: A_CREATOR,
        referrerFeeBps: 500,
      },
      ctx,
    )) as UnsignedInstructionView;

    const decoded = getHireFromListingInstructionDataDecoder().decode(
      decodeDataBase64(ix),
    );
    expect(decoded.referrerFeeBps).toBe(500);
    expect(decoded.referrer.__option).toBe("Some");
    if (decoded.referrer.__option !== "Some") throw new Error("expected referrer");
    expect(decoded.referrer.value).toBe(A_CREATOR);
  });

  it("rejects non-zero referrerFeeBps without a referrer payee", async () => {
    await expect(
      getTool("prepare_hire")!.handler(
        {
          listing: A_LISTING_PDA,
          buyer: A_AUTHORITY,
          creatorAgent: A_PROVIDER,
          taskId: HEX32,
          expectedPrice: "1",
          expectedVersion: "1",
          referrerFeeBps: 500,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });

  it("rejects a taskId that is not 64 hex chars", async () => {
    await expect(
      getTool("prepare_hire")!.handler(
        {
          listing: A_LISTING_PDA,
          buyer: A_AUTHORITY,
          creatorAgent: A_PROVIDER,
          taskId: "deadbeef", // too short
          expectedPrice: "1",
          expectedVersion: "1",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });
});

describe("prepare_hire_humanless handler", () => {
  it("returns an unsigned humanless hire instruction and exposes the buyer signer meta", async () => {
    const ix = (await getTool("prepare_hire_humanless")!.handler(
      {
        listing: A_LISTING_PDA,
        buyer: A_AUTHORITY,
        taskId: HEX32,
        expectedPrice: "50000000",
        expectedVersion: "4",
      },
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    const buyer = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(buyer?.role.signer).toBe(true);
  });

  it("rejects non-zero referrerFeeBps without a referrer payee", async () => {
    await expect(
      getTool("prepare_hire_humanless")!.handler(
        {
          listing: A_LISTING_PDA,
          buyer: A_AUTHORITY,
          taskId: HEX32,
          expectedPrice: "50000000",
          expectedVersion: "4",
          referrerFeeBps: 500,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });
});

describe("prepare_set_task_job_spec handler", () => {
  it("returns an unsigned activation instruction", async () => {
    const ix = (await getTool("prepare_set_task_job_spec")!.handler(
      {
        task: A_TASK_PDA,
        creator: A_AUTHORITY,
        jobSpecHash: HEX32,
        jobSpecUri: "agenc://job-spec/sha256/test",
      },
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    const creator = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(creator?.role.signer).toBe(true);
  });
});

describe("prepare_claim handler", () => {
  it("returns an unsigned claim instruction with no signatures", async () => {
    const ix = (await getTool("prepare_claim")!.handler(
      {
        task: A_TASK_PDA,
        claim: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
      },
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    const auth = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(auth!.role.signer).toBe(true);
  });
});

describe("review/cleanup/rating prepare handlers", () => {
  it.each([
    [
      "prepare_accept_task_result",
      {
        task: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
        treasury: A_AUTHORITY,
        creator: A_AUTHORITY,
      },
    ],
    [
      "prepare_reject_task_result",
      {
        task: A_TASK_PDA,
        claim: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
        creator: A_AUTHORITY,
        rejectionHash: HEX32,
      },
    ],
    [
      "prepare_auto_accept_task_result",
      {
        task: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
        treasury: A_AUTHORITY,
        creator: A_AUTHORITY,
        authority: A_AUTHORITY,
      },
    ],
    ["prepare_cancel_task", { task: A_TASK_PDA, authority: A_AUTHORITY }],
    ["prepare_close_task", { task: A_TASK_PDA, authority: A_AUTHORITY }],
    [
      "prepare_rate_hire",
      { task: A_TASK_PDA, listing: A_LISTING_PDA, buyer: A_AUTHORITY, score: 5 },
    ],
  ])("%s returns an unsigned instruction", async (toolName, args) => {
    const ix = (await getTool(toolName)!.handler(
      args as never,
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    expect(ix.dataBase64.length).toBeGreaterThan(0);
  });
});

describe("prepare_submit handler", () => {
  it("returns an unsigned submit instruction with no signatures (no resultData)", async () => {
    const ix = (await getTool("prepare_submit")!.handler(
      {
        task: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
        proofHash: HEX32,
      },
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.signatures).toEqual([]);
    expect(ix.dataBase64.length).toBeGreaterThan(0);
  });

  it("accepts a full fixed 64-byte resultData hex", async () => {
    const ix = (await getTool("prepare_submit")!.handler(
      {
        task: A_TASK_PDA,
        worker: A_PROVIDER,
        workerAuthority: A_AUTHORITY,
        proofHash: HEX32,
        resultData: HEX64,
      },
      ctx,
    )) as UnsignedInstructionView;
    expect(ix.signatures).toEqual([]);
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
  });

  it("rejects an odd-length resultData hex", async () => {
    await expect(
      getTool("prepare_submit")!.handler(
        {
          task: A_TASK_PDA,
          worker: A_PROVIDER,
          workerAuthority: A_AUTHORITY,
          proofHash: HEX32,
          resultData: "abc", // odd length
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });

  // REVERT-SENSITIVE (finding #2): a SHORT resultData must throw, not be
  // silently zero-padded to 64 bytes. Pre-fix, `hexToBytes("cafe")` returned a
  // 2-byte array and `fixEncoderSize(..., 64)` zero-padded it to 64 bytes, so
  // the worker committed 62 trailing zero bytes it never supplied — and this
  // built a tx instead of throwing.
  it("rejects a too-short resultData (would be silently zero-padded) with BAD_RESULTDATA_LEN", async () => {
    const err = await getTool("prepare_submit")!
      .handler(
        {
          task: A_TASK_PDA,
          worker: A_PROVIDER,
          workerAuthority: A_AUTHORITY,
          proofHash: HEX32,
          resultData: "cafe", // 2 bytes — short of the fixed 64
        },
        ctx,
      )
      .then(
        () => {
          throw new Error("expected a throw, got a built instruction");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MarketplaceToolError);
    expect((err as MarketplaceToolError).code).toBe("BAD_RESULTDATA_LEN");
  });

  // REVERT-SENSITIVE (finding #2): a LONG resultData must throw, not be silently
  // truncated to the first 64 bytes. Pre-fix, a 100-byte input was sliced to 64
  // by `fixEncoderSize` and still built a (wrong) tx.
  it("rejects a too-long resultData (would be silently truncated) with BAD_RESULTDATA_LEN", async () => {
    const err = await getTool("prepare_submit")!
      .handler(
        {
          task: A_TASK_PDA,
          worker: A_PROVIDER,
          workerAuthority: A_AUTHORITY,
          proofHash: HEX32,
          resultData: "ab".repeat(100), // 100 bytes — over the fixed 64
        },
        ctx,
      )
      .then(
        () => {
          throw new Error("expected a throw, got a built instruction");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MarketplaceToolError);
    expect((err as MarketplaceToolError).code).toBe("BAD_RESULTDATA_LEN");
  });
});

describe("prepare_register_agent handler", () => {
  it("returns an unsigned register_agent instruction and encodes the agent fields", async () => {
    const ix = (await getTool("prepare_register_agent")!.handler(
      {
        authority: A_AUTHORITY,
        agentId: HEX32,
        capabilities: "7",
        endpoint: "http://agent.test",
        stakeAmount: "1000000",
      },
      ctx,
    )) as UnsignedInstructionView;

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // The canonical assertion: an UNSIGNED artifact — no signatures.
    expect(ix.signatures).toEqual([]);
    // The authority wallet appears as a signer meta (the caller signs it).
    const authority = ix.accounts.find((a) => a.address === A_AUTHORITY);
    expect(authority, "authority is an account meta").toBeDefined();
    expect(authority!.role.signer).toBe(true);

    const decoded = getRegisterAgentInstructionDataDecoder().decode(
      decodeDataBase64(ix),
    );
    expect(Array.from(decoded.agentId)).toEqual(Array(32).fill(7));
    expect(decoded.capabilities).toBe(7n);
    expect(decoded.endpoint).toBe("http://agent.test");
    expect(decoded.stakeAmount).toBe(1_000_000n);
    // metadataUri omitted -> None (never silently defaulted to a value).
    expect(decoded.metadataUri.__option).toBe("None");
  });

  it("encodes an optional metadataUri and defaults stakeAmount to zero when omitted", async () => {
    const ix = (await getTool("prepare_register_agent")!.handler(
      {
        authority: A_AUTHORITY,
        agentId: HEX32,
        capabilities: "1",
        endpoint: "http://agent.test",
        metadataUri: "agenc://agent-card/sha256/test",
      },
      ctx,
    )) as UnsignedInstructionView;

    const decoded = getRegisterAgentInstructionDataDecoder().decode(
      decodeDataBase64(ix),
    );
    expect(decoded.stakeAmount).toBe(0n);
    expect(decoded.metadataUri.__option).toBe("Some");
    if (decoded.metadataUri.__option !== "Some") throw new Error("expected metadataUri");
    expect(decoded.metadataUri.value).toBe("agenc://agent-card/sha256/test");
  });

  it("rejects an agentId that is not 64 hex chars", async () => {
    await expect(
      getTool("prepare_register_agent")!.handler(
        {
          authority: A_AUTHORITY,
          agentId: "deadbeef", // too short
          capabilities: "1",
          endpoint: "http://agent.test",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });

  it("rejects a zero capabilities bitmask up-front (fixed on-chain invariant)", async () => {
    // register_agent.rs: require!(capabilities != 0, InvalidCapabilities).
    // capabilities == 0 is never valid under any config, so the prepare tool
    // must reject it client-side instead of returning a doomed instruction.
    // REVERT PROOF: delete the `capabilities === 0n` guard in the handler and
    // this test goes red (the tool builds and returns an instruction instead).
    const err = await getTool("prepare_register_agent")!
      .handler(
        {
          authority: A_AUTHORITY,
          agentId: HEX32,
          capabilities: "0",
          endpoint: "http://agent.test",
        },
        ctx,
      )
      .then(
        () => {
          throw new Error("expected a throw, got a built instruction");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MarketplaceToolError);
    expect((err as MarketplaceToolError).code).toBe("INVALID_CAPABILITIES");
  });
});
