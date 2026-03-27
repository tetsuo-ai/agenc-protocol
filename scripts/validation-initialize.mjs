#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function parseArgs(argv) {
  const args = { config: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      args.config = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validation-initialize.mjs --config <path>

Initializes the validation devnet deployment using a JSON config file.
`);
}

function expandHome(value) {
  if (!value.startsWith("~/")) {
    return value;
  }
  return path.join(process.env.HOME ?? "", value.slice(2));
}

function resolveFromRoot(value) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.join(rootDir, expanded);
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadKeypair(filePath) {
  const secret = await loadJson(filePath);
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function expectPublicKeyStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return values.map((value) => new PublicKey(value));
}

function expectImageId(value) {
  if (!Array.isArray(value) || value.length !== 32) {
    throw new Error("zkConfig.activeImageId must be a 32-byte number array");
  }
  return Uint8Array.from(value);
}

function signerMeta(pubkey) {
  return {
    pubkey,
    isSigner: true,
    isWritable: false,
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function publicKeysEqual(left, right) {
  return left.toBase58() === right.toBase58();
}

function compareNumberField(actual, expected, label) {
  const normalizedActual =
    typeof actual === "bigint" ? Number(actual) : Number(actual?.toString?.() ?? actual);
  if (normalizedActual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${normalizedActual}`);
  }
}

function comparePublicKeyField(actual, expected, label) {
  if (!publicKeysEqual(actual, expected)) {
    throw new Error(`${label} mismatch: expected ${expected.toBase58()}, got ${actual.toBase58()}`);
  }
}

function compareImageId(actual, expected, label) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (!left.equals(right)) {
    throw new Error(
      `${label} mismatch: expected [${Array.from(expected).join(", ")}], got [${Array.from(actual).join(", ")}]`,
    );
  }
}

async function getExistingAccount(connection, program, namespace, pubkey) {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) {
    return null;
  }
  return program.account[namespace].fetch(pubkey);
}

function protocolMatches(configAccount, expected) {
  compareNumberField(configAccount.disputeThreshold, expected.disputeThreshold, "protocol.disputeThreshold");
  compareNumberField(configAccount.protocolFeeBps, expected.protocolFeeBps, "protocol.protocolFeeBps");
  compareNumberField(configAccount.minAgentStake, expected.minStake, "protocol.minStake");
  compareNumberField(
    configAccount.minStakeForDispute,
    expected.minStakeForDispute,
    "protocol.minStakeForDispute",
  );
  compareNumberField(configAccount.multisigThreshold, expected.multisigThreshold, "protocol.multisigThreshold");
  comparePublicKeyField(configAccount.authority, expected.authority, "protocol.authority");
  comparePublicKeyField(configAccount.treasury, expected.treasury, "protocol.treasury");

  const owners = configAccount.multisigOwners
    .slice(0, Number(configAccount.multisigOwnersLen))
    .map((owner) => owner.toBase58());
  const expectedOwners = expected.multisigOwners.map((owner) => owner.toBase58());
  if (owners.join(",") !== expectedOwners.join(",")) {
    throw new Error(
      `protocol.multisigOwners mismatch: expected ${expectedOwners.join(", ")}, got ${owners.join(", ")}`,
    );
  }
}

function rateLimitsMatch(configAccount, expected) {
  compareNumberField(
    configAccount.taskCreationCooldown,
    expected.taskCreationCooldown,
    "rateLimits.taskCreationCooldown",
  );
  compareNumberField(
    configAccount.maxTasksPer24H,
    expected.maxTasksPer24h,
    "rateLimits.maxTasksPer24h",
  );
  compareNumberField(
    configAccount.disputeInitiationCooldown,
    expected.disputeInitiationCooldown,
    "rateLimits.disputeInitiationCooldown",
  );
  compareNumberField(
    configAccount.maxDisputesPer24H,
    expected.maxDisputesPer24h,
    "rateLimits.maxDisputesPer24h",
  );
  compareNumberField(
    configAccount.minStakeForDispute,
    expected.minStakeForDispute,
    "rateLimits.minStakeForDispute",
  );
}

function bidMarketplaceMatches(account, expected, authority) {
  comparePublicKeyField(account.authority, authority, "bidMarketplace.authority");
  compareNumberField(
    account.minBidBondLamports,
    expected.minBidBondLamports,
    "bidMarketplace.minBidBondLamports",
  );
  compareNumberField(
    account.bidCreationCooldownSecs,
    expected.bidCreationCooldownSecs,
    "bidMarketplace.bidCreationCooldownSecs",
  );
  compareNumberField(account.maxBidsPer24H, expected.maxBidsPer24h, "bidMarketplace.maxBidsPer24h");
  compareNumberField(
    account.maxActiveBidsPerTask,
    expected.maxActiveBidsPerTask,
    "bidMarketplace.maxActiveBidsPerTask",
  );
  compareNumberField(
    account.maxBidLifetimeSecs,
    expected.maxBidLifetimeSecs,
    "bidMarketplace.maxBidLifetimeSecs",
  );
  compareNumberField(
    account.acceptedNoShowSlashBps,
    expected.acceptedNoShowSlashBps,
    "bidMarketplace.acceptedNoShowSlashBps",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    printHelp();
    process.exit(1);
  }

  const configPath = resolveFromRoot(args.config);
  const config = await loadJson(configPath);

  const idlPath = resolveFromRoot(config.idlPath);
  const rawIdl = await loadJson(idlPath);
  const expectedProgramId = new PublicKey(config.programId);
  assert(rawIdl.address === expectedProgramId.toBase58(), "IDL address does not match config.programId");

  const authority = await loadKeypair(resolveFromRoot(config.authorityKeypairPath));
  const secondSigner = await loadKeypair(resolveFromRoot(config.secondSignerKeypairPath));
  const treasury = await loadKeypair(resolveFromRoot(config.treasuryKeypairPath));

  const thirdSignerPath = config.thirdSignerKeypairPath
    ? resolveFromRoot(config.thirdSignerKeypairPath)
    : null;
  const thirdSigner = thirdSignerPath ? await loadKeypair(thirdSignerPath) : null;

  const multisigOwners = expectPublicKeyStrings(config.protocol.multisigOwners, "protocol.multisigOwners");
  const activeImageId = expectImageId(config.zkConfig.activeImageId);
  const connection = new anchor.web3.Connection(
    config.rpcUrl,
    config.commitment ?? "confirmed",
  );
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: config.commitment ?? "confirmed",
  });
  anchor.setProvider(provider);

  const program = new anchor.Program(rawIdl, provider);
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    expectedProgramId,
  );
  const [bidMarketplacePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bid_marketplace")],
    expectedProgramId,
  );
  const [zkConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("zk_config")],
    expectedProgramId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [expectedProgramId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );

  const protocolExpected = {
    ...config.protocol,
    authority: authority.publicKey,
    treasury: treasury.publicKey,
    multisigOwners,
  };

  const result = {
    configPath,
    programId: expectedProgramId.toBase58(),
    protocolConfig: protocolConfigPda.toBase58(),
    bidMarketplace: bidMarketplacePda.toBase58(),
    zkConfig: zkConfigPda.toBase58(),
    treasury: treasury.publicKey.toBase58(),
    authority: authority.publicKey.toBase58(),
    secondSigner: secondSigner.publicKey.toBase58(),
    thirdSigner: thirdSigner?.publicKey.toBase58() ?? null,
    activeImageId: Array.from(activeImageId),
    signatures: {},
  };

  let protocolConfig = await getExistingAccount(connection, program, "protocolConfig", protocolConfigPda);
  if (!protocolConfig) {
    const initializeProtocolIx = await program.methods
      .initializeProtocol(
        config.protocol.disputeThreshold,
        config.protocol.protocolFeeBps,
        new anchor.BN(config.protocol.minStake),
        new anchor.BN(config.protocol.minStakeForDispute),
        config.protocol.multisigThreshold,
        multisigOwners,
      )
      .accounts({
        protocolConfig: protocolConfigPda,
        treasury: treasury.publicKey,
        authority: authority.publicKey,
        secondSigner: secondSigner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: programDataPda,
          isSigner: false,
          isWritable: false,
        },
      ])
      .instruction();
    initializeProtocolIx.keys = initializeProtocolIx.keys.map((keyMeta) =>
      publicKeysEqual(keyMeta.pubkey, treasury.publicKey)
        ? { ...keyMeta, isSigner: true }
        : keyMeta,
    );
    const initializeProtocolTx = new anchor.web3.Transaction().add(initializeProtocolIx);
    const signature = await provider.sendAndConfirm(initializeProtocolTx, [secondSigner, treasury]);
    result.signatures.initializeProtocol = signature;
    protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
  }
  protocolMatches(protocolConfig, protocolExpected);

  const rateLimitSigners = [authority.publicKey, secondSigner.publicKey];
  try {
    rateLimitsMatch(protocolConfig, config.rateLimits);
  } catch {
    const signature = await program.methods
      .updateRateLimits(
        new anchor.BN(config.rateLimits.taskCreationCooldown),
        config.rateLimits.maxTasksPer24h,
        new anchor.BN(config.rateLimits.disputeInitiationCooldown),
        config.rateLimits.maxDisputesPer24h,
        new anchor.BN(config.rateLimits.minStakeForDispute),
      )
      .accounts({
        protocolConfig: protocolConfigPda,
        authority: authority.publicKey,
      })
      .remainingAccounts(rateLimitSigners.map((pubkey) => signerMeta(pubkey)))
      .signers([secondSigner])
      .rpc();
    result.signatures.updateRateLimits = signature;
    protocolConfig = await program.account.protocolConfig.fetch(protocolConfigPda);
  }
  rateLimitsMatch(protocolConfig, config.rateLimits);

  let bidMarketplace = await getExistingAccount(
    connection,
    program,
    "bidMarketplaceConfig",
    bidMarketplacePda,
  );
  if (!bidMarketplace) {
    const signature = await program.methods
      .initializeBidMarketplace(
        new anchor.BN(config.bidMarketplace.minBidBondLamports),
        new anchor.BN(config.bidMarketplace.bidCreationCooldownSecs),
        config.bidMarketplace.maxBidsPer24h,
        config.bidMarketplace.maxActiveBidsPerTask,
        new anchor.BN(config.bidMarketplace.maxBidLifetimeSecs),
        config.bidMarketplace.acceptedNoShowSlashBps,
      )
      .accounts({
        protocolConfig: protocolConfigPda,
        bidMarketplace: bidMarketplacePda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(rateLimitSigners.map((pubkey) => signerMeta(pubkey)))
      .signers([secondSigner])
      .rpc();
    result.signatures.initializeBidMarketplace = signature;
    bidMarketplace = await program.account.bidMarketplaceConfig.fetch(bidMarketplacePda);
  }
  bidMarketplaceMatches(bidMarketplace, config.bidMarketplace, authority.publicKey);

  let zkConfig = await getExistingAccount(connection, program, "zkConfig", zkConfigPda);
  if (!zkConfig) {
    const signature = await program.methods
      .initializeZkConfig(Array.from(activeImageId))
      .accounts({
        protocolConfig: protocolConfigPda,
        zkConfig: zkConfigPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    result.signatures.initializeZkConfig = signature;
    zkConfig = await program.account.zkConfig.fetch(zkConfigPda);
  }
  compareImageId(zkConfig.activeImageId, activeImageId, "zkConfig.activeImageId");

  const resultPath = config.resultPath
    ? resolveFromRoot(config.resultPath)
    : path.join(rootDir, "artifacts/devnet-readiness/validation-init-result.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
