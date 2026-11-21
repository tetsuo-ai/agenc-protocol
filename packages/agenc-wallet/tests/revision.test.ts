// The service signs marketplace transactions only for the program revision it
// was built for, as the attest service does. Reads, and plain transfers of the
// wallet's own money, keep working on any revision.
import { describe, expect, it } from "vitest";
import {
  address,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type RpcTransport,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findProtocolConfigPda,
  SURFACE_REVISION_CURRENT,
  type MarketplaceClient,
} from "@tetsuo-ai/marketplace-sdk";
import { createRpcChain, transferInstruction } from "../src/chain.js";
import {
  assertSigningRevision,
  onlyPlainTransfers,
  revisionGatedClient,
  revisionRefusal,
  SIGNING_REVISION,
} from "../src/revision.js";
import { toWalletErrorShape } from "../src/errors.js";

/** A ProtocolConfig account stamped `revision` (the u16 after the first 349 bytes). */
function stamped(revision: number): Uint8Array {
  const data = new Uint8Array(351);
  new DataView(data.buffer).setUint16(349, revision, true);
  return data;
}

const marketplaceCall: Instruction = {
  programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
  accounts: [],
  data: new Uint8Array([1, 2, 3]),
};

describe("the revision this service signs for", () => {
  it("is the SDK's current revision, 9", () => {
    expect(SIGNING_REVISION).toBe(SURFACE_REVISION_CURRENT);
    expect(SIGNING_REVISION).toBe(9);
    expect(revisionRefusal(9)).toBeNull();
  });

  it("refuses an older program, naming both revisions, and says to try again later", () => {
    const refusal = revisionRefusal(8)!;
    expect(refusal.code).toBe("NOT_AVAILABLE");
    expect(refusal.retryable).toBe(true);
    expect(refusal.message).toBe(
      "The marketplace program is still on revision 8, and this version of the service signs only for revision 9. Nothing was signed. Try again once the marketplace moves to revision 9.",
    );
    // It reaches the panel with its retry hint.
    expect(toWalletErrorShape(refusal)).toEqual({
      code: "NOT_AVAILABLE",
      message: refusal.message,
      retryable: true,
    });
    expect(revisionRefusal(0)!.message).toMatch(/does not say which revision it is on/);
    expect(revisionRefusal(0)!.retryable).toBe(true);
  });

  it("refuses a newer program as needing an update, not a retry", () => {
    const refusal = revisionRefusal(10)!;
    expect(refusal.code).toBe("NOT_AVAILABLE");
    expect(refusal.retryable).toBe(false);
    expect(refusal.message).toMatch(/is on revision 10, and this version of the service signs only for revision 9\. Nothing was signed\. Update it/);
  });

  it("never names SOL or the wallet", () => {
    for (const revision of [0, 8, 10]) {
      expect(revisionRefusal(revision)!.message).not.toMatch(/SOL|wallet/);
    }
  });
});

describe("reading the program's stamp", () => {
  it("passes revision 9 and refuses anything else, read from the program's own ProtocolConfig", async () => {
    const [config] = await findProtocolConfigPda();
    const asked: Address[] = [];
    const reader = (revision: number, owner: Address = AGENC_COORDINATION_PROGRAM_ADDRESS) =>
      async (account: Address) => {
        asked.push(account);
        return { data: stamped(revision), owner };
      };
    await expect(assertSigningRevision(reader(9))).resolves.toBeUndefined();
    expect(asked).toEqual([config]);
    await expect(assertSigningRevision(reader(8))).rejects.toMatchObject({ code: "NOT_AVAILABLE", retryable: true });
    // An account some other program owns is no stamp at all.
    await expect(
      assertSigningRevision(reader(9, address("11111111111111111111111111111111"))),
    ).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/does not say/) });
    await expect(assertSigningRevision(async () => null)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("refuses with a retryable network error when the stamp cannot be read", async () => {
    await expect(
      assertSigningRevision(async () => {
        throw new Error("connection refused");
      }),
    ).rejects.toMatchObject({ code: "NETWORK", retryable: true, message: expect.stringMatching(/nothing was signed/) });
  });
});

describe("a gated client", () => {
  function recordingClient() {
    const calls: string[] = [];
    const client = {
      signer: { address: address("11111111111111111111111111111112") },
      transport: "the transport",
      async send(instructions: readonly Instruction[]) {
        calls.push(`send:${instructions.length}`);
        return { signature: "sig" };
      },
      async createServiceListing() {
        calls.push("createServiceListing");
        return { signature: "sig" };
      },
    };
    return { client: client as unknown as MarketplaceClient, calls };
  }
  const refuse = async () => {
    throw revisionRefusal(8)!;
  };

  it("checks the stamp before every marketplace call and signs nothing when it is refused", async () => {
    const { client, calls } = recordingClient();
    const gated = revisionGatedClient(client, refuse);
    await expect(gated.send([marketplaceCall])).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(gated.createServiceListing({} as never)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    expect(calls).toEqual([]);
    // Its fields are the client's own.
    expect(gated.signer).toBe(client.signer);
    expect(gated.transport).toBe(client.transport);
  });

  it("lets a plain transfer through without asking", async () => {
    const { client, calls } = recordingClient();
    let asked = 0;
    const gated = revisionGatedClient(client, async () => {
      asked += 1;
      throw revisionRefusal(8)!;
    });
    const from = await generateKeyPairSigner();
    const transfer = transferInstruction(from, address("11111111111111111111111111111112"), 5n);
    expect(onlyPlainTransfers([transfer])).toBe(true);
    expect(onlyPlainTransfers([transfer, marketplaceCall])).toBe(false);
    expect(onlyPlainTransfers([])).toBe(false);
    await expect(gated.send([transfer])).resolves.toEqual({ signature: "sig" });
    expect(asked).toBe(0);
    expect(calls).toEqual(["send:1"]);
  });

  it("sends once the stamp says 9", async () => {
    const { client, calls } = recordingClient();
    const gated = revisionGatedClient(client, async () => undefined);
    await gated.send([marketplaceCall]);
    await gated.createServiceListing({} as never);
    expect(calls).toEqual(["send:1", "createServiceListing"]);
  });
});

describe("a real network's chain", () => {
  /** An endpoint whose ProtocolConfig is stamped `revision`; it notes every method asked. */
  async function endpoint(revision: number) {
    const [config] = await findProtocolConfigPda();
    const methods: string[] = [];
    const transport = (async (request: { payload: { id: unknown; method: string; params: unknown[] } }) => {
      const { id, method, params } = request.payload;
      methods.push(method);
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      if (method === "getAccountInfo") {
        const asked = params[0] as string;
        return reply({
          context: { slot: 1 },
          value:
            asked === config
              ? {
                  data: [Buffer.from(stamped(revision)).toString("base64"), "base64"],
                  executable: false,
                  lamports: 1_000_000,
                  owner: AGENC_COORDINATION_PROGRAM_ADDRESS,
                  rentEpoch: 0,
                  space: 351,
                }
              : null,
        });
      }
      if (method === "getBalance") return reply({ context: { slot: 1 }, value: 42 });
      // Anything else is the client starting to sign and send.
      throw new Error(`the client went on to ${method}`);
    }) as unknown as RpcTransport;
    const chain = createRpcChain({ network: "mainnet", rpcUrl: "https://rpc.example", transport, minRequestGapMs: 0 });
    return { chain, methods };
  }

  it("on revision 8 refuses every marketplace call before it builds or signs, and still reads", async () => {
    const { chain, methods } = await endpoint(8);
    const signer = await generateKeyPairSigner();
    await expect(chain.clientFor(signer).send([marketplaceCall])).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
      retryable: true,
    });
    await expect(chain.assertSigningRevision!()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(chain.sendSigned({ messageBytes: new Uint8Array(), signatures: {} } as never)).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    // Only the stamp was read: no blockhash fetched, nothing sent.
    expect(new Set(methods)).toEqual(new Set(["getAccountInfo"]));
    expect(await chain.getBalance(signer.address)).toBe(42n);
  });

  it("on revision 8 still moves the wallet's own money", async () => {
    const { chain } = await endpoint(8);
    const signer = await generateKeyPairSigner();
    // The transfer is not refused: the client goes on to build it (the fake
    // endpoint stops it there).
    await expect(
      chain.clientFor(signer).send([transferInstruction(signer, address("11111111111111111111111111111112"), 5n)]),
    ).rejects.not.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("on revision 9 goes on to send", async () => {
    const { chain, methods } = await endpoint(9);
    const signer = await generateKeyPairSigner();
    await expect(chain.assertSigningRevision!()).resolves.toBeUndefined();
    await expect(chain.clientFor(signer).send([marketplaceCall])).rejects.not.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    expect(methods.filter((method) => method !== "getAccountInfo").length).toBeGreaterThan(0);
  });
});
