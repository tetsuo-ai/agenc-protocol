#!/usr/bin/env node
import { readFileSync } from "node:fs";

const idlPath = process.argv[2] || "target/idl/agenc_coordination.canary.json";
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const actual = idl.instructions.map((instruction) => instruction.name).sort();
const expected = [
  "accept_task_result",
  "cancel_task",
  "claim_task_with_job_spec",
  "configure_task_moderation",
  "configure_task_validation",
  "create_task",
  "deregister_agent",
  "expire_claim",
  "initialize_protocol",
  "migrate_protocol",
  "record_task_moderation",
  "register_agent",
  "reject_task_result",
  "set_task_job_spec",
  "submit_task_result",
  "suspend_agent",
  "unsuspend_agent",
  "update_agent",
  "update_launch_controls",
  "update_min_version",
  "update_multisig",
  "update_protocol_fee",
  "update_rate_limits",
  "update_treasury",
].sort();

const missing = expected.filter((name) => !actual.includes(name));
const unexpected = actual.filter((name) => !expected.includes(name));

if (missing.length > 0 || unexpected.length > 0) {
  console.error("Canary IDL surface mismatch.");
  if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) console.error(`Unexpected: ${unexpected.join(", ")}`);
  process.exit(1);
}

console.log(`Canary IDL surface OK (${actual.length} instructions).`);
