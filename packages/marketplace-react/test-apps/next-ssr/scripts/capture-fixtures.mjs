#!/usr/bin/env node
/**
 * capture-fixtures.mjs — snapshot REAL seeded listing account bytes into a
 * committed static fixture so the SSR app renders the REAL `<ListingGrid>` (fed
 * REAL decoded `ServiceListing` accounts) with NO validator at build/test time.
 *
 * It reads the seeded listing PDAs from the live sandbox (`.localnet/env.json`
 * -> fixturesPath) and fetches each account's base64 data, writing
 * app/listings-fixture.json = { capturedAtSlot, programId, listings: [{ address,
 * accountBase64 }] }. The SSR fixture transport then decodes those bytes with
 * the SDK's `getServiceListingDecoder()` at render time — genuine on-chain
 * accounts, so the real ListingCard/ListingGrid render name/category/price/hires
 * exactly as they would against a live indexer/gPA.
 *
 * Run after `node test/sandbox-up.mjs up`. Re-run to refresh the snapshot.
 *
 * Usage: node scripts/capture-fixtures.mjs [--rpc http://127.0.0.1:8899]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc, address } from "@solana/kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../../../.."); // -> agenc-protocol
const ENV_FILE = path.join(REPO_ROOT, ".localnet/env.json");
const OUT = path.join(APP_DIR, "app/listings-fixture.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const env = JSON.parse(await readFile(ENV_FILE, "utf8"));
  const rpcUrl = arg("--rpc", env.rpcUrl);
  const fixtures = JSON.parse(await readFile(env.fixturesPath, "utf8"));
  if (!fixtures.seeded || fixtures.listings.length === 0) {
    throw new Error(
      `no seeded listings at ${env.fixturesPath} — run \`node test/sandbox-up.mjs up\` first`,
    );
  }

  const rpc = createSolanaRpc(rpcUrl);
  const slot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
  const listings = [];
  for (const entry of fixtures.listings) {
    const info = await rpc
      .getAccountInfo(address(entry.address), { encoding: "base64" })
      .send();
    if (!info.value) throw new Error(`listing ${entry.address} not found on chain`);
    listings.push({ address: entry.address, accountBase64: info.value.data[0] });
  }

  const out = {
    _comment:
      "REAL seeded ServiceListing account bytes captured from the localnet sandbox. Regenerate with scripts/capture-fixtures.mjs after sandbox-up. Decoded at render time by app/fixture-transport.ts.",
    capturedAtSlot: slot,
    programId: env.programId,
    listings,
  };
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`capture-fixtures: wrote ${listings.length} listings -> ${OUT} (slot ${slot})`);
}

main().catch((error) => {
  console.error(`capture-fixtures: ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
