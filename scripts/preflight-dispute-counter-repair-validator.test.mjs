import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import {
  repairValidatorPorts,
  assertRepairValidatorAvailable,
  assertRepairValidatorPortFree,
} from "./test-fixtures/repair-validator.mjs";

test("repair validator derives all ports from a validated base", () => {
  assert.deepEqual(repairValidatorPorts("21000"), {
    rpc: 21000,
    websocket: 21001,
    faucet: 21002,
    gossip: 21003,
    dynamicStart: 21004,
    dynamicEnd: 21103,
  });
  assert.equal(repairValidatorPorts("65432").dynamicEnd, 65535);
  for (const value of [
    "",
    "0",
    "1023",
    "65433",
    "65536",
    "21000.5",
    "1e4",
    "-1",
    "oops",
  ])
    assert.throws(() => repairValidatorPorts(value), /AGENC_REPAIR_RPC_PORT/);
});

test("repair validator reports missing or broken Agave tools before port checks", async () => {
  for (const result of [{ error: { code: "ENOENT" } }, { status: 1 }])
    await assert.rejects(
      assertRepairValidatorAvailable(
        repairValidatorPorts("21000"),
        () => result,
      ),
      /solana-test-validator is missing or cannot run/,
    );
});

for (const protocol of ["tcp", "udp"]) {
  test(`repair validator refuses a busy ${protocol.toUpperCase()} port with an actionable error`, async () => {
    const socket = protocol === "tcp" ? createServer() : createSocket("udp4");
    if (protocol === "tcp") socket.listen(0, "127.0.0.1");
    else socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    try {
      await assert.rejects(
        assertRepairValidatorPortFree(port, protocol),
        /port .* is unavailable \(EADDRINUSE\).*AGENC_REPAIR_RPC_PORT/,
      );
    } finally {
      await new Promise((resolve) => socket.close(resolve));
    }
    await assertRepairValidatorPortFree(port, protocol);
  });
}
