// Real local RPC -> separate watchdog process -> real HTTP receiver. No RPC mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LOADER } from "./watchdog-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enabled = process.env.AGENC_RPC_E2E === "1";
async function until(predicate, message, timeout = 20000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

test(
  "upgrade watchdog: real buffer/write/top-up/authority/upgrade, pager failure/restart and HTTP catch-up",
  {
    skip: !enabled,
    timeout: 240_000,
  },
  async () => {
    const env = JSON.parse(readFileSync(join(root, ".localnet/env.json")));
    const endpoint = new URL(env.rpcUrl);
    assert.equal(env.cluster, "localnet");
    assert.equal(endpoint.protocol, "http:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
    execFileSync(
      process.execPath,
      [join(root, "scripts/localnet-status.mjs")],
      { cwd: root, stdio: "pipe" },
    );
    const connection = new Connection(env.rpcUrl, "confirmed");
    const payer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(env.keypairs.authority))),
    );
    const program = new PublicKey(env.programId);
    const [programData] = PublicKey.findProgramAddressSync(
      [program.toBuffer()],
      LOADER,
    );
    const vault = Keypair.generate(),
      buffer = Keypair.generate(),
      rotated = Keypair.generate();
    const directory = join(root, ".localnet", `watchdog-drill-${Date.now()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const evidence = {
      label: "issue-280-watchdog",
      startedAt: new Date().toISOString(),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTreeDirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0,
      programSha256: sha(
        readFileSync(
          join(
            root,
            "programs/agenc-coordination/target/deploy/agenc_coordination.so",
          ),
        ),
      ),
      transactions: [],
      receipts: [],
    };
    const evidenceFile = join(
      root,
      ".localnet/evidence/issue-280-watchdog.json",
    );
    mkdirSync(dirname(evidenceFile), { recursive: true });
    const save = () =>
      writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
    async function send(step, instructions, signers = [payer]) {
      const submittedAt = new Date().toISOString();
      const signature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...instructions),
        signers,
        { commitment: "confirmed" },
      );
      let landed;
      await until(async () => {
        landed = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        return landed;
      }, "transaction metadata missing");
      assert.equal(landed.meta.err, null);
      evidence.transactions.push({
        step,
        submittedAt,
        signature,
        slot: landed.slot,
        meta: landed.meta,
      });
      save();
      return landed;
    }
    const loaderIx = (number, keys, suffix = Buffer.alloc(0)) => {
      const tag = Buffer.alloc(4);
      tag.writeUInt32LE(number);
      return new TransactionInstruction({
        programId: LOADER,
        keys,
        data: Buffer.concat([tag, suffix]),
      });
    };
    const setAuthority = (from, to) =>
      loaderIx(4, [
        { pubkey: programData, isWritable: true, isSigner: false },
        { pubkey: from.publicKey, isWritable: false, isSigner: true },
        { pubkey: to.publicKey, isWritable: false, isSigner: false },
      ]);
    await send("fund dedicated local vault", [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: vault.publicKey,
        lamports: 2_000_000,
      }),
    ]);
    const settings = {
      programId: env.programId,
      genesisHash: await connection.getGenesisHash(),
      expectedUpgradeAuthority: payer.publicKey.toBase58(),
      vaultAddress: vault.publicKey.toBase58(),
      bufferAuthorities: [payer.publicKey.toBase58()],
      squads: null,
      pollIntervalMs: 500,
      discoveryIntervalMs: 1000,
      staleAfterMs: 15000,
      vaultTopUpLamports: "100000",
      vaultOutflowLamports: "100000",
    };
    const settingsFile = join(directory, "settings.json"),
      baselineFile = join(directory, "baseline.json");
    writeFileSync(settingsFile, JSON.stringify(settings));
    const childEnv = { ...process.env, AGENC_WATCHDOG_RPC_URL: env.rpcUrl };
    await run(
      process.execPath,
      [
        join(root, "scripts/upgrade-watchdog.mjs"),
        "capture",
        "--settings",
        settingsFile,
        "--out",
        baselineFile,
      ],
      { cwd: root, env: childEnv },
    );
    const baseline = JSON.parse(readFileSync(baselineFile));
    evidence.baseline = baseline;
    save();
    let rejectPager = false;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const event = JSON.parse(body);
      assert.equal(req.headers["idempotency-key"], event.id);
      if (!rejectPager) {
        evidence.receipts.push({ receivedAt: new Date().toISOString(), event });
        save();
      }
      res.writeHead(rejectPager ? 503 : 204);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    childEnv.AGENC_WATCHDOG_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/alerts`;
    const stateDirectory = join(directory, "state");
    let child = null,
      authorityRotated = false;
    function start(pollingOnly = false) {
      child = spawn(
        process.execPath,
        [
          join(root, "scripts/upgrade-watchdog.mjs"),
          "watch",
          "--baseline",
          baselineFile,
          "--state-dir",
          stateDirectory,
          ...(pollingOnly ? ["--polling-only", "true"] : []),
        ],
        { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
    }
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const stopping = child;
      const stopped = new Promise((resolve) => stopping.once("exit", resolve));
      stopping.kill("SIGTERM");
      await Promise.race([
        stopped,
        delay(15000, undefined, { ref: false }).then(() => {
          if (stopping.exitCode === null && stopping.signalCode === null)
            stopping.kill("SIGKILL");
        }),
      ]);
      await stopped;
    }
    const event = (type, predicate = () => true) =>
      evidence.receipts.find(
        (r) => r.event.type === type && predicate(r.event),
      );
    try {
      start();
      await until(
        () => event("monitor-healthy"),
        "watchdog did not become healthy",
      );
      rejectPager = true;
      await send(
        "initialize real loader Buffer",
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: buffer.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(101),
            space: 101,
            programId: LOADER,
          }),
          loaderIx(0, [
            { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          ]),
        ],
        [payer, buffer],
      );
      let pendingEvent;
      await until(() => {
        for (const name of readdirSync(join(stateDirectory, "outbox"))) {
          if (!name.endsWith(".json")) continue;
          const candidate = JSON.parse(
            readFileSync(join(stateDirectory, "outbox", name)),
          );
          if (
            candidate.type === "buffer-discovered" &&
            candidate.address === buffer.publicKey.toBase58()
          )
            pendingEvent = candidate;
        }
        return pendingEvent;
      }, "buffer alert was not durably queued while pager failed");
      await stop();
      rejectPager = false;
      start();
      await until(
        () => evidence.receipts.some((r) => r.event.id === pendingEvent.id),
        "queued alert was lost across restart",
      );
      const suffix = Buffer.alloc(4 + 8 + 4);
      suffix.writeUInt32LE(0);
      suffix.writeBigUInt64LE(4n, 4);
      suffix.set([1, 3, 3, 7], 12);
      await send("write real buffer payload", [
        loaderIx(
          1,
          [
            { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          ],
          suffix,
        ),
      ]);
      await until(
        () =>
          event(
            "buffer-changed",
            (e) =>
              e.address === buffer.publicKey.toBase58() &&
              e.current.payloadSha256 !== pendingEvent.current.payloadSha256,
          ),
        "buffer write was missed",
      );
      await send("top up watched vault", [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: vault.publicKey,
          lamports: 200_000,
        }),
      ]);
      await until(
        () => event("vault-changed", (e) => e.deltaLamports === "200000"),
        "vault top-up was missed",
      );
      await send("rotate local upgrade authority", [
        setAuthority(payer, rotated),
      ]);
      authorityRotated = true;
      await until(
        () =>
          event(
            "program-data-changed",
            (e) => e.current.upgradeAuthority === rotated.publicKey.toBase58(),
          ),
        "authority rotation was missed",
      );
      await send(
        "restore local upgrade authority",
        [setAuthority(rotated, payer)],
        [payer, rotated],
      );
      authorityRotated = false;
      await until(
        () =>
          event(
            "program-data-changed",
            (e) => e.current.upgradeAuthority === payer.publicKey.toBase58(),
          ),
        "authority restoration was missed",
      );
      // Upgrade only this owned local program to the same reviewed binary; no release ceremony.
      const deployBuffer = Keypair.generate();
      const deployBufferFile = join(directory, "deploy-buffer-keypair.json");
      writeFileSync(
        deployBufferFile,
        JSON.stringify([...deployBuffer.secretKey]),
        { mode: 0o600 },
      );
      const result = await run(
        "solana",
        [
          "program",
          "deploy",
          join(
            root,
            "programs/agenc-coordination/target/deploy/agenc_coordination.so",
          ),
          "--program-id",
          env.programId,
          "--upgrade-authority",
          env.keypairs.authority,
          "--keypair",
          env.keypairs.authority,
          "--buffer",
          deployBufferFile,
          "--url",
          env.rpcUrl,
          "--no-auto-extend",
          "--use-rpc",
          "--output",
          "json",
        ],
        { cwd: root, timeout: 120000, maxBuffer: 2_000_000 },
      );
      const deployment = JSON.parse(result.stdout);
      evidence.deployment = deployment;
      const original = baseline.accounts.find(
        (a) => a.kind === "program-data",
      ).view;
      await until(
        () =>
          event(
            "program-data-changed",
            (e) =>
              e.current.deployedSlot !== original.deployedSlot &&
              e.current.upgradeAuthority === payer.publicKey.toBase58(),
          ),
        "actual deployment slot mutation was missed",
      );
      const upgradeEvent = event(
        "program-data-changed",
        (e) => e.current.deployedSlot !== original.deployedSlot,
      );
      assert.equal(
        upgradeEvent.event.current.allocatedPayloadSha256,
        original.allocatedPayloadSha256,
      );
      assert.equal(
        (await connection.getAccountInfo(programData)).owner.toBase58(),
        LOADER.toBase58(),
      );
      // Explicit HTTP-only rehearsal proves catch-up without working subscriptions.
      await stop();
      start(true);
      await send(
        "vault outflow during subscription outage",
        [
          SystemProgram.transfer({
            fromPubkey: vault.publicKey,
            toPubkey: payer.publicKey,
            lamports: 300_000,
          }),
        ],
        [payer, vault],
      );
      await until(
        () =>
          event(
            "vault-changed",
            (e) => e.source === "poll" && BigInt(e.deltaLamports) < 0n,
          ),
        "HTTP reconciliation missed vault outflow",
      );
      evidence.assertions = {
        realBufferCreationAndWrite: true,
        actualProgramDataSlotChange: true,
        authorityRotationAndRestoration: true,
        vaultTopUpAndOutflow: true,
        alertRetryAfterProcessRestart: true,
        httpFallback: true,
        squadsScope:
          "parser/namespace unit tests only; no local Squads deployment or operator ceremony claimed",
      };
      evidence.completedAt = new Date().toISOString();
      save();
    } finally {
      if (authorityRotated)
        await send(
          "restore authority in cleanup",
          [setAuthority(rotated, payer)],
          [payer, rotated],
        );
      await stop();
      await new Promise((resolve) => server.close(resolve));
      save();
    }
  },
);
