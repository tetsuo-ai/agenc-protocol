import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectWallet } from "../src/client/socket-client.js";
import type { MethodResult } from "../src/client/protocol.js";
import { serveWallet } from "../src/server.js";
import { ConnectionGrants } from "../src/connection-grants.js";
import { startWorld } from "./harness.js";

function client(invitation: MethodResult<"connections.invite">) {
  const pair = generateKeyPairSync("ed25519");
  const key = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return async (method: string, params: Record<string, unknown>) => {
    const socket = connect(invitation.socket);
    const input = createInterface({ input: socket });
    const lines = input[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value!);
    const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
    try {
      const probe = randomBytes(32).toString("base64url");
      send({ probe });
      const hello = await next();
      expect(
        verify(
          null,
          Buffer.from(
            JSON.stringify(["agenc.market.broker.v1", probe, hello.challenge]),
          ),
          createPublicKey({
            key: Buffer.from(invitation.brokerKey, "base64"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(hello.proof, "base64"),
        ),
      ).toBe(true);
      const message = Buffer.from(
        JSON.stringify([
          "agenc.market.pair.v1",
          invitation.id,
          hello.challenge,
          key,
        ]),
      );
      send({
        id: invitation.id,
        key,
        code: invitation.code,
        signature: sign(null, message, pair.privateKey).toString("base64"),
      });
      const auth = await next();
      if (!auth.ok) throw new Error(auth.error);
      send({ id: 1, method, params });
      const reply = await next();
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.result;
    } finally {
      input.close();
      socket.destroy();
    }
  };
}

it("keeps project budgets, operations, subscriptions and handoffs scoped across a broker restart", async () => {
  const world = await startWorld();
  const options = {
    wallet: world.wallet,
    ownerToken: randomBytes(32).toString("hex"),
    socketPath: join(world.dataDir, "sock", "wallet.sock"),
    grantFile: join(world.dataDir, "connections.json"),
    agentExists: (id: string) => world.wallet.hasAgent(id),
    background: true,
  };
  let server = await serveWallet(options);
  let owner = await connectWallet({
    socketPath: options.socketPath,
    token: options.ownerToken,
  });
  try {
    const a = await owner.call("agents.create", { name: "Alpha" });
    const b = await owner.call("agents.create", { name: "Beta" });
    await owner.call("agents.setBudget", { agentId: a.id, perDayCents: 200 });
    const first = await owner.call("connections.invite", {
      agentId: a.id,
      project: "First",
      label: "Alpha terminal",
      access: "trade",
    });
    const second = await owner.call("connections.invite", {
      agentId: b.id,
      project: "Second",
      label: "Beta reader",
      access: "read",
    });
    const trade = client(first),
      read = client(second);
    expect(await trade("connections.info", {})).toMatchObject({
      agentId: a.id,
      project: "First",
      background: true,
    });
    expect(await read("connections.info", {})).toMatchObject({
      agentId: b.id,
      access: "read",
    });
    await expect(client(first)("connections.info", {})).rejects.toThrow(
      /expired|unavailable|again/i,
    );
    await expect(read("agents.fund", { agentId: b.id })).rejects.toThrow();
    const args = { service: world.listing, request: "Write a haiku." };
    const purchase = { name: "market_hire", args, operationId: randomUUID() };
    expect((await read("connections.tool", purchase)).ok).toBe(false);
    const placed = await trade("connections.tool", purchase);
    expect(placed.ok).toBe(true);
    const jobs = await owner.call("jobs.list", { agentId: a.id });
    expect(jobs.jobs).toHaveLength(1);
    const job = jobs.jobs[0]!;
    expect(
      (await owner.call("jobs.list", { agentId: b.id })).jobs,
    ).toHaveLength(0);
    await expect(read("handoff.status", { jobId: job.id })).rejects.toThrow();
    await owner.call("connections.handoff", {
      id: second.id,
      jobId: job.id,
      permissions: ["status"],
    });
    expect(await read("handoff.status", { jobId: job.id })).toMatchObject({
      payer: a.id,
    });
    await expect(
      read("handoff.file", { jobId: job.id, sha256: "0".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      read("handoff.propose", {
        jobId: job.id,
        action: "reject",
        note: "Changes.",
      }),
    ).rejects.toThrow();
    await read("connections.subscribe", { jobId: job.id });
    owner.close();
    await server.close();
    server = await serveWallet(options);
    owner = await connectWallet({
      socketPath: options.socketPath,
      token: options.ownerToken,
    });
    expect((await read("connections.changes", { cursor: 0 })).jobs).toEqual([
      job.id,
    ]);
    expect(
      (await trade("connections.tool", { ...purchase, lookup: true })).ok,
    ).toBe(true);
    expect((await trade("connections.tool", purchase)).ok).toBe(true);
    expect(
      (await owner.call("jobs.list", { agentId: a.id })).jobs,
    ).toHaveLength(1);
    await owner.call("connections.handoff", {
      id: second.id,
      jobId: job.id,
      permissions: [],
    });
    expect((await read("connections.changes", {})).jobs).toEqual([]);
    await expect(read("handoff.status", { jobId: job.id })).rejects.toThrow();
    await owner.call("connections.revoke", { id: second.id });
    await expect(read("connections.info", {})).rejects.toThrow();
    const audit = (await owner.call("connections.list", {})).audit;
    expect(
      audit
        .filter((row) => row.installation === second.id)
        .map((row) => row.action),
    ).toEqual(["handoff", "handoff", "revoke"]);
    expect(audit[0]).toMatchObject({
      payer: a.id,
      jobId: job.id,
      permissions: ["status"],
    });
    const expired = new ConnectionGrants(
      options.grantFile,
      "unused",
      () => Date.now() + 91 * 86400_000,
    );
    expect(() => expired.scope(first.id)).toThrow();
  } finally {
    owner.close();
    await server.close();
    await world.wallet.close();
  }
}, 45_000);
