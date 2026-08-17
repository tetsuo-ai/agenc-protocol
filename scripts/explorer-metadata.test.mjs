import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_CONTACT_NEEDLES,
  PROGRAM_ID,
  PVR_CONTACT,
  REVISION_5_COMMIT,
  UPGRADE_AUTHORITY_VAULT,
  buildSecurityCeremonyCommands,
  buildSubmitOsecArgs,
  buildVerifyPdaExportArgs,
  defaultSecurityJsonPath,
  extractBufferAddress,
  parseSecurityJson,
  renderOperatorCard,
  validateSecurityJson,
} from "./explorer-metadata.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in security.json is Explorer-ready and does not advertise the unverified mailbox", async () => {
  const raw = await readFile(defaultSecurityJsonPath(ROOT), "utf8");
  const doc = validateSecurityJson(parseSecurityJson(raw));
  assert.equal(doc.source_revision, REVISION_5_COMMIT);
  assert.ok(doc.contacts.includes(PVR_CONTACT));
  const blob = JSON.stringify(doc).toLowerCase();
  for (const needle of FORBIDDEN_CONTACT_NEEDLES) {
    assert.equal(blob.includes(needle.toLowerCase()), false);
  }
});

test("validateSecurityJson rejects the unverified mailbox and a missing PVR contact", () => {
  const base = {
    name: "AgenC Coordination",
    description: "test",
    project_url: "https://agenc.ag",
    contacts: [PVR_CONTACT],
    policy: "https://github.com/tetsuo-ai/agenc-protocol/blob/main/SECURITY.md",
    source_code: "https://github.com/tetsuo-ai/agenc-protocol",
    source_revision: REVISION_5_COMMIT,
    expiry: "2027-07-18",
  };

  assert.throws(
    () => validateSecurityJson({ ...base, contacts: ["email:security@agenc.tech"] }),
    /PVR channel|security@agenc.tech/,
  );
  assert.throws(
    () => validateSecurityJson({ ...base, contacts: [] }),
    /contacts/,
  );
  assert.throws(
    () => validateSecurityJson({ ...base, source_revision: "097ded12b03d27e8c89d50ad6ed8813493700129" }),
    /revision-5 candidate/,
  );
});

test("export commands pin the vault, program, and revision-5 commit", () => {
  const verify = buildVerifyPdaExportArgs();
  assert.ok(verify.includes(PROGRAM_ID));
  assert.ok(verify.includes(UPGRADE_AUTHORITY_VAULT));
  assert.ok(verify.includes(REVISION_5_COMMIT));
  assert.ok(verify.includes("0"));

  const osec = buildSubmitOsecArgs();
  assert.deepEqual(osec.slice(0, 3), ["remote", "submit-job", "--program-id"]);
  assert.ok(osec.includes(UPGRADE_AUTHORITY_VAULT));

  const security = buildSecurityCeremonyCommands({
    keypair: "/tmp/op.json",
    closeBuffer: "11111111111111111111111111111111",
  });
  const write = security.exportWrite("Buffer11111111111111111111111111111111");
  assert.ok(write.includes("security"));
  assert.ok(write.includes(PROGRAM_ID));
  assert.ok(write.includes(UPGRADE_AUTHORITY_VAULT));
  assert.ok(write.includes("base58"));

  const card = renderOperatorCard();
  assert.match(card, /two Squads vault approvals/);
  assert.match(card, new RegExp(PROGRAM_ID));
});

test("extractBufferAddress reads a base58 pubkey from CLI output", () => {
  assert.equal(
    extractBufferAddress("Created buffer 11111111111111111111111111111111\n"),
    "11111111111111111111111111111111",
  );
  assert.equal(extractBufferAddress("no address here"), null);
});
