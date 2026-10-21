import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadDisputeCounterRepairRecord,
  validateDisputeCounterRepairRecord,
  createDisputeCounterRepairAllowance,
  assertRevision5DisputeCutover,
} from "./mainnet-upgrade.mjs";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");
const record = loadDisputeCounterRepairRecord();
const key = (value) => new PublicKey(value);
const other = key(Buffer.alloc(32, 42));
function shape(pending = record.incident.dispute) {
  return {
    statusCounts: { active: 0 },
    blockers: [
      {
        kind: "tracked-initiator-counter-deficit",
        dispute: key(record.initiatorAgent),
      },
      { kind: "tracked-initiator-outcome-unapplied", dispute: key(pending) },
    ],
    initiatorCounterDeficits: [
      {
        initiator: key(record.initiatorAgent),
        pendingInitiatorOutcomes: 0,
        unfinalizedTrackedDisputes: 1,
        disputes: [key(pending)],
      },
    ],
  };
}
function allowance(
  env = { AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR: "1" },
  hash = record.priorRevision.payloadSha256,
) {
  return createDisputeCounterRepairAllowance({
    record,
    env,
    livePayloadSha256: hash,
    warn: () => {},
  });
}
test("reviewed remediation record validates and rejects malformed boundaries", () => {
  assert.equal(validateDisputeCounterRepairRecord(record), record);
  for (const mutate of [
    (r) => (r.schemaVersion = 2),
    (r) => (r.network = "devnet"),
    (r) => (r.genesisHash = "wrong"),
    (r) => (r.programId = other.toBase58()),
    (r) => (r.repairInstruction = "repair"),
    (r) => (r.initiatorAgent = "invalid"),
    (r) => (r.incident.dispute = "invalid"),
    (r) => (r.incident.task = "invalid"),
    (r) => (r.incident.claim = "invalid"),
    (r) => (r.incident.initiateDisputeSignature = "1"),
    (r) => (r.priorRevision.payloadSha256 = "ab"),
    (r) => (r.priorRevision.surfaceRevision = 8),
    (r) => (r.siblingDisputes = []),
    (r) => (r.siblingDisputes[0].dispute = r.incident.dispute),
    (r) => (r.siblingDisputes[0].task = "invalid"),
  ]) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.throws(
      () => validateDisputeCounterRepairRecord(copy),
      /invalid dispute counter remediation record/,
    );
  }
});
test("default rejects exact reviewed shape with operator recovery instructions", () => {
  assert.throws(
    () => assertRevision5DisputeCutover(shape()),
    /AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR=1.*predeploy.*mainnet-repair-dispute-counter.mjs.*before any stamp/,
  );
});
test("active revision-5 allowance accepts either recorded pending dispute", () => {
  for (const pending of [
    record.incident.dispute,
    record.siblingDisputes[0].dispute,
  ]) {
    assert.deepEqual(
      assertRevision5DisputeCutover(shape(pending), "Predeploy", {
        repairAllowance: allowance(),
      }),
      {
        agent: record.initiatorAgent,
        pendingDispute: pending,
        incidentDispute: record.incident.dispute,
      },
    );
  }
});
test("allowance refuses any deviation from exact reviewed shape", () => {
  for (const mutate of [
    (s) => s.blockers.push({ kind: "extra", dispute: other }),
    (s) => (s.statusCounts.active = 1),
    (s) => (s.initiatorCounterDeficits[0].pendingInitiatorOutcomes = 1),
    (s) => (s.initiatorCounterDeficits[0].unfinalizedTrackedDisputes = 2),
    (s) =>
      s.initiatorCounterDeficits[0].disputes.push(
        key(record.siblingDisputes[0].dispute),
      ),
    (s) => {
      s.blockers[1].dispute = other;
      s.initiatorCounterDeficits[0].disputes = [other];
    },
    (s) => {
      s.blockers[0].dispute = other;
      s.initiatorCounterDeficits[0].initiator = other;
    },
    (s) => (s.initiatorCounterDeficits = []),
  ]) {
    const scan = shape();
    mutate(scan);
    assert.throws(
      () =>
        assertRevision5DisputeCutover(scan, "Predeploy", {
          repairAllowance: allowance(),
        }),
      /dispute cutover requires/,
    );
  }
});
test("missing opt-in and non-revision-5 payload never activate allowance", () => {
  for (const repairAllowance of [
    allowance({}),
    allowance(undefined, "0".repeat(64)),
  ]) {
    assert.equal(repairAllowance.active, false);
    assert.throws(
      () =>
        assertRevision5DisputeCutover(shape(), "Predeploy", {
          repairAllowance,
        }),
      /dispute cutover requires/,
    );
  }
  const warnings = [];
  createDisputeCounterRepairAllowance({
    env: { AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR: "1" },
    livePayloadSha256: "0".repeat(64),
    warn: (s) => warnings.push(s),
  });
  assert.match(
    warnings.join(),
    /ignoring.*not the reviewed revision-5 payload/,
  );
});
test("postdeploy and prestamp reject even an accidentally forwarded allowance", () => {
  for (const stage of [
    "Postdeploy/prestamp rescan",
    "prestamp",
    "Postdeploy",
  ]) {
    assert.throws(
      () =>
        assertRevision5DisputeCutover(shape(), stage, {
          repairAllowance: allowance(),
        }),
      /dispute cutover requires/,
    );
  }
  const source = readFileSync(
    new URL("./mainnet-upgrade.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /"Postdeploy\/prestamp rescan",\s*\{ minContextSlot: prestampLoaderBefore.contextSlot, bondEntryPauseGated: true \},/,
  );
});
