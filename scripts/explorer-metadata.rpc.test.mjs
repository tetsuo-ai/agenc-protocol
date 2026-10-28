// Real default-feature Agave RPC + deployed PMP/Squads/Otter binaries.
// All signing keys and program authority in this test belong to disposable genesis.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, open } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as squads from "./test-support/squads-drill.mjs";
import { address, createNoopSigner, getBase58Encoder } from "@solana/kit";
import {
  getAllocateInstruction,
  getSetAuthorityInstruction,
  getWriteInstruction,
  getInitializeInstruction,
  Compression,
  Encoding,
  Format,
  DataSource,
} from "@solana-program/program-metadata";
import {
  assertDeployedRevision,
  assertSecurityBuffer,
  buildCanonicalSecurityTransaction,
  buildVerifyPdaExportArgs,
  canonicalSecurityAddress,
  decodeCanonicalSecurity,
  defaultSecurityJsonPath,
  json,
  PMP_ID,
  PROGRAM_DATA,
  PROGRAM_ID,
  OTTER_ID,
  RELEASE_ARTIFACT_SHA256,
  RELEASE_COMMIT,
  RELEASE_SLOT,
  sha256,
  UPGRADE_AUTHORITY_VAULT,
  toWeb3Instruction,
  validateVerifierExport,
  VERIFIER_SHA256,
} from "./explorer-metadata.mjs";
import {
  CONFIG,
  PINS,
  verifyDrillFiles,
} from "./fetch-explorer-drill-programs.mjs";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
} = require("@solana/web3.js");
const run = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.AGENC_EXPLORER_RPC_E2E === "1";

test(
  "two real Squads approvals publish exact canonical security and verification PDA, with failure and rent checks",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const programs = path.join(root, ".localnet/explorer-programs");
    await verifyDrillFiles(programs);
    // The live revision-8 ProgramData payload is the 2,075,896-byte release ELF
    // followed only by zero padding. The rebuilt-artifact guard must accept
    // that exact prefix and reject anything shorter.
    const livePayload = await readFile(path.join(programs, "agenc.so"));
    const releaseElf = livePayload.subarray(0, 2_075_896);
    assert.equal(sha256(releaseElf), RELEASE_ARTIFACT_SHA256);
    const liveSnapshot = {
      programId: PROGRAM_ID,
      programData: PROGRAM_DATA,
      authority: UPGRADE_AUTHORITY_VAULT,
      programDataSlot: RELEASE_SLOT,
      payload: livePayload,
    };
    assertDeployedRevision(liveSnapshot, releaseElf);
    assert.throws(() =>
      assertDeployedRevision(liveSnapshot, releaseElf.subarray(0, -1)),
    );
    const verifier = process.env.SOLANA_VERIFY_BIN;
    assert.ok(verifier, "SOLANA_VERIFY_BIN is required");
    assert.equal(sha256(await readFile(verifier)), VERIFIER_SHA256);
    const dir = await mkdtemp(path.join(root, ".localnet/explorer-drill-"));
    const members = [
        Keypair.generate(),
        Keypair.generate(),
        Keypair.generate(),
      ],
      creator = members[0],
      outsider = Keypair.generate(),
      createKey = Keypair.generate();
    const [multisigPda] = squads.getMultisigPda({
      createKey: createKey.publicKey,
    });
    const [vault] = squads.getVaultPda({ multisigPda, index: 0 });
    const port = Number(process.env.EXPLORER_DRILL_PORT ?? 15199);
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 63000);
    const rpc = `http://127.0.0.1:${port}`,
      connection = new Connection(rpc, "confirmed");
    // Refuse an occupied endpoint before spawning. No existing ledger is reset.
    let occupied = false;
    try {
      await connection.getVersion();
      occupied = true;
    } catch {}
    assert.equal(occupied, false, "drill port already serves an RPC");
    const log = await open(path.join(dir, "validator.log"), "w");
    const args = [
      "--ledger",
      path.join(dir, "ledger"),
      "--rpc-port",
      String(port),
      "--faucet-port",
      String(port + 100),
      "--gossip-port",
      String(port + 200),
      "--dynamic-port-range",
      `${port + 300}-${port + 330}`,
      "--bind-address",
      "127.0.0.1",
      "--quiet",
      "--upgradeable-program",
      PROGRAM_ID,
      path.join(programs, "agenc.so"),
      vault.toBase58(),
      "--bpf-program",
      PMP_ID,
      path.join(programs, "pmp.so"),
      "--bpf-program",
      PINS.squads.program,
      path.join(programs, "squads.so"),
      "--bpf-program",
      OTTER_ID,
      path.join(programs, "otter.so"),
      "--account",
      CONFIG.address,
      path.join(programs, "squads-config.json"),
    ];
    const validator = spawn("solana-test-validator", args, {
      cwd: dir,
      stdio: ["ignore", log.fd, log.fd],
    });
    let spawnError;
    validator.once("error", (e) => {
      spawnError = e;
    });
    const evidence = {
      label: "issue-199-explorer-metadata",
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
      programs: PINS,
      genesisFixture:
        "Four hash-pinned executables; target upgrade authority is a new local Squads vault. Only the public Squads global fee config is copied; no lifecycle/metadata/proposal account injection.",
      validatorArgs: args,
      transactions: [],
      assertions: {},
    };
    const evidencePath = path.join(
      root,
      ".localnet/evidence/issue-199-explorer-metadata.json",
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const save = () => writeFile(evidencePath, json(evidence) + "\n");
    await save();
    async function landed(signature) {
      for (let i = 0; i < 60; i++) {
        const t = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (t) return t;
        await delay(100);
      }
      throw Error(`confirmed transaction unavailable ${signature}`);
    }
    async function send(step, instructions, signers = [creator], errorPattern) {
      const lifetime = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: signers[0].publicKey,
        ...lifetime,
      }).add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 400000 + evidence.transactions.length,
        }),
        ...instructions,
      );
      tx.sign(...signers);
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      const t = await landed(signature);
      const confirmation = { value: { err: t.meta.err } };
      evidence.transactions.push({
        step,
        signature,
        slot: t.slot,
        meta: t.meta,
      });
      await save();
      if (errorPattern) {
        assert.ok(confirmation.value.err, `${step} must fail on chain`);
        assert.match((t.meta.logMessages ?? []).join("\n"), errorPattern);
      } else
        assert.equal(confirmation.value.err, null, `${step}: ${json(t.meta)}`);
      return t;
    }
    async function approve(index, member) {
      await send(
        `approve proposal ${index}`,
        [
          squads.instructions.proposalApprove({
            multisigPda,
            transactionIndex: index,
            member: member.publicKey,
          }),
        ],
        [member],
      );
    }
    async function storeProposal(index, instructions) {
      const blockhash = (await connection.getLatestBlockhash()).blockhash;
      await send(`store vault transaction ${index}`, [
        squads.instructions.vaultTransactionCreate({
          multisigPda,
          transactionIndex: index,
          creator: creator.publicKey,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionMessage: new TransactionMessage({
            payerKey: vault,
            recentBlockhash: blockhash,
            instructions,
          }),
        }),
      ]);
      await send(`create proposal ${index}`, [
        squads.instructions.proposalCreate({
          multisigPda,
          creator: creator.publicKey,
          transactionIndex: index,
        }),
      ]);
    }
    async function execute(index, errorPattern) {
      const { instruction, lookupTableAccounts } =
        await squads.instructions.vaultTransactionExecute({
          connection,
          multisigPda,
          transactionIndex: index,
          member: creator.publicKey,
        });
      assert.equal(lookupTableAccounts.length, 0);
      return send(
        `execute proposal ${index}`,
        [instruction],
        [creator],
        errorPattern,
      );
    }
    try {
      let ready = false;
      for (let i = 0; i < 300; i++) {
        if (spawnError) throw spawnError;
        if (validator.exitCode !== null)
          throw Error("validator exited; see validator.log");
        try {
          await connection.getVersion();
          ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(ready, "local validator startup");
      const genesis = await connection.getGenesisHash();
      assert.notEqual(genesis, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      evidence.genesisHash = genesis;
      for (const member of [...members, outsider]) {
        const signature = await connection.requestAirdrop(
          member.publicKey,
          5_000_000_000,
        );
        const t = await landed(signature);
        evidence.transactions.push({
          step: "local faucet funding",
          signature,
          slot: t.slot,
          meta: t.meta,
        });
      }
      const config = await squads.accounts.ProgramConfig.fromAccountAddress(
        connection,
        new PublicKey(CONFIG.address),
      );
      await send(
        "create autonomous 2-of-3 multisig",
        [
          squads.instructions.multisigCreateV2({
            treasury: config.treasury,
            creator: creator.publicKey,
            multisigPda,
            configAuthority: null,
            threshold: 2,
            members: members.map((k) => ({
              key: k.publicKey,
              permissions: squads.types.Permissions.all(),
            })),
            timeLock: 0,
            createKey: createKey.publicKey,
            rentCollector: null,
          }),
        ],
        [creator, createKey],
      );
      const multisig = await squads.accounts.Multisig.fromAccountAddress(
        connection,
        multisigPda,
      );
      assert.equal(multisig.threshold, 2);
      assert.equal(multisig.members.length, 3);
      assert.equal(
        multisig.configAuthority.toBase58(),
        SystemProgram.programId.toBase58(),
      );
      await send("fund local upgrade vault", [
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: vault,
          lamports: 500_000_000,
        }),
      ]);
      const raw = await readFile(defaultSecurityJsonPath()),
        buffer = Keypair.generate(),
        pmp = new PublicKey(PMP_ID),
        signer = createNoopSigner(address(creator.publicKey.toBase58()));
      const rent = await connection.getMinimumBalanceForRentExemption(
        96 + raw.length,
      );
      await send(
        "create metadata staging buffer",
        [
          SystemProgram.createAccount({
            fromPubkey: creator.publicKey,
            newAccountPubkey: buffer.publicKey,
            lamports: rent,
            space: 96 + raw.length,
            programId: pmp,
          }),
          toWeb3Instruction(
            getAllocateInstruction({
              buffer: address(buffer.publicKey.toBase58()),
              authority: createNoopSigner(address(buffer.publicKey.toBase58())),
            }),
          ),
          toWeb3Instruction(
            getSetAuthorityInstruction({
              account: address(buffer.publicKey.toBase58()),
              authority: createNoopSigner(address(buffer.publicKey.toBase58())),
              newAuthority: address(creator.publicKey.toBase58()),
            }),
          ),
        ],
        [creator, buffer],
      );
      for (let offset = 0; offset < raw.length; offset += 600)
        await send("write exact security bytes", [
          toWeb3Instruction(
            getWriteInstruction({
              buffer: address(buffer.publicKey.toBase58()),
              authority: signer,
              offset,
              data: raw.subarray(offset, offset + 600),
            }),
          ),
        ]);
      assertSecurityBuffer(
        await connection.getAccountInfo(buffer.publicKey),
        creator.publicKey.toBase58(),
        raw,
      );
      await assert.rejects(
        () =>
          buildCanonicalSecurityTransaction(connection, {
            authority: vault.toBase58(),
            buffer: buffer.publicKey.toBase58(),
            rentReturn: creator.publicKey.toBase58(),
            raw,
          }),
        /handed/,
      );
      // A third party cannot create canonical metadata, including with valid content.
      const [pd] = PublicKey.findProgramAddressSync(
        [new PublicKey(PROGRAM_ID).toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      );
      const metadata = canonicalSecurityAddress();
      const badInit = toWeb3Instruction(
        getInitializeInstruction({
          metadata: address(metadata.toBase58()),
          authority: createNoopSigner(address(outsider.publicKey.toBase58())),
          program: address(PROGRAM_ID),
          programData: address(pd.toBase58()),
          seed: "security",
          encoding: Encoding.Utf8,
          compression: Compression.None,
          format: Format.Json,
          dataSource: DataSource.Direct,
          data: Buffer.from("{}"),
        }),
      );
      await send(
        "outsider canonical write rejected",
        [
          SystemProgram.transfer({
            fromPubkey: outsider.publicKey,
            toPubkey: metadata,
            lamports: rent,
          }),
          badInit,
        ],
        [outsider],
        /Provided seeds do not result in a valid address/,
      );
      assert.equal(await connection.getAccountInfo(metadata), null);
      await send("handoff staging buffer to local vault", [
        toWeb3Instruction(
          getSetAuthorityInstruction({
            account: address(buffer.publicKey.toBase58()),
            authority: signer,
            newAuthority: address(vault.toBase58()),
          }),
        ),
      ]);
      const options = {
        authority: vault.toBase58(),
        buffer: buffer.publicKey.toBase58(),
        rentReturn: creator.publicKey.toBase58(),
        raw,
      };
      const built = await buildCanonicalSecurityTransaction(
        connection,
        options,
      );
      assert.equal(
        built.transaction.signatures.every((s) => s.signature === null),
        true,
      );
      await assert.rejects(
        () =>
          buildCanonicalSecurityTransaction(connection, {
            ...options,
            raw: Buffer.from(
              raw
                .toString()
                .replace("AgenC agent-marketplace", "AgenC OTHER-marketplace"),
            ),
          }),
        /bytes|length/,
      );
      // Exercise the actual emitted base58 blob, not a separate instruction fixture.
      const decoded = Transaction.from(
        Buffer.from(
          getBase58Encoder().encode(built.packet.unsignedTransaction),
        ),
      );
      assert.equal(decoded.feePayer.toBase58(), vault.toBase58());
      await storeProposal(1n, decoded.instructions);
      await approve(1n, members[0]);
      const bufferBefore = await connection.getAccountInfo(buffer.publicKey),
        vaultBefore = await connection.getBalance(vault);
      await execute(
        1n,
        /InvalidProposalStatus|not.*approved|NotApproved|custom program error/,
      );
      assert.equal(await connection.getAccountInfo(metadata), null);
      assert.equal(await connection.getBalance(vault), vaultBefore);
      assert.deepEqual(
        (await connection.getAccountInfo(buffer.publicKey)).data,
        bufferBefore.data,
      );
      await approve(1n, members[1]);
      const receiverBefore = await connection.getBalance(creator.publicKey);
      const executed = await execute(1n);
      assert.equal(
        await connection.getBalance(creator.publicKey),
        receiverBefore + rent - executed.meta.fee,
      );
      assert.equal(
        await connection.getBalance(vault),
        vaultBefore - built.packet.rentTopUp,
      );
      assert.equal(await connection.getAccountInfo(buffer.publicKey), null);
      assert.equal(
        decodeCanonicalSecurity(await connection.getAccountInfo(metadata), {
          authority: vault.toBase58(),
          raw,
        }).matches,
        true,
      );
      await execute(
        1n,
        /InvalidProposalStatus|AlreadyExecuted|custom program error/,
      );
      evidence.securityPacket = built.packet;
      // The same pinned verifier creates the real Otter PDA instructions for this
      // disposable vault. No job is submitted to OtterSec's external service.
      const { stdout } = await run(
        verifier,
        buildVerifyPdaExportArgs({ rpc, authority: vault.toBase58() }),
        { cwd: dir, maxBuffer: 2 * 1024 * 1024, timeout: 120000 },
      );
      const slot = (await connection.getAccountInfo(pd)).data.readBigUInt64LE(
        4,
      );
      const verifyPacket = validateVerifierExport(stdout, {
        authority: vault.toBase58(),
        deployedSlot: slot,
      });
      const verifyTx = Transaction.from(
        Buffer.from(
          getBase58Encoder().encode(verifyPacket.unsignedTransaction),
        ),
      );
      const priorCommit = "097ded12b03d27e8c89d50ad6ed8813493700129";
      // Establish a stale attestation through real approved transactions. This is
      // a controlled prior-commit fixture, not an injected verification account.
      const oldTx = Transaction.from(
        verifyTx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );
      const commitOffset = oldTx.instructions[0].data.indexOf(
        Buffer.from(RELEASE_COMMIT),
      );
      assert.ok(commitOffset >= 0);
      Buffer.from(priorCommit).copy(oldTx.instructions[0].data, commitOffset);
      assert.throws(
        () =>
          validateVerifierExport(
            oldTx
              .serialize({
                requireAllSignatures: false,
                verifySignatures: false,
              })
              .toString("base64"),
            { authority: vault.toBase58(), deployedSlot: slot },
          ),
        /commit/,
      );
      await storeProposal(2n, oldTx.instructions);
      await approve(2n, members[0]);
      await approve(2n, members[2]);
      await execute(2n);
      const verifyAddress = new PublicKey(verifyPacket.verificationPda);
      const stale = await connection.getAccountInfo(verifyAddress);
      assert.ok(stale.data.includes(Buffer.from(priorCommit)));
      assert.equal(stale.data.includes(Buffer.from(RELEASE_COMMIT)), false);
      // solana-verify reads finalized state. Wait for the real local root
      // before asking it to choose update rather than initialize.
      let rooted = false;
      for (let i = 0; i < 300; i++) {
        const account = await connection.getAccountInfo(
          verifyAddress,
          "finalized",
        );
        if (account && account.data.equals(stale.data)) {
          rooted = true;
          break;
        }
        await delay(200);
      }
      assert.ok(rooted, "prior attestation must finalize before export");
      const refreshed = await run(
        verifier,
        buildVerifyPdaExportArgs({ rpc, authority: vault.toBase58() }),
        { cwd: dir, maxBuffer: 2 * 1024 * 1024, timeout: 120000 },
      );
      const updatePacket = validateVerifierExport(refreshed.stdout, {
        authority: vault.toBase58(),
        deployedSlot: slot,
      });
      const updateTx = Transaction.from(
        Buffer.from(
          getBase58Encoder().encode(updatePacket.unsignedTransaction),
        ),
      );
      assert.deepEqual(
        [...updateTx.instructions[0].data.subarray(0, 8)],
        [219, 200, 88, 176, 158, 63, 253, 127],
      );
      await storeProposal(3n, updateTx.instructions);
      await approve(3n, members[0]);
      await execute(
        3n,
        /InvalidProposalStatus|NotApproved|custom program error/,
      );
      assert.deepEqual(
        (await connection.getAccountInfo(verifyAddress)).data,
        stale.data,
      );
      await approve(3n, members[2]);
      await execute(3n);
      const verifyAccount = await connection.getAccountInfo(verifyAddress);
      assert.equal(verifyAccount.owner.toBase58(), OTTER_ID);
      assert.equal(
        new PublicKey(verifyAccount.data.subarray(8, 40)).toBase58(),
        PROGRAM_ID,
      );
      assert.equal(
        new PublicKey(verifyAccount.data.subarray(40, 72)).toBase58(),
        vault.toBase58(),
      );
      assert.ok(verifyAccount.data.includes(Buffer.from(RELEASE_COMMIT)));
      assert.equal(
        verifyAccount.data.includes(Buffer.from(priorCommit)),
        false,
      );
      evidence.verificationPda = {
        address: verifyPacket.verificationPda,
        dataSha256: sha256(verifyAccount.data),
        deployedSlot: slot,
      };
      evidence.assertions = {
        actualSquads2of3: true,
        unsignedExportExecutedThroughCpi: true,
        oneApprovalRejected: true,
        outsiderCanonicalWriteRejected: true,
        staleOrDifferentBufferRejected: true,
        exactMetadataReadBack: true,
        bufferRentReturned: true,
        vaultSpentExactMetadataRent: true,
        replayRejected: true,
        staleVerificationPdaUpdatedThroughSquads: true,
        externalOtterSecJobSubmitted: false,
      };
      evidence.completedAt = new Date().toISOString();
      await save();
    } catch (error) {
      console.error(error);
      evidence.failure = String(error.stack ?? error);
      throw error;
    } finally {
      connection._rpcWebSocket.close();
      if (validator.exitCode === null) {
        validator.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => validator.once("exit", resolve)),
          delay(10000, undefined, { ref: false }),
        ]);
        if (validator.exitCode === null) validator.kill("SIGKILL");
      }
      await log.close();
      await save();
    }
  },
);
