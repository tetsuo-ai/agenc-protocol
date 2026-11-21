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
// Lead item 52: revision 9 retires the revision 8 repair allowance with its
// rail, so the pending repair-record shape is a hard gate at every stage.
const PENDING_REPAIR_GATE =
  /PENDING REVISION 8 DISPUTE COUNTER REPAIR \(pending-revision8-dispute-counter-repair\).*revision 8 release tree's scripts\/mainnet-repair-dispute-counter\.mjs/;
test("the exact reviewed shape is a hard gate with recovery instructions (item 52)", () => {
  assert.throws(() => assertRevision5DisputeCutover(shape()), PENDING_REPAIR_GATE);
});
test("even the old revision-5 opt-in no longer accepts either recorded pending dispute (item 52)", () => {
  for (const pending of [
    record.incident.dispute,
    record.siblingDisputes[0].dispute,
  ]) {
    for (const stage of [
      "Predeploy cutover snapshot",
      "Immediate predeploy rescan",
      "Postdeploy/prestamp rescan",
    ]) {
      assert.throws(
        () =>
          assertRevision5DisputeCutover(shape(pending), stage, {
            repairAllowance: allowance(),
          }),
        PENDING_REPAIR_GATE,
        `${stage} pending=${pending}`,
      );
    }
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
test("no opt-in or payload activates the retired allowance (item 52)", () => {
  for (const repairAllowance of [
    allowance(),
    allowance({}),
    allowance(undefined, "0".repeat(64)),
  ]) {
    assert.equal(repairAllowance.active, false);
    assert.throws(
      () =>
        assertRevision5DisputeCutover(shape(), "Predeploy", {
          repairAllowance,
        }),
      PENDING_REPAIR_GATE,
    );
  }
  const warnings = [];
  createDisputeCounterRepairAllowance({
    env: { AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR: "1" },
    livePayloadSha256: record.priorRevision.payloadSha256,
    warn: (s) => warnings.push(s),
  });
  assert.match(
    warnings.join(),
    /ignoring AGENC_ACCEPT_DISPUTE_COUNTER_REPAIR: revision 9 retires the revision 8 repair allowance/,
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
      PENDING_REPAIR_GATE,
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
