import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  anchor,
  web3,
  idl,
  historicalFixture,
} from "./test-fixtures/dispute-counter-repair.mjs";
import {
  PROGRAM_ID,
  MAINNET_GENESIS,
  scanDisputes,
  decodeAgentBinding,
} from "./preflight-dispute-scan.mjs";
import {
  runPreparePhase,
  runRepairPhase,
  repairReceiptPda,
} from "./mainnet-repair-dispute-counter.mjs";

import {
  repairValidatorPorts,
  assertRepairValidatorAvailable,
} from "./test-fixtures/repair-validator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Connection, PublicKey, SystemProgram } = web3;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test(
  "local RPC: historical 1/1 deficit, prepare, atomic repair, receipt and clean scanner",
  { skip: process.env.AGENC_RPC_E2E !== "1", timeout: 180_000 },
  async () => {
    const ports = repairValidatorPorts();
    await assertRepairValidatorAvailable(ports);
    const rpcUrl = `http://127.0.0.1:${ports.rpc}`;
    const f = await historicalFixture();
    assert.equal(
      decodeAgentBinding(f.healthyAgentData).pendingInitiatorOutcomes,
      2,
    );
    assert.equal(
      decodeAgentBinding(f.deficientAgentData).pendingInitiatorOutcomes,
      1,
    );
    const differingBytes = [...f.healthyAgentData.keys()].filter(
      (i) => f.healthyAgentData[i] !== f.deficientAgentData[i],
    );
    assert.deepEqual(differingBytes, [160, 177]);
    const directory = path.join(ROOT, ".repair-counter-e2e");
    mkdirSync(directory, { recursive: true });
    const binaryPath = path.join(
      ROOT,
      "programs/agenc-coordination/target/deploy/agenc_coordination.so",
    );
    const binary = readFileSync(binaryPath);
    const configPath = path.join(directory, "validator-config.yml");
    writeFileSync(
      configPath,
      `json_rpc_url: ${rpcUrl}\nwebsocket_url: ''\nkeypair_path: ${path.join(directory, "unused-keypair.json")}\ncommitment: confirmed\n`,
    );
    const args = [
      "--config",
      configPath,
      "--mint",
      f.authority.publicKey.toBase58(),
      "--reset",
      "--ledger",
      path.join(directory, "ledger"),
      "--bind-address",
      "127.0.0.1",
      "--rpc-port",
      String(ports.rpc),
      "--faucet-port",
      String(ports.faucet),
      "--gossip-port",
      String(ports.gossip),
      "--dynamic-port-range",
      `${ports.dynamicStart}-${ports.dynamicEnd}`,
      "--limit-ledger-size",
      "5000",
      // The reviewed build is SBF v0. Match the repo localnet legacy-loader drill.
      "--deactivate-feature",
      "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g",
      "--upgradeable-program",
      PROGRAM_ID.toBase58(),
      binaryPath,
      f.authority.publicKey.toBase58(),
    ];
    const fixtures = [
      ...f.accounts.map((a) => ({ ...a, owner: PROGRAM_ID })),
      ...[
        f.authority.publicKey,
        f.cosigner.publicKey,
        f.workerWallet,
        f.creator,
        f.treasury,
      ].map((pubkey) => ({
        pubkey,
        owner: SystemProgram.programId,
        data: Buffer.alloc(0),
        lamports: 10_000_000_000,
      })),
    ];
    for (const [i, account] of fixtures.entries()) {
      const fixturePath = path.join(directory, `account-${i}.json`);
      writeFileSync(
        fixturePath,
        JSON.stringify({
          pubkey: String(account.pubkey),
          account: {
            lamports: account.lamports,
            data: [account.data.toString("base64"), "base64"],
            owner: String(account.owner),
            executable: false,
            rentEpoch: 0,
          },
        }),
      );
      args.push("--account", String(account.pubkey), fixturePath);
    }
    const logFd = openSync(path.join(directory, "validator.log"), "w");
    const child = spawn("solana-test-validator", args, {
      cwd: ROOT,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const connection = new Connection(rpcUrl, "confirmed");
    try {
      let genesis;
      for (let i = 0; i < 90; i++) {
        if (spawnError)
          throw new Error(
            `Cannot start solana-test-validator: ${spawnError.message}`,
          );
        if (child.exitCode !== null)
          throw new Error(
            `validator exited ${child.exitCode}: ${readFileSync(path.join(directory, "validator.log"), "utf8").slice(-4000)}`,
          );
        try {
          genesis = await connection.getGenesisHash();
          break;
        } catch {
          await delay(500);
        }
      }
      assert.ok(genesis, "validator starts within 45 seconds");
      assert.notEqual(genesis, MAINNET_GENESIS);
      for (
        let i = 0;
        i < 40 && (await connection.getSlot("confirmed")) < 2;
        i++
      )
        await delay(250);
      assert.ok(
        (await connection.getSlot("confirmed")) >= 2,
        "validator has advanced past genesis",
      );
      const [programData] = PublicKey.findProgramAddressSync(
        [PROGRAM_ID.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      );
      const guard = async () => {
        assert.equal(await connection.getGenesisHash(), genesis);
        const account = await connection.getAccountInfo(
          programData,
          "confirmed",
        );
        assert.ok(
          account.data.subarray(45, 45 + binary.length).equals(binary),
          "local executable matches the fresh SBF exactly",
        );
        assert.ok(
          account.data.subarray(45 + binary.length).every((byte) => byte === 0),
        );
        return { contextSlot: 0 };
      };
      const program = new anchor.Program(
        idl,
        new anchor.AnchorProvider(connection, new anchor.Wallet(f.authority), {
          commitment: "confirmed",
        }),
      );
      // Inject only the scanner genesis read. All account reads and decoders are real RPC.
      const scan = async () => {
        await guard();
        const scannerConnection = new Proxy(connection, {
          get(target, property) {
            if (property === "getGenesisHash")
              return async () => MAINNET_GENESIS;
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return scanDisputes(scannerConnection);
      };
      const logs = [];
      const common = {
        connection,
        program,
        record: f.record,
        guard,
        log: (line) => logs.push(line),
      };
      const initial = await scan();
      assert.equal(initial.statusCounts.active, 2);
      assert.equal(
        initial.initiatorCounterDeficits[0].unfinalizedTrackedDisputes,
        2,
      );
      assert.equal(
        initial.initiatorCounterDeficits[0].pendingInitiatorOutcomes,
        1,
      );
      const planned = await runPreparePhase({ ...common, payer: f.authority });
      assert.equal(planned.results.length, 2);
      assert.ok(planned.results.every((r) => r.signature === null));
      assert.equal(
        (await scan()).statusCounts.active,
        2,
        "PLAN does not mutate",
      );
      const prepared = await runPreparePhase({
        ...common,
        payer: f.authority,
        execute: true,
      });
      assert.equal(prepared.results.length, 3);
      assert.ok(prepared.results.every((r) => r.signature));
      const cutover = await scan();
      assert.equal(cutover.statusCounts.active, 0);
      assert.equal(cutover.blockers.length, 2);
      assert.equal(
        cutover.initiatorCounterDeficits[0].pendingInitiatorOutcomes,
        0,
      );
      assert.equal(
        cutover.initiatorCounterDeficits[0].unfinalizedTrackedDisputes,
        1,
      );
      const repairPlan = await runRepairPhase({
        ...common,
        authority: f.authority,
        cosigners: [f.cosigner],
        scan,
      });
      assert.equal(repairPlan.signature, null);
      assert.equal(
        await connection.getAccountInfo(
          repairReceiptPda(f.record.incident.dispute),
        ),
        null,
      );
      const repaired = await runRepairPhase({
        ...common,
        authority: f.authority,
        cosigners: [f.cosigner],
        execute: true,
        scan,
      });
      assert.ok(repaired.signature);
      assert.equal(repaired.receipt.initiatorUnitsRestored, 1);
      assert.equal(repaired.state.agent.pendingInitiatorOutcomes, 0);
      assert.equal(repaired.state.agent.disputesAsDefendant, 0);
      assert.ok(repaired.state.disputes.every((d) => d.initiatorSlashApplied));
      assert.equal(repaired.scan.blockers.length, 0);
      assert.equal(repaired.scan.statusCounts.active, 0);
      await assert.rejects(
        runRepairPhase({
          ...common,
          authority: f.authority,
          cosigners: [f.cosigner],
          execute: true,
          scan,
        }),
        /exactly one unfinalized/,
      );
      writeFileSync(
        path.join(directory, "proof.json"),
        JSON.stringify(
          {
            genesis,
            program: String(PROGRAM_ID),
            binarySha256: sha(binary),
            fixtureAccounts: fixtures.length,
            historicalOverrideOffsets: differingBytes,
            preparePlanSimulations: planned.results.length,
            prepareTransactions: prepared.results.map((r) => r.signature),
            atomicRepairSignature: repaired.signature,
            receipt: String(repairReceiptPda(f.record.incident.dispute)),
            counters: [0, 0],
            active: 0,
            blockers: 0,
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(directory, "reviews.log"),
        logs.join("\n") + "\n",
      );
      console.log(
        "RPC PROOF: 15 genesis fixtures; 2 overwritten counter bytes; 2 prepare PLAN simulations; 3 prepare transactions; 1 repair PLAN simulation; 1 atomic repair transaction; counters=0/0; Active=0; blockers=0; replay refused.",
      );
    } finally {
      // Drain confirmation subscriptions before stopping the disposable validator.
      connection._rpcWebSocket.setAutoReconnect(false);
      connection._rpcWebSocket.close(1000);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), delay(5_000)]);
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      }
    }
  },
);
