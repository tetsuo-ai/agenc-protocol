// Disposable local-validator harness. Lifecycle accounts and stake are created
// by signed SDK transactions, never setAccount/encoder fixtures. The localnet
// bootstrap's --dev-ready ProtocolConfig genesis fixture is explicitly recorded;
// these tests are not an initialize/stamp-release ceremony rehearsal.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  devnet,
  generateKeyPairSigner,
  lamports,
  signature,
  type Address,
  type Decoder,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { expect } from "vitest";
import * as sdk from "../src/index.js";

export const RPC_ENABLED = process.env.AGENC_RPC_E2E === "1";
export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const id32 = () => new Uint8Array(randomBytes(32));

export async function localRpcHarness(label: string) {
  const env = JSON.parse(
    readFileSync(resolve(ROOT, ".localnet/env.json"), "utf8"),
  );
  const url = new URL(env.rpcUrl);
  if (
    env.cluster !== "localnet" ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "RPC regression tests require the disposable loopback localnet",
    );
  }
  // Binds the running ProgramData bytes to the local build, rather than trusting
  // a port number or merely checking that some program exists at the address.
  execFileSync(
    process.execPath,
    [resolve(ROOT, "scripts/localnet-status.mjs")],
    { cwd: ROOT, stdio: "pipe" },
  );
  // The cluster brand enables the faucet RPC type. The URL remains loopback.
  const rpc = createSolanaRpc(devnet(env.rpcUrl));
  // Broadcast even expected failures, so rejection/rollback is demonstrated by
  // confirmed transaction metadata, not just an RPC preflight simulation.
  const landedRpc = new Proxy(rpc, {
    get(target, property) {
      if (property === "sendTransaction") {
        return (...args: Parameters<typeof target.sendTransaction>) =>
          target.sendTransaction(args[0], {
            ...args[1],
            encoding: "base64",
            skipPreflight: true,
          });
      }
      return Reflect.get(target, property);
    },
  });
  const client = (signer: KeyPairSigner) =>
    sdk.createMarketplaceClient({
      signer,
      rpc: landedRpc,
      commitment: "confirmed",
    });
  const loadKey = async (file: string) =>
    createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))),
    );
  const admin = await loadKey(env.keypairs.authority);
  const moderator = await loadKey(env.keypairs.moderator);
  const [protocol] = await sdk.findProtocolConfigPda();
  const evidence: Record<string, unknown> = {
    label,
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    workingTreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim().length > 0,
    programSha256: createHash("sha256")
      .update(
        readFileSync(
          resolve(
            ROOT,
            "programs/agenc-coordination/target/deploy/agenc_coordination.so",
          ),
        ),
      )
      .digest("hex"),
    idlSha256: createHash("sha256")
      .update(
        readFileSync(
          resolve(ROOT, "artifacts/anchor/idl/agenc_coordination.json"),
        ),
      )
      .digest("hex"),
    bootstrap:
      "localnet-up --dev-ready; ProtocolConfig genesis fixture, production SBF; all agent/task/dispute/stake transitions use SDK -> RPC",
    transactions: [],
  };
  const path = resolve(ROOT, `.localnet/evidence/${label}.json`);
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        evidence,
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ) + "\n",
    );
  };
  async function info(account: Address) {
    return (
      await rpc
        .getAccountInfo(account, {
          encoding: "base64",
          commitment: "confirmed",
        })
        .send()
    ).value;
  }
  async function read<T>(account: Address, decoder: Decoder<T>) {
    const value = await info(account);
    expect(value, `${account} must exist`).not.toBeNull();
    expect(value!.owner).toBe(sdk.AGENC_COORDINATION_PROGRAM_ADDRESS);
    return decoder.decode(Buffer.from(value!.data[0], "base64"));
  }
  async function tx(sig: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await rpc
        .getTransaction(signature(sig), {
          encoding: "json",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      if (result?.meta) return result;
      await delay(250);
    }
    throw new Error(`confirmed transaction metadata missing: ${sig}`);
  }
  async function record(step: string, sig: string) {
    const result = await tx(sig);
    (evidence.transactions as unknown[]).push({
      step,
      signature: sig,
      slot: result.slot,
      meta: result.meta,
      message: result.transaction.message,
    });
    save();
    return result;
  }
  async function send(
    step: string,
    signer: KeyPairSigner,
    instructions: readonly Instruction[],
  ) {
    const result = await client(signer)
      .send(instructions)
      .catch(async (error: unknown) => {
        if (error instanceof sdk.AgencError && error.signature)
          await record(`${step} (unexpected failure)`, error.signature);
        throw error;
      });
    const landed = await record(step, result.signature);
    expect(landed.meta!.err).toBeNull();
    return landed;
  }
  async function reject(
    step: string,
    signer: KeyPairSigner,
    instructions: readonly Instruction[],
    code: number,
  ) {
    let failure: unknown;
    try {
      const unexpected = await client(signer).send(instructions);
      await record(`${step} (unexpected acceptance)`, unexpected.signature);
    } catch (error) {
      failure = error;
    }
    expect(failure, `${step} must fail on chain`).toBeInstanceOf(
      sdk.AgencError,
    );
    const error = failure as sdk.AgencError;
    expect(error.signature, error.message).not.toBeNull();
    const landed = await record(step, error.signature!);
    expect(
      error.code,
      landed.meta!.logMessages?.join("\n") ?? error.message,
    ).toBe(code);
    expect(landed.meta!.err).toMatchObject({
      InstructionError: [expect.any(BigInt), { Custom: BigInt(code) }],
    });
  }
  async function fundedSigner() {
    const signer = await generateKeyPairSigner();
    const sig = await rpc
      .requestAirdrop(signer.address, lamports(2_000_000_000n))
      .send();
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = (await rpc.getSignatureStatuses([sig]).send()).value[0];
      if (
        status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
      ) {
        expect(status.err).toBeNull();
        await record("faucet", sig);
        return signer;
      }
      await delay(250);
    }
    throw new Error("local faucet confirmation timed out");
  }
  const balance = async (account: Address) =>
    (await rpc.getBalance(account, { commitment: "confirmed" }).send()).value;
  const clock = async () => {
    const account = await info(
      address("SysvarC1ock11111111111111111111111111111111"),
    );
    return Buffer.from(account!.data[0], "base64").readBigInt64LE(32);
  };
  const config = await read(protocol, sdk.getProtocolConfigDecoder());
  evidence.disputeTimingSeconds = {
    votingPeriod: config.votingPeriod,
    maxDisputeDuration: config.maxDisputeDuration,
    grace: 120,
  };
  expect(config.authority).toBe(admin.address);
  expect(config.multisigThreshold).toBe(2);
  save();
  return {
    rpc,
    admin,
    moderator,
    protocol,
    config,
    send,
    reject,
    read,
    info,
    balance,
    clock,
    fundedSigner,
    evidence,
    finish() {
      evidence.completedAt = new Date().toISOString();
      save();
    },
  };
}
