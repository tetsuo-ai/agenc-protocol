import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AlertOutbox } from "./watchdog-core.mjs";
import { captureBaseline, watch } from "./upgrade-watchdog.mjs";
import { decodeProtocolControls } from "./protocol-config-monitor.mjs";
import {
  reviewFreshAdminTransaction,
  assertReviewedAdminTransaction,
} from "./admin-signing-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  Connection,
  Keypair,
  NonceAccount,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  TransactionExpiredNonceInvalidError,
} = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(label);
}

test(
  "#281: fresh signing guard, nonce revocation and config/treasury alerts over real local RPC",
  {
    skip: process.env.AGENC_RPC_E2E !== "1",
    timeout: 180000,
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
    const load = (name) =>
      Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(env.keypairs[name]))),
      );
    const payer = load("authority"),
      moderator = load("moderator"),
      seeder = load("seeder");
    const treasury = Keypair.generate(),
      vault = Keypair.generate(),
      nonce = Keypair.generate(),
      agent = Keypair.generate();
    const connection = new Connection(env.rpcUrl, "confirmed");
    const programId = new PublicKey(env.programId);
    const [protocol] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      programId,
    );
    const original = decodeProtocolControls(
      (await connection.getAccountInfo(protocol)).data,
    );
    assert.equal(original.treasury, payer.publicKey.toBase58());
    const ownerMetas = [payer, moderator].map((owner) => ({
      pubkey: owner.publicKey,
      isSigner: true,
      isWritable: false,
    }));
    const program = new anchor.Program(
      JSON.parse(
        readFileSync(
          join(root, "artifacts/anchor/idl/agenc_coordination.json"),
        ),
      ),
      new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
        commitment: "confirmed",
      }),
    );
    const treasuryIx = (next) =>
      program.methods
        .updateTreasury()
        .accountsStrict({
          protocolConfig: protocol,
          newTreasury: next.publicKey,
          authority: payer.publicKey,
        })
        .remainingAccounts(ownerMetas)
        .instruction();
    const launchIx = (paused) =>
      program.methods
        .updateLaunchControls(paused, 0xff, 0xffff)
        .accountsStrict({
          protocolConfig: protocol,
          authority: payer.publicKey,
        })
        .remainingAccounts(ownerMetas)
        .instruction();
    const ownersIx = (owners) =>
      program.methods
        .updateMultisig(
          original.multisig_threshold,
          owners.map((owner) => owner.publicKey),
        )
        .accountsStrict({
          protocolConfig: protocol,
          authority: payer.publicKey,
        })
        .remainingAccounts(ownerMetas)
        .instruction();
    const directory = join(
      root,
      ".localnet",
      `admin-monitor-drill-${Date.now()}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const evidence = {
      label: "issue-281-admin-signing-monitor",
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
      programSha256: createHash("sha256")
        .update(
          readFileSync(
            join(
              root,
              "programs/agenc-coordination/target/deploy/agenc_coordination.so",
            ),
          ),
        )
        .digest("hex"),
      transactions: [],
      receipts: [],
      reviews: [],
    };
    const evidenceFile = join(
      root,
      ".localnet/evidence/issue-281-admin-signing-monitor.json",
    );
    mkdirSync(dirname(evidenceFile), { recursive: true });
    const save = () =>
      writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
    async function record(step, signature) {
      let landed;
      await until(async () => {
        landed = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        return landed;
      }, "confirmed metadata missing");
      assert.equal(landed.meta.err, null);
      evidence.transactions.push({
        step,
        signature,
        slot: landed.slot,
        meta: landed.meta,
      });
      save();
      return landed;
    }
    async function send(step, instructions, signers = [payer]) {
      const sig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...instructions),
        signers,
        { commitment: "confirmed" },
      );
      return record(step, sig);
    }
    async function signedAdmin(step, instruction, extra = []) {
      const signers = [payer, moderator, ...extra].filter(
        (s, i, all) =>
          all.findIndex((other) => other.publicKey.equals(s.publicKey)) === i,
      );
      const latest = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({
        feePayer: payer.publicKey,
        ...latest,
      }).add(instruction);
      const signerPublicKeys = signers.map((s) => s.publicKey);
      const review = await reviewFreshAdminTransaction({
        connection,
        transaction,
        latest,
        signerPublicKeys,
      });
      assert.ok(transaction.signatures.every((s) => s.signature === null));
      evidence.reviews.push({ step, ...review });
      save();
      assertReviewedAdminTransaction(transaction, review, signerPublicKeys);
      transaction.sign(...signers);
      const sig = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
      });
      const confirmed = await connection.confirmTransaction(
        { signature: sig, ...latest },
        "confirmed",
      );
      assert.equal(confirmed.value.err, null);
      return record(step, sig);
    }
    await send(
      "fund disposable actors",
      [treasury, vault, agent].map((account) =>
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: account.publicKey,
          lamports: 10000000,
        }),
      ),
    );
    await send(
      "initialize actual durable nonce",
      [
        SystemProgram.createNonceAccount({
          fromPubkey: payer.publicKey,
          noncePubkey: nonce.publicKey,
          authorizedPubkey: payer.publicKey,
          lamports:
            await connection.getMinimumBalanceForRentExemption(
              NONCE_ACCOUNT_LENGTH,
            ),
        }),
      ],
      [payer, nonce],
    );
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
      protocolMonitoring: {
        treasuryInflowLamports: "100000",
        treasuryOutflowLamports: "100000",
      },
    };
    const baseline = await captureBaseline(connection, settings);
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      evidence.receipts.push({
        receivedAt: new Date().toISOString(),
        event: JSON.parse(body),
      });
      save();
      res.writeHead(204);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const outbox = new AlertOutbox(
      join(directory, "outbox"),
      `http://127.0.0.1:${server.address().port}/alerts`,
    );
    const controller = new AbortController();
    let monitorError;
    const monitoring = watch({
      connection,
      baseline,
      stateDirectory: directory,
      outbox,
      signal: controller.signal,
    }).catch((error) => {
      monitorError = error;
    });
    const event = (type, predicate = () => true) =>
      evidence.receipts.find(
        (receipt) => receipt.event.type === type && predicate(receipt.event),
      );
    let treasuryChanged = false,
      paused = false,
      ownersChanged = false;
    try {
      await until(() => event("monitor-healthy"), "monitor not healthy");
      const storedNonce = NonceAccount.fromAccountData(
        (await connection.getAccountInfo(nonce.publicKey)).data,
      ).nonce;
      const held = new Transaction({
        feePayer: payer.publicKey,
        nonceInfo: {
          nonce: storedNonce,
          nonceInstruction: SystemProgram.nonceAdvance({
            noncePubkey: nonce.publicKey,
            authorizedPubkey: payer.publicKey,
          }),
        },
      }).add(await treasuryIx(treasury));
      await assert.rejects(
        reviewFreshAdminTransaction({
          connection,
          transaction: held,
          latest: await connection.getLatestBlockhash("confirmed"),
          signerPublicKeys: [payer, moderator, treasury].map(
            (s) => s.publicKey,
          ),
        }),
        /durable-nonce/,
      );
      assert.equal(
        held.signatures.length,
        0,
        "guard must reject before any authority signature exists",
      );
      // Disposable negative control: emulate already-held signatures, then revoke their nonce.
      held.sign(payer, moderator, treasury);
      const before = Buffer.from(
        (await connection.getAccountInfo(protocol)).data,
      );
      const advanced = await send("revoke held nonce by advancing it", [
        SystemProgram.nonceAdvance({
          noncePubkey: nonce.publicKey,
          authorizedPubkey: payer.publicKey,
        }),
      ]);
      const heldSig = await connection.sendRawTransaction(held.serialize(), {
        skipPreflight: true,
      });
      await assert.rejects(
        connection.confirmTransaction(
          {
            signature: heldSig,
            nonceAccountPubkey: nonce.publicKey,
            nonceValue: storedNonce,
            minContextSlot: advanced.slot,
          },
          "confirmed",
        ),
        TransactionExpiredNonceInvalidError,
      );
      assert.equal(
        (await connection.getSignatureStatuses([heldSig])).value[0],
        null,
      );
      assert.deepEqual(
        (await connection.getAccountInfo(protocol)).data,
        before,
      );
      evidence.revokedNonce = {
        address: nonce.publicKey.toBase58(),
        heldSignature: heldSig,
        advancedAtSlot: advanced.slot,
        outcome:
          "runtime dropped stale nonce; no landed transaction, no config write",
      };
      save();
      // Actual registration changes total_agents and must not page administrative changes.
      const kit = await import("@solana/kit"),
        sdk = await import("../packages/sdk-ts/dist/index.js");
      const kitSigner = await kit.createKeyPairSignerFromBytes(agent.secretKey);
      const ix = await sdk.facade.registerAgent({
        authority: kitSigner,
        agentId: new Uint8Array(randomBytes(32)),
        capabilities: 1n,
        endpoint: "https://example.invalid/admin-monitor-test",
        metadataUri: null,
        stakeAmount: 1000000n,
      });
      await send(
        "register real agent (telemetry only)",
        [
          new TransactionInstruction({
            programId: new PublicKey(ix.programAddress),
            data: Buffer.from(ix.data),
            keys: ix.accounts.map((a) => ({
              pubkey: new PublicKey(a.address),
              isSigner: Boolean(a.role & 2),
              isWritable: Boolean(a.role & 1),
            })),
          }),
        ],
        [agent],
      );
      await delay(1200);
      assert.equal(
        event("protocol-changed"),
        undefined,
        "registration telemetry must not cause an admin alarm",
      );
      await signedAdmin(
        "fresh reviewed treasury rotation",
        await treasuryIx(treasury),
        [treasury],
      );
      treasuryChanged = true;
      await until(
        () =>
          event(
            "protocol-changed",
            (e) => e.current.admin?.treasury === treasury.publicKey.toBase58(),
          ),
        "treasury config alarm missing",
      );
      await until(
        () =>
          event(
            "treasury-changed",
            (e) => e.address === treasury.publicKey.toBase58(),
          ),
        "new treasury was not automatically tracked",
      );
      await send(
        "real treasury outflow",
        [
          SystemProgram.transfer({
            fromPubkey: treasury.publicKey,
            toPubkey: vault.publicKey,
            lamports: 300000,
          }),
        ],
        [payer, treasury],
      );
      await until(
        () =>
          event(
            "treasury-changed",
            (e) =>
              e.address === treasury.publicKey.toBase58() &&
              e.deltaLamports === "-300000",
          ),
        "treasury outflow alarm missing",
      );
      await signedAdmin(
        "reviewed owner set change",
        await ownersIx([payer, moderator, treasury]),
      );
      ownersChanged = true;
      await until(
        () =>
          event("protocol-changed", (e) =>
            e.current.admin?.multisig_owners.includes(
              treasury.publicKey.toBase58(),
            ),
          ),
        "owner-set alarm missing",
      );
      await signedAdmin("reviewed local pause", await launchIx(true));
      paused = true;
      await until(
        () =>
          event(
            "protocol-changed",
            (e) => e.current.admin?.protocol_paused === true,
          ),
        "pause alarm missing",
      );
      await signedAdmin("restore local unpaused state", await launchIx(false));
      paused = false;
      await signedAdmin(
        "restore original owners",
        await ownersIx([payer, moderator, seeder]),
      );
      ownersChanged = false;
      await signedAdmin("restore original treasury", await treasuryIx(payer));
      treasuryChanged = false;
      await until(
        () =>
          event(
            "protocol-changed",
            (e) => e.current.admin?.treasury === original.treasury,
          ),
        "treasury restoration alarm missing",
      );
      assert.deepEqual(
        decodeProtocolControls(
          (await connection.getAccountInfo(protocol)).data,
        ),
        original,
      );
      assert.equal(monitorError, undefined);
      evidence.assertions = {
        nonceRejectedBeforeSigning: true,
        revokedHeldTransactionDropped: true,
        zeroSignatureSimulationBeforeFreshSigning: true,
        telemetryDoesNotPage: true,
        treasuryRotationAndDynamicTracking: true,
        exactTreasuryOutflowDetected: true,
        ownerSetAndPauseChangesDetected: true,
        controlsRestored: true,
      };
      evidence.completedAt = new Date().toISOString();
      save();
    } finally {
      if (paused) await signedAdmin("cleanup pause", await launchIx(false));
      if (ownersChanged)
        await signedAdmin(
          "cleanup owners",
          await ownersIx([payer, moderator, seeder]),
        );
      if (treasuryChanged)
        await signedAdmin("cleanup treasury", await treasuryIx(payer));
      controller.abort();
      await monitoring;
      await new Promise((resolve) => server.close(resolve));
      save();
    }
  },
);
