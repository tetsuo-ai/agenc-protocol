import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";

export function repairValidatorPorts(
  value = process.env.AGENC_REPAIR_RPC_PORT ?? "19899",
) {
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65432)
    throw new Error(
      "AGENC_REPAIR_RPC_PORT must be an integer from 1024 through 65432 (104 consecutive ports required)",
    );
  const rpc = Number(value);
  return {
    rpc,
    websocket: rpc + 1,
    faucet: rpc + 2,
    gossip: rpc + 3,
    dynamicStart: rpc + 4,
    dynamicEnd: rpc + 103,
  };
}

export async function assertRepairValidatorPortFree(port, protocol = "tcp") {
  const socket = protocol === "udp" ? createSocket("udp4") : createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", (error) => {
      if (protocol === "udp") socket.close();
      reject(
        new Error(
          `Owned repair validator ${protocol.toUpperCase()} port ${port} is unavailable (${error.code}); choose a free range with AGENC_REPAIR_RPC_PORT`,
        ),
      );
    });
    const ready = () => socket.close(resolve);
    if (protocol === "udp")
      socket.bind({ port, address: "127.0.0.1", exclusive: true }, ready);
    else socket.listen({ port, host: "127.0.0.1", exclusive: true }, ready);
  });
}

export async function assertRepairValidatorAvailable(ports, run = spawnSync) {
  const version = run("solana-test-validator", ["--version"], {
    encoding: "utf8",
  });
  if (version.error || version.status !== 0)
    throw new Error(
      `solana-test-validator is missing or cannot run; install Agave tools and add them to PATH (${version.error?.code ?? `exit ${version.status}`})`,
    );
  for (let port = ports.rpc; port <= ports.dynamicEnd; port++) {
    await assertRepairValidatorPortFree(port);
    if (port >= ports.gossip) await assertRepairValidatorPortFree(port, "udp");
  }
}
