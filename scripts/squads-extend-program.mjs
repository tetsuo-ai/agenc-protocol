#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

export const EXTENSION_POLICY = Object.freeze({
  cluster: "mainnet-beta",
  mainnetGenesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  defaultRpcUrl: "https://api.mainnet-beta.solana.com",
  program: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
  programData: "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw",
  loader: "BPFLoaderUpgradeab1e11111111111111111111111",
  systemProgram: "11111111111111111111111111111111",
  squadsProgram: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
  multisig: "7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY",
  vaultIndex: 0,
  vault: "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf",
  additionalBytes: 97_152,
  previousPayloadCapacity: 2_183_224,
  requiredPayloadBytes: 2_280_376,
  expectedMessageSha256:
    "12c64e5b1476e6eec9d98c9f4743e6cbcf1a4b14366d1ab6741e246fc156f69b",
});

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

function encodeAddress(value) {
  return Buffer.from(addressEncoder.encode(address(value)));
}

function compareBytes(left, right) {
  return Buffer.compare(left.bytes, right.bytes);
}

function u32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function u16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

function checkedU8(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} does not fit in u8`);
  }
  return value;
}

function account(value, { signer = false, writable = false } = {}) {
  return { value, bytes: encodeAddress(value), signer, writable };
}

/**
 * Compile the one reviewed Squads TransactionMessage used to expand the live
 * AgenC ProgramData account. Its layout matches squads-multisig 2.1.0's
 * TransactionMessage::try_compile and AnchorSerialize implementation.
 */
export async function buildExtensionMessage(policy = EXTENSION_POLICY) {
  if (
    policy.previousPayloadCapacity + policy.additionalBytes !==
    policy.requiredPayloadBytes
  ) {
    throw new Error("extension policy capacity arithmetic drifted");
  }

  const [derivedProgramData] = await getProgramDerivedAddress({
    programAddress: address(policy.loader),
    seeds: [addressEncoder.encode(address(policy.program))],
  });
  if (derivedProgramData !== policy.programData) {
    throw new Error(
      `derived ProgramData ${derivedProgramData} differs from reviewed ${policy.programData}`,
    );
  }

  const vaultIndex = checkedU8(policy.vaultIndex, "Squads vault index");
  const [derivedVault] = await getProgramDerivedAddress({
    programAddress: address(policy.squadsProgram),
    seeds: [
      new TextEncoder().encode("multisig"),
      addressEncoder.encode(address(policy.multisig)),
      new TextEncoder().encode("vault"),
      Uint8Array.of(vaultIndex),
    ],
  });
  if (derivedVault !== policy.vault) {
    throw new Error(
      `derived Squads vault ${derivedVault} differs from reviewed ${policy.vault}`,
    );
  }

  // The vault is both the message payer and the checked loader authority.
  // Squads' compiler places it first as the sole writable signer.
  const vault = account(policy.vault, { signer: true, writable: true });
  const writableNonSigners = [
    account(policy.programData, { writable: true }),
    account(policy.program, { writable: true }),
  ].sort(compareBytes);
  const readonlyNonSigners = [
    account(policy.systemProgram),
    account(policy.loader),
  ].sort(compareBytes);
  const keys = [vault, ...writableNonSigners, ...readonlyNonSigners];
  const indexOf = (value) => {
    const index = keys.findIndex((entry) => entry.value === value);
    if (index < 0) throw new Error(`message key ${value} is missing`);
    return checkedU8(index, "account index");
  };

  // UpgradeableLoaderInstruction::ExtendProgramChecked is bincode enum index
  // 9 followed by its u32 additional_bytes field.
  const loaderData = Buffer.concat([u32(9), u32(policy.additionalBytes)]);
  const instructionAccounts = Buffer.from([
    indexOf(policy.programData),
    indexOf(policy.program),
    indexOf(policy.vault),
    indexOf(policy.systemProgram),
    indexOf(policy.vault),
  ]);
  const instruction = Buffer.concat([
    Buffer.from([indexOf(policy.loader)]),
    Buffer.from([checkedU8(instructionAccounts.length, "instruction account count")]),
    instructionAccounts,
    u16(loaderData.length),
    loaderData,
  ]);
  const message = Buffer.concat([
    // num_signers, num_writable_signers, num_writable_non_signers
    Buffer.from([1, 1, 2]),
    Buffer.from([checkedU8(keys.length, "static account count")]),
    ...keys.map((entry) => entry.bytes),
    Buffer.from([1]),
    instruction,
    Buffer.from([0]),
  ]);
  const sha256 = createHash("sha256").update(message).digest("hex");
  if (sha256 !== policy.expectedMessageSha256) {
    throw new Error(
      `extension message sha256 ${sha256} differs from independently reviewed ${policy.expectedMessageSha256}`,
    );
  }
  return Object.freeze({
    accountKeys: keys.map((entry) => entry.value),
    bytes: new Uint8Array(message),
    sha256,
  });
}

export function decodeExtensionMessage(bytes) {
  const data = Buffer.from(bytes);
  let cursor = 0;
  const take = (count, label) => {
    if (cursor + count > data.length) throw new Error(`truncated ${label}`);
    const value = data.subarray(cursor, cursor + count);
    cursor += count;
    return value;
  };
  const byte = (label) => take(1, label)[0];
  const numSigners = byte("num_signers");
  const numWritableSigners = byte("num_writable_signers");
  const numWritableNonSigners = byte("num_writable_non_signers");
  const keyCount = byte("account_keys length");
  const accountKeys = Array.from({ length: keyCount }, () =>
    addressDecoder.decode(take(32, "account key")),
  );
  const instructionCount = byte("instructions length");
  const instructions = Array.from({ length: instructionCount }, () => {
    const programIdIndex = byte("program id index");
    const accountCount = byte("instruction accounts length");
    const accountIndexes = [...take(accountCount, "instruction accounts")];
    const dataLength = take(2, "instruction data length").readUInt16LE();
    return {
      programIdIndex,
      accountIndexes,
      data: new Uint8Array(take(dataLength, "instruction data")),
    };
  });
  const lookupCount = byte("address table lookups length");
  if (lookupCount !== 0) throw new Error("unexpected address table lookup");
  if (cursor !== data.length) throw new Error("trailing transaction-message bytes");
  return {
    numSigners,
    numWritableSigners,
    numWritableNonSigners,
    accountKeys,
    instructions,
  };
}

/**
 * The installed Squads CLI prints its RPC URL verbatim before confirmation.
 * Refuse URL shapes commonly used to carry API keys so this wrapper cannot
 * copy a credential into terminal/session logs.
 */
export function assertCredentialFreeCliRpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--rpc-url must be a valid credential-free HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(
      "--rpc-url must be credential-free HTTPS with no userinfo, path, query, or fragment because squads-multisig-cli prints it verbatim",
    );
  }
  return parsed.href;
}

async function jsonRpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} RPC returned HTTP ${response.status}`);
  const document = await response.json();
  if (document.error) {
    throw new Error(`${method} RPC failed: ${String(document.error.message ?? "unknown error")}`);
  }
  return document.result;
}

/** Validate the exact live state in which the reviewed one-time extension is valid. */
export async function verifyPreExtensionState(
  rpcUrl,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  const genesis = await rpc(rpcUrl, "getGenesisHash");
  if (genesis !== policy.mainnetGenesis) {
    throw new Error(`RPC genesis ${String(genesis)} is not reviewed mainnet-beta`);
  }
  const result = await rpc(rpcUrl, "getAccountInfo", [
    policy.programData,
    { commitment: "finalized", encoding: "base64" },
  ]);
  const accountInfo = result?.value;
  if (
    !accountInfo ||
    accountInfo.owner !== policy.loader ||
    accountInfo.executable !== false ||
    !Number.isSafeInteger(accountInfo.lamports) ||
    accountInfo.lamports < 0 ||
    !Array.isArray(accountInfo.data) ||
    accountInfo.data[1] !== "base64"
  ) {
    throw new Error("ProgramData RPC state is missing or malformed");
  }
  const programData = Buffer.from(accountInfo.data[0], "base64");
  const expectedAccountBytes = policy.previousPayloadCapacity + 45;
  if (programData.length !== expectedAccountBytes) {
    throw new Error(
      `ProgramData size ${programData.length} differs from pre-extension ${expectedAccountBytes}; refusing a duplicate or stale extension`,
    );
  }
  if (programData.readUInt32LE(0) !== 3 || programData[12] !== 1) {
    throw new Error("ProgramData loader header is malformed or immutable");
  }
  const authority = addressDecoder.decode(programData.subarray(13, 45));
  if (authority !== policy.vault) {
    throw new Error(`ProgramData authority ${authority} differs from reviewed vault ${policy.vault}`);
  }
  const targetAccountBytes = policy.requiredPayloadBytes + 45;
  const targetRent = await rpc(rpcUrl, "getMinimumBalanceForRentExemption", [
    targetAccountBytes,
    { commitment: "finalized" },
  ]);
  if (!Number.isSafeInteger(targetRent) || targetRent < 0) {
    throw new Error("target ProgramData rent response is malformed");
  }
  const requiredTopUpLamports = Math.max(0, targetRent - accountInfo.lamports);
  const vaultBalanceResult = await rpc(rpcUrl, "getBalance", [
    policy.vault,
    { commitment: "finalized" },
  ]);
  const vaultLamports = vaultBalanceResult?.value;
  if (!Number.isSafeInteger(vaultLamports) || vaultLamports < 0) {
    throw new Error("vault balance response is malformed");
  }
  if (vaultLamports < requiredTopUpLamports) {
    throw new Error(
      `Squads vault needs ${requiredTopUpLamports} lamports for ProgramData rent but has ${vaultLamports}`,
    );
  }
  return {
    authority,
    contextSlot: result.context?.slot ?? null,
    currentAccountBytes: programData.length,
    requiredTopUpLamports,
    targetAccountBytes,
    targetRentLamports: targetRent,
    vaultLamports,
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/squads-extend-program.mjs",
    "  node scripts/squads-extend-program.mjs --execute --keypair <member.json> [options]",
    "      (--execute creates and activates the Squads proposal; it does not execute the extension)",
    "",
    "Options:",
    "  --rpc-url <credential-free-https-url>",
    "  --fee-payer-keypair <path>",
    "  --memo <text>",
    "  --priority-fee-lamports <integer>",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    execute: false,
    rpcUrl: EXTENSION_POLICY.defaultRpcUrl,
    priorityFeeLamports: "5000",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (
      arg === "--keypair" ||
      arg === "--fee-payer-keypair" ||
      arg === "--rpc-url" ||
      arg === "--memo" ||
      arg === "--priority-fee-lamports"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      const key = {
        "--keypair": "keypair",
        "--fee-payer-keypair": "feePayerKeypair",
        "--rpc-url": "rpcUrl",
        "--memo": "memo",
        "--priority-fee-lamports": "priorityFeeLamports",
      }[arg];
      options[key] = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(options.priorityFeeLamports)) {
    throw new Error("--priority-fee-lamports must be a non-negative integer");
  }
  return options;
}

export function buildCreateProposalCliArgs(options, messageBytes) {
  const cliArgs = [
    "vault-transaction-create",
    "--rpc-url",
    options.rpcUrl,
    "--keypair",
    options.keypair,
    "--program-id",
    EXTENSION_POLICY.squadsProgram,
    "--multisig-pubkey",
    EXTENSION_POLICY.multisig,
    "--vault-index",
    String(EXTENSION_POLICY.vaultIndex),
    "--priority-fee-lamports",
    options.priorityFeeLamports,
  ];
  if (options.feePayerKeypair) {
    cliArgs.push("--fee-payer-keypair", options.feePayerKeypair);
  }
  if (options.memo) cliArgs.push("--memo", options.memo);
  for (const value of messageBytes) {
    cliArgs.push("--transaction-message", String(value));
  }
  return cliArgs;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const message = await buildExtensionMessage();
  const decoded = decodeExtensionMessage(message.bytes);
  const preview = {
    ...EXTENSION_POLICY,
    transactionMessageBytes: message.bytes.length,
    transactionMessageSha256: message.sha256,
    accountKeys: decoded.accountKeys,
    instructionAccountIndexes: decoded.instructions[0].accountIndexes,
    instructionDataHex: Buffer.from(decoded.instructions[0].data).toString("hex"),
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!options.execute) return 0;
  if (!options.keypair) throw new Error("--execute requires --keypair");
  const cliRpcUrl = assertCredentialFreeCliRpcUrl(options.rpcUrl);
  const preExtension = await verifyPreExtensionState(cliRpcUrl);
  console.log(
    JSON.stringify(
      {
        action: "create-and-activate-squads-proposal",
        innerExtensionExecutesNow: false,
        preExtension,
      },
      null,
      2,
    ),
  );
  for (const [label, path] of [
    ["keypair", options.keypair],
    ["fee payer keypair", options.feePayerKeypair],
  ]) {
    if (path && !existsSync(path)) throw new Error(`${label} path does not exist`);
  }

  const cliArgs = buildCreateProposalCliArgs(
    { ...options, rpcUrl: cliRpcUrl },
    message.bytes,
  );
  const result = spawnSync("squads-multisig-cli", cliArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`squads-multisig-cli exited with ${result.status}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
