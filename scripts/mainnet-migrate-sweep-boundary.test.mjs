import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CHILD = new URL("./mainnet-migrate-sweep.mjs", import.meta.url);

test("migration child binds every execute mutation to the paused reviewed release", async () => {
  const source = await readFile(CHILD, "utf8");
  for (const required of [
    "SO_PATH",
    "EXPECTED_SO_SHA256",
    "loadReviewedUpgradeAuthorityPolicy",
    "readProgramUpgradeAuthoritySnapshot",
    "assertImmediatePreUpgradeSnapshot",
    "assertApprovedExecutableSnapshot",
    "simulateNonBroadcastableInstructions",
    "getAccountInfoAndContext",
    "protocol_paused=false",
  ]) {
    assert.match(source, new RegExp(required));
  }

  const mainBody = source.slice(source.indexOf("async function main()"));
  assert.ok(
    mainBody.indexOf("readProgramUpgradeAuthoritySnapshot(") <
      mainBody.indexOf("initializeSigningMaterial();"),
    "loader/custody must be verified before plaintext signer files are opened",
  );
  assert.match(
    source,
    /async function sendInstruction[\s\S]*verifyMigrationBoundary\(`\$\{label\} pre-broadcast`\)[\s\S]*sendRawTransaction[\s\S]*submitted[\s\S]*confirmationSlot[\s\S]*verifyMigrationBoundary\([\s\S]*post-confirmation/,
  );
  assert.match(
    source,
    /async function simulateInstruction[\s\S]*verifyMigrationBoundary[\s\S]*simulateNonBroadcastableInstructions/,
  );
  assert.doesNotMatch(
    source,
    /simulateTransaction\(transaction,\s*\{[\s\S]*sigVerify:\s*true/,
  );
});
