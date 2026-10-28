#!/usr/bin/env node
// Download public, hash-pinned executable bytes for disposable genesis only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  UPGRADEABLE_LOADER_ID,
} from "./program-upgrade-authority-policy.mjs";
import {
  DEFAULT_RPC,
  PMP_ID,
  PMP_SHA256,
  PROGRAM_ID,
  RELEASE_PAYLOAD_SHA256,
  OTTER_ID,
  sha256,
  json,
} from "./explorer-metadata.mjs";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { Connection, PublicKey } = require("@solana/web3.js");
export const PINS = Object.freeze({
  agenc: { program: PROGRAM_ID, sha256: RELEASE_PAYLOAD_SHA256 },
  pmp: { program: PMP_ID, sha256: PMP_SHA256 },
  squads: {
    program: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
    sha256: "dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c",
  },
  otter: {
    program: OTTER_ID,
    sha256: "b501789b71bb383556f7c1cc7a01e51ae9bb4111bf14e4dec9f09b18e506307a",
  },
});
export const CONFIG = {
  address: "BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr",
  sha256: "ba8e7712f069f2e68e8583b105ac2eb22d791265440da56df32f9f3f734af3e0",
};
export async function fetchDrillPrograms(directory, rpc = DEFAULT_RPC) {
  await mkdir(directory, { recursive: true });
  const c = new Connection(rpc, "confirmed");
  if (
    (await c.getGenesisHash()) !==
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
  )
    throw Error("Expected mainnet read-only source");
  const evidence = { observedAt: new Date().toISOString(), programs: [] };
  for (const [name, pin] of Object.entries(PINS)) {
    const id = new PublicKey(pin.program),
      loader = new PublicKey(UPGRADEABLE_LOADER_ID);
    const [pd] = PublicKey.findProgramAddressSync([id.toBuffer()], loader);
    const r = await c.getMultipleAccountsInfoAndContext([id, pd]);
    const p = decodeUpgradeableProgramAccount(r.value[0], loader),
      d = decodeUpgradeableProgramDataAccount(r.value[1], loader);
    if (
      p.programDataAddress !== pd.toBase58() ||
      sha256(d.payload) !== pin.sha256
    )
      throw Error(
        `Pinned ${name} executable changed; review before replacing a fixture`,
      );
    await writeFile(path.join(directory, `${name}.so`), d.payload);
    evidence.programs.push({
      name,
      ...pin,
      contextSlot: r.context.slot,
      programData: pd.toBase58(),
      deployedSlot: d.slot,
    });
  }
  const r = await c.getAccountInfoAndContext(new PublicKey(CONFIG.address));
  const a = r.value;
  if (
    !a ||
    a.owner.toBase58() !== PINS.squads.program ||
    a.executable ||
    sha256(a.data) !== CONFIG.sha256
  )
    throw Error("Squads global config changed; re-review the fixture");
  // web3 represents rentEpoch=u64::MAX as an imprecise JS number. Rent exemption
  // comes from the copied lamports/data; use genesis epoch 0, not a rounded u64.
  await writeFile(
    path.join(directory, "squads-config.json"),
    json({
      pubkey: CONFIG.address,
      account: {
        lamports: a.lamports,
        owner: a.owner.toBase58(),
        executable: false,
        rentEpoch: 0,
        data: [a.data.toString("base64"), "base64"],
      },
    }),
  );
  evidence.squadsConfig = {
    ...CONFIG,
    contextSlot: r.context.slot,
    note: "Only the public global fee/config fixture is copied. Test multisig, proposals, buffers and metadata are created by real local transactions.",
  };
  await writeFile(
    path.join(directory, "source-evidence.json"),
    json(evidence) + "\n",
  );
  return evidence;
}
export async function verifyDrillFiles(directory) {
  for (const [name, pin] of Object.entries(PINS))
    if (
      sha256(await readFile(path.join(directory, `${name}.so`))) !== pin.sha256
    )
      throw Error(`Invalid ${name} drill binary`);
  const config = JSON.parse(
    await readFile(path.join(directory, "squads-config.json"), "utf8"),
  );
  if (
    config.pubkey !== CONFIG.address ||
    config.account.owner !== PINS.squads.program ||
    sha256(Buffer.from(config.account.data[0], "base64")) !== CONFIG.sha256
  )
    throw Error("Invalid Squads config fixture");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? ".localnet/explorer-programs");
  fetchDrillPrograms(dir, process.env.EXPLORER_READ_RPC ?? DEFAULT_RPC)
    .then((e) => console.log(json(e)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
